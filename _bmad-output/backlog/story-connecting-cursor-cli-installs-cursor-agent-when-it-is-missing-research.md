# Research: install `cursor-agent` from the provider setup

Question (owner, 2026-11-12): can the plugin, while the `cursor-cli` provider is being set up, install the Cursor CLI itself and configure it to work with an API key? Answer: yes, on Linux and macOS, with the limits below. Checked on 2026-11-12 against `cursor-agent` 2026.11.11-b912975, OpenClaw 2026.11.3 (npm `latest`), and the ClawHub listing of `openclaw-all-cli@0.1.8`. Nothing was installed or run; files were downloaded and read only.

## How Cursor installs its CLI

- Linux and macOS: `curl https://cursor.com/install -fsS | bash`. The script is generated per release and hardcodes the version. It needs no root: it downloads `https://downloads.cursor.com/lab/<version>/<os>/<arch>/agent-cli-package.tar.gz` (`os` = `linux` or `darwin`, `arch` = `x64` or `arm64`), unpacks it with `--strip-components=1` into `~/.local/share/cursor-agent/versions/<version>/`, and links `~/.local/bin/cursor-agent` and `~/.local/bin/agent` to `<version>/cursor-agent`. It edits no shell profile; it prints the `PATH` line to add.
- Windows: `irm 'https://cursor.com/install?win32=true' | iex`. It downloads `windows/<arch>/agent-cli-package.zip`, unpacks it with `tar.exe` into `%LOCALAPPDATA%\cursor-agent\versions\<version>`, copies `cursor-agent.cmd`/`.ps1`/`.exe` launchers one level up, and adds that folder to the user `PATH`. It says Git for Windows (Git Bash) is required "to run a private worker".
- Every package has a checksum file beside it: `<package URL>.sha256` (`<hex>  agent-cli-package.tar.gz`). All six platform packages of 2026.11.11 have one. The checksum comes from the same CDN, so it proves the download is complete and unchanged in transit, not who made it; TLS to `downloads.cursor.com` is the trust root, as it is for Cursor's own script.
- Size (2026.11.11): Linux x64 package 169 MiB (176,703,341 bytes), unpacked 536 MiB in 435 entries, no symlinks; macOS 167-174 MiB; Windows zip about 75 MiB. The package carries its own Node (`dist-package/node`), `rg`, and native modules. The Linux build is `linux-x64-gnu`: glibc only, so Alpine (musl) hosts are not covered.
- `cursor-agent` is the launcher script at the package root (`dist-package/cursor-agent`, mode 0755).
- There is no documented "latest version" endpoint. The version appears only inside the generated install script. The `downloads.cursor.com/lab/` layout is not documented by Cursor and may change.

## Using an API key

Already built (backlog story "Cursor provider in the Control UI provider list"): the Connect method **Cursor CLI API key (CURSOR_API_KEY)** (`api-key-env`) asks for the key and writes it to `plugins.entries.openclaw-all-cli.config.cursor-cli.env.CURSOR_API_KEY`, which reaches the Cursor process, the probes, and the usage reader only. What is missing is a check of the key before it is saved: `CURSOR_API_KEY=<key> cursor-agent about` prints `User Email` for a good key and `The provided API key is invalid` for a bad one (`cursor-agent status` ignores the key). Running it writes the key and its tokens to `~/.config/cursor/auth.json` (MEMORY.md, "Key on disk"), the same as any turn with the key.

## What OpenClaw offers a plugin

- Provider auth methods (`api.registerProvider(...).auth[].run(ctx)`) run on the Gateway host. `ctx.prompter` has `confirm`, `select`, `text` (with `sensitive`), `note`, and `progress(label)`; `ctx.signal` cancels; the result's `configPatch` is applied by the host. The same method runs from the Control UI (**Connect provider**, `models.authLogin` wizard) and from `openclaw models auth login --provider cursor-cli --method <id>`.
- `openclaw/plugin-sdk/setup-tools` exports `detectBinary` and `extractArchive` (from `@openclaw/fs-safe`: tar, tar.gz, and zip, with limits on archive bytes, extracted bytes, entries, and path depth, `stripComponents`, entry modes). `CONFIG_DIR` gives the OpenClaw state directory.
- Precedent in OpenClaw itself: the Signal channel setup detects `signal-cli`, offers to install it when missing, downloads the official release asset, stores it under `~/.openclaw/tools/signal-cli/<version>/`, and writes the binary path into config. Native Windows is not supported there either.
- Nix mode (`nixMode`) disables "auto-install and self-mutation flows"; a plugin install offer should respect it.
- OpenClaw runs no local dangerous-code scan at plugin install (operators can add `security.installPolicy`); `openclaw security audit --deep` reports `plugins.code_safety` patterns.
- Plugins run in the Gateway process as trusted code. Spawning a process is already part of this plugin.

## ClawHub security audit

The 0.1.8 listing is "suspicious" because of the native-reader finding (MCP07). The audit has an LLM review with five dimensions: Purpose & Capability, Instruction Scope, **Install Mechanism**, Credentials, Persistence & Privilege. Install Mechanism is "note" today ("no separate installation mechanism risk"). Code that downloads and runs a third-party binary will be judged there and by the A.I.G static scan (patterns: exec, download-and-run, exfiltration, credential harvesting). What keeps that judgment defensible:

- No shell, no `curl | bash`, no `iex`: the plugin downloads the package itself and never runs Cursor's install script.
- Only Cursor's own HTTPS host, a version pinned in the plugin release, and the package's sha256 pinned in the plugin (taken from Cursor's `.sha256` file when the pin is made) and checked before unpacking.
- Only after an explicit yes in the setup dialog that names the source, version, size, and target folder; never at Gateway start or during a turn.
- Into a folder the plugin owns under the OpenClaw state directory; no `PATH`, shell profile, `~/.local/bin`, or system change; no root.
- Documented in README and `docs/setup.md` in the same release, so the scanner's description of the behavior matches the docs.

Expected outcome: Install Mechanism becomes "note" or "concern"; the overall verdict stays at least "suspicious" until the MCP07 finding is fixed. That is an owner trade-off, recorded in the story.

## Feasibility per platform

| Host | Verdict |
| --- | --- |
| Linux x64 / arm64, glibc | Yes |
| macOS x64 / arm64 | Yes (download by Node is not quarantined; to be confirmed live) |
| Linux musl (Alpine containers) | No Cursor build; show the manual path |
| Windows | Possible later (zip, launchers, Git Bash requirement); not in the first story |
| Nix mode | No install offer; show the manual path |
| Gateway in Docker | Yes when the state directory is a volume; the install survives container restarts there, unlike `~/.local` |

## Open points for the build

- Whether the Control UI wizard renders `confirm` and `progress` steps for a provider auth method, and whether a multi-minute download fits its step timeout. Fallback: install from `openclaw models auth login` only, and point the Control UI dialog at it.
- Whether `cursor-agent` self-updates and where it writes then (inside the plugin's folder or into `~/.local/share/cursor-agent`).
- `extractArchive` limits for a 536 MiB package and that it keeps the executable bits.
- macOS Gatekeeper on the unpacked binaries (`com.apple.quarantine` is not set by a Node download, so none is expected).
- How the pinned version and hashes are refreshed: a repo script that reads Cursor's install script for the current version and its `.sha256` files, and a CI check that the pinned URLs still answer.
