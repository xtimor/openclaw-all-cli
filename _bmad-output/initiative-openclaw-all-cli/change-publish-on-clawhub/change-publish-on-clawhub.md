---
type: change
title: "Publish the plugin on ClawHub, the OpenClaw marketplace"
parent: initiative-openclaw-all-cli
date: 2026-11-11
scope: moderate
status: approved
---

# Change: publish the plugin on ClawHub, the OpenClaw marketplace

## Issue summary

The owner wants the plugin listed in the OpenClaw marketplace (user, 2026-11-11). Today it ships only on npmjs.com (v0.1.7, 2026-11-10). OpenClaw's docs name ClawHub as the main discovery surface for community plugins (`openclaw plugins search`, `openclaw plugins install clawhub:<name>`). An npm install also warns that the package is outside ClawHub review, and the Gateway logs `plugin provenance-invalid`, because OpenClaw verifies ClawHub and official sources only (README, `docs/setup.md`).

The owner made the strategic call. The tactics below are the agent's (AGENTS.md: the user decides strategy only).

## Impact analysis

- **Decision superseded.** "npm only; ClawHub is a later choice" (user, 2026-10-22) in the initiative Notes, epic-distribution Notes and Boundaries, the architecture Deferred entry "ClawHub stays deferred", and `MEMORY.md`. New decision: publish on ClawHub as well; npm stays.
- **Epic impact.** epic-distribution grows by three stories (30 to 32); its Outcome and Done when gain a ClawHub line. epic-cursor-cli and epic-antigravity-cli are unchanged.
- **Spec and PRD.** No capability covers distribution (`covers = []`), so the spec is not edited.
- **Artifacts.** `package.json` (`openclaw.build.openclawVersion` is missing; `openclaw.compat.pluginApi` is set), `openclaw.plugin.json` (an optional single `categories` slug), `.github/workflows/release.yml` and CI, `docs/release.md`, `docs/setup.md`, `README.md`, and MEMORY.md. No change under `src/`.
- **What ClawHub needs (from `openclaw/clawhub` docs/publishing.md and the `clawhub` CLI 0.25.1 README, read 2026-11-11):**
  - A code plugin is published with `clawhub package publish <tgz> --family code-plugin`, from the exact `npm pack` tarball. `clawhub package validate <source>` and `--dry-run` check it first.
  - The package needs `openclaw.plugin.json`, plus `package.json` `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion`. Every declared entry must ship: `openclaw.runtimeExtensions` points at `dist/plugin.js`, which we publish.
  - `assets/icon.png` (a PNG of at most 512 KiB) becomes the catalog icon. We already ship it.
  - The package scope must match the publishing owner. Whether an unscoped name like `openclaw-all-cli` is accepted is not documented and was not tested.
  - A new release stays hidden until ClawHub's security checks pass.
  - The first publish must be manual or use a token. After it, GitHub Actions trusted publishing (OIDC, `workflow_dispatch`) through the reusable `openclaw/clawhub/.github/workflows/package-publish.yml` needs no stored token. Our releases already run by `workflow_dispatch`.
- **Not run here.** Running the `clawhub` CLI (validate, dry run) was refused in this session's sandbox as code from outside. Ticket 30 runs it in CI.
- **Risk.** A published release cannot be quietly withdrawn, and the name and owner on ClawHub are hard to change later (transfer needs admin on both sides). The ClawHub account and the first credential are the owner's.

## Recommended approach

Direct adjustment: three stories in epic-distribution, in this order.

| Ticket | What | Risk | Notes |
| --- | --- | --- | --- |
| 30 | A package ClawHub accepts: `openclaw.build.openclawVersion`, one manifest category, the ClawHub name settled by a dry run, and validation plus a dry-run publish in CI on pull requests | medium | unknown: whether an unscoped name is accepted |
| 31 | The release also publishes to ClawHub: the same `.tgz` as npm, through the reusable workflow pinned by SHA, first with `CLAWHUB_TOKEN`, then trusted publishing; a dry run publishes nothing | high | hitl: the owner signs in to ClawHub with GitHub and adds the `CLAWHUB_TOKEN` secret once |
| 32 | Install from ClawHub proven and documented: `openclaw plugins install clawhub:<name>` gives a working turn on current OpenClaw; README and `docs/setup.md` lead with it, npm stays the fallback; the review and provenance notes are corrected | medium | after the first ClawHub release passes review |

Effort: about a day of agent work for 30 and 31; 31 then waits on the owner's token and ClawHub's review; 32 follows the first public listing. Scope class: moderate (new stories in an existing epic, no replan).

Tactics decided by the agent:

- **Name.** Keep `openclaw-all-cli` if ClawHub accepts it unscoped under the owner's account, so npm and ClawHub share one name and the runtime id. Otherwise use `@xtimor/openclaw-all-cli` on ClawHub only. Ticket 30's dry run decides.
- **One artifact.** ClawHub gets the same tarball that npm gets and the GitHub release carries, so its sha256 matches across the three.
- **Credentials.** As with npm: a token only for the first publish, then trusted publishing, then the owner deletes the token. Pin the reusable workflow to a commit SHA, as every other action in this repo is pinned.
- **Release flow unchanged for the owner.** The agent still asks "release?" and dispatches `release.yml`; ClawHub becomes one more job in that run.

## Detailed changes applied now

1. `initiative-openclaw-all-cli.md`, Notes: the 2026-10-22 npm line keeps npm; a new Decision line adds ClawHub (user, 2026-11-11).
2. `architecture-openclaw-all-cli.md`, Deferred, Distribution: "ClawHub stays deferred" is replaced by "ClawHub publishing is epic-distribution, stories 30 to 32".
3. `epic-distribution/epic-distribution.md`: Description, Outcome, Done when (new item 10), Boundaries, Notes (old decision struck, new one added), References.
4. `epic-distribution/tickets.toml`: entries 30, 31, 32.
5. `MEMORY.md`: the public release line now says npm and ClawHub.

## Handoff

- Developer agent (BMAD build): 30, then 31 up to the point of the first real publish.
- The owner (hitl, once): sign in at clawhub.ai with GitHub, create an API token, and save it as the repository secret `CLAWHUB_TOKEN`. Then approve the release that carries the first ClawHub publish. After trusted publishing is set, delete the token.
- Success criteria: epic-distribution Done when item 10, and stories 30 to 32's verify lines.
