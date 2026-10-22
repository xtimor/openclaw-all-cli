---
type: change
title: "Publish to npm from GitHub CI, and a readable settings form"
parent: initiative-openclaw-all-cli
date: 2026-10-22
scope: moderate
status: approved
---

# Change: publish to npm from GitHub CI, and a readable settings form

## Issue summary

Installing the plugin takes a manual build and pack on the user's machine (`docs/setup.md`), and the plugin's settings form in the OpenClaw Control UI shows raw field names with no help. The user asked (2026-10-22) for a release path from GitHub to npmjs.com (their "variant B") and a better settings form, and for tickets only, no implementation yet.

## Impact analysis

- **Decision superseded.** The initiative note "no public release (npm or ClawHub) in this initiative; release is a later initiative" (user, 2026-10-16) and the architecture's Deferred entry "Distribution: npm package versus ClawHub, and release automation" no longer hold. The user decided on 2026-10-22: npm, with GitHub Actions. ClawHub stays out.
- **Earlier note.** "CI waits until the repo has a remote" (agent, 2026-10-16): the repo has had a remote since then, so CI is now due.
- **Epic impact.** epic-cursor-cli is unchanged; its entries 17 (done) and 18 (user's own OpenClaw, hitl) stay. A new epic, `epic-distribution`, is added. It does not wait on entry 18.
- **Spec and PRD.** The spec has no capability for distribution; the new epic covers none (`covers = []`). No spec edit.
- **Artifacts.** `package.json` (`private: true` today), `openclaw.plugin.json` (`uiHints`), `.github/workflows/` (none today), `docs/setup.md`, `README.md`, a new `docs/release.md`.
- **Risk.** Publishing is hard to undo: an npm version cannot be reused after unpublishing, so rollback means deprecate and release a new version. The package name, scope, and the publishing credential are the owner's.

## Recommended approach

Direct adjustment: one new epic of five stories, in this order. 3.1 and 3.2 start at once and are independent.

| Ticket | What | Risk | Notes |
| --- | --- | --- | --- |
| 3.1 | Readable settings form (`uiHints`, API key sensitive, limits advanced) | low | |
| 3.2 | CI on pull requests (typecheck, unit tests, build, pack and install smoke) | low | no secret |
| 3.3 | A package npm can publish (metadata, `files`, allowlist test, README) | medium | unknown: name and scope |
| 3.4 | Release workflow: tag to npmjs.com with provenance, GitHub release with the tarball, dry-run mode, `docs/release.md` | high | hitl: the owner creates the credential; unknown: trusted publishing or token |
| 3.5 | Install from npm proven and documented (`plugins install`, `plugins update`, `docs/setup.md` rewritten) | medium | after the first real release |

Effort: 3.1 to 3.3 are a day of agent work; 3.4 waits on the owner's npm setup; 3.5 follows the first release. Scope class: moderate (new epic, no replan of the existing one).

## Detailed changes applied now

1. `initiative-openclaw-all-cli.md`, Notes: the 2026-10-16 "no public release" line is marked superseded; a new Decision line records npm with GitHub CI and no ClawHub (user, 2026-10-22).
2. `architecture-openclaw-all-cli.md`, Deferred: the Distribution entry now reads that npm release automation is epic-distribution, while ClawHub stays deferred.
3. `MEMORY.md`: the "no public release" decision line is replaced.
4. `tickets.toml` (initiative): epic 3 `epic-distribution`; `epic-distribution/tickets.toml`: entries 3.1 to 3.5; `epic-distribution/epic-distribution.md`.

## Handoff

- Developer agent: 3.1, 3.2, then 3.3 once the package name is settled.
- The user (hitl): choose the package name and scope; create the npm account or scope and the publishing credential for 3.4; make the first release tag.
- Success criteria: the epic's Done-when list.
