# Setup

How to run `cursor-cli/<model>` in your OpenClaw.

> **Status:** walking skeleton. The plugin registers `cursor-cli`, treats a Cursor login as auth, and answers a prompt over `cursor-agent acp`. With OpenClaw 2026.10.3 every turn restarts the process and resumes the chat with `session/load`, so there is no warm process between turns. OpenClaw's tools reach Cursor through a local MCP proxy. Text, thinking, and tool calls stream to OpenClaw as they happen. `/model` lists your account's Cursor models; see [Cursor provider](providers/cursor.md) for what works now.

## Requirements

| Component | Version | Check |
| --- | --- | --- |
| OpenClaw | 2026.10.3 or later | `openclaw --version` |
| Node.js (for OpenClaw and the build) | 24.16 up to 25, or 26.1 and later | `node --version` |
| Cursor CLI (`cursor-agent`) | 2026.07.06 or later | `cursor-agent --version` |
| Cursor plan | Headless CLI allowed (admins can disable it) | `cursor-agent status` |

The plugin runs `cursor-agent --version` before its first process and fails a turn on a build older than 2026.07.06 (`unsupported_version`). Older OpenClaw builds treat CLI backends as text-only, with no tools and no streaming. Older `cursor-agent` builds can corrupt `cli-config.json` when several agents run at once.

## 1. Sign in to Cursor

```sh
cursor-agent login
cursor-agent status
```

