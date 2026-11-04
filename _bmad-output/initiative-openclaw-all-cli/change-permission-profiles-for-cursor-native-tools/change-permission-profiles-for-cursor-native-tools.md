---
type: change
title: "Permission profiles for Cursor's native read, grep, and glob"
parent: initiative-openclaw-all-cli
date: 2026-11-04
scope: moderate
status: approved
---

# Change: permission profiles for Cursor's native read, grep, and glob

## Issue summary

Issue #67. A `cursor-cli` run whose native tool selection is empty (`tools.fs.workspaceOnly: true` selects `native: []`) is refused in `prepareExecution` before any process starts, because AD-9 says Cursor cannot switch off its native `read`, `grep`, and `glob` per run. On OpenClaw 2026.10.9 the host then falls back to another model, or the agent has none. Live checks on `cursor-agent` 2026.10.22 over ACP (reported in the issue) show the belief is wrong: `deny: ["Read(*)"]` in the per-agent `cli-config.json` closes all three together, in `ask` and `agent` mode; the MCP path stays open under it; the file is read once per process; Cursor rejects an incomplete `cli-config.json` (accepted: `{version, permissions}` or `{permissions}`) and falls back to defaults. This course correction records that evidence; this run did not re-measure it (no Cursor login on the host).

## Impact analysis

- **Epic impact.** epic-cursor-cli gains no new epic; the fix is one backlog ticket.
- **Spec.** CAP-7 lists shell, write, edit, delete, and web fetch as locked down; it never mentions native read, so no spec edit. The Non-goals are untouched.
- **Architecture.** AD-9 changes: "Cursor cannot switch off its native read, grep, and glob per run, so those stay open" becomes two static permission profiles chosen from the run's native selection (edited now).
- **Parity matrix and manifest.** Rows P10 and P18 say the native readers cannot be switched off; they change with the code (a manifest change updates the matrix, the docs, and the live test together, AD-10), so the fix ticket edits them, not this proposal.
- **Docs.** `docs/providers/cursor.md` (the workspace-only section added by ticket 19, Known limits, Permissions and tool availability) and `docs/setup.md` change with the code, in the fix ticket.
- **Code.** `src/core/backend.ts` (profile pick, refusal for a partial selection), `src/core/permissions.ts`, `src/core/ports.ts`, the Cursor adapter, the process reuse key, the chat-store link.
- **Risk.** Medium: a wrong profile either opens files the operator closed or closes files the run needs; a missed profile in the reuse key serves a turn from the wrong process. Mitigated by the reuse-key criterion and tests, and a live re-check where a Cursor login exists.

## Recommended approach

Direct adjustment, one ticket (backlog 20, bug, p2, size M), built in a later run once this proposal has merged:

1. Two adapter permission profiles: `default` (today) and `restricted` (`deny: ["Read(*)"]`); the adapter writes only static permissions.
2. The core picks the profile that serves the run's native selection; a partial selection of the three stays refused, same message shape, naming the tools that stayed on.
3. The profile id is part of the process reuse key.
4. A profile with its own config directory points its chat store at the default profile's, so a chat resumes under either.
5. AD-9 (done now), P10 and P18, CAP-7 reading in the docs, and the docs change in the same ticket; the ticket carries the triage reproduction test.

## Detailed changes applied now

1. `architecture-openclaw-all-cli.md`, AD-9: the sentence "Cursor cannot switch off its native read, grep, and glob per run, so those stay open (below)." is replaced by the profile rule, and the per-agent permission bullet for native read, grep, and glob names the `default` profile.
2. Ticket backlog 20 created (below).

## Handoff

Decision: approved by the owner's approval of the issue; the batch pull request merges on green checks. The implementation run builds ticket 20 after this proposal is on `main` (issue #67 goes to `status:planned`).
