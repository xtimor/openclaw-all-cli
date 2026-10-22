---
type: initiative
title: "Coding CLIs as OpenClaw models, at claude-cli parity"
parent: none
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7, CAP-8, CAP-9, CAP-10, CAP-11, CAP-12]
assignee: ""
risk: high
---

# Coding CLIs as OpenClaw models, at claude-cli parity

## Description

OpenClaw users run their coding-CLI subscriptions as ordinary OpenClaw models, with the experience and features of the built-in `claude-cli` backend. One plugin, a shared core, and one adapter per CLI: Cursor first, Antigravity next. The spec owns the capabilities, constraints, and non-goals; the architecture spine owns the invariants.

## Outcome

A user switches an OpenClaw chat to `cursor-cli/<model>` and gets the spec's success signal; the same then holds for Antigravity through a new adapter alone.

## Done when

1. The spec's success signal passes as a live demo on a supported OpenClaw with Cursor.
2. Every `claude-cli-parity.md` row has a Cursor status verified by a live test, or a recorded gap with its reason.
3. Antigravity works as `antigravity-cli/<model>` with no change to `src/core/`.
4. A person sets up each provider from `docs/` alone.

## Boundaries

Capability boundary: one epic per CLI provider; the shared core is built inside the first epic and only consumed by later ones. Not OpenClaw core changes, not a host-owned tool loop, not per-agent CLI logins (spec Non-goals). Tracer path: one `cursor-cli/auto` reply in an isolated OpenClaw.

- Touch point: OpenClaw Gateway (plugin install, config, auth profiles) — configured, never patched; owner: epic-cursor-cli
- Touch point: Cursor account and `cursor-agent` login — consumed; owner: epic-cursor-cli
- Touch point: Antigravity CLI and its Google account login — consumed; owner: epic-antigravity-cli

## References

- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, section Capabilities
- constraint — the same spec, section Constraints
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md
- parity — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md

## Notes

- Decision: work only against an isolated OpenClaw (`.spike/`, Node 24); the user's own OpenClaw and Node are upgraded at the end (user, 2026-10-16).
- Decision: a Cursor API key is optional, not required (user, 2026-10-16).
- Decision: the agent makes design decisions; the user decides strategy only (user, 2026-10-15).
- ~~Decision: no public release (npm or ClawHub) in this initiative (user, 2026-10-16).~~ Superseded 2026-10-22 by the next line.
- Decision: publish to npmjs.com from GitHub Actions, as epic-distribution; ClawHub stays out (user, 2026-10-22).
- Decision: GitHub issues are the intake for bugs and ideas; a triage agent runs twice a day, the owner approves development, an agent implements as a PR; in epic-distribution (user, 2026-10-22).
- Decision: Cursor usage must be found; shipping without usage is a last resort (user, 2026-10-16).
- Decision: the platform baseline (repo scaffold, dev OpenClaw, test harness) is epic-cursor-cli entry 1; CI waits until the repo has a remote (agent, 2026-10-16).
- Waits on epic-cursor-cli because: epic-antigravity-cli consumes the shared core and the adapter seam it delivers.
