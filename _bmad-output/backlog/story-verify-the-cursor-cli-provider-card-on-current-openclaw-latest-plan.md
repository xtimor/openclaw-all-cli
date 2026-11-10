---
title: 'Verify the cursor-cli provider card on current OpenClaw latest'
type: 'chore'
ticket: 21
created: '2026-11-05'
status: done
baseline_revision: '7a315009cecd12acc41595e2b34a222cb036e1ce'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['inline-self-review']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two display points of the Control UI Model Providers card for `cursor-cli` are unmeasured on a current OpenClaw: whether Connect provider is offered for a provider with `auth: []`, and what the card shows after the CLI login is lost while the Gateway runs.

**Approach:** Measure the card in an isolated stand on npm `latest` OpenClaw with the packed plugin (valid login, login moved aside with the Gateway running, restored, plus an unconfigured control), record models and a turn per state, and write the findings to `docs/`. No plugin change.

</intent-contract>

## Tasks & Acceptance

**Acceptance Criteria:**
- Given the isolated stand, when the card is read per state, then credential line, Connect provider, models, and a turn are recorded in `docs/providers/cursor-card-latest.md` with OpenClaw version and date, plus the control.
- Given a state the host cannot measure, when recorded, then it says "not run" with the reason.
- Given the change, when `npm run ci` runs, then it passes.

## Implementation Notes

Route: oneshot (docs only, measurement). Stand: `.spike/card-latest` (OpenClaw 2026.10.10 from npm `latest`, plugin from `npm pack`), port 18931, Playwright Chromium on `/model-providers`.

- The host has an API key and no `cursor-agent` login (`cursor-agent status`: `Not logged in`), so state (a) "valid login" is not run; key states stand in. `cli-config.json` holds no credential, so moving it aside changed nothing; removing the key was the closest lost-credential state.
- Card line is `Not configured` and Connect provider is shown in every state. Key in the Gateway environment does not change the line (contradicted `docs/setup.md`, corrected). Models drop to 1 without a credential and return within about 14 s of the key, no restart. Control provider: same line, button `Set API key`.
- `~/.cursor/cli-config.json` was rewritten by `cursor-agent` itself during the first turn (adds `selectedModel` default, `updatedAt`), before the backup copy was taken, so the original 837-byte file could not be restored byte for byte; the restored file is the post-turn version (same settings, model Auto).
- Files: `docs/providers/cursor-card-latest.md` (new), `docs/setup.md`, `docs/providers/cursor.md`, `README.md`, `CHANGELOG.md`.

## Plan Change Log

## Review Triage Log

### 2026-11-05 - Review pass
- verdicts: 1 findings - high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` The quick-review subagent could not be launched (this session has no subagent tool), so the diff was self-reviewed against the plan's ACs and the docs against the recorded measurements; no defect found. Rejected: nothing to fix, and a re-run needs a session with subagents.

## Verification

**Commands:**
- `npm run ci` -- expected: passes
- `node scripts/plan-gate.mjs <plan>` -- expected: passes

## Auto Run Result

- Summary: measured the `cursor-cli` provider card on OpenClaw 2026.10.10 (npm `latest`) in an isolated stand with the packed plugin. Credential line `Not configured` and Connect provider shown in every state; models and turn per state recorded; control provider card recorded (`Set API key`). Valid-login state not run (no login on this host). Docs corrected where a stated limit changed (key in the Gateway environment does not change the card).
- Files: `docs/providers/cursor-card-latest.md` (findings), `docs/setup.md`, `docs/providers/cursor.md` (pointer), `README.md` (link), `CHANGELOG.md` (one line), this plan.
- Review: no patches, no deferred items; one rejected row (see the log: review ran inline, no subagent available).
- Verification: `npm run ci` passed ("All checks passed."); `node scripts/plan-gate.mjs` run on this plan.
- Residual risks: the login-only card is unmeasured; `~/.cursor/cli-config.json` was restored to its post-turn form (cursor-agent had rewritten it before the backup).
