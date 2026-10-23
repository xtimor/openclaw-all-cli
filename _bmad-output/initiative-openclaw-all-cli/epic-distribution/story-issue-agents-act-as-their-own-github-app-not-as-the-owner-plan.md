---
title: 'Issue agents act as their own GitHub App, not as the owner'
type: 'feature'
ticket: 14
created: '2026-10-23'
status: 'in-review'
baseline_revision: '15fa8d8af552e3535a96637d3a3e57707a5b3177'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every comment, label, pull request, and merge of the triage and implementation agents appears under the owner's name, because they write through the owner's GitHub connector.

**Approach:** The owner creates a GitHub App installed on this repository only; the agents mint a short-lived installation token from two environment variables and do every GitHub write with `gh` under that token, so GitHub shows the app's bot login. Without the variables nothing changes.

## Boundaries & Constraints

**Always:** the private key and tokens are never printed, logged, committed, or put in a command line visible in output (pass the token through `GH_TOKEN` in the environment of the `gh` call). Tokens are re-minted when older than ~50 minutes. The owner remains the only approver: an app-set `status:approved` is reverted like anyone's. The script uses only Node's standard library (no new dependency).

**Never:** store the key in the repository or a workflow secret; change release or CI workflows; let the app approve itself; drop the owner fallback.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Token | `AGENT_APP_ID`, `AGENT_APP_PRIVATE_KEY_B64` set; API returns the installation and a token | prints only the token to stdout | — |
| Login | `--login` flag | prints `<app-slug>[bot]` | — |
| Missing vars | either variable unset | exit 2, message names the missing variable, nothing printed to stdout | exit 2 |
| Bad key | key not a valid PEM after base64 decode | exit 1, message without the key | exit 1 |
| API error | 401/404 from GitHub | exit 1 with status and API message, no key or JWT in output | exit 1 |
| Agent marker by agent | `<!-- issue-impl -->` comment by a login in `ISSUE_FLOW_AGENTS` on needs-info | no status change | — |
| Approval by agent | `status:approved` labeled by the agent login | reverted (agent is not an owner) | — |

</intent-contract>

## Code Map

- `scripts/agent-token.mjs` (new) -- reads `AGENT_APP_ID`, `AGENT_APP_PRIVATE_KEY_B64`, optional `AGENT_APP_REPO` (default `xtimor/openclaw-all-cli`) and `GITHUB_API_URL` (default `https://api.github.com`, tests point it at a local server); builds an RS256 JWT with `node:crypto` (`iat` now-60, `exp` now+540, `iss` app id), `GET /repos/{repo}/installation`, `POST /app/installations/{id}/access_tokens`, prints the token; `--login` prints `GET /app` slug + `[bot]`. Uses global `fetch`; honors `HTTPS_PROXY` only if Node does by default (document that `gh` is the fallback: `gh api` can't mint, so the script must work through the session proxy — test it live).
- `test/agent-token.test.ts` (new) -- spawn the script against a local `http` server with a generated RSA key (`crypto.generateKeyPairSync`): verify the JWT signature and claims, the two calls, stdout is only the token, missing vars exit 2, bad key exit 1, API 401 exit 1, and the key/JWT never appear in stdout or stderr.
- `scripts/issue-flow/transitions.mjs` (`onComment`, `isOwner` use ~213-221; `parseOwners`) + `scripts/issue-flow/apply.mjs` (`runEvent` reads `env.ISSUE_FLOW_OWNERS`) -- add `ISSUE_FLOW_AGENTS` (same parser); an agent marker comment by an owner OR an agent login is ignored as a reply. Approval logic untouched (agents are not owners).
- `.github/workflows/issue-flow.yml:32-34` -- `ISSUE_FLOW_AGENTS:` with a placeholder value the owner fills (empty is fine) and a comment.
- `test/issue-flow.test.ts` -- agent-login marker comment on needs-info: no change; agent-login approval: reverted.
- `docs/agents/identity.md` (new) -- for the agents: at the start of a run, if both variables are set, `export GH_TOKEN="$(node scripts/agent-token.mjs)"` (never echo it), `ME="$(node scripts/agent-token.mjs --login)"`, do every GitHub write with `gh` (`gh issue comment`, `gh issue edit --add-label`, `gh pr create/ready/merge --match-head-commit`, `gh api`), re-mint before writes after ~50 min; reads may use any tool; if unset, keep the owner connector and say "acting as the owner (no agent app configured)" in the report. For the owner: create the app (Settings → Developer settings → GitHub Apps → New; webhook off; repository permissions Contents RW, Issues RW, Pull requests RW, Checks R, Commit statuses R, Metadata R; only this account), install it on this repository only, generate a private key, base64 it (`base64 -w0 key.pem` / macOS `base64 -i key.pem`), set `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY_B64` in the routine's cloud environment, add the bot login to `ISSUE_FLOW_AGENTS`, delete the local key file.
- `docs/agents/triage.md`, `docs/agents/implement.md`, `docs/agents/comments.md` -- "`ME` is the login of your GitHub access" → see `identity.md`; the batch-PR merge rule's author check is `ME`; the PR's head branch rule stays.
- `docs/issues.md`, `issue-flow.md`, `epic-distribution.md` (decision 2026-10-23), `MEMORY.md` -- the agents' identity and setup link.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/agent-token.mjs`, `test/agent-token.test.ts` -- token and login -- the identity
- [ ] `scripts/issue-flow/*`, `.github/workflows/issue-flow.yml`, `test/issue-flow.test.ts` -- `ISSUE_FLOW_AGENTS` -- agent comments are not replies
- [ ] `docs/agents/identity.md`, `triage.md`, `implement.md`, `comments.md` -- the agents use it -- behavior
- [ ] `docs/issues.md`, `issue-flow.md`, `epic-distribution.md`, `MEMORY.md` -- docs of record and owner setup

**Acceptance Criteria:**
- Given the two variables in the routine's environment and the app installed, when a run comments, labels, or opens and merges its batch PR, then GitHub shows the app's bot login.
- Given no variables, when a run starts, then it works as before and its report says it acted as the owner.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx vitest run test/agent-token.test.ts test/issue-flow.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."
