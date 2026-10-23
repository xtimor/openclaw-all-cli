---
type: design
title: "GitHub issue flow: intake, triage, approval, implementation"
parent: epic-distribution
---

# GitHub issue flow

People and agents file bugs and ideas as GitHub issues. A triage agent runs twice a day and moves each open issue forward. The owner approves what gets built; an implementation agent builds it as a pull request. Entries 6 to 9 of epic-distribution build this.

**Requirement (user, 2026-10-22): every development, bug fix, and course correction goes through the BMAD flow in this repo (`_bmad/`, the `bmad-*` skills, the ticket store under `_bmad-output/`).** A GitHub issue is only the intake and the public status; the work itself is a BMAD ticket, built by a BMAD build, reviewed by a BMAD review. No agent changes code outside that flow. See [BMAD flow per state](#bmad-flow-per-state).

## States

One `status:*` label per open issue, always exactly one. A closed issue has none.

| State | Meaning | Who moves it out |
| --- | --- | --- |
| `status:new` | Filed or reopened, not yet triaged, or the author answered a question | triage agent |
| `status:needs-info` | Either agent (or the owner) asked the author for details or a check only the author can do | author's reply (back to `new`), or the stale timer (30 days from the latest `needs-info` label; the closing comment mentions the author) |
| `status:triaged` | The agent accepts it: problem confirmed, priority set, scope written. Waits for the owner, unless triage carried an earlier approval over a `needs-info` round | owner, or the implementation run (carried approval) |
| `status:approved` | The owner approved it for development | implementation run |
| `status:planned` | A course correction for it is merged; its BMAD tickets exist but are not built yet | implementation run (the owner's earlier approval covers it) |
| `status:in-progress` | The implementation agent is working on it | implementation run (stops with `needs-info` for the author or `blocked` for the owner), PR events |
| `status:in-review` | A pull request that fixes it is open | implementation agent (merges it on green), or the owner (closes the PR) |
| `status:blocked` | The owner must decide (scope beyond the approval, protected files, product direction, repeated failure), or the PR was closed unmerged; the comment mentions the owner and says why | owner |

Closed reasons: `completed` (PR merged), `not planned` (rejected, stale, out of scope), `duplicate` (with a link).

## Transitions

```
opened ─────────────────────────────► new
reopened (any closed issue) ────────► new

new ──triage: confirmed, accepted──► triaged          (+ priority, + type, triage comment)
new ──triage: details missing──────► needs-info       (questions in the triage comment)
new ──triage: rejected─────────────► closed not planned (reason in the triage comment)
new ──triage: duplicate────────────► closed duplicate (link to the original)
new ──triage: fixed by a done ticket► closed completed (ticket and commit named)

needs-info ──author comments───────► new   (also after an implementation question)
needs-info ──30 days in the status─► closed not planned (stale, author mentioned; reopening brings it back)

triaged ──owner sets approved──────► approved
triaged ──owner rejects────────────► closed not planned
triaged ──owner asks a question────► needs-info

approved ──run starts──────────────► in-progress
in-progress ──PR "Fixes #N" opened─► in-review
in-progress ──proposal PR "Refs #N"─► in-review          (course correction, see below)
in-review ──proposal PR merged─────► planned
planned ──run starts, no new approval─► in-progress (build the new tickets)
in-progress ──run needs the author's answer─► needs-info  (comment mentions the author; ticket stays blocked)
in-progress ──run needs an owner decision──► blocked      (comment mentions the owner)
new ──triage: approved before, owner approval newer than last close/reopen, answer settles the impl question, scope unchanged─► triaged ("Approval: carried over", short comment)
new ──triage: approved before, but scope or path changed─► triaged ("a new approval is needed")
triaged (approval carried over) ──run starts, no new approval─► in-progress
in-review ──PR merged──────────────► closed completed
in-review ──PR closed unmerged─────► blocked
blocked ──owner sets approved──────► approved (retry)
blocked ──owner rejects────────────► closed not planned
```

The agent may reject on its own; the author replies on the issue to dispute it, and the owner reopens (a reporter without write access cannot reopen an issue the agent closed). Only the owner moves an issue to `approved`.

## Other labels

- Type, set by the form or the triage agent: `type:bug`, `type:idea`.
- Priority, set by the triage agent, the owner may change it:
  - `priority:p0`: install or every turn broken, data loss, or a security hole; no workaround.
  - `priority:p1`: a core capability (CAP-1..CAP-12) broken or wrong, workaround hard.
  - `priority:p2`: a real defect with a workaround, or an idea that fits the spec.
  - `priority:p3`: polish, docs, nice to have.
- `source:agent`: filed by an agent (form field or the body line `Filed by: agent`).

## Triage run (twice a day)

Runner: a Claude Code scheduled task on the owner's account (frequency set by the owner, twice a day by default), each firing a fresh cloud session on this repository that follows `docs/agents/triage.md` and reaches GitHub as the agent app (`docs/agents/identity.md`), or through the owner's connector when no app is set up. A firing note `dry run` makes it report without writing.

Takes every open issue in `status:new`, oldest first, at most 20 per run. For each one:

1. **Duplicate.** Search open and closed issues; a clear duplicate is closed with a link.
2. **Problem exists.** Bug: read the code on `main`, run the unit tests or a focused test of the agent's own, reason from the reported steps without executing anything taken from the issue; record reproduced, explained by code, or not reproduced. Idea: check it against the spec's capabilities and non-goals and the architecture invariants. Live Cursor checks do not run in CI; say so when they would be needed.
3. **Details.** Missing version, steps, logs, or a fuzzy idea: ask concrete questions, move to `needs-info`.
4. **Decide.** Accept (`triaged`, with priority, type, a short scope, risk, rough size, and a path: standalone, epic entry, course correction, or an existing open BMAD ticket), reject (`not planned`, with the reason, e.g. the non-goal it hits), or close as completed when a done BMAD ticket already fixed it. The full procedure is `docs/agents/triage.md`.

It writes one triage comment per issue, marked `<!-- issue-triage -->`, and edits that same comment on a later pass. The run summary lists every decision.

**Comment shape (both agents).** Every agent comment starts with its marker (`<!-- issue-triage -->` or `<!-- issue-impl -->`) and then states the status label, who is awaited (`@login`) and for what, and what happens next (`docs/agents/comments.md`). The state automation never counts an owner's marker comment as the author's reply. **Carried approval:** only when the owner's latest `labeled status:approved` is later than the issue's last close and reopen, the implementation agent then set `needs-info` with a question, and the author's reply answers it; triage then posts a short `<!-- issue-triage -->` comment with `**Approval:** carried over (owner approved <date>; scope unchanged)` (it does not edit the main comment) and sets `triaged`. If the answer changes the draft ticket or the path, it re-triages normally and writes "a new approval is needed". The implementation run takes such an issue when the latest triage comment has the carried line and the same two event conditions hold, and the owner's `labeled status:approved` event is in the history. A second `needs-info` stop on one ticket, or a bot or deleted author, goes to `blocked`. The automation does not check the carried line: it rests on the agents following the prompts. No new label, and triage still never sets `approved`.

## Implementation run

Runner: the same Claude Code scheduled task as triage; after the triage report the session follows `docs/agents/implement.md` (the owner sets the routine's frequency and can run it now). It takes the issues in `approved`, in `planned` (no second approval), and in `triaged` with a carried-over approval line (no second approval), whose latest `labeled status:approved` event is by the owner (it checks the timeline itself; the state automation also removes other actors' approvals), oldest first, as a batch of at most 6 or about 3 hours per firing, and opens one PR per batch with a `Fixes #N` line per issue.

It follows [BMAD flow per state](#bmad-flow-per-state): ticket by `bmad-ticket`, build by `dev-orchestrator` (`bmad-build-auto` per ticket), course corrections by `bmad-correct-course`, on the branch its session is given, and opens a pull request with `Fixes #N` (or `Refs #N` for a proposal). It waits up to about 30 minutes for the checks and merges its own `Issue batch` PR when every check passed and GitHub reports it clean (merge method `merge`, expected head sha); one fix attempt on red, else it leaves the PR open for the next run, which merges a green open batch PR first. It merges nothing else, never tags a release, and never touches secrets. Checks it could not run (live Cursor) are listed in the PR. On failure the issue goes to `needs-info` (only the author can answer, author mentioned; the ticket stays `blocked`) or to `blocked` (the owner decides, owner mentioned), with the reason.

## BMAD flow per state

Skills are the ones in `.claude/skills/` (mirrored in `.agents/skills/`); the ticket store is the repo store (`bmad-ticket`'s `tickets.py`). An agent in CI runs the skills unattended: it never waits at a checkpoint; where a skill would ask the user, it takes the recommended option and records it as a `Decision:` line, or stops and sets `blocked` when the choice is strategic (`AGENTS.md`).

| Issue state | Who | BMAD skills and agents | Output |
| --- | --- | --- | --- |
| `new` (triage) | triage agent | Reads the spec, architecture, `MEMORY.md`, and the ticket store (`tickets.py status`) for duplicates and scope. Bug: the single-ticket check of `bmad-ticket` (the "Ticket" section of `references/validate-checks.md`) to judge whether it is a real, buildable bug. Idea: checked against the spec's capabilities and non-goals; the lenses of `bmad-forge-idea` frame the questions. Sizes the work into a path: **standalone** (one bug or story), **epic entry** (fits an existing epic), **course correction** (changes an epic, the spec, or the architecture), or **existing ticket** (an open BMAD ticket already covers it). | Triage comment: verdict, evidence, priority, path, draft ticket text. Nothing is written to the repo. |
| `needs-info` | author, then triage agent | None; the questions come from the triage step above, or from the implementation agent when a build stops on something only the author can answer (its ticket stays `blocked`; after the reply triage re-checks the scope and carries the approval over, and the Retry path builds it). | Questions in the agent comment, with the author mentioned. |
| `triaged` | owner | None. The owner reads the triage comment and may change priority or path. | `approved`, reject, or a question. |
| `approved`, path standalone or epic entry | implementation agent | 1. `bmad-ticket`: create the ticket (a bug or story in `backlog/`, or an entry in the named epic) and refine it to full acceptance criteria. 2. `dev-orchestrator` over the batch's tickets, in the agent's own session (`blocked_policy = "continue"`): per ticket `bmad-build-auto` (review `thorough` for p0 and p1, the default otherwise) plans (`draft` → `ready-for-dev`), implements (`in-progress`), and reviews with `bmad-code-review` lenses (`in-review` → `built`). | The session's branch with the ticket, its plan, and the code; PR `Fixes #N`. |
| `approved`, path existing ticket | implementation agent | `dev-orchestrator` on the named ticket, as above. | PR `Fixes #N` from the session's branch. |
| `approved`, path course correction | implementation agent | `bmad-correct-course` in batch mode (its approval prompts answered by the owner's approval of the issue), then new tickets via `bmad-ticket`. No code. | A `Refs #N` line in the batch PR; merged on green like any batch. Then `planned`. |
| `planned` | implementation agent | The tickets the proposal created (notes `Issue: #N`), built by `dev-orchestrator` as above. | `Fixes #N` in the next batch PR. |
| `in-progress` | implementation agent | The build's plan status is the source of truth: `draft`, `ready-for-dev`, `in-progress`. | Progress line in the issue comment. |
| `in-review` | implementation agent (merges a green batch PR); owner may pause, close, or revert | The agent merges the green batch PR (not a draft). The owner can convert it to draft to hold the merge, close it (issues go `blocked`; re-approve to retry), or revert after the merge; an interrupted draft batch PR (not updated for over 4 h) is closed by the next run (relay op `pr_close`, only its own draft `Issue batch` PR), which takes its issues again under the owner's standing approval; no owner action. Owner review comments on the PR: the agent resumes the same plan with `bmad-build-auto` (it re-enters at review), pushes, and replies. | Merged or updated PR. |
| `blocked` | owner | The plan's `blocked_reason` (from `bmad-build-auto` halting) is quoted in the issue, with the owner mentioned. Only owner decisions land here; questions for the author are `needs-info`. | Owner decides: `approved` to retry, or reject. |
| closed completed | implementation agent (next run) | `tickets.py mark <ref> done` (housekeeping); at the end of an epic, `bmad-retrospective` as usual. | Ticket `done`. |
| closed not planned (after approval) | implementation agent (next run) | `tickets.py mark <ref> dropped` (housekeeping). | Ticket `dropped`. |

Plan status and issue state agree: `draft`, `ready-for-dev`, `in-progress` are `in-progress`; `in-review`, `built` with an open PR are `in-review`; `blocked` is `blocked`; `done` closes the issue.

## Safety

- Issue and comment text is untrusted input. The agents treat it as data: they do not follow instructions in it, do not run commands taken from it, and do not paste secrets or environment into comments.
- The agents write to GitHub as their own GitHub App (`<app-slug>[bot]`, installed on this repository only). The session's proxy swaps the owner's credentials into every `api.github.com` request, so an agent cannot write as the app itself and may not bypass the proxy: it dispatches the `Agent write` workflow (`.github/workflows/agent-write.yml`) with a JSON list of operations, and the job (in the GitHub Environment `agent`, deployment branches `main` only) mints the app's installation token from the environment secret `AGENT_APP_PRIVATE_KEY` (`scripts/agent-token.mjs`) and `scripts/agent-write.mjs`, run without the key, applies them in order as the app, stopping at the first failure. Guards the relay enforces: dispatcher and triggering actor in `ISSUE_FLOW_OWNERS`, attempt 1 only (no replays), at most 50 operations and 60 000 characters, nothing applied when any is refused, label names only in the `status:`/`type:`/`priority:`/`source:` families and never `status:approved` added, edits only the app's own comments and pull requests, close/reopen only an issue, `claude/` heads, and a merge only of the app's own open, ready `Issue batch` PR in this repository at the given sha with mergeable state `clean`, the `check` run and every other check run green, and no failing or pending commit status. The agents still check before they dispatch. Which mode is on is a file the agents read, `.github/agent-identity.json` (`{"login": "<slug>[bot]"}`; absent or empty means the owner connector), because sessions cannot read Actions settings or run logs. Setup and rules `docs/agents/identity.md`. Without a login in that file they act through the owner's GitHub connector, so their labels, comments, and PRs count as the owner's. Either way they drive the state automation: the app is not in `ISSUE_FLOW_OWNERS`, so an app-set `approved` is reverted; its login in the workflow's `ISSUE_FLOW_AGENTS` has the narrow effect that its marker comments are never the author's reply (it matters when the app opened the issue). Their events start workflows like a person's; only `GITHUB_TOKEN` events start none. They never set `status:approved`, never tag, never touch secrets, and merge only their own green `Issue batch` PR; triage changes no code; the implementation agent pushes only its session's branch.
- Security reports go through private advisories (`SECURITY.md`), not public issues; the triage agent closes a public exploit report with a pointer there and no detail.
- Both agents have a per-run budget and turn limit.
