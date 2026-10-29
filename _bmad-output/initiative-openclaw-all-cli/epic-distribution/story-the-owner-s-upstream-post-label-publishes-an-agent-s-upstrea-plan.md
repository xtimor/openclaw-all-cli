---
title: 'The owner''s `upstream:post` label publishes an agent''s upstream draft through GitHub'
type: 'feature'
ticket: 25
created: '2026-10-29'
status: 'built'
baseline_revision: 'eb7072f1836e3cadefda465928c08ff5d350d188'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
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

No subagent tool was available to this worker: the build and the four review lenses ran in-session (full route by size, no implementing subagent), as for tickets 3.23 and 3.24. Decisions:

- **Shared path, not a fork.** `scripts/upstream-post.mjs` builds the input of `scripts/upstream-issue.mjs` and calls its `run()` unchanged, so every 3.23/3.24 guard runs there. It defines none (a test pins that) and imports one check, `checkNamesTarget`, for the visible-target rule.
- **Draft format.** `<!-- upstream-draft target=<repo>#<n> op=comment -->` (a comment needs the number) or `target=<repo> op=create` (no number: a create has none; the ticket's text showed `#<n>` once for both) with a first line `Title: `, closed by `<!-- /upstream-draft -->`; tags alone on their lines; any other line that mentions `upstream-draft`, a second block, an unknown or repeated attribute, or another op is refused. The workflow appends the `Filed for xtimor/openclaw-all-cli#<n>` line.
- **Replay and withdrawal change nothing.** Attempt over 1, a triggering actor outside the owners, or the label no longer on the issue: exit 1 with no write. Removing the label is how the owner cancels. From the labeler check on, every outcome posts one `<!-- upstream-post -->` comment on our issue and removes the label (the ticket: removed in both cases).
- **The owner approves what they read.** The label time is the `created_at` of the issue's latest `upstream:post` label event, and the draft comment's `updated_at` must be at least 60 seconds older (changed after the security review; first it was `issue.updated_at` of the payload). The tags are HTML comments, so the draft text may hold no `<!--` and no invisible or direction-changing character, and a comment draft must name its target in the visible text of the same comment (the tag itself is invisible). The last two came out of the review (below).
- **Who is the agent.** The login in `.github/agent-identity.json` plus REST type `Bot`; no login (relay off) means nothing is trusted, so a connector-written draft is refused by design.
- **Concurrency.** The job shares the group `upstream-issue` with the dispatch workflow: one run at a time across both, so the idempotency check cannot race into a duplicate. A third pending run is dropped by GitHub (label stays, no result comment): the docs tell the owner to label again.
- **Labels.** `upstream:post` is in `.github/labels.yml` (17 labels). The relay's `LABEL_RE` families already refuse it; the test pins add and remove in six spellings. `test/sync-labels.test.ts` names the 16 labels of the design plus this one.
- **Docs.** `identity.md` (both workflows, draft form, rules, what the workflow does, owner steps), `implement.md` (two bullets), `triage.md`, `issues.md`, `MEMORY.md`; `agent-flow-docs.test.ts` parses the docs' own fenced draft blocks with the real parser. `scripts/upstream-issue.sh` and its workflow stay for the owner's interactive sessions (header notes added). `.claude/settings.json` untouched.

Mutation checks (each failed at least one test): labeler owner, bot, and actor checks; comment author filter; `Bot` type; latest-not-first; edited-after; attempt; triggering actor; label presence; label removal; result comment; implementation marker; one block; malformed tag; identity file; HTML comment; invisible characters; visible target; workflow label filter, environment, permissions, concurrency group, token mask (24 in all).

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 18 findings — high 0, medium 3, low 12, false 2, maybe-false 1
- findings: (the four lenses — blind-hunter, edge-case-hunter, verification-gap, intent-alignment — ran in the build's own session, no subagent tool: none was context-free)
  - `[medium]` `[patch]` The owner approves the rendered draft, but HTML comments and invisible or direction-changing characters travel with it and would be published under the owner's name — `parseDraft` refuses `<!--` and the invisible set in the draft text; tests `HIDDEN` (two comment forms, 11 code points, title and body, plus visible non-ASCII passing); mutation checks fail.
  - `[medium]` `[patch]` A comment draft's target lives only in the invisible tag, so the owner cannot see which upstream issue the comment lands on (the approved issue may name several) — the visible text of the comment must name the target (`checkNamesTarget`, reused, number matched exactly); test `VISIBLE_TARGET` (five refusals, URL form, mention inside the draft, create needs none); mutation check fails; docs and pins say so.
  - `[low]` `[patch]` The default identity path (`new URL("../.github/agent-identity.json", import.meta.url)`) was never run by a test — test `DEFAULT_IDENTITY` runs without the hook with the repository file's login and with another app.
  - `[medium]` `[defer]` An agent that disobeys its rules can add `upstream:post` as the owner through the owner's GitHub connector (relay refused it, connector is not) — the same trust limit as `status:approved`, which the state automation can revert only because it sees a non-owner actor; here the actor is the owner. Bounded: the draft must still come from the app, an approved issue, names the target, caps. Recorded in `deferred`; the docs forbid it for agents.
  - `[low]` `[reject]` A published result becomes exit 1 when the result comment or label removal fails — intended (the run is red, the log and annotation still carry the URL); tested.
  - `[low]` `[reject]` `Ignored` exits 0 for any other label — the job `if` already filters; the script check is the second guard; tested.
  - `[low]` `[reject]` Our issue is read twice (the label check, then `checkApproved` inside the shared `run()`) — one cheap request; the shared path stays untouched by requirement.
  - `[false]` `[reject]` `oneLine` truncates a URL to 500 characters in the result comment — a URL goes through `RESULT_URL` as itself; only reasons use `oneLine`.
  - `[low]` `[reject]` More than 2000 comments on our issue refuses — fail closed, same limit style as 3.24.
  - `[low]` `[reject]` A tag nested in a list or indented is refused as malformed — the message names the rule; the docs say tags stand alone on their lines.
  - `[maybe-false]` `[reject]` `issue.updated_at` of a `labeled` payload might be earlier than the label time, which would refuse a draft edited in the seconds before the label — if true the owner labels again (safe failure, low); what would settle it: one live labeled event compared with its `labeled` timeline entry. Recorded as not verified.
  - `[low]` `[reject]` One pending run per concurrency group: a third labeled event is dropped, the label stays without a result comment — GitHub behavior; workflow header and docs tell the owner to label again.
  - `[false]` `[reject]` The label removal `DELETE .../labels/upstream%3Apost` may 404 because of the encoded colon and hide it (404 passes) — `sync-labels.mjs` PATCHes `status:*` labels with the same `encodeURIComponent` live; the stub decodes it the same way.
  - `[low]` `[reject]` "Approved at some point" (3.23) lets a later removal of `status:approved` not stop a publish — not this change: and the owner's fresh `upstream:post` on this issue is itself an approval.
  - `[low]` `[reject]` The workflow tests are text pins, not a YAML parse — the repository's other workflow tests do the same.
  - `[low]` `[reject]` Real-runner behavior is not verified (payload fields, `issues: write` token in the `agent` environment, label sync before first use) — listed under Not run.
  - `[low]` `[reject]` The ticket's text shows `#<n>` in the target of both ops; a create here takes none — a create has no issue number; a number gets a one-line refusal naming the rule. Recorded as a Decision above.
  - `[low]` `[reject]` The result comment mentions the owner by `@login` (a notification) — only for a verified owner login; a stranger or bot is never mentioned (tested).

### 2026-10-29 — Independent security review (after the build)
- verdicts: 7 findings — high 1, medium 2, low 4, false 0, maybe-false 0
- findings: (from an independent reviewer of `eb7072f..HEAD`; fixed on the same branch by the build worker, in-session, each with tests and mutation checks)
  - `[high]` `[patch]` A Claude session writes with the owner's credentials: its events show `actor=xtimor`, type `User`, and `performed_via_github_app.slug == "claude"` (seen on #54), so an injected session could add `upstream:post`, or approve an issue, and pass every check — (a) `upstream-post` reads the issue's events itself (`checkLabelEvent`): the latest `upstream:post` label event must be a `labeled` one (read again up to 4 times while an older click is the last entry), by the person who added the label, an owner, `actor.type` `User`, `performed_via_github_app` null, and its `created_at` is the label time; (b) `checkApproved` counts only `isOwnersOwnClick` events (owner, not a Bot, no app); (c) `transitions.mjs` carries `viaApp` from the events and `reconcile` reverts an owner approval whose latest event has it (new comment wording: "with their own click"); (d) implement.md, triage.md, identity.md, issues.md say so, and implement.md gives the `gh api --jq` that prints the app slug. Tests: `test/upstream-post.test.ts` (APP, ACTOR, LATEST, LAG, NO_EVENT, TIME, APPROVAL), `test/upstream-issue.test.ts`, `test/issue-flow.test.ts` (unit and `runEvent`), doc pins; mutation checks fail them.
  - `[medium]` `[patch]` An HTML comment outside the block named the target and so satisfied the visible-target check — `visible` has HTML comments (closed or not) cut out before `checkNamesTarget`; test `COMMENT_HIDES_TARGET`.
  - `[medium]` `[patch]` Hidden text still got published — the draft refuses link reference definition lines (`/^ {0,3}\[[^\]]+\]:/m`) and raw HTML outside code spans and fences (`withoutCode`, a linear scan, no backtracking: a timing test with adversarial input), and `INVISIBLE` is widened to `\p{Cf}`, U+FE00-FE0F, U+E0100-E01EF, U+3164, U+115F, U+1160, U+FFA0, U+034F, U+180E; tests `MARKDOWN_HIDING`, `INVISIBLE_WIDE`, `PERFORMANCE`. `trimBlank` used `/\s+$/` (quadratic on a long whitespace run) and is now `trimEnd()`.
  - `[low]` `[patch]` A draft changed just before the label passed — the comment must be at least 60 s (`SETTLE_MS`) older than the label event, so the same second and any later edit are refused; test `EDITED_RECENTLY`, docs say to wait a minute.
  - `[low]` `[patch]` `issue.updated_at` of the payload as the label time — replaced by the event time (covered by the first finding, (a)); the workflow no longer passes `LABELED_AT` (a pin checks it is gone).
  - `[low]` `[patch]` A second draft for the same target and issue never posts (idempotent by marker) and nothing said so — documented in identity.md and implement.md (one comment or issue per target per issue of ours; a new note needs a new issue), the result comment says `Existing:` and why; test EXISTING and doc pins.
  - `[low]` `[reject]` While the issue's event list lags, `issue-flow` cannot see `performed_via_github_app` of the approval it handles (the webhook payload has no field for it; its fallback treats the sender as the actor) — the owner's decision is enforced a second time where it matters: `checkApproved` reads the events API for every upstream write and the implementation agent's own check (implement.md step 6) reads it before every build; the automation only restores the label state. Recorded in MEMORY; what would settle it: a retry of the timeline read in `runEvent`.
- The earlier deferred item (an agent adding `upstream:post` through the owner's connector) is resolved by the first finding and removed from `deferred`.

## Design Notes

Why the label, not a dispatch: the routine's auto-mode permission check refuses a public write made by the agent itself, but it cannot refuse a GitHub workflow that acts on the owner's own click. The label is the approval, as `Batch merge` merges on the owner's "ready".

Draft block (the agent writes exactly one inside its latest `<!-- issue-impl -->` comment; the text between the tags is the public text, without the `Filed for` line):

```
<!-- upstream-draft target=openclaw/openclaw#172969 op=comment -->
<the comment>
<!-- /upstream-draft -->

<!-- upstream-draft target=openclaw/openclaw op=create -->
Title: <one line>

<the issue body>
<!-- /upstream-draft -->
```

## Verification

**Commands:**
- `npx vitest run test/upstream-post.test.ts test/upstream-issue.test.ts test/upstream-issue-sh.test.ts test/agent-flow-docs.test.ts test/sync-labels.test.ts test/agent-write.test.ts` -- expected: pass
- `npm run ci` -- expected: pass

**Manual checks (if no CLI):**
- Live (not run here): the owner labels #54 (or the next follow-up) and the draft appears upstream.

## Auto Run Result

Status: built. Blocking condition: none.

**Summary:** The owner's label `upstream:post` on one of our issues now publishes an agent's upstream draft through GitHub. The agent writes one `<!-- upstream-draft ... -->` block in its latest `<!-- issue-impl -->` comment (`op=comment` with `target=openclaw/openclaw#<n>`, or `op=create` with a `Title:` line) and sets `status:blocked` awaiting the owner. The `Upstream post` workflow (`issues` `labeled`, environment `agent`) checks the labeler, reads the app's draft, hands it to `run()` of `scripts/upstream-issue.mjs` (every 3.23/3.24 guard unchanged), comments the URL or the refusal reason on our issue, and removes the label. Agents never add the label (the relay refuses it) and no longer call `scripts/upstream-issue.sh`.

**Files changed:** `.github/labels.yml`, `.github/workflows/upstream-post.yml` (new), `.github/workflows/upstream-issue.yml` (header), `scripts/upstream-post.mjs` (new), `scripts/upstream-issue.sh` (header), `test/upstream-post.test.ts` (new), `test/agent-write.test.ts`, `test/sync-labels.test.ts`, `test/agent-flow-docs.test.ts`, `docs/agents/{identity,implement,triage}.md`, `docs/issues.md`, `MEMORY.md`, this plan.

**Review:** 18 findings from four lenses run in-session (no subagents available): 3 patched (2 medium, 1 low), 1 deferred (medium), 14 rejected or false with reasons in the triage log.

**Follow-up review recommended: true.** Patched: high 0, medium 2, low 1. The unverified risk: the two medium patches (hidden draft content, the visible target) were found and written by the same session that built the flow, with no context-free reviewer, so a fresh independent security review of `scripts/upstream-post.mjs` and `upstream-post.yml` is worth one pass before the first live use.

**Verification:** `npm run ci` passed (see the commit); `test/upstream-post.test.ts` (45), the doc pins, and the 3.23/3.24 suites pass; 24 mutation checks each fail a test.

**Not run:** the live run (the owner labels #54 or the next draft); on a real runner: the `issues`/`labeled` payload fields (`sender`, `issue.updated_at`), `secrets.GITHUB_TOKEN` with `issues: write` in the `agent` environment, the shared concurrency group dropping a third pending run, and `Labels` having synced `upstream:post` before the first use.

**Residual risks:** the deferred finding (a rule-breaking agent can use the owner's connector to add the label); an owner who labels without reading approves whatever the app wrote; one draft and one target per label; `issue.updated_at` of the labeled event could refuse a draft edited in the seconds before the label (the owner labels again).

## Auto Run Result (independent security review fixes)

Status: built. Blocking condition: none.

**Summary:** The label (and an approval) must be the owner's own click, not an event made through a GitHub App: `upstream-post` reads the label event from the issue's events (owner, `User`, `performed_via_github_app` null, its time is the label time), `checkApproved` counts only such approvals, and the `Issue flow` automation reverts an owner approval made through an app. A name in an HTML comment no longer counts as the visible target. The draft also refuses link reference definitions, raw HTML outside code, and a wider set of invisible characters; it must be at least 60 seconds older than the label; the docs say a second draft for the same target posts nothing new, and the result comment says so.

**Files changed:** `scripts/upstream-post.mjs`, `scripts/upstream-issue.mjs` (`isOwnersOwnClick`, `checkApproved`), `scripts/issue-flow/transitions.mjs`, `.github/workflows/upstream-post.yml`, `test/upstream-post.test.ts`, `test/upstream-issue.test.ts`, `test/issue-flow.test.ts`, `test/agent-flow-docs.test.ts`, `docs/agents/{identity,implement,triage}.md`, `docs/issues.md`, `MEMORY.md`, this plan.

**Review:** 7 findings in the log (the independent reviewer's 6, plus one low of my own on the event-list lag): 6 patched (1 high, 2 medium, 3 low), 1 rejected (low) with its reason; the earlier deferred item is resolved and removed, so `deferred` is empty.

**Follow-up review recommended: true.** Patched: high 1, medium 2, low 3. The unverified risk: the new event reads (`performed_via_github_app`, `actor.type`, the lag retry) are checked against stubs of the REST shape the reviewer saw on #54 and have not run against a real runner; a short context-free pass over `checkLabelEvent` and the `reconcile` change is worth it before the first live use.

**Verification:** `npm run ci` passed (see the commit); 15 further mutation checks (label click check, actor equals labeler (first survived, a test with two owners now kills it), latest must be `labeled`, 60-second window, same second, HTML-comment strip, link reference definitions, raw HTML, `\p{Cf}`, the invisible fillers, app approvals in `checkApproved`, the actor type, the app flag in `reconcile`, and in `normalizeTimeline`) each fail a test.

**Not run:** the live run; real label events of the owner's own browser click carrying `performed_via_github_app: null`; the lag retry on a runner.

**Residual risks:** as above, plus the `Issue flow` lag fallback (rejected finding); an owner who labels without reading approves whatever the app wrote.
