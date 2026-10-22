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
- Cursor CLI (`cursor-agent`) 2026.07.06 or later, signed in (`cursor-agent login`) or with `CURSOR_API_KEY` set.

## Install

```sh
openclaw plugins install openclaw-all-cli
```

Then pick a model, e.g. `cursor-cli/auto`:

```sh
openclaw agent --local --model cursor-cli/auto --message "Reply with the word ok"
```

All settings are optional and live under `plugins.entries.openclaw-all-cli.config`. See [Setup](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#3-configure) for the keys, the Gateway start, and troubleshooting.

## Status

Early release. Cursor CLI only.

## Docs

- [Setup](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md): requirements, install, configuration, verification, troubleshooting.
- [Cursor provider](https://github.com/xtimor/openclaw-all-cli/blob/main/docs/providers/cursor.md): how `cursor-cli/<model>` runs and how it compares with `claude-cli`.

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
