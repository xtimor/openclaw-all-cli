# Agent identity

Who the issue agents write as. With a GitHub App, GitHub shows `<app-slug>[bot]` on their comments, labels, and pull requests; without one they act as the owner through the GitHub connector, as before. Agent-neutral; used by [triage.md](triage.md), [implement.md](implement.md), and [comments.md](comments.md). Design: `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md`.

## For the agents

At the start of a run, before any GitHub write:

1. If neither `AGENT_APP_ID` nor `AGENT_APP_PRIVATE_KEY_B64` is set, no app is configured: keep the owner connector, set `ME` as your instructions say (the connector's "get me" call, or `gh api user`), and put "acting as the owner (no agent app configured)" in your report. If only one is set, that is a setup error: stop and report it (the script names the missing variable, exit 2).
2. Else set `ME="$(node scripts/agent-token.mjs --login)"` (`<app-slug>[bot]`). If it fails, stop and report; do not fall back to the owner when the app is configured but broken.
3. Do **every** GitHub write with `gh` under the app's token: comments and their edits, labels, closing an issue, creating or editing a pull request, marking it ready, merging it. Pass the token in the environment of that one command:

   ```bash
   GH_TOKEN="$(node scripts/agent-token.mjs)" gh issue comment 12 --body-file /tmp/c.md
   GH_TOKEN="$(node scripts/agent-token.mjs)" gh issue edit 12 --add-label status:triaged --remove-label status:new
   GH_TOKEN="$(node scripts/agent-token.mjs)" gh issue close 12 --reason "not planned"
   GH_TOKEN="$(node scripts/agent-token.mjs)" gh pr create --draft --base main --head "$BRANCH" --title "Issue batch (in progress)" --body-file /tmp/pr.md
   GH_TOKEN="$(node scripts/agent-token.mjs)" gh pr ready 20
   GH_TOKEN="$(node scripts/agent-token.mjs)" gh pr merge 20 --merge --match-head-commit "$SHA"
   GH_TOKEN="$(node scripts/agent-token.mjs)" gh api -X PATCH repos/xtimor/openclaw-all-cli/issues/comments/<id> -f body="$(cat /tmp/c.md)"
   ```

   If your shell keeps variables between commands you may `export GH_TOKEN="$(node scripts/agent-token.mjs)"` once instead, and re-mint before a write when the token is older than about 50 minutes (it lives one hour). A session's own `GH_TOKEN` is the owner's or the platform's; the per-command prefix overrides it only for that command.
4. Reads may use any tool. `git push` of your session branch still uses the session's git access (it is not a GitHub API write); the pull request you open from it is the app's.
5. Never print, log, commit, or paste the key, the token, or a JWT: no `echo`, `set -x`, `env`, or `gh auth status`; no token in a command line, URL, remote, file in the repository, comment, or report. The script prints only the token (or the login) and never the key.

Exit codes of `scripts/agent-token.mjs`: 0 ok; 1 the key or GitHub failed (the message has the status, no secret); 2 a variable is missing or malformed.

`ME` is this login. The batch pull request's author check is `ME`. Comments you wrote before the app was set up carry the owner's login: a marker comment by the owner counts as yours too when you look for your earlier comments.

## For the owner

One-time setup (about 10 minutes):

1. GitHub, Settings, Developer settings, GitHub Apps, New GitHub App. Name it (the slug becomes `<slug>[bot]`). Webhook off. Repository permissions: Contents read and write, Issues read and write, Pull requests read and write, Checks read, Commit statuses read, Metadata read. Install on only this account.
2. Install the app on `xtimor/openclaw-all-cli` only (Only select repositories).
3. On the app page, Generate a private key (a `.pem` file downloads). Note the App ID.
4. Base64 the key on one line: `base64 -w0 key.pem` (macOS: `base64 -i key.pem`).
5. In the routine's cloud environment (claude.ai/code, the "Triage issues" task's environment, secrets) set `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY_B64`. Optional: `AGENT_APP_REPO` (default `xtimor/openclaw-all-cli`).
6. Delete the `.pem` file and the base64 text from your machine. The key lives only in that environment; never put it in the repository or in a GitHub secret.
7. Put the bot login in `ISSUE_FLOW_AGENTS` in `.github/workflows/issue-flow.yml` (for example `ISSUE_FLOW_AGENTS: "my-agents[bot]"`; comma separated). To read the login without the key: it is `<slug>[bot]` on the app's public page, or run the script once with the variables set: `node scripts/agent-token.mjs --login`.
8. Run the routine ("Run now") and check that its comment shows the bot.

What changes: the agents' comments, labels, and pull requests are the bot's. The state automation treats the bot like any non-owner for approvals (an app-set `status:approved` is reverted), and ignores its `<!-- issue-triage -->` / `<!-- issue-impl -->` comments as the author's reply because of `ISSUE_FLOW_AGENTS`. Events made with an app token start workflows (unlike `GITHUB_TOKEN`), so the state automation and CI run for the agents' pull requests. To go back, unset the two variables: the agents act as the owner again.

Rotate the key by generating a new one on the app page, replacing the variable, and deleting the old key there. If the key leaks, delete it on the app page at once; tokens expire within the hour.

If `GET /app` is not reachable from the routine's network (a restricted proxy), `--login` reads the slug from the installation instead; the token path needs `GET /repos/{repo}/installation` and `POST /app/installations/{id}/access_tokens`. Node's `fetch` ignores `HTTPS_PROXY` unless told: the script enables it itself on Node 24.13+, and on older Node set `NODE_USE_ENV_PROXY=1`.
