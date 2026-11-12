---
id: 27
type: story
title: "Connecting cursor-cli installs cursor-agent when it is missing"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: high
---

# Connecting cursor-cli installs cursor-agent when it is missing

## Description

A user who connects the `cursor-cli` provider on a Gateway host without the Cursor CLI no longer has to install it by hand. Both Connect methods (Control UI **Connect provider** and `openclaw models auth login --provider cursor-cli`) detect a missing or too old `cursor-agent` and, after an explicit yes, download Cursor's official package for the host, check its pinned sha256, unpack it into a folder the plugin owns under the OpenClaw state directory, and point `cursor-cli.command` at it. The API key method then checks the key with the installed CLI before it saves it, so one dialog takes a bare host to a working `cursor-cli/auto`. The download source, version, and hash are adapter data; the core does the download, check, and unpack, and names no CLI (new AD-17 in the spine).

## Acceptance Criteria

1. **The install is offered only when needed**
   **Given** a host where `cursor-cli.command` (or `cursor-agent` on the Gateway's `PATH`) runs a supported `cursor-agent`
   **When** either Connect method runs
   **Then** no install is offered and the method behaves as today
   **And** given no `cursor-agent`, or one older than the plugin's minimum, the method offers the install, naming the version, the source host, the download size, the disk space needed, and the target folder
2. **Nothing is downloaded without a yes**
   **Given** the install offer
   **When** the user declines, cancels, or the run is non-interactive
   **Then** nothing is downloaded or written, and the method ends with the manual install command from `docs/setup.md`
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
6. **The API key is checked before it is saved**
   **Given** the API key method and a working `cursor-agent` (installed now or already present)
   **When** the user enters a key
   **Then** the plugin runs `cursor-agent about` with the key for the Cursor process only; a key it accepts is saved as today, and a key it rejects is not saved and the user is told it is invalid
   **And** the key never appears in a log, a note, an error, or a process argument
7. **Unsupported hosts get the manual path**
   **Given** Windows, Linux musl, another architecture, or OpenClaw in Nix mode
   **When** either Connect method finds no `cursor-agent`
   **Then** no install is offered and the method shows why and the manual install instructions
8. **The pin is maintained in the repo**
   **Given** the repository
   **When** a maintainer runs the pin script
   **Then** it reads the current version from Cursor's install script and each platform's `.sha256`, and writes them as adapter data
   **And** CI fails when a pinned URL no longer answers or its checksum no longer matches
9. **Docs, spine, and log**
   **Given** the change
   **When** the docs are read
   **Then** `docs/setup.md` and `docs/providers/cursor.md` describe the managed install (what is downloaded, from where, where it goes, how to update and remove it, the proxy setting, the unsupported hosts), README states it in one line, the spine has AD-17, and `CHANGELOG.md` has one plain line under `## Unreleased`
10. **Checks pass**
    **Given** the branch
    **When** the focused tests and `npm test` run
    **Then** they pass with a local HTTP stub serving a small package (good, bad hash, truncated, oversized, cancelled); a live install of the real package with a real key turn runs where Cursor is reachable and is recorded as not run otherwise

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

- Decision (owner, 2026-11-12): explore and plan the feature; build only after the owner approves this ticket.
- Assumption: the first story covers Linux (glibc) and macOS; Windows is a later story (zip, launchers, Git Bash requirement).
- Assumption: the managed folder is `<state dir>/tools/cursor-agent/<version>/`, as OpenClaw's own Signal setup does for `signal-cli`; older managed versions are removed after a successful switch.
- Assumption: the pinned version moves with plugin releases; the plugin does not follow Cursor's latest on its own.
- Decision (owner, 2026-11-12): the install is offered while the provider is being set up (the API key step of Connect provider), never when the plugin itself is installed.
- Open question: whether a multi-minute download fits the Control UI wizard's step timeout; if not, the Control UI dialog points at the CLI command and the install runs there only. (The Control UI 2026.11.3 wizard does render `confirm` and Gateway-run `progress` steps.)
- Open question: whether `cursor-agent` updates itself and where it writes then.
- Open question: whether `extractArchive` from `openclaw/plugin-sdk/setup-tools` handles the 536 MiB package and keeps executable bits, or the core needs its own bounded unpack.
- Risk high: the plugin downloads and runs third-party binaries, and ClawHub's audit judges an install mechanism. Check outside this ticket: the owner reviews the ClawHub audit of the first release that ships it, and runs the install once on the owner's own macOS or Linux host.
