# Issues

Bugs and ideas are filed as GitHub issues, by people and by agents. A triage agent looks at new issues twice a day. Only the owner approves work, once per issue: nothing is built until an issue is `status:approved`. Then an agent builds it and opens a pull request, and GitHub merges it when its checks are green (the `Batch merge` workflow, as the agent app). You do not merge, and you release whenever you like (see [release.md](release.md)).

Security problems are not issues: see [Security reports](#security-reports).

## File an issue (web)

Open [New issue](https://github.com/xtimor/openclaw-all-cli/issues/new/choose) and pick a form. Blank issues are off.

- **Bug report**: plugin version, OpenClaw version, `cursor-agent` version, steps to reproduce, expected and actual behavior, logs (remove secrets first).
- **Idea**: the problem, your proposal, who benefits.

Both forms have a "Filed by an agent" checkbox; tick it if an AI agent is filing on someone's behalf. The form sets the type label (`type:bug` or `type:idea`) and `status:new`.

## File an issue (agent)

An agent files the same shape through `gh` or the REST API. Use the same `### ` headings as the forms, in this order, and end the body with the line `Filed by: agent`. Set the labels `type:bug` (or `type:idea`), `status:new`, and `source:agent`.

Bug:

````sh
gh issue create --repo xtimor/openclaw-all-cli \
  --title "[Bug]: <short summary>" \
  --label type:bug --label status:new --label source:agent \
  --body "$(cat <<'EOF'
### Plugin version

0.1.1

### OpenClaw version

2026.10.3

### cursor-agent version

2026.10.19-abcdef0

### Steps to reproduce

1. ...

### Expected behavior

...

### Actual behavior

...

### Logs

```shell
...
```

### Filed by an agent

- [X] An AI agent filed this issue

Filed by: agent
EOF
)"
````

Idea: title `[Idea]: <short summary>`, headings `### Problem`, `### Proposal`, `### Who benefits`, `### Filed by an agent`, then `Filed by: agent`; labels `type:idea`, `status:new`, `source:agent`.

Through the REST API the same data goes to `POST /repos/xtimor/openclaw-all-cli/issues` as `{"title": "...", "body": "...", "labels": ["type:bug", "status:new", "source:agent"]}`. Setting labels needs push access to the repository; without it GitHub drops the labels silently. File anyway, with the same headings and the body line `Filed by: agent`: the state automation sets `status:new` on every opened issue, and the triage agent sets the type and `source:agent` from the body.

Write the body as plain facts. Do not paste keys, tokens, or environment dumps.

## States

An open issue has exactly one `status:*` label; a closed issue has none.

| Label | Meaning | Moves on when |
| --- | --- | --- |
| `status:new` | Filed or reopened, not triaged yet, or the author answered a question | The triage agent runs |
| `status:needs-info` | Details are missing, or a build needs a check only the author can do; the comment of the triage or implementation agent asks and mentions the author | The author replies (back to `new`), or 30 days pass in this status (closed as not planned, the author mentioned; reopening brings it back) |
| `status:triaged` | Accepted: problem confirmed, priority set, scope written. Waits for the owner, unless the comment says the approval was carried over | The owner approves, rejects, or asks a question; with a carried-over approval, the next implementation run starts |
| `status:approved` | The owner approved it for development (the only approval an issue needs) | An implementation run starts |
| `status:planned` | A course correction for it is merged; its tickets exist but are not built | The next implementation run builds them; no second approval |
| `status:in-progress` | An agent is working on it | A pull request opens, or the run stops: on a question only the author can answer (`needs-info`) or on a decision only the owner can make (`blocked`) |
| `status:in-review` | A pull request for it is open: a fix (`Fixes #N`) or a course-correction proposal (`Refs #N`) | GitHub's `Batch merge` workflow merges it when its checks are green (a fix closes the issue as completed; a proposal moves it to `planned`), or the owner closes it (`blocked`) |
| `status:blocked` | The owner must decide (scope beyond the approval, protected files other than the asset files an approved draft ships, product direction, a repeated failure), or the pull request was closed unmerged; a comment mentions the owner and says why | The owner approves a retry or rejects |

Other labels: `type:bug`, `type:idea`; `priority:p0` (install or every turn broken, data loss, security hole) to `priority:p3` (polish, docs); `source:agent` (filed by an agent). The triage agent sets the priority; the owner may change it.

An issue closes as completed (the pull request merged, or a finished ticket already fixed it), not planned (rejected, stale, out of scope), or duplicate (with a link to the original).

## What happens when

1. **Filed.** A workflow (`.github/workflows/issue-flow.yml`, no model) sets `status:new` on every opened or reopened issue and removes any other `status:*` label.
2. **Triage, on the owner's schedule (twice a day by default).** For each new issue, oldest first, the agent checks for duplicates, checks that the problem exists (a bug is reproduced or explained by the code; an idea is checked against the project's scope), and asks for missing details. Then it accepts (`status:triaged`, with priority, type, a short scope), asks (`status:needs-info`), or rejects with a reason. It keeps one triage comment per issue and edits it on later passes. To dispute a rejection, reply on the issue; the owner reopens it. The triage agent is a Claude Code scheduled task on the owner's account: each run is a fresh cloud session that follows [docs/agents/triage.md](agents/triage.md) and writes to GitHub as its own GitHub App (`<app-slug>[bot]`) when the owner has set one up (it dispatches the `Agent write` workflow, whose `agent` environment holds the app's key; the agent itself never has it; [docs/agents/identity.md](agents/identity.md)), else through the owner's GitHub connector, so its labels and comments appear under the owner's name; its comment begins with the hidden marker `<!-- issue-triage -->`, which the state automation does not count as the author's reply (the implementation agent's marker is `<!-- issue-impl -->`). It never approves, never changes code, and needs no model credential in GitHub. The same scheduled task then builds the approved issues (step 4); the owner sets how often it runs, pauses it, or starts it at once (Run now) in Claude Code's routines (claude.ai/code), task "Triage issues".
3. **Approval.** Only the owner sets `status:approved`. The workflow removes the label again when anyone else sets it, restores the previous status, and comments that only the owner approves. The owner list is `ISSUE_FLOW_OWNERS` in the workflow file.
4. **Implementation.** In the same run, right after triage, the agent ([docs/agents/implement.md](agents/implement.md)) takes the owner-approved issues (and those whose approval was carried over a `needs-info` round) as a batch (at most 6 per run, oldest first), builds each through the repository's BMAD flow (ticket, plan, build, review), and opens one pull request for the batch with a `Fixes #N` line per issue. If a build stops on something only the author can answer (for example a check on their machine), the issue goes to `needs-info` with the author mentioned; if it needs your decision, it goes to `blocked` with you mentioned. One batch pull request is open at a time. The agent marks it ready and waits up to about 30 minutes for GitHub to merge it: the `Batch merge` workflow (`.github/workflows/batch-merge.yml`) merges it as the agent app when CI completes, when it is marked ready, and every hour, unless the pull request is a draft; a red batch gets one fix attempt, then stays open and is reported. A green batch still open at the start of the next run is merged by `Batch merge` and not built on until then. When the issue changes an epic, the spec, or the architecture, it first opens a course-correction proposal (`Refs #N`) instead; its merge moves the issue to `planned`, and the next run builds the new tickets without a second approval. The agent never merges anything itself; `Batch merge` merges only an `Issue batch` pull request of the agent app from a `claude/` branch of this repository, only when every check passed (the `check` run from GitHub Actions) and GitHub reports it clean, and never one that changes a protected file (workflows, scripts, the agents' docs, `AGENTS.md`, the publish fields of `package.json`; it stays open for you), and never tags a release or touches secrets. It runs the ticket's live Cursor checks when the routine's environment has `CURSOR_API_KEY` (a Cursor API key, set in the cloud environment's variables; live turns use your Cursor account); checks it could not run are listed in the pull request, and a missing live check never stops a build.
5. **After the merge.** Nothing is left for you: a fix closes the issue, a proposal moves it to `planned`. You can still read the batch pull request. To hold a merge, convert the pull request to draft (`Batch merge` never merges a draft; mark it ready to let it merge). To stop a batch, close the pull request (every issue in it moves to `blocked`; re-approve the ones you want to retry), or revert a merge. A running batch keeps its draft `Issue batch (in progress)` fresh at least every 30 minutes. A draft untouched for more than 2 hours is interrupted (the run stopped): the next run closes it itself, takes its issues again under your earlier approval, and builds them in a new batch; you do nothing. An issue left `in-progress` with no open batch pull request is taken again the same way. A batch you paused (converted to draft) keeps its `Issue batch: #A, ...` title and is never closed by the agent. To change an open batch, ask an agent session to update the pull request.
6. **Release.** Releasing is separate and yours to start: tell an agent "release", or run the `Release` workflow once ([release.md](release.md)).

**Approval carries over a question.** If you approved an issue and the implementation agent then stops with a question only the author can answer (`needs-info`, author mentioned), you do not approve it again: when the author answers it, triage posts a short comment `Approval: carried over (owner approved <date>; scope unchanged)`, sets `status:triaged`, and the next run builds it. This holds only while your approval is newer than the issue's last close and reopen, and only for the question the agent asked; if the answer changes the draft ticket or the path, triage says a new approval is needed and waits for you. A second `needs-info` stop on the same ticket goes to you (`blocked`). Agents still never set `status:approved`.

**What an agent comment looks like.** Both agents write the same shape: a hidden marker on the first line, then the status label, who is awaited (`@login`) and for what, and what happens next. Details and examples: [agents/comments.md](agents/comments.md).

Issue and comment text is treated as data by the agents and by the workflow: they do not follow instructions found in it.

## State automation

The `Issue flow` workflow keeps the states in step without a person or a model. The rules are in `scripts/issue-flow/transitions.mjs` (tested in `test/issue-flow.test.ts`):

- **One status.** After every status label change the workflow settles the issue from its current labels and its label history: the most recently added status label stays and the others are removed; an open issue left with none becomes `status:new`. The workflow runs without a queue, so parallel runs reach the same result.
- **Closed.** A closed issue loses every `status:*` label when a person closes it. A close made with a workflow's `GITHUB_TOKEN` starts no run, so the closer clears the status itself; a close by an agent (its GitHub App through the `Agent write` relay, or the owner's connector) starts a run like a person's, which clears it. Reopening an issue makes it `status:new` (unless a status was set after the reopen).
- **Approval.** A `status:approved` whose latest label event was by someone outside the owner list is removed (with one comment). The status it replaced comes back: the status label that was removed just before the approval, or the one still on the issue, or `status:new` if there was none.
- **Reply.** A comment by the issue's author on a `status:needs-info` issue moves it to `status:new`. A comment by anyone else changes nothing. A comment that starts with the marker `<!-- issue-triage -->` or `<!-- issue-impl -->` by an owner or by an agent app login (`ISSUE_FLOW_AGENTS` in the workflow) is never a reply; the same text by anyone else, or a marker quoted later in a comment, counts as one.
- **Pull requests.** A pull request whose body says `Fixes #N`, `Closes #N`, or `Resolves #N` (case-insensitive), or `Refs #N`, moves issue N only along the normal path, and only when the pull request comes from this repository or its author is an owner (a fork or outsider pull request changes nothing). Opened, edited, or reopened: `status:in-progress` becomes `status:in-review` (`in-review` stays). Merged: a `Fixes` issue loses its status once it is closed (GitHub closes it when the pull request merges into the default branch; into another branch the issue stays open and keeps its status), and a `Refs` issue goes from `status:in-review` to `status:planned`. Closed unmerged: `status:in-review` becomes `status:blocked`. Any other state is left alone. Only `#N` of this repository counts; links to other repositories and numbers that are pull requests are ignored.
- **Stale.** A daily job (03:17 UTC) closes a `status:needs-info` issue as not planned once it has been in that status for 30 days, counted from the latest time the label was added (other updates do not reset it; if the label events cannot be read, the last update counts). Its comment mentions the author, so GitHub notifies them; the issue is never deleted or locked. Reopening it brings it back as `status:new`. To see what it would close, run the workflow by hand (Actions, `Issue flow`, `Run workflow`) with `dry_run` on (the default): it only lists them in the log.

