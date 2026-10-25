---
id: 9
type: story
title: "A changelog in the repository root, kept current by every change"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
---

# A changelog in the repository root, kept current by every change

## Description

The repository gets `CHANGELOG.md` in its root: user-facing release notes per version, newest first, with an `Unreleased` section at the top. Every change that alters what a user of the plugin sees (behavior, setup, config, docs a user follows, a fixed issue) adds its line under `Unreleased` in the same change. A release turns `Unreleased` into the version's section, and the GitHub release shows that section. Past versions `0.1.0`, `0.1.1`, `0.1.2` are filled in from their tags and releases.

## Acceptance Criteria

1. **The file exists with history**
   **Given** the repository root
   **When** a reader opens `CHANGELOG.md`
   **Then** it has `Unreleased` and sections for `0.1.2`, `0.1.1`, `0.1.0` with release dates, in Keep a Changelog style (Added, Changed, Fixed, as needed), user-facing lines in plain words with issue links where an issue exists, and no internal process noise (ticket bookkeeping, run logs)
2. **Every change keeps it current**
   **Given** the agent instructions (`docs/agents/implement.md`, and the build rules agents follow) and the contributor docs
   **When** a change alters what a user sees
   **Then** it adds its line under `Unreleased` in the same pull request; internal-only changes (CI, agent flow, tests, tickets) add none
3. **A release uses it**
   **Given** a release dispatched with an empty or explicit tag
   **When** it runs
   **Then** the GitHub release notes carry the `Unreleased` section (or the section already named for that version), and the changelog on `main` names the version and date after the release, without CI pushing commits to `main` (`docs/release.md` says how, for example the agent's "release" flow moves `Unreleased` in a pull request before it dispatches)
4. **A release never fails for an empty changelog**
   **Given** an empty `Unreleased`
   **When** the owner dispatches a release
   **Then** the release still runs, and the notes fall back to the generated ones
5. **Tests and checks**
   **Given** the suite
   **When** it runs
   **Then** tests cover extracting a section (named version, `Unreleased`, missing, empty), and `npm run ci` passes

## Boundaries

- Must not change: the one-action release (empty tag computes the version), the release guards, CI never pushing to `main`, and the owner's single approval per issue.
- Do not edit `AGENTS.md` (owner permission needed); put the rule in `docs/` and the agent docs.

## References

- docs — docs/release.md
- docs — docs/agents/implement.md
- releases — https://github.com/xtimor/openclaw-all-cli/releases

## Notes

- Owner asked on 2026-10-25: a release-notes file in the root, kept up to date.
- Decision (2026-10-25): name `CHANGELOG.md` (the convention npm and GitHub readers look for), Keep a Changelog layout.
- Risk medium: the release script and the issue agents' rules change.
