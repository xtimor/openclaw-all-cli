---
type: epic
title: "Install from npm, released by GitHub CI"
parent: initiative-openclaw-all-cli
covers: []
after: []
assignee: ""
risk: medium
---

# Install from npm, released by GitHub CI

## Description

A person installs the plugin with one command from npmjs.com, and every release is built, checked, and published by GitHub Actions from a git tag. The plugin's settings form in the OpenClaw Control UI reads clearly. It supersedes the initiative's "no public release" decision (user, 2026-10-22).

## Outcome

`openclaw plugins install <package>` installs the current release into a supported OpenClaw, and pushing a tag `vX.Y.Z` is the only manual step of a release.

## Done when

1. A pull request runs typecheck, the unit tests, the build, and a pack check in GitHub Actions; the live suite stays out of CI.
2. Pushing a tag publishes the package to npmjs.com with provenance and attaches the same `.tgz` to a GitHub release; a dry run publishes nothing.
3. In an isolated OpenClaw, `openclaw plugins install` of the published package gives a working `cursor-cli` turn with an OpenClaw tool call.
4. The Control UI settings form for the plugin has labels and help for every field, marks the API key sensitive, and groups the limits as advanced.
5. `docs/setup.md` starts with the short npm install and keeps the build-from-source path for contributors; a release section in `docs/` says how to cut one.

## Boundaries

`package.json`, `openclaw.plugin.json` (`uiHints`), `.github/workflows/`, `docs/`, `README.md`. No change under `src/` except what a published package needs. Installing into the user's own OpenClaw stays epic-cursor-cli entry 18 (hitl). ClawHub is not part of this epic.

## References

- decision superseded — _bmad-output/initiative-openclaw-all-cli/initiative-openclaw-all-cli.md, Notes
- change proposal — _bmad-output/initiative-openclaw-all-cli/change-npm-release-and-settings-form/change-npm-release-and-settings-form.md
- OpenClaw manifest `uiHints` — `.spike/openclaw/node_modules/openclaw/docs/plugins/manifest/setup-and-auth.md`

## Notes

- Unknown: the npm package name and scope (`openclaw-all-cli` unscoped, or `@<scope>/openclaw-all-cli`) and who owns the npm account; the person who owns it creates the publishing credential (hitl, entry 4).
- Decision: npm only; ClawHub is a later choice (user, 2026-10-22).
- Does not wait on epic-cursor-cli entry 18: the install path it exercises is the same plugin, and 18 stays a person's task.