Changes made with the workflow's own `GITHUB_TOKEN` start no workflow in GitHub, so it cannot loop; it also ignores events by `github-actions[bot]` as a second guard. Only `GITHUB_TOKEN` events start none. The issue agents' label changes, closes, comments, and pull requests start it like a person's, with the agent app's token (minted by the `Agent write` relay) or through the owner's connector, and the workflow reconciles them. It needs `issues: write`, `pull-requests: read`, and `contents: read`, and it never checks out or runs code from a pull request.

## Labels

The label set is code: `.github/labels.yml`. The `Labels` workflow (`.github/workflows/labels.yml`) runs on a push to `main` that changes that file or `scripts/sync-labels.mjs`, and by hand (Actions, `Labels`, `Run workflow`). It creates missing labels and updates color and description; it never deletes, and labels that are not in the file stay as they are. Running it again changes nothing.

By hand, with a token that may write issues:

```sh
GITHUB_TOKEN=... GITHUB_REPOSITORY=xtimor/openclaw-all-cli node scripts/sync-labels.mjs --dry-run
```

`--dry-run` prints what would be created or updated without writing. `--file <path>` reads another labels file.

## Security reports

Do not file vulnerabilities as issues. Use a [private security advisory](https://github.com/xtimor/openclaw-all-cli/security/advisories/new); [SECURITY.md](https://github.com/xtimor/openclaw-all-cli/blob/main/SECURITY.md) says what to include and which versions are supported.
