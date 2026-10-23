# Agent identity

Who the issue agents write as. With a GitHub App, GitHub shows `<app-slug>[bot]` on their comments, labels, and pull requests; without one they act as the owner through the GitHub connector, as before. Agent-neutral; used by [triage.md](triage.md), [implement.md](implement.md), and [comments.md](comments.md). Design: `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md`.

## For the agents

At the start of a run, before any GitHub write. A variable is **set** when it is non-empty after trimming, as the script reads it.

1. Neither `AGENT_APP_ID` nor `AGENT_APP_PRIVATE_KEY_B64` set: no app is configured. Keep the owner connector, set `ME` as your instructions say (the connector's "get me" call, or `gh api user`), and put "acting as the owner (no agent app configured)" in your report. Only one set: a setup error; stop and report (the script names the missing variable, exit 2).
2. Both set: the app is configured, and from here **a failed mint stops the run; it never falls back to the owner.** Mint once into a variable and stop on any failure or an empty value:

   ```bash
   TOKEN="$(node scripts/agent-token.mjs)" || { echo "agent token failed" >&2; exit 1; }   # stop and report
   [ -n "$TOKEN" ] || { echo "agent token empty" >&2; exit 1; }                              # stop and report
   ME="$(node scripts/agent-token.mjs --login)" || { echo "agent login failed" >&2; exit 1; }
   ```

   (Treat an `exit` here as: stop the run and say what failed in your report.) An empty `GH_TOKEN` would make `gh` use other credentials, which is why the check comes before any write.
3. Do **every** GitHub write with `gh` under that token, **directly, not through the session proxy**: the cloud session's proxy replaces the `Authorization` header of `api.github.com` requests with the owner's credentials, so a write sent through it lands under the owner's name whatever `GH_TOKEN` says. Clear the proxy variables for that one command:

   ```bash
   agh() { env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy GH_TOKEN="$TOKEN" gh "$@"; }
   agh api /installation/repositories --jq .total_count >/dev/null || { echo "app token did not reach GitHub" >&2; exit 1; }   # proof, before the first write
   agh issue comment 12 --body-file /tmp/c.md
   agh issue edit 12 --add-label status:triaged --remove-label status:new
   agh issue close 12 --reason "not planned"
   agh pr create --draft --base main --head "$BRANCH" --title "Issue batch (in progress)" --body-file /tmp/pr.md
   agh pr ready 20
   agh pr merge 20 --merge --match-head-commit "$SHA"
   agh api -X PATCH repos/xtimor/openclaw-all-cli/issues/comments/<id> -f body="$(cat /tmp/c.md)"
   ```

   The proof call answers only for an installation token; through the proxy (owner credentials) it fails, so a run whose writes would land as the owner stops before the first one. The token lives one hour. Mint again only when it is older than about 50 minutes (note the time of the mint), with the same checks. If each of your commands runs in a fresh shell, repeat the mint, the `agh` definition, and the proof at the top of every command that writes, and put the writes of one step in that one command. Reads may go through the proxy.
4. **Read authors and actors by REST.** `gh pr view --json author` and `gh issue view --json comments` use GraphQL, where an app shows under another name than `<slug>[bot]`. For every check of who wrote or did something, use `gh api` and compare the REST login with `ME`: a pull request's author `gh api repos/xtimor/openclaw-all-cli/pulls/<n> --jq .user.login`; a comment's author `gh api repos/xtimor/openclaw-all-cli/issues/<n>/comments --paginate` (`.user.login`, `.created_at`, `.body`); an event's actor `gh api repos/xtimor/openclaw-all-cli/issues/<n>/events --paginate` (`.actor.login`). Other reads may use any tool.
5. `git push` of your session branch still uses the session's git access (it is not a GitHub API write); the pull request you open from it is the app's.
6. Never print, log, commit, or paste the key, the token, or a JWT: no `echo "$TOKEN"`, `set -x`, `env`, or `gh auth status`; no token in a command line, URL, remote, file in the repository, comment, or report. The script prints only the token (or the login) and never the key.

Exit codes of `scripts/agent-token.mjs`: 0 ok; 1 the key or GitHub failed (the message has the status, no secret); 2 a variable is missing or malformed.

### Your comments

"A comment of yours" (what the prompts call a comment of `ME`) is a comment whose first line is your marker (`<!-- issue-triage -->` or `<!-- issue-impl -->`) and that is, by REST:

- by the app login;
- with an app configured, by an owner (`ISSUE_FLOW_OWNERS` in `.github/workflows/issue-flow.yml`) **and created before the app's first marker comment on that issue** (earlier runs acted as the owner);
- without an app, by the owner.

An owner's comment after the app's first marker comment on that issue is never yours, marker or not. `ME` itself is the app login (or the owner without an app); the batch pull request's author check is `ME`.

## For the owner

One-time setup (about 10 minutes):

1. GitHub, Settings, Developer settings, GitHub Apps, New GitHub App. Name it (the slug becomes `<slug>[bot]`). Webhook off. Repository permissions: Contents read and write, Issues read and write, Pull requests read and write, Checks read, Commit statuses read, Metadata read. Under "Where can this app be installed", choose "Only on this account" (that limits who may install it; the installation itself is step 2).
2. Install the app on `xtimor/openclaw-all-cli` only (Only select repositories).
3. On the app page, Generate a private key (a `.pem` file downloads). Note the App ID.
4. Base64 the key on one line: `base64 -w0 key.pem` (macOS: `base64 -i key.pem`).
5. In the routine's cloud environment (claude.ai/code, the "Triage issues" task's environment, secrets) set `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY_B64`. Optional: `AGENT_APP_REPO` (default `xtimor/openclaw-all-cli`).
6. Delete the `.pem` file and the base64 text from your machine. The key lives only in that environment; never put it in the repository or in a GitHub secret.
7. Put the bot login in `ISSUE_FLOW_AGENTS` in `.github/workflows/issue-flow.yml` (for example `ISSUE_FLOW_AGENTS: "my-agents[bot]"`; comma separated). To read the login without the key: it is `<slug>[bot]` on the app's public page, or run the script once with the variables set: `node scripts/agent-token.mjs --login`.
8. Run the routine ("Run now") and check that its comment shows the bot.

What changes: the agents' comments, labels, and pull requests are the bot's. The bot is not in `ISSUE_FLOW_OWNERS`, so the state automation treats it like any non-owner: an app-set `status:approved` is reverted. `ISSUE_FLOW_AGENTS` has a narrower job: an agent's marker comment (`<!-- issue-triage -->` / `<!-- issue-impl -->`) never counts as the author's reply, which matters when the app itself opened the issue. Events made with an app token start workflows (unlike `GITHUB_TOKEN`), so `Issue flow` and CI run for the agents' labels, closes, comments, and pull requests like for a person's. To go back, unset the two variables: the agents act as the owner again.

Rotate the key by generating a new one on the app page, replacing the variable, and deleting the old key there. If the key leaks, delete it on the app page at once; tokens expire within the hour.

If `GET /app` is not reachable from the routine's network (a restricted proxy), `--login` reads the slug from the installation instead; the token path needs `GET /repos/{repo}/installation` and `POST /app/installations/{id}/access_tokens`. The script connects to GitHub directly and never through the session proxy (which would swap in the owner's credentials); with `NODE_USE_ENV_PROXY` set it re-runs itself without it.
