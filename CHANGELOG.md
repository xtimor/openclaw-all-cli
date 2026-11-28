# Changelog

What changed for people who use the plugin, newest first. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). How it is kept and used by releases: [Release](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/release.md#changelog).

## Unreleased

### Fixed

- On OpenClaw 2026.10.3 with more than one agent in the config, ending a chat (`/new`, a reset, a deletion, or an idle or daily rollover) now closes its `cursor-agent` process again, instead of leaving it running until the 15-minute idle close ([#105](https://github.com/xtimor/openclaw-all-cli/issues/105)).
- On OpenClaw 2026.10.3, a Cursor key saved through **Connect provider** now shows on the `cursor-cli` card at once, instead of the card staying "Not configured" until a Gateway restart when the Gateway had started with `cursor-cli` as the model on a state with no saved key yet ([#106](https://github.com/xtimor/openclaw-all-cli/issues/106)). The cause is in OpenClaw 2026.10.3 (2026.11 is not affected): at each Gateway start on 2026.10.3 the plugin now has OpenClaw settle where it keeps saved keys, as the first saved key would; it saves nothing.
- A `cursor-cli` turn that OpenClaw serves no `exec` (for example an automation with a tool allow-list, `tools.fs.workspaceOnly`, or exec host `node`) no longer refuses edits as if the chat were read-only: when the turn is offered OpenClaw tools that change files or records (for example `write` and `edit`, or `file_write`), it now runs in Cursor's agent mode, with Cursor's own shell and file writes still blocked, and every prompt names those tools and says the chat is not read-only ([#102](https://github.com/xtimor/openclaw-all-cli/issues/102)). Checked live: in Cursor's ask mode the model refused every such write even with that sentence; in agent mode it wrote through OpenClaw's `write`.
- A collector child with an output schema on `cursor-cli/gpt-5.3-codex` now answers through OpenClaw's `structured_output` tool instead of failing with "structured_output was not called": the plugin's sentence about that tool now ends the prompt, after OpenClaw's own "reply normally in your final assistant message", which the codex model had followed (2 of 2 runs before, 3 of 3 passed after, on OpenClaw 2026.10.3; follow-up to [#75](https://github.com/xtimor/openclaw-all-cli/issues/75)).

## 0.1.11 - 2026-11-20

### Fixed

- **Test connection** on the `cursor-cli` card in the Control UI (and `openclaw models status --probe`) now runs one short, text-only Cursor request through `cursor-agent acp` instead of failing as "Timed out": it shows `ok`, or names the real cause, such as a refused or missing API key or a missing `cursor-agent`. It needs an API key (the CLI's own login is not used) and costs one small Cursor request per click. OpenClaw's skill review and the session companion's "ask" use the same path (not checked live). The request runs in read-only mode without tools, in a throwaway Cursor home that is removed afterwards, never reads or writes `~/.config/cursor/auth.json`, and stops after 120 s or when the plugin unloads.
- A stale Cursor plan quota now says that the plan quota API did not answer, instead of naming the Cursor CLI.
- The Control UI's context-usage tile no longer moves down after a turn that made fewer model requests than the one before it: the plugin now withholds a turn's reading when it is lower than the highest one already shown for the warm process, instead of only when a turn's own reading is implausibly large ([#97](https://github.com/xtimor/openclaw-all-cli/issues/97)). The remembered high resets on a process restart, so the guarantee holds per warm process, not for the whole chat.
- The `cursor-cli` provider no longer shows as authenticated for a wrong, expired, or revoked `CURSOR_API_KEY`, or for a degraded `cursor-agent status` line that admits it could not confirm the login ([#98](https://github.com/xtimor/openclaw-all-cli/issues/98)): a present key is now checked with `cursor-agent about`, with the result cached briefly and re-checked after a turn finds the server rejects it.
- A transient Cursor backend throttle no longer reads as a spent plan quota: it now says "hit a temporary rate limit (resource exhausted)" instead of "rate limit reached (usage limit)", and OpenClaw's own retry handling can treat it as the transient condition it is instead of a long-term limit. A genuine plan exhaustion ("upgrade your plan to continue") still reads as a usage limit, unchanged ([#99](https://github.com/xtimor/openclaw-all-cli/issues/99)).

## 0.1.10 - 2026-11-18

### Fixed

- The `cursor-cli` provider no longer shows the Cursor plan quota when `cursor-agent` is not on the Gateway's host, even if a Cursor key is still saved somewhere (for example after removing `cursor-agent` and reinstalling the plugin).
- OpenClaw 2026.11 no longer warns "Uses OpenClaw APIs that retire on Oct 1, 2026" for this plugin: it reads the saved Cursor key through OpenClaw's current SDK module, so the key keeps working once OpenClaw removes the old one.

## 0.1.9 - 2026-11-16

### Added

- Connecting the `cursor-cli` provider on a Linux (glibc) or macOS host without `cursor-agent` now offers to install the version pinned in the plugin (sha256-checked, from `downloads.cursor.com`, into `<state dir>/tools/cursor-agent/`) after you say yes; the API key method checks the key with `cursor-agent about` before saving it, and a new remove method offers to remove the saved key and the installed CLI.

### Changed

- The plugin is now on ClawHub, the OpenClaw plugin catalog: install it with `openclaw plugins install clawhub:openclaw-all-cli --accept-capabilities` (no `--force` needed); npm stays available. The README and setup guide lead with ClawHub and explain the security audit OpenClaw shows before the install and how to move an npm install over.
- The Cursor CLI API key method now saves the key in OpenClaw's auth store as the profile `cursor-cli:default` instead of the plugin config, so the Control UI dialog ends without `did not return a credential profile` and the provider card lists the key. The plugin hands the profile's key to the `cursor-agent` process only (not to `exec`), and to the model list and the usage and quota reads; it wins over a key in the plugin config, which the method removes when it saves the main agent's profile (for another agent the config key stays for the others); the method's note names `cursor-agent logout` for a copy an older version left in `~/.config/cursor/auth.json`. The Control UI lists only this method; `login` and `remove` stay terminal methods (`openclaw models auth login --provider cursor-cli --method login|remove`). OpenClaw's **Remove key** now removes the key, and when the plugin installed `cursor-agent` for it, the plugin removes that install at the next Gateway start that loads it (after Remove key OpenClaw refuses the Gateway's next `cursor-cli` chat turn itself) or a keyless turn that reaches it, unless a key is left for any agent, a turn started meanwhile, the auth store cannot be read, or `cursor-agent` has its own login; a turn never waits for that removal. `cursor-agent` runs that get a key from the plugin now cache it in the agent's Cursor home (`key-cache/`), not in `~/.config/cursor/auth.json`, and the plugin deletes that cache once the key is gone, so a removed key stops working. The quota reads the key through OpenClaw first, within its 5 s budget. A login alone still shows "Not configured" on the card (openclaw/openclaw#184700).

## 0.1.7 - 2026-11-10

### Added

- OpenClaw's usage surfaces can now show your Cursor plan quota (plan name, used share of the total, Auto + Composer, and API models, reset date, and spend this cycle) when `CURSOR_API_KEY` is set in the Gateway's environment; it is cached for 60 s, shows the last reading marked stale when Cursor does not answer, and never runs from a chat turn. ([#82](https://github.com/xtimor/openclaw-all-cli/issues/82))

### Fixed

- Docs: the update steps no longer say a running Gateway is refreshed by `openclaw plugins update`, which current OpenClaw refuses. With the Gateway running, reinstall with `--force`; or stop the Gateway, run `plugins update`, and start it again. OpenClaw 2026.10.3 still accepts `plugins update` with the Gateway running. ([#80](https://github.com/xtimor/openclaw-all-cli/issues/80))

## 0.1.6 - 2026-11-09

### Fixed

- When OpenClaw serves `structured_output` for a Cursor turn (a run with an output schema), the first prompt now tells the model to give its final answer through that tool, so GPT models no longer end such runs with `structured_output was not called`. A model may still skip it: there is no re-prompt. ([#75](https://github.com/xtimor/openclaw-all-cli/issues/75))
- When OpenClaw serves `exec` for a Cursor turn, the first prompt now tells the model that Cursor's own shell is disabled and commands run through `exec` (long ones in the background, polled with `process`), so weaker models no longer lose a turn on a refused shell call. The docs no longer say OpenClaw answers a denied shell call. ([#76](https://github.com/xtimor/openclaw-all-cli/issues/76))
- A Cursor process now closes when its conversation ends (`/new`, a reset, a deletion, an idle or daily rollover), not up to 15 minutes later, so ended chats no longer pile up processes and memory. ([#74](https://github.com/xtimor/openclaw-all-cli/issues/74))

## 0.1.5 - 2026-11-05

### Added

- The plugin icon now shows next to the OAC / Cursor-CLI choices on the model setup page of the Control UI, not a letter avatar. The chat picker, provider cards, and Connect dialog still show a letter avatar until OpenClaw changes. ([#45](https://github.com/xtimor/openclaw-all-cli/issues/45))
- Every Cursor turn writes one line to OpenClaw's debug log (`OPENCLAW_LOG_LEVEL=debug`, search `turn timings`) with how long the process start, the chat start or resume, the model switch, the wait for the first thought, the first text, and the end took, so a slow first reply can be traced to the step that causes it. The docs name the fields and give a live split for `grok-4.7` and `auto`. ([#44](https://github.com/xtimor/openclaw-all-cli/issues/44))

### Changed

- `cursor-cli` no longer refuses a run whose native tool selection is empty (`tools.fs.workspaceOnly: true`, a tool cap, tools disabled, a system agent). It starts Cursor in a second, static `restricted` permission profile that closes Cursor's native `read`, `grep`, and `glob` with one `Read(*)` deny, so the model uses OpenClaw's file tools through the proxy. Chats resume under either profile. A partial selection is still refused. ([#67](https://github.com/xtimor/openclaw-all-cli/issues/67))
- Docs: the Control UI provider card for `cursor-cli` was measured on OpenClaw 2026.10.10: it reads "Not configured" and offers **Connect provider** with a login or a key, with a key in the Gateway environment, and with no credential, so it does not show whether the login works; use the model list or a turn. The earlier note that a key in the Gateway environment turns the line into "API key from environment" is corrected. See [Cursor provider card on OpenClaw latest](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor-card-latest.md). ([#69](https://github.com/xtimor/openclaw-all-cli/issues/69))
- Docs: `tools.fs.workspaceOnly: true` cannot be honoured by `cursor-cli`, because Cursor's native `read`, `grep`, and `glob` are on in every turn: it is unenforced on OpenClaw 2026.10.3 and earlier, and the run is refused at preflight on 2026.10.9 and later (the fallback model, if any, answers). The [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md#workspace-only-file-access-toolsfsworkspaceonly) docs say what to do instead. ([#65](https://github.com/xtimor/openclaw-all-cli/issues/65))
- Issues: the maintainer can send an agent's result back with comments through the new `status:rework` (add the label after commenting; it counts only as the maintainer's own click). The approval still holds, so there is no new triage and no new approval: the next implementation run works from the maintainer's comments after its last result and answers with a fix, a corrected upstream draft (`status:awaiting-post`), or a question (`status:blocked`). See [Issues](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/issues.md).
- Issues: the label for a newly filed issue is now `status:todo` (it was `status:new`): the same status also holds a reopened issue and an author's answer, and `todo` says what it waits for, triage. The issue forms set it, and the existing label is renamed in place on GitHub, so open and closed issues and their history keep it.
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
