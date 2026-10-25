---
title: "A changelog in the repository root, kept current by every change"
type: 'feature'
ticket: 9
created: '2026-10-25'
status: built
baseline_revision: 'd9753fbbdb7f1bbf8440d718f7fbabf54058347e'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md', '{project-root}/docs/release.md']
warnings: []
deferred:
  - summary: >-
      The release step that reads CHANGELOG.md was not run on a real GitHub runner.
    evidence: |-
      Tests use a stub npm/gh/git and the repository's Node; a local dry run printed the notes. A runner's setup-node Node and `gh release create --notes-file` are the only parts not exercised. Settled by the next real dispatch.
    location: >-
      scripts/release.sh:187
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** Releases carry only GitHub's generated list of pull request titles (ticket bookkeeping included), and nothing records what a user of the plugin gains per version.

**Approach:** A root `CHANGELOG.md` (Keep a Changelog layout, `Unreleased` on top, past versions filled in) that every user-facing change updates in its own change; `scripts/release.sh` takes the release notes from it (section named for the version, else `Unreleased`, else GitHub's generated notes) and never fails for it.

## Boundaries & Constraints

**Always:** The release stays one action (an empty tag still computes the version), the release guards and the one approval per issue stay as they are, CI never pushes to `main`. A missing, empty, or malformed changelog falls back to generated notes.

**Never:** Edit `AGENTS.md`; edit `tickets.toml`, ticket files, or the runs folder; push or tag.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Named section | `## 1.0.1 - date` has lines | Release notes = that section's body + sha256 line, no generated notes | n/a |
| Unreleased only | no section for the version, `Unreleased` has lines | Notes = `Unreleased` body; log and summary say it still needs stamping | n/a |
| Both | named section and `Unreleased` | The named section wins | n/a |
| Empty / headings only / comments only | no usable section | Generated notes (`--generate-notes`) as today | Release continues, reason printed |
| File missing or unreadable, node missing | no `CHANGELOG.md` | Generated notes | Release continues |
| Stamp | `Unreleased` has lines, version new | `Unreleased` emptied, new `## X - date` section below it with the lines | Refuse: no lines, version exists, bad version or date |
| Dry run | any | Notes preview printed, nothing published | n/a |

</intent-contract>

## Code Map

- `scripts/release.sh` -- creates the GitHub release with `--generate-notes --notes "sha256: ..."`; the step goes after Pack, the `gh release create` args switch to `--notes-file`.
- `scripts/changelog.mjs` (new) -- `section`, `stamp`, `check` over pure functions; Node, like `scripts/sync-labels.mjs`.
- `test/release-script.test.ts` -- stub `npm`/`gh`/`git`, project copy in a temp dir; `gh` stub must keep the `--notes-file` content; the copy needs `scripts/changelog.mjs`.
- `docs/release.md` -- Cut a release, agent flow, new Changelog section; `docs/agents/implement.md` -- rules; `docs/setup.md` Develop; `README.md` Docs list.
- `_bmad/custom/bmad-build-auto.toml`, `bmad-build.toml` (new) -- `persistent_facts` carry the rule into every build.
- Do not change: `.github/workflows/release.yml` (no new input), `package.json` `files` (the changelog stays out of the tarball), guards in `release.sh`.

## Tasks & Acceptance

**Execution:**
- [ ] `CHANGELOG.md` -- Unreleased, 0.1.2 (2026-10-25), 0.1.1 and 0.1.0 (2026-10-22) from tags, releases, and merged history; user-facing lines, issue links -- AC1
- [ ] `scripts/changelog.mjs` -- parse, notes lookup, stamp, validate, CLI -- AC3, AC4
- [ ] `scripts/release.sh` -- notes step, `--notes-file`, fallback, stamp reminder -- AC3, AC4
- [ ] `test/changelog.test.ts` -- notes (named, `Unreleased`, missing, empty), stamp, validate, the real file -- AC1, AC5
- [ ] `test/release-script.test.ts` -- notes cases in the release matrix -- AC3, AC4, AC5
- [ ] docs, build facts, README -- the rule where agents and contributors read it -- AC2

**Acceptance Criteria:**
- Given the repository root, when `CHANGELOG.md` is opened, then `Unreleased`, 0.1.2, 0.1.1, 0.1.0 exist with dates and plain user-facing lines.
- Given a user-facing change, when an agent or contributor follows `docs/agents/implement.md`, `docs/release.md#changelog`, or the build facts, then it adds its line under `Unreleased` in the same change.
- Given a dispatch with an empty or explicit tag, when the release runs, then the GitHub release body is the version's section or `Unreleased`, and `docs/release.md` says the agent stamps in a pull request first.
- Given an empty `Unreleased`, when a release runs, then it still runs with generated notes.
- Given the suite, when it runs, then section extraction is covered and `npm run ci` passes.

## Implementation Notes

Subagents are not available to this worker (the orchestrator allowed it). The full route's implementation and the quick review lens therefore ran in this session.

Decisions: `scripts/changelog.mjs` (Node, like `sync-labels.mjs`) holds the logic so `release.sh` only calls it; `section` exits 1 with a reason when there is nothing, and the release treats any failure of the step as "generated notes". With a section the GitHub release gets `--notes-file` (section, blank line, sha256 line) and no `--generate-notes`; without, the old arguments. Headings are `## X.Y.Z - date` and `## Unreleased` (no link footers, so a section never swallows reference definitions). `stamp` exists so the agent's release flow is mechanical and tested. The changelog is not added to the tarball (`files` unchanged, protected-field change not needed). Build rule carried by `_bmad/custom/bmad-build.toml` and `bmad-build-auto.toml` `persistent_facts` (AGENTS.md untouched). Release dates: 0.1.0 and 0.1.1 2026-10-22, 0.1.2 2026-10-25 (GitHub release time; tag commit is 10-24). 0.1.2 holds every merged change since 0.1.1, which includes #8, #10, #12, #13 (docs only, host cause), #9, #11, #14 as user-facing lines; process work (agents, relay, tickets) is left out except the issue forms and security policy.

Files: `CHANGELOG.md`, `scripts/changelog.mjs`, `scripts/release.sh`, `test/changelog.test.ts`, `test/release-script.test.ts`, `docs/release.md`, `docs/agents/implement.md`, `docs/setup.md`, `README.md`, `_bmad/custom/bmad-build.toml`, `_bmad/custom/bmad-build-auto.toml`, `MEMORY.md`.

## Plan Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 5 findings — high 0, medium 2, low 2, false 0, maybe-false 1
- findings (the quick lens ran in this session, by inspection of the diff against the criteria):
  - `[medium]` `[patch]` An owner dispatch from the Actions UI that used `Unreleased` leaves those lines there, so the agent's next stamp would release them twice — the flow in `docs/release.md` now checks the latest release body first and stamps those lines under the released version.
  - `[medium]` `[patch]` The changelog step ran with the job tokens in its environment although the checks do not get them — `env -u` the same four variables; a test shows the step sees none.
  - `[low]` `[patch]` The "no process noise" test matched the bare words ticket and backlog, which a user line could use — narrowed to ticket numbers, `backlog`, run log, `_bmad`, `MEMORY.md`, batch PR.
  - `[low]` `[reject]` The changelog is not in the npm tarball — the criteria do not ask for it, and `files` is a guarded field; GitHub and the repository are where it is read.
  - `[maybe-false]` `[defer]` The step on a real runner (setup-node's Node, `gh --notes-file`) — see `deferred`.

## Design Notes

Section names: `## Unreleased` and `## X.Y.Z - YYYY-MM-DD` (brackets and a `v` prefix are read too). A section ends at the next `## ` heading. Content = a line that is not blank, not a heading, not inside an HTML comment. Release flow: the agent computes the version (as `docs/release.md` says), runs `node scripts/changelog.mjs stamp X.Y.Z <today>` in a pull request, merges it, then dispatches with that tag. An owner dispatch from the UI with lines still under `Unreleased` releases them as the notes; `main` keeps them there until an agent stamps (the summary says so), because CI never pushes to `main`.

## Verification

**Commands:**
- `.spike/node/bin/node node_modules/vitest/vitest.mjs run test/changelog.test.ts test/release-script.test.ts` -- expected: pass
- `npm run ci` -- expected: All checks passed.

## Auto Run Result

**Summary.** Root `CHANGELOG.md` with Unreleased and 0.1.2, 0.1.1, 0.1.0. `scripts/changelog.mjs` extracts a version's section (else Unreleased, else nothing), stamps Unreleased into a version section, and checks the layout. `scripts/release.sh` gives the GitHub release that text plus the sha256 line, and falls back to generated notes on any failure, so an owner dispatch with an empty changelog still releases. The agent's release flow stamps in a pull request, merges it, then dispatches with the explicit tag; CI pushes nothing. Rule placed in `docs/release.md#changelog`, `docs/agents/implement.md`, `docs/setup.md`, and the BMAD build facts.

**Files changed.** See Implementation Notes.

**Review.** Patches applied: 3 (2 medium, 1 low). Deferred: 1. Rejected: 1 (low, changelog not in the tarball).

**Verification.** `npx vitest run test/changelog.test.ts test/release-script.test.ts`: 83 passed. Three mutations failed their named tests (notes-file plus generate-notes, no Unreleased fallback, inverted step condition) and were restored. `RELEASE_TAG=v0.1.3 DRY_RUN=true scripts/release.sh` printed the Unreleased notes and the stamp reminder. `npm run ci`: All checks passed.

**Residual risks.** The runner path is unverified (deferred). The stamp-after-owner-dispatch step rests on an agent following the docs.
