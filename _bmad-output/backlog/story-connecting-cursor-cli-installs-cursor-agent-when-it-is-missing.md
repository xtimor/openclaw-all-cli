---
id: 27
type: story
title: "Connecting cursor-cli installs cursor-agent when it is missing"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: high
---

# Connecting cursor-cli installs cursor-agent when it is missing

## Description

A user who connects the `cursor-cli` provider on a Gateway host without the Cursor CLI no longer has to install it by hand. Both Connect methods (Control UI **Connect provider** and `openclaw models auth login --provider cursor-cli`) detect a missing or too old `cursor-agent` and, after an explicit yes, download Cursor's official package for the host, check its pinned sha256, unpack it into a folder the plugin owns under the OpenClaw state directory, and point `cursor-cli.command` at it. A third method, remove, offers to remove the saved key and the managed CLI. The API key method then checks the key with the installed CLI before it saves it, so one dialog takes a bare host to a working `cursor-cli/auto`. The download source, version, and hash are adapter data; the core does the download, check, and unpack, and names no CLI (new AD-17 in the spine).

## Acceptance Criteria

1. **The install is offered only when needed**
   **Given** a host where `cursor-cli.command` (or `cursor-agent` on the Gateway's `PATH`) runs a supported `cursor-agent`
   **When** either Connect method runs
   **Then** no install is offered and the method behaves as today
   **And** given no `cursor-agent`, or one older than the plugin's minimum, the method offers the install, naming the version, the source host, the download size, the disk space needed, and the target folder; when the Control UI step timeout rules the download out, the Control UI dialog instead names the CLI command that installs
2. **Nothing is downloaded without a yes**
   **Given** the install offer
   **When** the user declines, cancels, or the run is non-interactive
   **Then** nothing is downloaded or written, and the method ends with a link to the manual install section of `docs/setup.md` (the plugin source holds no download-and-run command); the API key method still saves the key, unchecked, with a note that no CLI was found, as it does today
   **And** the plugin never installs at Gateway start, during a turn, or from a probe
3. **Only the pinned package is installed**
   **Given** a yes on Linux (x64, arm64, glibc) or macOS (x64, arm64)
   **When** the install runs
   **Then** it downloads only `https://downloads.cursor.com/` URLs for the pinned version and platform, checks the sha256 pinned in the plugin before unpacking, unpacks with size and entry limits into a temporary folder, and moves it into `<state dir>/tools/cursor-agent/<version>/` in one rename
   **And** the installed launcher answers `--version` with the pinned version before the method continues
4. **A failed install leaves nothing behind**
   **Given** a download error, a proxy refusal, a hash mismatch, too little disk space, an unpack limit, a cancel, or a launcher that does not run
   **When** the install stops
   **Then** the temporary folder is removed, the config is not changed, an earlier install is untouched, and the message names the cause and the manual path
5. **The config points at the managed CLI**
   **Given** a successful install
   **When** the method ends
   **Then** its `configPatch` sets `cursor-cli.command` to the absolute launcher path and keeps every other `cursor-cli` setting
   **And** the model list, probes, and turns use that path without a `PATH` change
   **And** older folders under `<state dir>/tools/cursor-agent/` are removed, and the login method's fix text names the absolute launcher path
6. **The API key is checked before it is saved**
   **Given** the API key method and a working `cursor-agent` (installed now or already present)
   **When** the user enters a key
   **Then** the plugin runs `cursor-agent about` with the key for the Cursor process only; a key it accepts is saved as today, a key it rejects is not saved and the user is told it is invalid, and an answer that is neither is retried once, then the key is not saved and the user is told the check could not run
   **And** the key never appears in a log, a note, an error, or a process argument
7. **Unsupported hosts get the manual path**
   **Given** Windows, Linux musl, another architecture, or OpenClaw in Nix mode
   **When** either Connect method finds no `cursor-agent`
   **Then** no install is offered and the method shows why and links the manual install instructions; the API key method still saves the key, unchecked, as today
8. **Removing the key offers to remove the managed CLI**
   **Given** a saved key in `cursor-cli.env`, a managed `cursor-agent`, or both
   **When** the user runs the provider's remove method (Control UI **Connect provider** or `openclaw models auth login --provider cursor-cli --method remove`)
   **Then** it asks, when a key is saved, whether to remove it, and, when a managed install exists, separately whether to remove that too, naming its folder and size; with neither, it says there is nothing to remove
   **And** a yes to the key removes `CURSOR_API_KEY` from `cursor-cli.env` and keeps the other settings, and the note says Cursor's own copy in `~/.config/cursor/auth.json` and OpenClaw's rotated config copies remain, linking the full removal steps in `docs/setup.md`; a yes to the CLI removes the managed folder and unsets `cursor-cli.command` only when it points there, after closing the plugin's idle `cursor-agent` processes from that folder, and refuses while a turn runs on it; a `cursor-agent` the plugin did not install is never removed
9. **The pin is maintained in the repo**
   **Given** the repository
   **When** a maintainer runs the pin script
   **Then** it reads the current version from Cursor's install script and the `.sha256` of each supported platform (linux x64/arm64, darwin x64/arm64), and writes them as adapter data
   **And** a scheduled CI job (not every pull request) fails when a pinned `.sha256` file no longer answers or no longer matches the pin; it does not download the packages
10. **Docs, spine, and log**
    **Given** the change
    **When** the docs are read
    **Then** `docs/setup.md` and `docs/providers/cursor.md` describe the managed install (what is downloaded, from where, where it goes, how to update it, how to remove it with the remove method or by hand, the proxy setting, the unsupported hosts), README states it in one line, the spine has AD-17, and `CHANGELOG.md` has one plain line under `## Unreleased`
11. **Checks pass**
    **Given** the branch
    **When** the focused tests and `npm test` run
    **Then** they pass with a local HTTP stub serving a small package (good, bad hash, truncated, oversized, cancelled, no disk space, wrong host refused, launcher fails `--version`); a live install of the real package with a real key turn runs where Cursor is reachable and is recorded as not run otherwise

## Boundaries

- Must not change: a user's own `cursor-agent`, `~/.local/bin`, `~/.local/share/cursor-agent`, `PATH`, or shell profiles; the login method's behavior when the CLI is present; where the key is stored; the per-agent Cursor home; turns, probes, and usage reads.
- Must not run Cursor's install script or any shell to install.
- Must not download from a host other than `downloads.cursor.com`, or a version or hash not pinned in the plugin release.

## References

- research — _bmad-output/backlog/story-connecting-cursor-cli-installs-cursor-agent-when-it-is-missing-research.md
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md
- earlier story — _bmad-output/backlog/story-cursor-provider-in-the-control-ui-provider-list.md
- docs — docs/setup.md, sections Install the requirements and Sign in from the Control UI or the CLI

## Notes

- Decision (owner, 2026-11-12): explore and plan the feature; build only after the owner approves this ticket. Approved 2026-11-12.
- Decision (owner, 2026-11-12): removing the key must also offer to remove the Cursor CLI. OpenClaw's own **Remove key** button (Models, provider card; `models.authLogout`) deletes only OpenClaw auth profiles and `models.providers.<id>.apiKey`, calls no plugin code, and asks nothing (checked in OpenClaw 2026.11.3), and this plugin's key is in neither place. So the plugin adds its own remove method beside the two Connect methods. A provider hook on **Remove key** would need an OpenClaw change (upstream request, not this story).
- Decision (owner approval, 2026-11-12): this story covers Linux (glibc) and macOS; Windows is a later story (zip, launchers, Git Bash requirement).
- Decision (owner approval, 2026-11-12): the managed folder is `<state dir>/tools/cursor-agent/<version>/`, as OpenClaw's own Signal setup does for `signal-cli`; older managed versions are removed after a successful switch.
- Decision (owner approval, 2026-11-12): the pinned version moves with plugin releases; the plugin does not follow Cursor's latest on its own.
- Decision (2026-11-12, validation): kept as one story, built in one pull request with plan phases (install core, key check, remove method, pin and CI); the validator suggested a split.
- Decision (2026-11-12, validation): on a host without a CLI (declined, unsupported) the API key method keeps today's path and saves the key unchecked.
- Open question: whether a returned `configPatch` can delete a key (`CURSOR_API_KEY`, `command`), or the remove method needs another way to unset them.
- Decision (owner, 2026-11-12): the install is offered while the provider is being set up (the API key step of Connect provider), never when the plugin itself is installed.
- Open question: whether a multi-minute download fits the Control UI wizard's step timeout; if not, the Control UI dialog points at the CLI command and the install runs there only. (The Control UI 2026.11.3 wizard does render `confirm` and Gateway-run `progress` steps.)
- Open question: whether `cursor-agent` updates itself and where it writes then.
- Open question: whether `extractArchive` from `openclaw/plugin-sdk/setup-tools` handles the 536 MiB package and keeps executable bits, or the core needs its own bounded unpack.
- Risk high: the plugin downloads and runs third-party binaries, and ClawHub's audit judges an install mechanism. Check outside this ticket: the owner reviews the ClawHub audit of the first release that ships it, and runs the install once on the owner's own macOS or Linux host.
