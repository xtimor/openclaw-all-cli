# OpenClaw All CLI

An OpenClaw plugin that exposes local coding CLIs as models. For chat, the agent, and `/model`, a reply through a CLI and a reply through an API are the same kind of model.

The goal is the experience and features of OpenClaw's built-in `claude-cli` backend, for every supported CLI. As in `claude-cli`, the CLI runs the turn's tool loop, but only with OpenClaw's tools. OpenClaw owns policy, transcript, and session. The CLI's own tools do not act in that turn.

## First stage

Cursor CLI (`cursor-agent`), on a Cursor subscription. Models are available as a regular provider, e.g. `cursor-cli/<model>`.

The same contract then carries over to other CLIs, Antigravity next. A new provider is added once Cursor already meets the criteria below.

## Criteria

- **Like a native model.** Streaming, model selection, the agent turn, and usage tracking look the same as for a model connected via API.
- **Sessions carry over.** One OpenClaw chat continues on another CLI. Past messages come with the session, with no manual retelling.
- **OpenClaw MCP, skills, and tools stay in place.** OpenClaw calls them. The CLI sees them as model tools, not as a second command set.
- **Isolation on request.** An agent can get its own CLI workspace: its own resume, its own state directory, its own cwd.
- **Agents don't interfere.** Two agents never share one resume, one lock, or one write to per-agent CLI state. A shared CLI login is allowed.

## Requirements

- OpenClaw 2026.10.3 or later.
- Node.js 24.16 up to 25, or 26.1 and later.
- Cursor CLI (`cursor-agent`) 2026.07.06 or later, signed in with `cursor-agent login`. An API key works too; give it to the plugin config (`cursor-cli.env`), not to the Gateway's environment, as [The API key](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#the-api-key) explains. The Control UI's **Connect provider** list offers both ([Sign in from the Control UI or the CLI](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#sign-in-from-the-control-ui-or-the-cli)); with an explicit `agents.defaults.modelPolicy.allow`, add `cursor-cli/*` to it ([Configure](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#3-configure)).
- No `cursor-agent` yet? On Linux (glibc) and macOS the Connect provider methods offer to install the `cursor-agent` version pinned in the plugin, sha256-checked, from `downloads.cursor.com` into OpenClaw's state folder, only after you say yes ([Let the plugin install cursor-agent](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#let-the-plugin-install-cursor-agent)).

## Install

From ClawHub, the OpenClaw plugin catalog (`openclaw plugins search openclaw-all-cli` finds it):

```sh
openclaw plugins install clawhub:openclaw-all-cli --accept-capabilities
```

OpenClaw shows ClawHub's security audit of the release first. It currently reads "Outcome: Review" because Cursor's own read, grep, and glob tools can read files outside the workspace (see [Permissions and tool availability](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md#permissions-and-tool-availability)); the install goes on. `--accept-capabilities` accepts what the plugin registers (the `cursor-cli` provider, backend, and usage reader); without it OpenClaw installs nothing. A running local Gateway picks the plugin up; otherwise it loads at the next Gateway start.

From npm instead (the same tarball, same sha256):

```sh
openclaw plugins install openclaw-all-cli --accept-capabilities --force
```

OpenClaw warns that an npm package is outside ClawHub review; `--force` confirms it (without it a terminal asks, and a script gets `Install cancelled`) and replaces an earlier install.

Then pick a model, e.g. `cursor-cli/auto`:

```sh
openclaw agent --local --model cursor-cli/auto --message "Reply with the word ok"
```

All settings are optional and live under `plugins.entries.openclaw-all-cli.config`. See [Setup](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#3-configure) for the keys, the Gateway start, and troubleshooting.

## Update

Current OpenClaw refuses `plugins update` while the Gateway runs. Pick one path.

With the Gateway running, reinstall the latest release over the old one (`--force` replaces it; without it OpenClaw says the plugin already exists):

```sh
openclaw plugins install clawhub:openclaw-all-cli --accept-capabilities --force
```

Or stop the Gateway through its service owner (`openclaw gateway stop`, or stop the Gateway container for Docker Compose), update, and start it again:

```sh
openclaw plugins update openclaw-all-cli
```

Either way, check the installed version with `openclaw plugins list | grep openclaw-all-cli`. OpenClaw 2026.10.3 still accepts `plugins update` with the Gateway running. `update` follows the source you installed from (ClawHub or npm). With no Gateway running, the new version loads at the next Gateway start. If you installed a fixed version (`clawhub:openclaw-all-cli@X.Y.Z`), `update` keeps it; the install command above follows the latest release again. Installed from npm before? Run the ClawHub install command from [Install](#install) once: it replaces the npm install, no `--force` needed, and later updates come from ClawHub. What changed in each version: [Changelog](https://github.com/xtimor/openclaw-all-cli/blob/main/CHANGELOG.md).

## Status

Early release. Cursor CLI only. To build from source, see [Build from source](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#build-from-source).

## Docs

- [Setup](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md): requirements, install, configuration, verification, troubleshooting.
- [Changelog](https://github.com/xtimor/openclaw-all-cli/blob/main/CHANGELOG.md): what changed in each version, for users of the plugin.
- [Release](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/release.md): cut a release (on the owner's approval, or from a tag), dry run, first release, rollback, rotating the credential.
- [Issues](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/issues.md): file a bug or an idea (people and agents), the states, what happens when, security reports.
- [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md): how `cursor-cli/<model>` runs and how it compares with `claude-cli`.
- [Cursor provider card on OpenClaw latest](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor-card-latest.md): what the Control UI provider card shows for `cursor-cli`, measured on 2026.10.10.

## References

| Source | What we take |
| --- | --- |
| OpenClaw built-in `claude-cli` | The cli-backend contract: headless run, OpenClaw session, OpenClaw tools |
| [jeehou/openclaw-cursor-cli](https://github.com/jeehou/openclaw-cursor-cli) | Registering `cursor-agent` as a provider and cli-backend |
| [elvatis/openclaw-cli-bridge-elvatis](https://github.com/elvatis/openclaw-cli-bridge-elvatis) | Several CLIs behind one OpenClaw connection |
| [drewstone/cli-bridge](https://github.com/drewstone/cli-bridge) | Session resume, concurrency slots, per-agent state |
| [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) | Queue and lifecycle of CLI jobs |

## License

[MIT](https://github.com/xtimor/openclaw-all-cli/blob/main/LICENSE)
