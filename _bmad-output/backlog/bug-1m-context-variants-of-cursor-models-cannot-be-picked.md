---
id: 17
type: bug
title: "1M context variants of Cursor models cannot be picked"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# 1M context variants of Cursor models cannot be picked

## Description

Cursor sells Claude Opus 5.5 and other models with a 1M context, but the plugin lists only the variant the ACP session reports, at 300k, and runs only that. The owner cannot pick the 1M variant. Where Cursor accepts the 1M variant, each should be its own model next to the existing one.

## Reproduction

1. Run `openclaw models list --provider cursor-cli` and `cursor-agent --list-models` on the same account.
2. Actual: one `cursor-cli/claude-opus-5-5` row at 300k; Cursor lists the Opus 5.5 rows as "1M". Expected: a 1M choice, if Cursor accepts it.

## Cause Hypothesis

The catalog lists only the rows the ACP session reports, whose default `context=` is 300k. The plugin never builds a `context=1m` ID, and the family table holds 300k for Opus 5.5 and Opus 5.

## Acceptance Criteria

1. **The live probe decides**
   **Given** a Cursor login and `CURSOR_API_KEY`
   **When** `session/set_model` is sent the listed row's ID with `context=1m`, and `claude-opus-5-5[context=1m,...]`
   **Then** the result (accepted, or the error text) and one turn on the 1M ID if accepted are recorded in Notes; with no login the probe is recorded as not run, and the build in 2 and 3 below follows the fake's behavior and says so
2. **1M variants are separate models**
   **Given** the 1M ID is accepted, and a model list where a family has a 1M option
   **When** the catalog is built
   **Then** each such variant is a model of its own (for example `cursor-cli/claude-opus-5-5-1m`) with a 1,000,000 window read from its own ID, and every existing model name, ref, and alias is unchanged
3. **The window follows the ID**
   **Given** an ID that carries a `context` value
   **When** its window is chosen
   **Then** the value in the ID is used and the family table is never consulted; the context ceiling of a 1M row is 1,000,000
4. **No catalog change if refused**
   **Given** Cursor refuses the 1M ID
   **When** the catalog is built
   **Then** it is the same as before, and the docs say the 1M variants are refused
5. **Tests cover it**
   **Given** the test suite
   **When** it runs
   **Then** tests on the fake `cursor-agent` cover the 1M naming, the window from the ID, the ceiling, and the unchanged names, fail without the fix, and `npm test` passes
6. **Docs and changelog**
   **Given** `docs/providers/cursor.md` and `CHANGELOG.md`
   **When** they are read
   **Then** the docs say 300k is Cursor's ACP default and not the model's limit, and the changelog has a line linking #46

## Boundaries

- The ids and refs of today's models (`cursor-cli/claude-opus-5-5` and the others) do not change.
- A 1M variant that Cursor bills differently is named as such in the docs.

## References

- parent — none
- source — GitHub issue #46
- docs — docs/providers/cursor.md

## Notes

- Issue: #46
- Open question: what a 1M turn bills; the live probe records what Cursor shows, if anything.
- High-risk-style check: the live probe, when a login exists, is the check outside the ticket's tests.
