---
title: 'Agent writes go through a GitHub Actions relay that acts as the agent app'
type: 'feature'
ticket: 15
created: '2026-10-23'
status: 'in-progress'
baseline_revision: '19fe7f20987b15329f45b1704828ac51aa68a842'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/identity.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The cloud session's proxy swaps the owner's credentials into every `api.github.com` request, so agents in a session can only write as the owner; bypassing the proxy is not allowed.

**Approach:** Agents dispatch an `Agent write` workflow with a JSON list of operations; the workflow mints the app's installation token from repository secrets and a tested script applies the operations as `<app-slug>[bot]`, with its own guards.

## Boundaries & Constraints

**Always:** the key lives only in the repository secret `AGENT_APP_PRIVATE_KEY`; `AGENT_APP_ID` is a repository variable. The token is never printed (`::add-mask::` it). Workflow inputs reach scripts only through `env`, never interpolated into `run:` text. Actions pinned by full SHA like the other workflows (`actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`), `permissions: {}` at the top level and `contents: read` for the job (the app token does the writes). Runs only on `main` (`if: github.ref == 'refs/heads/main'`). Operations apply in order and stop at the first failure (later ones not applied; summary says which). Without `AGENT_APP_ID` set the agents write as the owner exactly as before.

**Never:** add `status:approved`; merge anything but the agent's own batch PR; touch another repository; bypass the session proxy; add a new dependency or third-party action.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Comment then label | `[{op:"comment",issue:12,body},{op:"labels",issue:12,add:["status:triaged"],remove:["status:new"]}]` | POST comment, then POST labels, then DELETE label, in that order | — |
| Edit own comment | `{op:"edit_comment",comment_id,body}`, comment author is the app | PATCH | author not the app → refused, exit 1 |
| Close | `{op:"close",issue,reason:"not_planned"}` | PATCH state closed with state_reason | bad reason → refused |
| PR create | `{op:"pr_create",head:"claude/x",title,body,draft:true}` | POST pulls base main; summary shows the number | head not `claude/` → refused |
| PR ready / edit | `{op:"pr_ready",pr}` / `{op:"pr_edit",pr,title?,body?}` | GraphQL markReadyForReview via REST-equivalent or `PATCH` (edit) | PR author not the app → refused |
| Merge | `{op:"merge",pr,sha}` | PUT merge, method merge, sha | PR draft, closed, author not app, head not `claude/`, title not `Issue batch`, sha mismatch → refused before the call |
| Approval | labels add `status:approved` | refused, nothing applied | exit 1 |
| Dispatcher | `github.actor` not in `ISSUE_FLOW_OWNERS` | refused, nothing applied | exit 1 |
| Size | more than 50 ops or input over 60 000 chars | refused | exit 1 |
| Unknown op | `{op:"delete"}` | refused, nothing applied (validate all first) | exit 1 |
| No token leak | any | token and key never in stdout/stderr/summary | — |

</intent-contract>

## Code Map

- `scripts/agent-token.mjs` (exists, ticket 3.14) -- accepts `AGENT_APP_PRIVATE_KEY_B64` or a raw PEM (readKey accepts `-----BEGIN`); in the workflow pass the secret as `AGENT_APP_PRIVATE_KEY_B64` env holding the raw PEM, or add a clean `AGENT_APP_PRIVATE_KEY` name that takes the PEM (prefer: accept `AGENT_APP_PRIVATE_KEY` raw PEM as an alternative variable; update its tests). Its proxy branch (`setGlobalProxyFromEnv`) stays harmless on runners.
- `scripts/agent-write.mjs` (new) -- `node scripts/agent-write.mjs` reads `AGENT_WRITE_OPS` (JSON), `GH_TOKEN` (app token), `GITHUB_REPOSITORY`, `GITHUB_ACTOR`, `ISSUE_FLOW_OWNERS`, `GITHUB_API_URL`, `AGENT_LOGIN`; validates everything first, then applies in order with `fetch` (REST; for "ready for review" use the GraphQL `markPullRequestReadyForReview` mutation via `POST /graphql`, the only API for it); writes a Markdown summary to `GITHUB_STEP_SUMMARY` (op, target, result, created ids/numbers; never bodies' secrets — bodies are not echoed). Reuse `parseOwners` from `scripts/issue-flow/transitions.mjs`.
- `test/agent-write.test.ts` (new) -- local `http` stub like `test/agent-token.test.ts`; covers every matrix row.
- `.github/workflows/agent-write.yml` (new) -- `workflow_dispatch` input `ops` (string, required); `concurrency: agent-write` (queue, no cancel); job: checkout, setup-node `24.22.0` (same pin and `NODE_VERSION` env style as `ci.yml`/`release.yml`), step "Token": `TOKEN=$(node scripts/agent-token.mjs)`, `echo "::add-mask::$TOKEN"`, write to `$GITHUB_ENV`-free handoff (prefer one step that mints and runs the writer in the same shell, so the token never leaves the process env); `LOGIN=$(node scripts/agent-token.mjs --login)`; `ISSUE_FLOW_OWNERS` copied from issue-flow.yml's value (keep both in sync: note it in both files).
- `.github/workflows/issue-flow.yml:39` -- `ISSUE_FLOW_AGENTS` stays `""` until the bot login is known (the orchestrator fills it after the first live run).
- `docs/agents/identity.md` -- rewrite "For the agents": relay on when `gh api repos/xtimor/openclaw-all-cli/actions/variables/AGENT_APP_ID` answers 200 (through the normal session access; never bypass the proxy); write ops to a temp file outside the repo, `gh workflow run agent-write.yml --ref main -f ops="$(cat ops.json)"`, find the run (`gh run list --workflow agent-write.yml --limit 5 --json databaseId,createdAt,event` after the dispatch time), `gh run watch <id> --exit-status`, read the result back by REST; one dispatch per issue step (comment and its labels together, so the comment-before-label order holds inside one run). Remove the session-side mint, `AGENT_APP_*` cloud variables, `agh`, and the proof call. Owner setup: create the app (keep), install, generate the key, add secret `AGENT_APP_PRIVATE_KEY` (raw PEM) and variable `AGENT_APP_ID`; do not put the key in the cloud environment. Keep "Your comments" and the REST author checks; `ME` = the bot login (from the relay run summary, or `ISSUE_FLOW_AGENTS`).
- `docs/agents/triage.md`, `docs/agents/implement.md` -- where they say to write (comment, label, close, PR, merge), point to identity.md's relay; the merge rules stay, and the relay re-checks them.
- `docs/issues.md`, `issue-flow.md`, `epic-distribution.md` (decision 2026-10-23), `MEMORY.md` (replace the 3.14 cloud-variable lines with the proxy finding and the relay).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/agent-write.mjs`, `test/agent-write.test.ts` -- the relay logic and guards -- writes as the app, safely
- [ ] `scripts/agent-token.mjs` (+ test) -- raw PEM variable -- secret as stored
- [ ] `.github/workflows/agent-write.yml` -- the relay workflow -- identity without the proxy
- [ ] `docs/agents/identity.md`, `triage.md`, `implement.md` -- agents use the relay -- behavior
- [ ] `docs/issues.md`, `issue-flow.md`, `epic-distribution.md`, `MEMORY.md` -- docs of record

**Acceptance Criteria:**
- Given the secret and variable set, when an agent dispatches `Agent write` with a comment, then the comment appears under `<app-slug>[bot]` and the run summary names the bot.
- Given no `AGENT_APP_ID` variable, when a run starts, then agents write as the owner as before.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx vitest run test/agent-write.test.ts test/agent-token.test.ts test/issue-flow.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."
