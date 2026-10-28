# Changelog

What changed for people who use the plugin, newest first. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). How it is kept and used by releases: [Release](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/release.md#changelog).

## Unreleased

### Added

- Every Cursor turn writes one line to OpenClaw's debug log (`OPENCLAW_LOG_LEVEL=debug`, search `turn timings`) with how long the process start, the chat start or resume, the model switch, the wait for the first thought, the first text, and the end took, so a slow first reply can be traced to the step that causes it. The docs name the fields and give a live split for `grok-4.7` and `auto`. ([#44](https://github.com/xtimor/openclaw-all-cli/issues/44))

### Changed

- Docs: Cursor's 1M context variants ("Claude Opus 5.5 1M" and similar) cannot be picked as `cursor-cli/...` models, because Cursor refuses a `context=1m` model ID over ACP (checked live: `Invalid model value`), so the plugin lists no 1M model and leaves every existing model name unchanged. The 300k shown for these models is Cursor's ACP default, not their limit. If Cursor starts listing a 1M row, the plugin shows it as its own model with a 1,000,000 window. Details in the [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md#1m-context-variants) docs. ([#46](https://github.com/xtimor/openclaw-all-cli/issues/46))
- Issues: the triage and implementation agents no longer close an issue they cannot or will not fix. They give the reason and the evidence under the new `status:declined`, mention the maintainer, and leave the issue open; the maintainer closes it or moves it on, and an untouched declined issue closes as not planned after 30 days. Security reports are still closed at once with a pointer to the security policy. See [Issues](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/issues.md).

## 0.1.4 - 2026-10-27

### Changed

- README: an "Update" section with the update command, how to check the installed version, and what to do after a pinned install.
- Cursor models show as "OAC / <name>" (for example "OAC / GPT-5.3 Codex") in the model picker and model lists, so they stand apart from another provider's models. Model IDs and refs such as `cursor-cli/auto` are unchanged. ([#37](https://github.com/xtimor/openclaw-all-cli/issues/37))
- The provider shows as "OAC / Cursor-CLI" (provider list, "Connect provider" group, plugin settings), no longer the same "Cursor CLI" as the separate `@jeehou/openclaw-cursor-cli` plugin. The provider ID `cursor-cli` and model refs such as `cursor-cli/auto` are unchanged. ([#36](https://github.com/xtimor/openclaw-all-cli/issues/36))
- Docs: with only the `cursor-agent` login, the Control UI provider card reads "Not configured" with a Connect button although every model works. OpenClaw 2026.10.3 builds that card from saved profiles and config or env keys only, and honors the plugin's declared synthetic auth only for its own bundled plugins, so the plugin cannot fix it without writing a placeholder key (it does not). Reported upstream as [openclaw/openclaw#184700](https://github.com/openclaw/openclaw/issues/184700); how to check the login meanwhile is in [Setup](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md). ([#39](https://github.com/xtimor/openclaw-all-cli/issues/39))
- Docs: the plugin icon shows on the Plugins page, in the command palette, in channel setup, and on the chat install card, but never in the model picker, on provider cards, or in the "Connect provider" list: OpenClaw draws those from brand artwork bundled with its Control UI, keyed by provider ID, and `cursor-cli` has none. This corrects the 0.1.2 note about the icon. Details and the OpenClaw code that decides it are in the [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md) docs. ([#35](https://github.com/xtimor/openclaw-all-cli/issues/35))
- Docs: why the first reply of a new Cursor session takes 20 s or more, measured part by part (mostly the model thinking over the agent's instructions, plus about 4 s to start `cursor-agent` and its chat), and why the plugin does not pre-start `cursor-agent` or prepare a chat per agent. Details in the [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md#first-reply-of-a-new-chat) docs. ([#38](https://github.com/xtimor/openclaw-all-cli/issues/38))

### Fixed

- The Control UI context tile no longer shows a Cursor turn far above the model's context window (such as 5.6M / 256k after a turn with tool calls). Cursor sums the tokens of every model request in a turn, so OpenClaw read those sums as the context size; when they are more than the window, the plugin now tells OpenClaw the turn's context size is unknown and leaves out the total. The tile then keeps the earlier reading (shown with `~`), and the input, output, and cache counts stay as Cursor reports them. What the numbers mean is in the [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md#usage) docs. ([#40](https://github.com/xtimor/openclaw-all-cli/issues/40))

## 0.1.3 - 2026-10-25

### Added

- This changelog. A release's GitHub notes are its section of this file.

## 0.1.2 - 2026-10-25

### Added

- The Cursor CLI provider is in the Control UI "Connect provider" list (and `openclaw models auth login --provider cursor-cli`) with two methods: use the `cursor-agent` login, or enter a `CURSOR_API_KEY`, which is stored in the plugin config for the Cursor process only. ([#10](https://github.com/xtimor/openclaw-all-cli/issues/10))
- OpenClaw's Effort control (`/think`, the effort picker) works for Cursor models whose ID has an effort setting: the plugin runs the listed variant of the same model that matches the level. ([#8](https://github.com/xtimor/openclaw-all-cli/issues/8))
- A plugin icon for the provider card and the model picker. ([#9](https://github.com/xtimor/openclaw-all-cli/issues/9))
- Bug and idea forms on GitHub, a guide to reporting them ([Issues](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/issues.md)), and a security policy.

### Changed

- Setup: with an explicit `agents.defaults.modelPolicy.allow`, add `cursor-cli/*` to it, or the Cursor models are refused and missing from `/model`.
- Docs: the first turn after a Gateway start can restart `cursor-agent` once more, because OpenClaw is still loading the model list. Why, and the setting that avoids it, are in the [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md) known limits.
- Docs: a webchat that draws a reply twice is OpenClaw's behavior, not the plugin's; the findings are in the Cursor provider known limits. ([#13](https://github.com/xtimor/openclaw-all-cli/issues/13))

### Fixed

- `cursor-agent` is no longer restarted on every turn. A follow-up reply starts in about 2 seconds in the plugin instead of about 5.5 seconds, and through a Gateway in 5 to 7.6 seconds instead of 9 seconds. ([#11](https://github.com/xtimor/openclaw-all-cli/issues/11))
- Models no longer all show a 128k context window. A window is shown where Cursor states it (the `context=` value of the model ID, or a known model family); other models keep OpenClaw's default. ([#12](https://github.com/xtimor/openclaw-all-cli/issues/12))
- The Gateway error `cli backend already registered: cursor-cli (cursor-cli)` is explained in Setup: the older `@jeehou/openclaw-cursor-cli` plugin is still installed and must be uninstalled. ([#14](https://github.com/xtimor/openclaw-all-cli/issues/14))

## 0.1.1 - 2026-10-22

### Changed

- Setup installs the plugin from npm: `openclaw plugins install openclaw-all-cli --accept-capabilities --force`, and `openclaw plugins update openclaw-all-cli` updates it. Building from source moved to "Build from source".
- Docs: the Gateway start uses `NO_COLOR=1` so its log can be searched, a first reply in a new workspace is OpenClaw's greeting, and the `plugin provenance-invalid` warning is harmless for the npm install.

## 0.1.0 - 2026-10-22

### Added

- First release, on npm as `openclaw-all-cli` with provenance, and on GitHub with the tarball's sha256. It runs Cursor CLI (`cursor-agent`) as models `cursor-cli/<model>`.
- The account's Cursor models are listed in `/model` and `openclaw models list`. Sign in with `cursor-agent login` or a `CURSOR_API_KEY`.
- Replies stream as text, thinking, and tool progress. A chat continues across turns and Gateway restarts, and a chat carries over when the model is switched from or to an API model.
- OpenClaw's tools, skills, system prompt, and `exec` are what the model uses; Cursor's own shell and file-writing tools are off, and approvals go through OpenClaw. Images work.
- Token usage per turn with a `CURSOR_API_KEY`. Each agent gets its own Cursor config and chat store, and Cursor processes are stopped with the Gateway.
