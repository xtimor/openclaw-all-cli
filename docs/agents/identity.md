# Agent identity

Who the issue agents write as. With the relay on, GitHub shows `<app-slug>[bot]` on their comments, labels, and pull requests; with it off they act as the owner through the GitHub connector, as before. Agent-neutral; used by [triage.md](triage.md), [implement.md](implement.md), and [comments.md](comments.md). Design: `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md`.

Why a relay: a cloud session's proxy swaps the owner's credentials into every `api.github.com` request, so an agent in a session can only write as the owner, and going around the proxy is not allowed. So the agent does not hold the app's key. It dispatches the `Agent write` workflow (`.github/workflows/agent-write.yml`) with a list of operations; the workflow mints the app's token from a repository secret and `scripts/agent-write.mjs` applies the operations as the app, with its own guards. Reads stay as they are (any tool, as the session).

## For the agents

At the start of a run, before any GitHub write.

1. **Is the relay on?** `gh api repos/xtimor/openclaw-all-cli/actions/variables/AGENT_APP_ID --jq .name` (through the session's normal access; never bypass the proxy).
   - Answers `AGENT_APP_ID`: the relay is on; continue with step 2.
   - Answers 404: no app is configured. Keep the owner connector, set `ME` as your instructions say (the connector's "get me" call, or `gh api user`), write directly as before, and put "acting as the owner (no agent app configured)" in your report. Skip the rest of this section except step 4.
   - Any other answer (403, 5xx, no answer): stop and report; do not guess.
2. **From here a failed relay stops the run; it never falls back to writing as the owner.** `ME` is the bot login: the value of `ISSUE_FLOW_AGENTS` in `.github/workflows/issue-flow.yml` when it is filled, else the line `agent-write: acting as <login>` of the first relay run's log (`gh run view <id> --log`).
3. **Write through the relay.** Collect the writes of one step into one JSON list in a temporary file outside the repository (for example `/tmp/agent-ops.json`), dispatch, wait for the run, and read the result:

   ```bash
   SINCE="$(date -u -d '-20 seconds' +%Y-%m-%dT%H:%M:%SZ)"
   gh workflow run agent-write.yml --ref main -f ops="$(cat /tmp/agent-ops.json)"
   RUN=""; for _ in $(seq 12); do sleep 5
     RUN="$(gh run list --workflow agent-write.yml --limit 5 --json databaseId,createdAt,event \
       --jq "[.[] | select(.event == \"workflow_dispatch\" and .createdAt >= \"$SINCE\")] | last | .databaseId // empty")"
     [ -n "$RUN" ] && break; done
   [ -n "$RUN" ] || { echo "relay run not found" >&2; exit 1; }   # stop and report
   gh run watch "$RUN" --exit-status || { gh run view "$RUN" --log | grep 'agent-write:' ; exit 1; }   # stop and report
   gh run view "$RUN" --log | grep 'agent-write:'   # who it acted as, and what was applied
   ```

   (Treat an `exit` here as: stop the run and say what failed in your report.) Rules:
   - **One dispatch per issue step**, and **the next only after the previous run has finished**: GitHub keeps one pending run per group, so a run queued behind a running one is dropped when a newer one queues.
   - **Comment and its labels go in the same dispatch**, comment first: operations apply in order, so the state automation sees the comment before the label change. A failure stops the list; the log and the step summary say which operation failed and that the later ones were not applied. Read the issue before dispatching it again; never repeat operations that were applied.
   - The text of every operation is public the moment you dispatch it (workflow inputs are readable by anyone who can read the repository), like the comment itself. Put no secret, token, or environment in it. The workflow echoes no body.
   - The branch of a `pr_create` is pushed first with `git push` from your session (that is git, not the API; the session's own git access is used).
   - Only the owner can dispatch: the relay refuses any other dispatcher. A refused list applies nothing.

   Operations (`scripts/agent-write.mjs` validates the whole list first; at most 50 operations and 60 000 characters):

   | Operation | Fields | Guard in the relay |
   | --- | --- | --- |
   | `comment` | `issue`, `body` | none |
   | `edit_comment` | `comment_id`, `body` | the comment's author must be the app |
   | `labels` | `issue`, `add`?, `remove`? | adds first, then removes; `status:approved` is never added; removing a label that is not set is fine |
   | `close` | `issue`, `reason` (`completed`, `not_planned`, `duplicate`) | an issue, never a pull request |
   | `pr_create` | `head`, `title`, `body`?, `draft`? | `head` must be a `claude/` branch of this repository; base is `main` |
   | `pr_ready` | `pr` | the pull request's author must be the app |
   | `pr_edit` | `pr`, `title`?, `body`? | the pull request's author must be the app |
   | `merge` | `pr`, `sha` | merge method `merge`; refused unless the pull request is open, not a draft, by the app, head branch `claude/` in this repository, base `main`, title starting `Issue batch`, and its head sha is `sha` |

   Example, a triage decision (comment, then labels, in one run):

   ```json
   [
     {"op": "comment", "issue": 12, "body": "<!-- issue-triage -->\n**Status:** ..."},
     {"op": "labels", "issue": 12, "add": ["type:bug", "status:triaged"], "remove": ["status:new"]}
   ]
   ```

   The relay's guards repeat the merge rules of [implement.md](implement.md#merging-the-batch-pull-request); they do not replace the green check, which you still do before you dispatch `merge`. Read back what mattered by REST (step 4), for example the new comment's id from `gh api repos/xtimor/openclaw-all-cli/issues/<n>/comments`, before an `edit_comment`.
4. **Read authors and actors by REST.** `gh pr view --json author` and `gh issue view --json comments` use GraphQL, where an app shows under another name than `<slug>[bot]`. For every check of who wrote or did something, use `gh api` and compare the REST login with `ME`: a pull request's author `gh api repos/xtimor/openclaw-all-cli/pulls/<n> --jq .user.login`; a comment's author `gh api repos/xtimor/openclaw-all-cli/issues/<n>/comments --paginate` (`.user.login`, `.created_at`, `.body`); an event's actor `gh api repos/xtimor/openclaw-all-cli/issues/<n>/events --paginate` (`.actor.login`). Other reads may use any tool.
5. Never print, log, commit, or paste a key, a token, or a JWT. You hold none: the relay does. No `env`, `set -x`, or `gh auth status` output in a report either.

### Your comments

"A comment of yours" (what the prompts call a comment of `ME`) is a comment whose first line is your marker (`<!-- issue-triage -->` or `<!-- issue-impl -->`) and that is, by REST:

- by the app login;
- with the relay on, by an owner (`ISSUE_FLOW_OWNERS` in `.github/workflows/issue-flow.yml`) **and created before the app's first marker comment on that issue** (earlier runs acted as the owner);
- with the relay off, by the owner.

An owner's comment after the app's first marker comment on that issue is never yours, marker or not. `ME` itself is the app login (or the owner with the relay off); the batch pull request's author check is `ME`.

## For the owner

One-time setup (about 10 minutes):

1. GitHub, Settings, Developer settings, GitHub Apps, New GitHub App. Name it (the slug becomes `<slug>[bot]`). Webhook off. Repository permissions: Contents read and write, Issues read and write, Pull requests read and write, Checks read, Commit statuses read, Metadata read. Under "Where can this app be installed", choose "Only on this account" (that limits who may install it; the installation itself is step 2).
2. Install the app on `xtimor/openclaw-all-cli` only (Only select repositories).
3. On the app page, Generate a private key (a `.pem` file downloads). Note the App ID.
4. In the repository (Settings, Secrets and variables, Actions): add the secret `AGENT_APP_PRIVATE_KEY` with the text of the `.pem` file as it is (`gh secret set AGENT_APP_PRIVATE_KEY < key.pem` does it), and the variable `AGENT_APP_ID` with the App ID. The variable switches the relay on for the agents.
5. Delete the `.pem` file from your machine. Do **not** put the key in the routine's cloud environment: the agents never hold it.
6. Check the relay: dispatch `Agent write` by hand (Actions, Agent write, Run workflow, on `main`) with `[{"op": "comment", "issue": <an open issue>, "body": "relay check"}]`. The comment shows the bot, and the run's summary names it (`agent-write: acting as <slug>[bot]` in the log).
7. Put the bot login in `ISSUE_FLOW_AGENTS` in `.github/workflows/issue-flow.yml` (for example `ISSUE_FLOW_AGENTS: "my-agents[bot]"`; comma separated). It is the `<slug>[bot]` of step 6.
8. Run the routine ("Run now") and check that its comments show the bot.

What changes: the agents' comments, labels, and pull requests are the bot's. The bot is not in `ISSUE_FLOW_OWNERS`, so the state automation treats it like any non-owner: an app-set `status:approved` is reverted (and the relay never adds it). `ISSUE_FLOW_AGENTS` has a narrower job: an agent's marker comment (`<!-- issue-triage -->` / `<!-- issue-impl -->`) never counts as the author's reply, which matters when the app itself opened the issue. Events made with an app token start workflows (unlike `GITHUB_TOKEN`), so `Issue flow` and CI run for the agents' labels, closes, comments, and pull requests like for a person's. Only the logins in `ISSUE_FLOW_OWNERS` of `agent-write.yml` may dispatch the relay (keep it equal to `issue-flow.yml`'s), and it runs only on `main`. To go back, delete the variable `AGENT_APP_ID`: the agents act as the owner again.

Rotate the key by generating a new one on the app page, replacing the secret, and deleting the old key there. If the key leaks, delete it on the app page at once; tokens expire within the hour. Repository secrets can be read by anyone who can push a workflow to a branch of the repository, so keep write access small.

The relay mints the token with `scripts/agent-token.mjs` (RS256 JWT, installation token scoped to this repository, one hour). `AGENT_APP_PRIVATE_KEY_B64` (the same PEM as base64) is accepted in its place.
