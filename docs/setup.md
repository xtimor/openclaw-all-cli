# Setup

How to run `cursor-cli/<model>` in your OpenClaw.

> **Status:** walking skeleton. The plugin registers `cursor-cli`, treats a Cursor login as auth, and answers a prompt over a warm `cursor-agent acp` session. Streaming of tool calls, OpenClaw tools, per-agent homes, and the model list in `/model` arrive in later changes; see [Cursor provider](providers/cursor.md) for what works now.

## Requirements

| Component | Version | Check |
| --- | --- | --- |
| OpenClaw | 2026.10.3 or later | `openclaw --version` |
| Node.js (for OpenClaw and the build) | 24.16 up to 25, or 26.1 and later | `node --version` |
| Cursor CLI (`cursor-agent`) | 2026.07.06 or later | `cursor-agent --version` |
| Cursor plan | Headless CLI allowed (admins can disable it) | `cursor-agent status` |

Older OpenClaw builds treat CLI backends as text-only, with no tools and no streaming. Older `cursor-agent` builds can corrupt `cli-config.json` when several agents run at once.

## 1. Sign in to Cursor

```sh
cursor-agent login
cursor-agent status
```

`status` must say you are logged in. On macOS the login is stored in the Keychain and is shared by every agent. A `CURSOR_API_KEY` in the Gateway's environment also counts as a login.

**Optional: Cursor API key.** Create a user API key in the Cursor Dashboard. Add it as an OpenClaw `api_key` auth profile if you want OpenClaw to replay chat history into a fresh Cursor session.

## 2. Install the plugin

OpenClaw installs a plugin from built JavaScript, so build and pack it first:

```sh
git clone <repo-url> openclaw-all-cli
cd openclaw-all-cli
npm install
npm run package          # builds dist/ and writes openclaw-all-cli-<version>.tgz
openclaw plugins install ./openclaw-all-cli-*.tgz --accept-capabilities
```

OpenClaw warns that the source is outside ClawHub review and asks you to confirm; pass `--force` to confirm without a prompt. Do not install the checkout directory with `--link`: OpenClaw scans the whole directory, and a checkout that also holds a development toolchain fails to load.

The plugin loads the first time a turn selects `cursor-cli/<model>`. It also loads at Gateway start when your config names a `cursor-cli/...` model.

## 3. Configure

All settings are optional. They live under `plugins.entries.openclaw-all-cli.config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `cursor-cli.command` | `cursor-agent` | Path or name of the Cursor CLI. Set it when the Gateway's `PATH` does not include `cursor-agent`. |

Isolation, transport, and API-key settings are documented here once they exist.

## 4. Verify

```sh
openclaw plugins inspect openclaw-all-cli --runtime --json
openclaw agent --model cursor-cli/auto --message "Say hi"
```

The first command must report `"status": "loaded"` and `cursor-cli` under `cliBackendIds`. The second prints Cursor's reply.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `CLI backend executable could not be resolved: cursor-agent` | The Gateway cannot find `cursor-agent` | Put it on the Gateway's `PATH`, or set `cursor-cli.command` |
| `cursor-cli/<model>` is `[indeterminate]` in `openclaw models status` | OpenClaw sees no Cursor login | Run `cursor-agent login`, then check `cursor-agent status` |
| `The CLI offers no "ask" mode` | The `cursor-agent` build has no read-only mode | Run `cursor-agent update` |
| `The CLI has no model "<id>" for this account` | The account cannot use that model | Pick another model or check the plan |
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
