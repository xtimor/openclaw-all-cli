# Agent identity

Who the issue agents write as. With the relay on, GitHub shows `<app-slug>[bot]` on their comments, labels, and pull requests; with it off they act as the owner through the GitHub connector, as before. Agent-neutral; used by [triage.md](triage.md), [implement.md](implement.md), and [comments.md](comments.md). Design: `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md`.

Why a relay: a cloud session's proxy swaps the owner's credentials into every `api.github.com` request, so an agent in a session can only write as the owner, and going around the proxy is not allowed. From a session, `gh workflow run`, `gh run watch`, `gh run list`, and reads work; repository settings (Actions variables and secrets) and run logs are refused. So the agent does not hold the app's key. It dispatches the `Agent write` workflow (`.github/workflows/agent-write.yml`) with a list of operations; the workflow mints the app's token from an environment secret and `scripts/agent-write.mjs` applies the operations as the app, with its own guards. Reads stay as they are (any tool, as the session). The agent reads every effect back by REST; it cannot read the relay's log.

## For the agents

At the start of a run, before any GitHub write.

1. **Is the relay on?** The repository file `.github/agent-identity.json` on `main` says: `{"login": "<app-slug>[bot]"}`. Read it from `main`, not from your branch:

   ```bash
   gh api 'repos/xtimor/openclaw-all-cli/contents/.github/agent-identity.json?ref=main' --jq .content | base64 -d | jq -r '.login // empty'
   ```

   - A login (`<slug>[bot]`): the relay is on; that login is `ME`. Continue with step 2.
   - 404 (no file), or an empty or missing `login`: no relay. Keep the owner connector, set `ME` as your instructions say (the connector's "get me" call, or `gh api user`), write directly as before, and put "acting as the owner (no agent app configured)" in your report. Skip to step 4.
   - Any other answer (no answer, 403, a file that is not JSON, a login that does not end in `[bot]`): stop and report; do not guess.
2. **From here a failed relay stops the run; it never falls back to writing as the owner.**
3. **Write through the relay.** Collect the writes of one step into one JSON list and write it to a file under `/tmp` with the Write tool (not a shell heredoc or function, no ad hoc wrapper scripts: the session's permission check denies those). Then run exactly this, from the repository root, with nothing before it (no `cd ... &&`, no environment prefix, no absolute path, no pipe), one call per dispatch:

   ```bash
   scripts/agent-relay.sh /tmp/agent-ops-<n>.json
   ```

   The allow rules in `.claude/settings.json` match only that command shape (`scripts/agent-relay.sh <file>`); any other shape is not allowed and a refused call stops the run.

   The script (`scripts/agent-relay.sh`, the only relay entry point the repository's `.claude/settings.json` allows) dispatches `agent-write.yml` on `main` with the file's text, watches the run, checks that it concluded `success`, and prints the run id. It waits until the run is `completed` (polling every 10 s for about 20 minutes after `gh run watch`). It exits non-zero with a one-line reason on stderr when the file is missing, not a JSON array, or over 60 000 bytes (exit 2, nothing dispatched; split the step), the dispatch fails, no run id comes back, the run did not succeed (`relay run <id>: <conclusion>`), or it is still running after the wait (`relay run <id> still <status>; do not re-dispatch, read back first`: then read the effects back by REST and dispatch only what is missing). Treat a non-zero exit as: stop the run and say what failed in your report, after the read-back below. It never touches the proxy variables.

   If your `gh` prints no run URL (an older version), the script stops with "no run id"; list the runs instead and take the newest `workflow_dispatch` run created after the dispatch: `gh api 'repos/xtimor/openclaw-all-cli/actions/workflows/agent-write.yml/runs?event=workflow_dispatch&per_page=5' --jq '.workflow_runs[] | [.id, .created_at, .actor.login] | @tsv'` (the actor is the owner).

   **Read every effect back by REST** (step 4), whether the run succeeded or not: the comment by `ME` on the issue, the issue's labels and state, the pull request by head branch (`gh api 'repos/xtimor/openclaw-all-cli/pulls?head=xtimor:<branch>&state=all'`), its draft and merged state. **Never repeat operations that a failed run may have applied without reading back first**, and then dispatch only what is still missing. Rules:
   - **One dispatch per issue step**, and the next only after the previous run has finished. Runs do not queue safely when two are pending.
   - **Comment and its labels go in the same dispatch**, comment first: operations apply in order, so the state automation sees the comment before the label change. A failure stops the list; later operations are not applied.
   - The text of every operation is public the moment you dispatch it (workflow inputs are readable by anyone who can read the repository), like the comment itself. Put no secret, token, or environment in it. The workflow echoes no body.
   - The branch of a `pr_create` is pushed first with `git push` from your session (that is git, not the API; the session's own git access is used).
   - Only the owner can dispatch, and only the first attempt of a run counts: the relay refuses another dispatcher, a different person who re-runs a run, and any re-run. A refused list applies nothing.

   Operations (`scripts/agent-write.mjs` validates the whole list first; at most 50 operations and 60 000 characters):

   | Operation | Fields | Guard in the relay |
   | --- | --- | --- |
   | `comment` | `issue`, `body` | none |
   | `edit_comment` | `comment_id`, `body` | the comment's author must be the app |
   | `labels` | `issue`, `add`?, `remove`? | only `status:`, `type:`, `priority:`, `source:` names in lowercase (`status:[a-z0-9-]`); `status:approved` is never added; no name in both lists; adds first, then removes; removing a label that is not set is fine |
   | `close` | `issue`, `reason` (`completed`, `not_planned`, `duplicate`) | an issue, never a pull request |
   | `reopen` | `issue` | an issue, never a pull request |
   | `pr_create` | `head`, `title`, `body`?, `draft`? | `head` must be a `claude/` branch of this repository; base is `main` |
   | `pr_ready` | `pr` | the pull request's author must be the app |
   | `pr_edit` | `pr`, `title`?, `body`? | the pull request's author must be the app |
   | `pr_close` | `pr` | closes only an open draft pull request by the app, head branch `claude/` in this repository, title exactly `Issue batch (in progress)`, not updated for 2 hours or more (an interrupted batch; see [implement.md](implement.md#before-the-batch)); anything else is refused |
   | `merge` | `pr`, `sha` | method `merge`; refused unless the pull request is open, not a draft, by the app, head branch `claude/` in this repository, base `main`, title starting `Issue batch`, head sha equal to `sha`, mergeable state `clean`, the check run named `check` present and `success` on that sha, every other check run completed `success`, `skipped`, or `neutral`, and the combined commit status not `failure`/`pending`/`error` (no statuses at all is fine) |

   Example, a triage decision (comment, then labels, in one run):

   ```json
   [
     {"op": "comment", "issue": 12, "body": "<!-- issue-triage -->\n**Status:** ..."},
     {"op": "labels", "issue": 12, "add": ["type:bug", "status:triaged"], "remove": ["status:new"]}
   ]
   ```

   The relay's merge guards repeat the merge rules of [implement.md](implement.md#merging-the-batch-pull-request), including green checks; you still do that check and the wait before you dispatch `merge`, and you pass the sha you checked. Beyond those guards the relay does not judge: whether a comment is right, or which issue to close, is yours.
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
4. In the repository, Settings, Environments, New environment `agent`. Under Deployment branches and tags choose "Selected branches and tags" and add `main`. Add the environment secret `AGENT_APP_PRIVATE_KEY` with the text of the `.pem` file as it is (`gh secret set AGENT_APP_PRIVATE_KEY --env agent < key.pem` does it) and the environment variable `AGENT_APP_ID` with the App ID. No repository-level secret or variable is needed. The environment is what keeps the key from a copy of the workflow file on another branch: a run on any other ref cannot use it.
5. Delete the `.pem` file from your machine. Do **not** put the key in the routine's cloud environment: the agents never hold it.
6. Check the relay: dispatch `Agent write` by hand (Actions, Agent write, Run workflow, on `main`) with `[{"op": "comment", "issue": <an open issue>, "body": "relay check"}]`. The comment shows the bot; the run's summary names it (`Acting as <slug>[bot]`).
7. Switch the agents to the relay: add `.github/agent-identity.json` on `main` with `{"login": "<slug>[bot]"}` (you, or an agent session at your request, in a pull request or a commit), and put the same login in `ISSUE_FLOW_AGENTS` in `.github/workflows/issue-flow.yml` (for example `ISSUE_FLOW_AGENTS: "my-agents[bot]"`; comma separated).
8. Run the routine ("Run now") and check that its comments show the bot.

What changes: the agents' comments, labels, and pull requests are the bot's. The bot is not in `ISSUE_FLOW_OWNERS`, so the state automation treats it like any non-owner: an app-set `status:approved` is reverted (and the relay never adds it). `ISSUE_FLOW_AGENTS` has a narrower job: an agent's marker comment (`<!-- issue-triage -->` / `<!-- issue-impl -->`) never counts as the author's reply, which matters when the app itself opened the issue. Events made with an app token start workflows (unlike `GITHUB_TOKEN`), so `Issue flow` and CI run for the agents' labels, closes, comments, and pull requests like for a person's.

What the relay enforces, in `scripts/agent-write.mjs`: the dispatcher and the person who started the run are in `ISSUE_FLOW_OWNERS` of `agent-write.yml` (keep it equal to `issue-flow.yml`'s), the run is attempt 1 (no replays), it runs only on `main` in the `agent` environment, at most 50 operations and 60 000 characters, nothing is applied when any operation is refused, application stops at the first failure, and the per-operation guards in the table above (including green checks for a merge). The private key is not passed to the script that handles the operations, and the token is revoked when the step ends. The agents still check before they dispatch (merge rules, who wrote what).

To go back to the owner connector, empty the `login` in `.github/agent-identity.json` (or remove the file).

Rotate the key by generating a new one on the app page, replacing the environment secret, and deleting the old key there. If the key leaks, delete it on the app page at once; tokens expire within the hour.

The relay mints the token with `scripts/agent-token.mjs` (RS256 JWT, installation token scoped to this repository, one hour). The script also accepts the same PEM as base64 in `AGENT_APP_PRIVATE_KEY_B64`; if both variables are set they must hold the same key.
