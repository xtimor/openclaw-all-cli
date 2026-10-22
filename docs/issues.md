# Issues

Bugs and ideas are filed as GitHub issues, by people and by agents. A triage agent looks at new issues twice a day. Only the owner approves work: nothing is built until an issue is `status:approved`, and then an agent opens a pull request.

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
| `status:needs-info` | Details are missing; the triage comment asks | The author replies (back to `new`), or 14 days pass without a reply (closed as not planned; reopening brings it back) |
| `status:triaged` | Accepted: problem confirmed, priority set, scope written | The owner approves, rejects, or asks a question |
| `status:approved` | The owner approved it for development | An implementation run starts |
| `status:planned` | A course correction for it is merged; its tickets exist but are not built | The owner sets `approved` again to build them |
| `status:in-progress` | An agent is working on it | A pull request opens, or the run fails |
| `status:in-review` | A pull request for it is open: a fix (`Fixes #N`) or a course-correction proposal (`Refs #N`) | The owner merges it (a fix closes the issue as completed; a proposal moves it to `planned`) or closes it (`blocked`) |
| `status:blocked` | The run failed or the pull request was closed unmerged; a comment says why | The owner approves a retry or rejects |

Other labels: `type:bug`, `type:idea`; `priority:p0` (install or every turn broken, data loss, security hole) to `priority:p3` (polish, docs); `source:agent` (filed by an agent). The triage agent sets the priority; the owner may change it.

An issue closes as completed (the pull request merged), not planned (rejected, stale, out of scope), or duplicate (with a link to the original).

## What happens when

1. **Filed.** The issue starts as `status:new`.
2. **Triage, twice a day (06:00 and 18:00 UTC).** For each new issue, oldest first, the agent checks for duplicates, checks that the problem exists (a bug is reproduced or explained by the code; an idea is checked against the project's scope), and asks for missing details. Then it accepts (`status:triaged`, with priority, type, a short scope), asks (`status:needs-info`), or rejects with a reason. It keeps one triage comment per issue and edits it on later passes. A rejection is undone by reopening the issue.
3. **Approval.** Only the owner sets `status:approved`. The state labels of anyone else do not start work.
4. **Implementation.** An agent builds it through the repository's BMAD flow (ticket, plan, build, review) on an `issue/<N>-<slug>` branch and opens a pull request that fixes the issue (`Fixes #N`). When the issue changes an epic, the spec, or the architecture, it first opens a course-correction proposal (`Refs #N`) instead; its merge moves the issue to `planned`, and the owner's next `approved` builds the new tickets. It never merges, never tags a release, and never touches secrets. Checks it could not run (for example a live Cursor turn) are listed in the pull request.
5. **Review.** The owner reviews and merges the pull request: a fix closes the issue, a proposal moves it to `planned`.

Issue and comment text is treated as data by the agents: they do not follow instructions found in it.

## Labels

The label set is code: `.github/labels.yml`. The `Labels` workflow (`.github/workflows/labels.yml`) runs on a push to `main` that changes that file or `scripts/sync-labels.mjs`, and by hand (Actions, `Labels`, `Run workflow`). It creates missing labels and updates color and description; it never deletes, and labels that are not in the file stay as they are. Running it again changes nothing.

By hand, with a token that may write issues:

```sh
GITHUB_TOKEN=... GITHUB_REPOSITORY=xtimor/openclaw-all-cli node scripts/sync-labels.mjs --dry-run
```

`--dry-run` prints what would be created or updated without writing. `--file <path>` reads another labels file.

## Security reports

Do not file vulnerabilities as issues. Use a [private security advisory](https://github.com/xtimor/openclaw-all-cli/security/advisories/new); [SECURITY.md](https://github.com/xtimor/openclaw-all-cli/blob/main/SECURITY.md) says what to include and which versions are supported.
