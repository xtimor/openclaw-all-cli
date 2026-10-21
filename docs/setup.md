# Setup

How to run `cursor-cli/<model>` in your OpenClaw.

> **Status:** pre-release. There is no published package yet: you build the plugin from source and install the resulting `.tgz`. Only Cursor CLI is supported; see [Cursor provider](providers/cursor.md) for what works.

## Requirements

| Component | Version | Check |
| --- | --- | --- |
| Node.js (for OpenClaw and the build) | 24.16 up to 25, or 26.1 and later | `node --version` |
| OpenClaw | 2026.10.3 or later | `openclaw --version` |
| Cursor CLI (`cursor-agent`) | 2026.07.06 or later | `cursor-agent --version` |
| Cursor plan | Headless CLI allowed (admins can disable it) | see [step 1](#1-sign-in-to-cursor) |

Tested with OpenClaw 2026.10.3 and `cursor-agent` 2026.10.16 (developed against) and 2026.10.19 (proven on a clean install).

The plugin runs `cursor-agent --version` before its first process and fails a turn on a build older than 2026.07.06 (`unsupported_version`). Older OpenClaw builds treat CLI backends as text-only, with no tools and no streaming. Older `cursor-agent` builds can corrupt `cli-config.json` when several agents run at once.

### Install the requirements

Skip what `node --version`, `openclaw --version`, and `cursor-agent --version` already show in range.

1. **Node.js 24.16+.** OpenClaw refuses Node 25 and anything below 24.16 (it prints `Running on an unsupported Node`; `npm install -g` warns `EBADENGINE`). Install a current 24.x from [nodejs.org](https://nodejs.org/en/download), or with [nvm](https://github.com/nvm-sh/nvm): `nvm install 24`. Use a Node whose global npm prefix you can write (nvm does), so `npm install -g` needs no `sudo`.

   Without nvm or a browser, unpack the official tarball into your home (use `arm64` instead of `x64` on ARM; any 24.x from 24.16 on works):

   ```sh
   curl -fsSL https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz | tar -xJ -C "$HOME"
   export PATH="$HOME/node-v24.22.0-linux-x64/bin:$PATH"      # add this line to your shell profile
   node --version
   ```

   The global npm prefix is then that directory, so `npm install -g` needs no `sudo`.
2. **OpenClaw**, from npm. Pin the version this plugin was built against:

   ```sh
   npm install -g openclaw@2026.10.3
   openclaw --version
   ```

   The build in [step 2](#2-install-the-plugin) takes OpenClaw's types from this global install, so install OpenClaw with npm. Make sure the `bin` directory of `npm prefix -g` is on your `PATH`.
3. **Cursor CLI.**

   ```sh
   curl https://cursor.com/install -fsS | bash      # behind a proxy it can fail once with SSL_ERROR_SYSCALL: run it again
   export PATH="$HOME/.local/bin:$PATH"     # the installer puts cursor-agent in ~/.local/bin
   cursor-agent --version
   ```

   Add that `PATH` line to your shell profile. The Gateway needs `cursor-agent` on its own `PATH`, or `cursor-cli.command` set (see [Configure](#3-configure)).

Behind a firewall or HTTP proxy, allow `cursor.com` and `*.cursor.sh` (the CLI, the model list, and the usage ledger at `api2.cursor.sh`). Node's `fetch` ignores `HTTPS_PROXY` unless the Gateway starts with `NODE_USE_ENV_PROXY=1`. A proxy that denies `telemetry.openclaw.ai:443` is harmless.

## 1. Sign in to Cursor

Pick one:

- **Login**, on a machine with a browser: `cursor-agent login`, then `cursor-agent status` must say you are logged in. On macOS the login is stored in the Keychain. On Linux it is `~/.config/cursor/auth.json`. Either is shared by every agent: the per-agent Cursor home (below) sees it (checked on Linux with a per-agent `CURSOR_CONFIG_DIR`). The plugin does not copy or change it.
- **API key**, on a headless host (`cursor-agent login` needs a browser): create a user API key in the Cursor Dashboard and give it to the Cursor process as described under [The API key](#the-api-key). A key also counts as a login, and it is what lets the plugin record each turn's token usage (see [Usage](providers/cursor.md#usage)); with a login only, usage shows 0.

Check a key without exporting it. `cursor-agent status` ignores keys, so use `about`:

```sh
read -rs CURSOR_KEY                     # paste the key; nothing is echoed or kept in history
CURSOR_API_KEY="$CURSOR_KEY" cursor-agent about | grep 'User Email'
```

It must show your email. A wrong key prints `The provided API key is invalid`. If it prints `Not logged in` with a key set, run it once more (the first run right after installing `cursor-agent` can fail), and check the variable is non-empty without printing it: `[ -n "$CURSOR_KEY" ] && echo set`.

**Cursor stores credentials on disk.** The login (access and refresh tokens) and, whenever `cursor-agent` runs with `CURSOR_API_KEY` (this check, or any turn), the key too, live in `~/.config/cursor/auth.json` on Linux (mode 0600; the Keychain on macOS). That is Cursor's behavior, independent of the plugin and of `CURSOR_CONFIG_DIR`. A command the model runs through `exec` as your user can read that file; see [The API key](#the-api-key). To remove every copy of a key, in this order: `openclaw config unset plugins.entries.openclaw-all-cli.config.cursor-cli.env`, delete OpenClaw's rotated config copies next to `openclaw.json` (`openclaw.json.bak`, `openclaw.json.bak.1` to `.bak.4`, `openclaw.json.last-good`), then `cursor-agent logout` (it also removes a browser login). Unset the config first: while it holds the key, the plugin's probes write `auth.json` again. Rotating the key at Cursor is the real remedy, since a copy may already have been read.

Each agent runs Cursor with its own config and chat store under `<agentDir>/openclaw-all-cli/cursor-cli/`, which the plugin creates.

### The API key

With OpenClaw's `exec` enabled, any command the model runs inherits the Gateway's environment and can read every variable in it, a `CURSOR_API_KEY` exported to the Gateway included. The plugin does not strip it. In order of preference:

1. **Use the login** (`cursor-agent login`). It keeps the credential out of the Gateway's environment and out of the OpenClaw config file, but not out of reach of `exec`: the tokens sit in `~/.config/cursor/auth.json`, readable by a same-user command just like a key. Usage then shows 0 (see [Usage](providers/cursor.md#usage)).
2. **Give the key to the Cursor process only**, through the plugin config. `cursor-cli.env` is passed to `cursor-agent` and to the plugin's own probes and usage reads, and not put into the Gateway's environment or the environment `exec` starts commands with. That keeps the key out of `env` output only, not out of reach (the login has the same limit): `exec` runs as the same user (unsandboxed by default), so a command can still read the key from `/proc/<pid>/environ` of the `cursor-agent` process, from the OpenClaw config file that holds it, and from `~/.config/cursor/auth.json`, where `cursor-agent` itself writes the key and its tokens whenever it runs with a key. Against `exec`, exec approvals (`tools.exec.ask`) and a sandbox are the protection, for the login and the key alike. Set it from the shell variable of the check above, so the key text is never typed into a command:

   ```sh
   openclaw config set plugins.entries.openclaw-all-cli.config.cursor-cli.env \
     "$(printf '{"CURSOR_API_KEY":"%s"}' "$CURSOR_KEY")" --strict-json
   unset CURSOR_KEY
   ```

   The key is visible in the process list for the moment the command runs. Do not also export it to the Gateway. The config file and its rotated copies hold the key, so protect them like any secret. For anything you do not trust, keep exec approvals on (`tools.exec.ask`) and run the agent in a sandbox, whichever option you use.
3. If you export the key to the Gateway anyway, keep exec approvals on (`tools.exec.ask`) and approve commands only from prompts you trust.

**Optional: Cursor API key profile.** Save the same kind of key as an OpenClaw `api_key` profile for `cursor-cli`:

```sh
printf '%s\n' "$CURSOR_KEY" | openclaw models auth paste-api-key --provider cursor-cli
```

It prints `Auth profile: cursor-cli:manual (cursor-cli/api_key)`; remove it with `openclaw models auth logout cursor-cli:manual --yes`. The profile only lets OpenClaw build a history prompt from a `cursor-cli` chat's own turns, for a fresh Cursor chat after the chat was lost (OpenClaw 2026.10.3 did not complete that retry in the live probe). The key is not handed to `cursor-agent`: give the Cursor process the key as above, or use an account that is logged in. It does not carry history across a switch from an API model; the plugin's note and `sessions_history` do (see [Cursor provider](providers/cursor.md#chat-continuity-across-a-model-switch)). Whether a key is billed differently from the login is not settled yet.

## 2. Install the plugin

OpenClaw installs a plugin from built JavaScript, so build and pack it first. The build needs only Node, npm, and the global OpenClaw from above:

```sh
git clone https://github.com/xtimor/openclaw-all-cli.git
cd openclaw-all-cli
npm install
npm link openclaw        # after npm install: it points the build at the global OpenClaw's types
npm run package          # builds dist/ and writes openclaw-all-cli-<version>.tgz
openclaw plugins install ./openclaw-all-cli-$(node -p "require('./package.json').version").tgz --accept-capabilities
```

Run `npm link openclaw` after every `npm install`, which removes the link. Without it the build fails with `Cannot find module 'openclaw/plugin-sdk/...'`.

OpenClaw warns that the source is outside ClawHub review and asks you to confirm; pass `--force` to confirm without a prompt. `--force` also replaces an earlier install. After `git pull`, run `npm run package` again and reinstall the same way: the plugin runs from `dist/`, which is not rebuilt for you. Do not install the checkout directory with `--link`: OpenClaw scans the whole directory, and a checkout that also holds a development toolchain fails to load. The command prints `Saved for the next Gateway start`: restart a running Gateway to load the new build.

The plugin loads the first time a turn selects `cursor-cli/<model>`. It also loads at Gateway start when your config names a `cursor-cli/...` model; the account's models appear in `/model` only once it is loaded, so name one as the default model (see [Start the Gateway](#4-start-the-gateway)).

## 3. Configure

All settings are optional. They live under `plugins.entries.openclaw-all-cli.config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `cursor-cli.command` | `cursor-agent` | Path or name of the Cursor CLI. Set it when the Gateway's `PATH` does not include `cursor-agent`. |
| `cursor-cli.env` | none | Variables for the `cursor-agent` process only, such as `CURSOR_API_KEY`. Kept out of the environment `exec` starts commands with only; not out of its reach (same user, and Cursor writes the key to `~/.config/cursor/auth.json`; see [The API key](#the-api-key)). |
| `cursor-cli.maxConcurrentTurns` | `4` | Turns that run at once (1 to 64). More wait in order for a free slot. |
| `cursor-cli.maxProcesses` | `8` | `cursor-agent` processes alive at once, idle ones included (1 to 64, at least `maxConcurrentTurns`). At the cap the least recently used idle process is closed. |

A value outside 1 to 64 (or not an integer) is rejected by OpenClaw's config validation before the plugin loads, so fix it in the config. A `maxProcesses` below `maxConcurrentTurns` passes that check: the plugin ignores both caps with a warning, keeps your other settings such as `command`, and uses the defaults. Keep both under OpenClaw's own limit of 16 live sessions.

Compaction: Cursor's ACP mode has no compaction, so OpenClaw compacts its own transcript for `cursor-cli` agents (`/compact`, and before a turn when a chat grows past its budget). That needs an API model to write the summary. Set one, for example `openclaw config set agents.defaults.compaction.model <provider>/<model>`. Without it OpenClaw uses the agent's own model, which needs an API login; whether a Cursor API-key profile counts as one is unverified. If no usable model exists, `/compact` reports the host's reason (for example `No route-compatible authentication source is configured`); that a turn crossing the budget then fails is expected but untested. See [Compaction](providers/cursor.md#compaction).

Isolation needs no setting: every agent gets its own Cursor home with the same fixed permissions (see [Cursor provider](providers/cursor.md)). The plugin has no other settings.

Shell commands: the model's shell is OpenClaw's own `exec` tool (and `process`), so what it may run follows OpenClaw's `tools.exec.*` settings (`security`, `ask`, `timeoutSec`), its exec approvals, its sandbox, and `tools.deny`. Cursor's native shell stays denied. A command that needs approval waits for an approval client (the Control UI, an app, or a chat channel); a headless `openclaw agent` run is denied at once. A foreground command is stopped after 55 seconds (Cursor gives up at 60); long commands must run in the background and be polled with `process`, so keep `process` available. See [Shell commands](providers/cursor.md#shell-commands-openclaw-exec).

## 4. Start the Gateway

`openclaw agent` and `/model` talk to a Gateway. The default one listens on port 18789; if it is taken, pass `--port <n>` here and set `OPENCLAW_GATEWAY_PORT=<n>` for the other commands.

**You have no Gateway yet** (a fresh OpenClaw has no config, and the Gateway refuses to start without `gateway.mode`):

```sh
openclaw config set gateway.mode local
openclaw config set agents.defaults.model.primary cursor-cli/auto    # makes the plugin load at Gateway start
openclaw gateway run                                                  # stays in the foreground; use a second terminal
```

Wait for the log line `[gateway] ready` (the log has color codes, so `grep -a ready gateway.log` finds it where `grep 'gateway\] ready'` may not; `NO_COLOR=1` turns the colors off). Stop it with Ctrl-C or SIGTERM. A loopback Gateway needs no auth setup for local commands. Start it from a shell where `cursor-agent` is on `PATH` (or `cursor-cli.command` is set), and with `NODE_USE_ENV_PROXY=1` behind a proxy. To keep it running, background it (`nohup openclaw gateway run > gateway.log 2>&1 &`; `$!` is the wrapper's pid, so find the Gateway with `ps -eo pid,comm,args | grep '[o]penclaw-gateway'`; Linux truncates the process name to 15 characters, so `pgrep -x openclaw-gateway` finds nothing) or use your own process manager. Stop it by pid: `kill -TERM <pid>`.

**After stopping, check for leftovers.** A stop with SIGTERM or SIGINT (Ctrl-C) closes every `cursor-agent` the plugin started together with its whole process group, so Cursor's `worker-server` and its `typescript-language-server` / `tsserver` children go with it, and the agent home's `pids/` folder is empty. What can still remain, and for how long:

- After a SIGKILL of the Gateway (or a crash), the processes stay until the next Gateway start, which stops them within 30 seconds.
- A `cursor-agent` group whose leader died while no Gateway ran is not stopped by the next start (nothing proves it is the plugin's); its `worker-server` exits by itself about 5 minutes after its last request.
- On Windows the plugin stops only the `cursor-agent` process, so its `worker-server` can stay for about 5 minutes.
- Children Cursor puts in a process group of their own are not covered (Cursor's native shell does; the plugin's static home denies it).
- A `worker-server` shared by two plugin processes (same agent and workspace, or Cursor's `/tmp/.cursor` fallback for long paths, where your own `cursor-agent` may share it) dies with the process that started it; the other one starts a new worker on its next request.
- A new chat Cursor refuses after it was created (an unknown model, a missing mode) keeps its small folder under `acp-sessions/`.
- A model listing for which OpenClaw gives no agent directory is not recorded; a Gateway killed in its few seconds can leave that process behind.

To look: `ps -eo pid,pgid,comm,args | grep -E '[c]ursor|[w]orker-server|[t]sserver|[t]ypescript-language'`, and stop each leftover by pid with `kill <pid>`. Do not use `pkill -f`: it matches your own shell's command line.

**You already run a Gateway** (for example `~/.openclaw`): restart it once, so it loads the plugin you just installed and the default model above (set the default only if you want `cursor-cli` as your default model; otherwise the plugin loads on the first `cursor-cli/...` turn and `/model` lists the Cursor rows after it). Its environment must provide `cursor-agent` on `PATH`; with option 2 above the key is in the config, so the Gateway needs no key variable.

## 5. Verify

```sh
openclaw plugins inspect openclaw-all-cli --runtime --json
openclaw models list --provider cursor-cli
openclaw agent --model cursor-cli/auto --message "Say hi"
```

The first command must report `"status": "loaded"` and `cursor-cli` under `cliBackendIds`. The second lists your account's Cursor models (more than `auto`) and needs a running Gateway that has loaded the plugin and a login or key. The third runs through your Gateway and prints Cursor's reply. Add `--json` to see the turn's usage at `result.meta.agentMeta.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `total`; non-zero with a key, 0 with a login only). In the isolated OpenClaw (see Develop) no Gateway runs by default: run the command with `--local`, or start one as shown there and drop `--local`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Running on an unsupported Node (22.x)`, or `EBADENGINE` for `openclaw` | OpenClaw needs Node `>=24.16 <25 \|\| >=26.1` | Install Node 24.16+ (see [Install the requirements](#install-the-requirements)) and reinstall OpenClaw with it |
| `plugin "openclaw-all-cli" requires plugin API >=2026.10.3, but this OpenClaw runtime exposes 2026.10.2` | OpenClaw is older than 2026.10.3 | `npm install -g openclaw@2026.10.3` |
| `Cannot find module 'openclaw/plugin-sdk/...'` (or `TS2307`) during `npm run package` | The build cannot see OpenClaw's types: no global OpenClaw, or `npm install` removed the link | `npm link openclaw` after `npm install` (see [step 2](#2-install-the-plugin)) |
| `Gateway start blocked: existing config is missing gateway.mode` | A fresh OpenClaw has no Gateway config | `openclaw config set gateway.mode local`, then start again |
| `Another gateway (pid N) already owns this state directory` | A Gateway for the same OpenClaw state is running | Use it, or stop it by pid (`kill -TERM <pid>`; `openclaw gateway stop` stops only a service install, not a `gateway run` process) and start again, or give the new one its own state with `--profile <name>` |
| The Gateway cannot bind port 18789 | Another program uses the port (wording unverified) | Stop that program, or start the Gateway with `--port <n>` and set `OPENCLAW_GATEWAY_PORT=<n>` for the other commands |
| `plugin provenance-invalid` warning in the Gateway log ("OpenClaw can't verify where this plugin came from") | A plugin installed from a local `.tgz` has no registry provenance for OpenClaw to check | Harmless for your own build; ignore it |
| `remote model catalog refresh failed` in the Gateway log at startup | Behind a proxy OpenClaw cannot refresh its remote model catalog | Harmless; ignore it |
| `Couldn't connect to OpenClaw.` from `openclaw agent` | No Gateway is running; `agent` without `--local` needs one | Start it ([step 4](#4-start-the-gateway)), or add `--local` |
| `curl`, `cursor-agent`, or the usage ledger time out or fail TLS behind a proxy | Cursor's hosts are blocked, or Node ignores the proxy | Allow `cursor.com` and `*.cursor.sh`; start the Gateway with `NODE_USE_ENV_PROXY=1` |
| `openclaw models list --provider cursor-cli` prints `No models found.` | No login and no key, or the plugin is not loaded | Sign in or set the key (step 1), restart the Gateway, name a `cursor-cli/...` default model |
| `CLI backend executable could not be resolved: cursor-agent` | The Gateway cannot find `cursor-agent` | Put it on the Gateway's `PATH`, or set `cursor-cli.command` |
| `cursor-cli/<model>` is `[indeterminate]` in `openclaw models status`, or `No models found.` from `openclaw models list --provider cursor-cli` | OpenClaw sees no Cursor login | Run `cursor-agent login` and check `cursor-agent status`, or give the Cursor process a key (step 1) |
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
| The turn fails with `Cursor internal server error: Error: ...`, `Cursor rejected the request (invalid request format): ...`, `Cursor rate limit reached (usage limit): ...`, `Cursor authentication failed (unauthorized): ...`, `Cursor payment required: ...`, `Cursor is overloaded ...`, or `Cursor timed out ...` | Cursor reported a failed turn (network, sign-in, plan, rate limit) and the plugin turned it into an error; the text after the colon is Cursor's own | Read Cursor's text: sign in again, check the plan or payment method, wait out the rate limit, or fix the network or proxy for `*.cursor.sh`. See [Errors](providers/cursor.md#errors) |
| `Cursor refused the request, check the API key and settings (API key revoked or not allowed for this organization): Check your settings to continue` | Cursor asked for a settings check: the API key is invalid or revoked, or the client is outdated | Set a valid `CURSOR_API_KEY` or sign in again; run `cursor-agent update` |
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
| `package install requires compiled runtime output` | The plugin was installed without a build (for example with `--link`) | Run `npm run package` and install the `.tgz` |

## Develop

This section is for working on the plugin. `npm run dev:env` sets up everything below in one go (Node 24 and OpenClaw in `.spike/`, npm deps, `cursor-agent`). The isolated OpenClaw lives under `.spike/` (gitignored), never touches `~/.openclaw`, and gives the build its types, so `npm link openclaw` is not needed there:

```sh
npm run dev:setup      # installs Node 24 and OpenClaw 2026.10.3 into .spike/ when missing
npm run dev:install    # builds, packs, and installs this plugin into the isolated OpenClaw
npm run dev:openclaw -- agent --local --model cursor-cli/auto --message "Say hi"
npm run dev:openclaw -- gateway run --allow-unconfigured --auth none --port 18911   # a Gateway for multi-turn checks
OPENCLAW_GATEWAY_PORT=18911 npm run dev:openclaw -- agent --model cursor-cli/auto --message "Say hi"
npm test               # unit tests, import-boundary test
npm run typecheck
npm run test:live      # real cursor-agent; needs a Cursor login and no sandbox
```
