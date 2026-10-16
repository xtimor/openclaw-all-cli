---
type: epic
title: "Antigravity as a second adapter on the shared core"
parent: initiative-openclaw-all-cli
covers: [CAP-12]
after: [epic-cursor-cli]
assignee: ""
risk: high
---

# Antigravity as a second adapter on the shared core

## Description

Antigravity runs in OpenClaw as `antigravity-cli/<model>` through a new adapter on the core that epic-cursor-cli built. It delivers the adapter half of CAP-12, proving the core is CLI-agnostic; its docs and parity column serve initiative Done when 2 and 4 under AD-10.

## Outcome

An Antigravity user selects `antigravity-cli/<model>` and gets streamed replies with OpenClaw tools; the signal is that `src/core/` is unchanged by this epic.

## Done when

1. `antigravity-cli/<model>` answers a turn with an OpenClaw tool call in an isolated OpenClaw.
2. `git diff` of this epic touches no file under `src/core/`.
3. The Antigravity column of `claude-cli-parity.md` is filled, each row verified by a live test or recorded as a gap.
4. `docs/providers/antigravity.md` lets a person set it up alone.

## Boundaries

The Antigravity adapter (`src/adapters/antigravity/`), its manifest, docs, and live tests. It also touches files epic-cursor-cli owns: `src/plugin.ts` and `openclaw.plugin.json` (register the backend), `README.md` and `docs/setup.md` (link the provider), and a new `src/transports/<x>/` if Antigravity doesn't speak ACP. Only `src/core/` is off-limits.

## References

- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, CAP-12 and Open Questions
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md, AD-1, AD-2, AD-4, AD-10

## Notes

- Unknown: whether Antigravity has a headless CLI with streaming output, resume, and MCP (ACP or otherwise); the first story at inception is research on it.
- Waits on epic-cursor-cli because: the spec adds a provider only after Cursor passes every capability; it consumes the core, the adapter seam, and the live harness.
- Assumption: a core change Antigravity needs goes into a new epic placed before this one, and the no-core-change diff starts after it (agent, 2026-10-16).
