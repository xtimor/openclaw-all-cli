---
type: epic
title: "Cursor as an OpenClaw model at claude-cli parity"
parent: initiative-openclaw-all-cli
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7, CAP-8, CAP-9, CAP-10, CAP-11, CAP-12]
after: []
assignee: ""
risk: high
---

# Cursor as an OpenClaw model at claude-cli parity

## Description

The plugin repo, its shared core, the generic ACP transport, and the Cursor adapter, built so `cursor-cli/<model>` behaves like `claude-cli` in OpenClaw. The spec's CAP-1 to CAP-11 are the requirements, plus the core half of CAP-12 (a CLI-agnostic core and adapter seam); the architecture spine's AD-1 to AD-14 bind every story.

## Outcome

A Cursor subscriber uses `cursor-cli/<model>` in OpenClaw chat, agent, and `/model` the way they use `claude-cli`; the signal is the spec's success signal passing live.

## Requirements

The spec's capabilities CAP-1 to CAP-11 and the core half of CAP-12, used by id: _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, section Capabilities.

## Done when

1. In an isolated OpenClaw 2026.10.3, the spec's success signal passes as a live demo.
2. `test/live/` passes one live test per `claude-cli-parity.md` row with a Cursor status of match or approx; every gap row names its reason.
3. Two agents run turns in parallel for 20 turns each with no error and no corrupted Cursor config.
4. An agent following only `docs/setup.md` and `docs/providers/cursor.md` gets a working turn on a clean isolated OpenClaw.
5. An import-boundary test shows `src/core/` names no CLI and adapters import only ports and transports.
6. The plugin runs a cursor-cli turn with an OpenClaw tool call in the user's own upgraded OpenClaw.

## Boundaries

The whole plugin for Cursor: `src/plugin.ts`, `src/core/`, `src/transports/`, `src/adapters/cursor/`, `test/`, `docs/`, and the final install into the user's OpenClaw (entry 18). Not Antigravity (epic-antigravity-cli), not OpenClaw core (spec Non-goals).

## References

- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md
- parity — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md
- spike — _bmad-output/initiative-openclaw-all-cli/spike-cursor-transport/spike-cursor-transport.md
- research — _bmad-output/initiative-openclaw-all-cli/research-cursor-agent-openclaw-integration/research-cursor-agent-openclaw-integration.md

## Notes

- Unknown: whether OpenClaw accepts `liveSession: "claude-stdio"` and third-party synthetic auth; entry 1 answers it. A "no" on liveSession amends AD-8 and re-slices entries 7 and 8 before they start.
- Unknown: the source of Cursor usage on ACP; entry 9 answers it right after the tracer bullet, because CAP-3 is the least certain requirement.
- Tracer bullet: entry 1, the thinnest path through plugin, core, ACP transport, adapter, and OpenClaw. It also owns the core contracts (ports, events, errors, manifest skeleton) so later lanes start in parallel.
- Lanes after entry 1: tools and lifecycle (2 → 3 → 4 → 7 → 8), events (5), models (6), usage (9 → 10). They join at 12; parity rows 13 → 14; docs proof 15; sweep 16; suite 17; install 18.
- Hands off to epic-antigravity-cli: `ports.ts` (open/prompt/cancel/close, NormalizedEvent, CliError), the manifest shape keyed P1-P19, the gated `test/live/` harness, the `docs/providers/<cli>.md` layout, and a git tag at epic close as the baseline for its no-core-change check.
- Decision: 18 entries kept as one epic and one owner; splitting would only cut a single lane in two (agent, 2026-10-16).
- Decision: each entry adds the live tests for the parity rows it names; entry 17 only fills rows no entry owns (agent, 2026-10-16).
- Decision: the epic runs with `bmad-build`, the agent deciding design and the user deciding strategy (user, 2026-10-15).
- Decision: development runs only against the isolated OpenClaw in `.spike/` on Node 24 (user, 2026-10-16).
