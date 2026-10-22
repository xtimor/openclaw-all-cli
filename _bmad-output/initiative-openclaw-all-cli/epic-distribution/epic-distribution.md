---
type: epic
title: "Install from npm, released by GitHub CI, and the GitHub issue loop"
parent: initiative-openclaw-all-cli
covers: []
after: []
assignee: ""
risk: medium
---

# Install from npm, released by GitHub CI, and the GitHub issue loop

## Description

A person installs the plugin with one command from npmjs.com, and every release is built, checked, and published by GitHub Actions from a git tag. The plugin's settings form in the OpenClaw Control UI reads clearly. People and agents file bugs and ideas as GitHub issues; a triage agent works through them twice a day, the owner approves what gets built, and an implementation agent opens the pull request ([issue flow](issue-flow.md)). It supersedes the initiative's "no public release" decision (user, 2026-10-22).

## Outcome

`openclaw plugins install <package>` installs the current release into a supported OpenClaw, and pushing a tag `vX.Y.Z` is the only manual step of a release. An open issue is either waiting on its author, waiting on the owner, being built, or closed with a reason; it never sits untriaged for more than half a day.

## Done when

1. A pull request runs typecheck, the unit tests, the build, and a pack check in GitHub Actions; the live suite stays out of CI.
2. Pushing a tag publishes the package to npmjs.com with provenance and attaches the same `.tgz` to a GitHub release; a dry run publishes nothing.
3. In an isolated OpenClaw, `openclaw plugins install` of the published package gives a working `cursor-cli` turn with an OpenClaw tool call.
4. The Control UI settings form for the plugin has labels and help for every field, marks the API key sensitive, and groups the limits as advanced.
5. `docs/setup.md` starts with the short npm install and keeps the build-from-source path for contributors; a release section in `docs/` says how to cut one.
6. A person or an agent files a bug or an idea through a form or as `docs/issues.md` says, and it gets `status:new`.
7. Twice a day the triage agent leaves every `status:new` issue in `needs-info`, `triaged` (with priority), or closed with a reason; a dry run writes nothing.
8. Only the owner's `status:approved` starts an implementation run, which ends in a PR with `Fixes #N` (or a course-correction proposal PR) or in `status:blocked` with a reason; merging the PR closes the issue.
9. Every change an issue leads to is a BMAD ticket with a build plan and a review in the ticket store (`bmad-ticket`, `bmad-build-auto`, `bmad-correct-course`); no agent changes code outside that flow.

## Boundaries

`package.json`, `openclaw.plugin.json` (`uiHints`), `.github/` (workflows, issue forms, labels), `scripts/issue-flow/`, `SECURITY.md`, `docs/`, `README.md`. No change under `src/` except what a published package needs. Installing into the user's own OpenClaw stays epic-cursor-cli entry 18 (hitl). ClawHub is not part of this epic.

## References

- decision superseded — _bmad-output/initiative-openclaw-all-cli/initiative-openclaw-all-cli.md, Notes
- change proposal — _bmad-output/initiative-openclaw-all-cli/change-npm-release-and-settings-form/change-npm-release-and-settings-form.md
- issue flow — _bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md
- change proposal — _bmad-output/initiative-openclaw-all-cli/change-github-issue-loop/change-github-issue-loop.md
- OpenClaw manifest `uiHints` — `.spike/openclaw/node_modules/openclaw/docs/plugins/manifest/setup-and-auth.md`

## Notes

- Decision: package `openclaw-all-cli`, unscoped; the owner (xtimor) holds the npm account (user, 2026-10-22).
- Decision: full automation: a tag publishes with no human step, via npm trusted publishing (OIDC, `--allow-publish`). npm needs the package to exist before a trust can be set, so only the first release is staged (`npm stage publish`) with a granular token without 2FA bypass, "Read and write (stage only)", as secret `NPM_TOKEN`; the owner approves it once with 2FA, then runs `npm trust github ... --allow-publish` and deletes the token. Bypass-2FA tokens are not used (npm removes direct token publish in January 2027) (user, 2026-10-22).
- Decision: release flow: the agent asks the owner "release?" and, on approval, does everything itself (dispatches `release.yml` on `main`, which creates the tag); the owner pushes no tag. npm's own 2FA steps (approving the first staged version, `npm trust`) stay the owner's (user, 2026-10-22).
- Decision: the name `openclaw-all-cli` was free on npmjs.com (registry 404, 2026-10-22); the owner created `NPM_TOKEN` (stage only, no bypass) as a repository secret (user, 2026-10-22).
- Decision: npm only; ClawHub is a later choice (user, 2026-10-22).
- Does not wait on epic-cursor-cli entry 18: the install path it exercises is the same plugin, and 18 stays a person's task.
- Decision: issues are the intake for bugs and ideas from people and agents; a triage agent runs twice a day, may reject on its own, and hands accepted issues to the owner; only the owner approves development (user, 2026-10-22).
- Decision: states are `status:*` labels with the flow in `issue-flow.md`; triage twice a day (05:46 and 17:46 UTC); issue text is untrusted input (agent, 2026-10-22). Superseded in part: the agents do not run in GitHub Actions.
- Decision: the triage and implementation agents run as Claude Code scheduled tasks on the owner's subscription (fresh cloud session per firing, GitHub through the owner's connector, prompts in `docs/agents/`); no model credential in GitHub; implementation every 3 hours plus on demand (user, 2026-10-22; change agents-as-claude-code-scheduled-tasks).
- Decision: the implementation run works in batches: all owner-approved issues, oldest first, at most 6 or about 3 hours per run, each with its own BMAD ticket and plan, one PR per batch with a `Fixes #N` line per issue (user, 2026-10-22). One routine runs both agents in one session per firing (triage, then implementation); the owner created it in the claude.ai UI (agent-created scheduled tasks get no repository) and sets its frequency (user, 2026-10-22).
- Requirement: every development, bug fix, and course correction goes through the BMAD flow in this repo; the per-state mapping of skills is in `issue-flow.md` (user, 2026-10-22).
