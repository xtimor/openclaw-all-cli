---
title: 'The owner''s `upstream:post` label publishes an agent''s upstream draft through GitHub'
type: 'feature'
ticket: 25
created: '2026-10-29'
status: 'ready-for-dev'
baseline_revision: 'eb7072f1836e3cadefda465928c08ff5d350d188'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/identity.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The routine's auto-mode permission check refused `scripts/upstream-issue.sh` (a public write in `openclaw/openclaw` under the owner's name), so agents leave upstream drafts in our issues and the owner's session posts them by hand.

**Approach:** The agent writes the draft as one fixed block in its `<!-- issue-impl -->` comment; the owner's label `upstream:post` on our issue is the approval; a workflow on `issues` `labeled` (like Batch merge acts on an owner signal) turns the block into the input of the 3.23/3.24 code path, publishes it with `GH_PUBLIC_TOKEN`, comments the result on our issue, and removes the label.

## Boundaries & Constraints

**Always:** the 3.23/3.24 guards run unchanged by calling `run()` of `scripts/upstream-issue.mjs` (approved issue, the issue names the target, own issue for comments, caps, idempotent, owner actors, attempt 1, size limits, one marker line); labeler = `github.event.sender`, an owner, type `User`, not `[bot]`; draft only from the latest `<!-- issue-impl -->` comment whose author is the login in `.github/agent-identity.json` (type `Bot`) and exactly one draft block; the draft must not have changed after the label; the label must still be on the issue; job `environment: agent`, `permissions: {}` plus `contents: read`, `issues: write`; concurrency group `upstream-issue` (shared with the dispatch workflow); every input through env or the API; the token masked, never printed; the result comment and every output hold no draft text.

**Never:** a second write kind upstream; a fork of the guards (copied code); `upstream:post` accepted by the relay; edits to `.claude/settings.json`, `AGENTS.md`, `tickets.toml`, ticket files, or run logs; a change to an `agent-write.mjs` guard.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Comment draft | owner labels; bot comment holds `op=comment` block | one upstream comment; result comment with URL; label removed | No error expected |
| Create draft | block `op=create` with a `Title:` line | one upstream issue; result URL | No error expected |
| Repeat | marker already published | `existing` URL, nothing new | exit 0 |
| Stranger or bot labeler | sender not an owner, or a bot | no read of the draft, nothing upstream; reason comment; label removed | exit 1 |
| Bad draft | none, two blocks, malformed tag, wrong op or target, empty, no `Title:` | refused before any upstream request | reason comment; label removed |
| Wrong author | block only in a comment by a non-app author, or a non-bot | ignored: no draft | same |
| Edited after label | comment `updated_at` later than the label | refused (owner labels again) | same |
| Guard of 3.23/3.24 | unapproved issue, not own issue, cap, PR | the same refusal text | same |
| Replay or withdrawn | attempt over 1, or label no longer set | no writes at all | exit 1 |

</intent-contract>

## Code Map

- `scripts/upstream-issue.mjs` -- `run(env, log, now)` is the shared path (unchanged); `ALLOWED_REPOS`, `markers`.
- `scripts/agent-write.mjs` -- `makeClient`, `WriteError`, `lower`, `cell`, `writeSummary` reused; `LABEL_RE` already refuses `upstream:post` (pin it by test only).
- `scripts/batch-merge.mjs`, `.github/workflows/batch-merge.yml` -- the model of GitHub acting on an owner signal.
- `.github/labels.yml` -- the new label; `test/sync-labels.test.ts` counts labels.
- Create: `scripts/upstream-post.mjs` (`parseDraft`, `findDraft`, `run`, `main`), `.github/workflows/upstream-post.yml`, `test/upstream-post.test.ts`.
- Docs: `docs/agents/{implement,triage,identity}.md`, `docs/issues.md`, `MEMORY.md`, `test/agent-flow-docs.test.ts`.

## Tasks & Acceptance

**Execution:**
- [ ] `.github/labels.yml`, `test/sync-labels.test.ts`, `test/agent-write.test.ts` -- add the label, count it, pin the relay refusal
- [ ] `scripts/upstream-post.mjs` -- parser, draft lookup, guards, shared `run()`, result comment, label removal
- [ ] `.github/workflows/upstream-post.yml` -- trigger, filter, environment, env-only inputs, report step
- [ ] `test/upstream-post.test.ts` -- parser, stub-API runs per matrix row, workflow pins, mutation checks
- [ ] docs, MEMORY, doc pins -- draft format, owner step, agents stop calling the helper

**Acceptance Criteria:**
- Given an owner's `upstream:post` on an approved issue with a valid bot draft, when the workflow runs, then the upstream comment or issue exists once, our issue gets the result URL, and the label is gone.
- Given any refusal, then nothing is sent upstream and no stream holds a token or draft text.
- Given `npm run ci`, then it passes.

## Implementation Notes

No subagent tool was available to this worker: the build and the review lenses run in-session.

## Plan Change Log

## Review Triage Log

## Design Notes

Draft block (agents write exactly this inside their `<!-- issue-impl -->` comment; the text between the tags is the public text, without the `Filed for` line, which the workflow appends):

```
<!-- upstream-draft target=openclaw/openclaw#172969 op=comment -->
<body>
<!-- /upstream-draft -->

<!-- upstream-draft target=openclaw/openclaw op=create -->
Title: <one line>

<body>
<!-- /upstream-draft -->
```

## Verification

**Commands:**
- `npx vitest run test/upstream-post.test.ts test/upstream-issue.test.ts test/agent-flow-docs.test.ts test/sync-labels.test.ts test/agent-write.test.ts` -- expected: pass
- `npm run ci` -- expected: pass

**Manual checks (if no CLI):**
- Live (not run here): the owner labels #54 (or the next follow-up) and the draft appears upstream.
