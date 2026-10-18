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

The plugin records the minimum `cursor-agent` version (2026.07.06) but does not enforce it yet. Older OpenClaw builds treat CLI backends as text-only, with no tools and no streaming. Older `cursor-agent` builds can corrupt `cli-config.json` when several agents run at once.

## 1. Sign in to Cursor

```sh
cursor-agent login
cursor-agent status
```

`status` must say you are logged in. On macOS the login is stored in the Keychain and is shared by every agent. A `CURSOR_API_KEY` in the Gateway's environment also counts as a login.

Each agent runs Cursor with its own config and chat store under `<agentDir>/openclaw-all-cli/cursor-cli/`, which the plugin creates. The plugin does not copy or change the login. Where Cursor keeps the login in its config directory instead of the Keychain, the per-agent home may not see it (not yet checked on a host without a Keychain); set `CURSOR_API_KEY` for the Gateway there.

**Optional: Cursor API key.** Create a user API key in the Cursor Dashboard. Add it as an OpenClaw `api_key` auth profile if you want OpenClaw to replay chat history into a fresh Cursor session.

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

Isolation needs no setting: every agent gets its own Cursor home with the same fixed permissions (see [Cursor provider](providers/cursor.md)). Transport and API-key settings are documented here once they exist.

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
| `The CLI offers no "ask" mode` | The `cursor-agent` build has no read-only mode | Run `cursor-agent update` |
| `cursor-cli keeps native read, grep, glob on in every turn...` | A run asked for a tool selection without Cursor's always-on native tools (a tool cap, tools disabled, a system agent) | Run that turn on another model; see [Cursor provider](providers/cursor.md) |
| `Cursor has no model "<name>" for this account` | The account does not have that model | Pick one from `openclaw models list --provider cursor-cli`, or check the plan |
| Only `cursor-cli/auto` is listed | **No login:** the plugin lists nothing and logs nothing; after `cursor-agent login` (or setting `CURSOR_API_KEY`) the next read lists at once. **Failed listing:** the Gateway log says `Could not list the Cursor CLI models` and why; the failure is remembered for 30 seconds, and `openclaw models list --provider cursor-cli --refresh` waits it out | Fix the login or `cursor-agent`, then run the refresh (after 30 seconds when a listing failed) |
| No `cursor-cli` models in the Gateway's list | The plugin is not loaded yet | Name a `cursor-cli/...` model as the default model so it loads at Gateway start |
| `The CLI speaks ACP protocol N` | `cursor-agent` speaks a protocol this plugin does not | Run `cursor-agent update`, or update the plugin |
| `The CLI rejected its login` | `cursor-agent` refused the ACP login | Run `cursor-agent login` and check `cursor-agent status` |
| `CLI session not found` (`session_expired`) | Cursor does not know the chat: it belongs to another agent's home or was deleted. OpenClaw retries with a fresh chat and its own history only when it has history to reseed | Start a new chat with `/reset` |
| `The CLI cannot load a session` | This `cursor-agent` build cannot resume chats | Run `cursor-agent update` |
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
