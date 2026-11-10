---
id: 26
type: story
title: "Show Cursor plan quota in OpenClaw"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
---

# Show Cursor plan quota in OpenClaw

## Description

A user of `cursor-cli` models sees how much of their Cursor plan is left in OpenClaw's own usage surfaces (Control UI Models and Usage pages, chat context popover, `/status`, `openclaw status --usage`, `openclaw models status`), through OpenClaw's provider usage hooks `resolveUsageAuth` and `fetchUsageSnapshot`. Cursor has no documented quota API, so the work starts with a spike with the real key: it finds what Cursor reports, and the hooks are built from that. The reader sits in the Cursor adapter behind an optional port; the core names no CLI.

## Acceptance Criteria

1. **The spike is recorded**
   **Given** `CURSOR_API_KEY` is set
   **When** the spike has run
   **Then** `MEMORY.md` and a spike note state which `api2.cursor.sh` DashboardService methods return plan, period, limits, per-model usage, spend, and reset date, what an API key returns against a login-only account, and the chosen cache TTL
   **And** if Cursor returns nothing usable, the ticket is marked blocked for the owner with that evidence and no hook is built
2. **Cursor data becomes a snapshot**
   **Given** a Cursor reply the spike found
   **When** the hook asks the reader for a snapshot
   **Then** where Cursor reports a limit the snapshot has a quota window (used or remaining, reset time), and where it does not, a summary text such as spend against the spend limit
   **And** nothing is estimated by the plugin: only values Cursor reported appear
3. **The hooks are wired through an optional port**
   **Given** an adapter that has no quota reader
   **When** the plugin registers
   **Then** the provider works as before and offers no snapshot
   **And** the Cursor reader is named only inside the Cursor adapter, not in the core
4. **Requests are cached and merged**
   **Given** a snapshot fetched for one Cursor account
   **When** N refreshes arrive within the TTL, including concurrent ones
   **Then** at most one Cursor request is made
   **And** the exchanged access token is reused for its 1 h lifetime
5. **Failures degrade and back off**
   **Given** Cursor answers 429, 5xx, rejects the key, or returns a changed shape
   **When** a snapshot is requested
   **Then** the last snapshot is returned marked stale, or none when there is none, and no error reaches the caller
   **And** further requests to Cursor are held off for a back-off period (10 minutes, as the per-turn usage reader does)
6. **Turns are untouched**
   **Given** a chat turn
   **When** it runs
   **Then** it makes no quota request, and a quota failure never fails or slows the turn
   **And** the per-turn token usage read behaves as before
7. **Docs and log**
   **Given** the change
   **When** the docs are read
   **Then** `docs/providers/cursor.md` describes the quota display, its source, its cache and its limits, `README.md` links it, and `CHANGELOG.md` has one plain line under `## Unreleased` with the link to issue #82
8. **Checks pass**
   **Given** the branch
   **When** `npx vitest run test/quota.test.ts` and then `npm test` run
   **Then** both pass; the live check with the key runs when Cursor is reachable, and is recorded as not run otherwise

## Boundaries

- Must not change: per-turn token usage reporting, turn behavior, model catalog, and the key exchange used today.
- Must not poll in the background or call Cursor from a chat turn.
- No cost estimation by the plugin.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/82
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md
- docs — docs/providers/cursor.md

## Notes

- Issue: #82
- Decision: approved scope is the main triage comment of #82; spike first, then the hooks.
- Decision: the spike TTL is chosen by the spike; the back-off is 10 minutes unless the spike finds a reason otherwise.
- Assumption: where Cursor reports no limits, a summary line is enough for the display.
