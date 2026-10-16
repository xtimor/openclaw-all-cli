# Research brief

- **Topic:** cursor-agent as an OpenClaw model provider
- **Type:** technical · **Shape:** explore · **Topology:** breadth-first
- **Decision:** How the plugin connects cursor-agent to OpenClaw (contract, tool bridging, session resume, per-agent isolation) and which criteria are feasible as written.
- **Knobs:** preset standard (config default): 3 researchers, 8 sources/round, depth 2 · validation normal · red team off.
- **Surfaces:** web search, web fetch, local `cursor-agent` 2026.04.17 and `openclaw` 2026.2.22 (help output, installed package source). gh CLI not authenticated.

## Criteria to test

1. Native-model parity: streaming, model selection, agent turn, usage accounting look like an API model.
2. Session portability: one OpenClaw chat continues on another CLI with prior history, no manual retelling.
3. OpenClaw owns MCP, skills, tools; the CLI sees them as model tools, not a second command set.
4. Isolation on request: per-agent resume, state dir, cwd.
5. Agents do not share a resume, a lock, or writes to the CLI home dir.

## Dimensions

1. **OpenClaw side** — plugin API for providers / cli-backends; built-in `claude-cli` backend; how history and OpenClaw tools/MCP/skills reach the CLI.
2. **cursor-agent side** — headless mode, stream output format, model list/selection, resume/chat ids, MCP config, disabling built-in tools, config/state dirs, concurrency/locking, usage reporting.
3. **Reference implementations** — jeehou/openclaw-cursor-cli, elvatis/openclaw-cli-bridge-elvatis, drewstone/cli-bridge, verivus-oss/llm-cli-gateway: registration, tool bridging, resume, concurrency, per-agent state, known issues.