`status` must say you are logged in. On macOS the login is stored in the Keychain and is shared by every agent. A `CURSOR_API_KEY` also counts as a login (see [The API key](#the-api-key) for where to put it), and it is what lets the plugin record each turn's token usage (see [Usage](providers/cursor.md#usage)); with a login only, usage shows 0. Behind an HTTP proxy, start the Gateway with `NODE_USE_ENV_PROXY=1` so the usage calls to `api2.cursor.sh` use it.

Each agent runs Cursor with its own config and chat store under `<agentDir>/openclaw-all-cli/cursor-cli/`, which the plugin creates. The plugin does not copy or change the login. Where Cursor keeps the login in its config directory instead of the Keychain, the per-agent home may not see it (not yet checked on a host without a Keychain); give the plugin a key as described under [The API key](#the-api-key).

### The API key

With OpenClaw's `exec` enabled, any command the model runs inherits the Gateway's environment and can read every variable in it, a `CURSOR_API_KEY` exported to the Gateway included. The plugin does not strip it. In order of preference:

1. **Use the login** (`cursor-agent login`). Its credentials live in the Cursor home (the Keychain on macOS), not in the environment. Usage then shows 0 (see [Usage](providers/cursor.md#usage)).
2. **Give the key to the Cursor process only**, through the plugin config. `cursor-cli.env` is passed to `cursor-agent` and to the plugin's own probes, and not put into the Gateway's environment or the environment `exec` starts commands with. That keeps the key out of `env` output, not out of reach: `exec` runs as the same user (unsandboxed by default), so a command can still read the key from `/proc/<pid>/environ` of the `cursor-agent` process or from the OpenClaw config file that holds it:

   ```sh
   openclaw config set plugins.entries.openclaw-all-cli.config.cursor-cli.env '{"CURSOR_API_KEY":"<key>"}' --strict-json
   ```

   Do not also export the key to the Gateway. The config file holds the key, so protect it like any secret. For anything you do not trust, prefer the login, keep exec approvals on (`tools.exec.ask`), and run the agent in a sandbox.
3. If you export the key to the Gateway anyway, keep exec approvals on (`tools.exec.ask`) and approve commands only from prompts you trust.

**Optional: Cursor API key profile.** Create a user API key in the Cursor Dashboard and save it as an OpenClaw `api_key` profile for `cursor-cli`:

```sh
printf '%s\n' "$KEY" | openclaw models auth paste-api-key --provider cursor-cli
```

It prints `Auth profile: cursor-cli:manual (cursor-cli/api_key)`; remove it with `openclaw models auth logout cursor-cli:manual --yes`. The profile only lets OpenClaw build a history prompt from a `cursor-cli` chat's own turns, for a fresh Cursor chat after the chat was lost (OpenClaw 2026.10.3 did not complete that retry in the live probe). The key is not handed to `cursor-agent`: use the same key as `CURSOR_API_KEY` for the Cursor process (see [The API key](#the-api-key)), or an account that is logged in. It does not carry history across a switch from an API model; the plugin's note and `sessions_history` do (see [Cursor provider](providers/cursor.md#chat-continuity-across-a-model-switch)). Whether a key is billed differently from the login is not settled yet.

## 2. Install the plugin

OpenClaw installs a plugin from built JavaScript, so build and pack it first:

```sh
git clone <repo-url> openclaw-all-cli
cd openclaw-all-cli
npm install
npm run dev:setup        # once: the build resolves OpenClaw's types from the toolchain in .spike/
npm run package          # builds dist/ and writes openclaw-all-cli-<version>.tgz
openclaw plugins install ./openclaw-all-cli-$(node -p "require('./package.json').version").tgz --accept-capabilities
```

After `git pull`, run `npm run package` again and reinstall with `openclaw plugins install ./openclaw-all-cli-$(node -p "require('./package.json').version").tgz --accept-capabilities`: the plugin runs from `dist/`, which is not rebuilt for you.

OpenClaw warns that the source is outside ClawHub review and asks you to confirm; pass `--force` to confirm without a prompt. Do not install the checkout directory with `--link`: OpenClaw scans the whole directory, and a checkout that also holds a development toolchain fails to load.

The plugin loads the first time a turn selects `cursor-cli/<model>`. It also loads at Gateway start when your config names a `cursor-cli/...` model; the account's models appear in `/model` only once it is loaded, so name one (for example as the default model).

## 3. Configure

All settings are optional. They live under `plugins.entries.openclaw-all-cli.config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `cursor-cli.command` | `cursor-agent` | Path or name of the Cursor CLI. Set it when the Gateway's `PATH` does not include `cursor-agent`. |
| `cursor-cli.env` | none | Variables for the `cursor-agent` process only, such as `CURSOR_API_KEY`. Kept out of the environment `exec` starts commands with, but not out of its reach (same user, see [The API key](#the-api-key)). |
| `cursor-cli.maxConcurrentTurns` | `4` | Turns that run at once (1 to 64). More wait in order for a free slot. |
| `cursor-cli.maxProcesses` | `8` | `cursor-agent` processes alive at once, idle ones included (1 to 64, at least `maxConcurrentTurns`). At the cap the least recently used idle process is closed. |

A value outside 1 to 64 (or not an integer) is rejected by OpenClaw's config validation before the plugin loads, so fix it in the config. A `maxProcesses` below `maxConcurrentTurns` passes that check: the plugin ignores both caps with a warning, keeps your other settings such as `command`, and uses the defaults. Keep both under OpenClaw's own limit of 16 live sessions.

Isolation needs no setting: every agent gets its own Cursor home with the same fixed permissions (see [Cursor provider](providers/cursor.md)). Transport and API-key settings are documented here once they exist.

Shell commands: the model's shell is OpenClaw's own `exec` tool (and `process`), so what it may run follows OpenClaw's `tools.exec.*` settings (`security`, `ask`, `timeoutSec`), its exec approvals, its sandbox, and `tools.deny`. Cursor's native shell stays denied. A command that needs approval waits for an approval client (the Control UI, an app, or a chat channel); a headless `openclaw agent` run is denied at once. A foreground command is stopped after 55 seconds (Cursor gives up at 60); long commands must run in the background and be polled with `process`, so keep `process` available. See [Shell commands](providers/cursor.md#shell-commands-openclaw-exec).

## 4. Verify

```sh
openclaw plugins inspect openclaw-all-cli --runtime --json
openclaw models list --provider cursor-cli
openclaw agent --model cursor-cli/auto --message "Say hi"
```

The first command must report `"status": "loaded"` and `cursor-cli` under `cliBackendIds`. The second lists your account's Cursor models and needs a running Gateway that has loaded the plugin. The third runs through your Gateway and prints Cursor's reply. In the isolated OpenClaw (see Develop) no Gateway runs by default: run the command with `--local`, or start one with `npm run dev:openclaw -- gateway --allow-unconfigured` and drop `--local`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `CLI backend executable could not be resolved: cursor-agent` | The Gateway cannot find `cursor-agent` | Put it on the Gateway's `PATH`, or set `cursor-cli.command` |
| `cursor-cli/<model>` is `[indeterminate]` in `openclaw models status`, or `Auth: no` in `openclaw models list` | OpenClaw sees no Cursor login | Run `cursor-agent login`, then check `cursor-agent status` |
| `OpenClaw gave no agent directory` | The host passed no `agentDir` for the turn | Report it with your OpenClaw version; the plugin will not share a home between agents |
| `Could not prepare the CLI home` | The plugin cannot write `cli-config.json` under the agent directory | Fix the directory's permissions or free disk space |
| `The CLI offers no "ask" mode` | A side question needs the `cursor-agent` read-only mode and this build has none | Run `cursor-agent update` |
| `cursor-cli keeps native read, grep, glob on in every turn...` | A run asked for a tool selection without Cursor's always-on native tools (a tool cap, tools disabled, a system agent) | Run that turn on another model; see [Cursor provider](providers/cursor.md) |
| The model says it has no shell, or `exec` is missing | `tools.deny` hides `exec`, the run is capped or rooted, or the agent's exec host is `node` | Remove `exec` from `tools.deny`; run the turn without a cap; use exec host `gateway` or `sandbox` |
| The model reports that a tool call ran longer than 55 seconds and was stopped (or `MCP error -32001: Request timed out`) | Cursor gives up on a tool call after 60 seconds; the plugin stops a call at 55 | Ask for the command to run in the background and read it with `process`; do not hide `process` with `tools.deny` |
| `The CLI offers no "agent" mode, so it cannot run safely.` | A turn with host `exec` needs the `cursor-agent` agent mode and this build has none | Run `cursor-agent update` |
| `Cursor has no model "<name>" for this account` | The account does not have that model | Pick one from `openclaw models list --provider cursor-cli`, or check the plan |
| Only `cursor-cli/auto` is listed | **No login:** the plugin lists nothing and logs nothing; after `cursor-agent login` (or setting `CURSOR_API_KEY`) the next read lists at once. **Failed listing:** the Gateway log says `Could not list the Cursor CLI models` and why; the failure is remembered for 30 seconds, and `openclaw models list --provider cursor-cli --refresh` waits it out | Fix the login or `cursor-agent`, then run the refresh (after 30 seconds when a listing failed) |
| No `cursor-cli` models in the Gateway's list | The plugin is not loaded yet | Name a `cursor-cli/...` model as the default model so it loads at Gateway start |
| `cursor-agent <version> is too old: this plugin needs 2026.07.06 or newer` (`unsupported_version`) | The installed `cursor-agent` is older than the minimum | Run `cursor-agent update` |
| `All N CLI processes are busy` (`overloaded`) | The process cap is full of running turns (only possible when something broke the usual limits) | Retry; raise `maxProcesses`; report it if it repeats |
| `The plugin is shutting down` | The Gateway is stopping or the plugin is reloading | Retry once the Gateway is back |
| A log line `Stopped CLI process <pid>, which a previous Gateway left running` | A Gateway was killed and left `cursor-agent` running; the plugin cleaned it up | Nothing. Stop the Gateway with SIGTERM next time to avoid it |
| `` `ps` is not available `` | The host has no `ps`, so processes are not recorded and a killed Gateway's leftovers are not cleaned | Install `ps` (procps); check for stray `cursor-agent` processes by hand |
| `The CLI speaks ACP protocol N` | `cursor-agent` speaks a protocol this plugin does not | Run `cursor-agent update`, or update the plugin |
| `The CLI rejected its login` | `cursor-agent` refused the ACP login | Run `cursor-agent login` and check `cursor-agent status` |
| Usage shows 0 for `cursor-cli` turns | No `CURSOR_API_KEY` for the Cursor process (login only; see [The API key](#the-api-key)), or the usage ledger failed. The Gateway log then holds `Cursor usage: the API key was rejected (...)`, `Cursor usage: unexpected ledger answer (...)`, or `Cursor usage unavailable for 3 turns in a row (last: ...)`, each followed by "usage is off for 10 min"; a network error behind a proxy has no warning until the third turn | Set a valid `CURSOR_API_KEY`; behind an HTTP proxy start the Gateway with `NODE_USE_ENV_PROXY=1`; see [Usage](providers/cursor.md#usage) |
| After a switch the model does not know the earlier turns | OpenClaw does not copy history from another model into `cursor-cli`; the model reads it with `sessions_history`. That tool is denied (`tools.deny`), or the chat runs with `--local`, which has no Gateway for it | Remove `sessions_history` from `tools.deny`; run the chat through a Gateway |
| `CLI session not found` (`session_expired`) | Cursor does not know the chat: it belongs to another agent's home or was deleted. OpenClaw may retry with a fresh chat and its own history only when it has history to reseed (2026.10.3 did not in the live probe) | Start a new chat with `/reset` |
| `Capability mismatch: Cursor CLI does not report <what> (parity row Pn), which the plugin's manifest needs` (`capability_mismatch`) | This `cursor-agent` build lacks a capability the plugin needs: session resume (P5) or HTTP MCP servers (P7). The turn failed right after the handshake: no chat was created or loaded and no prompt was sent. Resumed chats get the same text | Run `cursor-agent update`; if it repeats, report it with `cursor-agent --version` |
| `The CLI offered no "cursor_login" login method` | `cursor-agent` no longer lists the login method the plugin uses | Run `cursor-agent update`; report it with `cursor-agent --version` |
| `Another turn of this chat is still running in a CLI process` | Two turns reached one chat at the same time | Retry once the first turn is done |
| `The CLI does not list models` | The `cursor-agent` build reports no model list | Use `cursor-cli/auto`, or run `cursor-agent update` |
| `A turn is already running in this session` | Two turns reached one Cursor process | Wait for the first turn; if it repeats, report it in the repository issue tracker |
| `The CLI refused the request` | Cursor declined the prompt | Rephrase the prompt, or check the plan's content rules |
| `The working directory "<dir>" does not exist` | The agent's workspace was removed | Recreate the directory or change the agent's workspace |
| A turn hangs with no output | Known `cursor-agent` transport stalls | Update `cursor-agent`; the OpenClaw watchdog ends the turn |
| `package install requires compiled runtime output` | The plugin was installed without a build | Run `npm run package` and install the `.tgz` |

## Develop

An isolated OpenClaw lives under `.spike/` (gitignored) and never touches `~/.openclaw`:

```sh
npm run dev:setup      # installs Node 24 and OpenClaw 2026.10.3 into .spike/ when missing
npm run dev:install    # builds, packs, and installs this plugin into the isolated OpenClaw
npm run dev:openclaw -- agent --local --model cursor-cli/auto --message "Say hi"
npm test               # unit tests, import-boundary test
npm run typecheck
npm run test:live      # real cursor-agent; needs a Cursor login and no sandbox
```
