---
title: "The provider icon is shown nowhere in the Control UI"
type: 'bugfix'
ticket: 10
created: '2026-10-26'
status: done
baseline_revision: '2a714e72c25056dbff66be575560566ca15cc31c'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Users expect the plugin's `assets/icon.png` on the provider card, the Connect provider list, and the model picker, but the Control UI of OpenClaw 2026.10.3 draws a plugin icon only on some pages. The docs and the 0.1.2 changelog line wrongly say the provider card and the model picker show it.

**Approach:** Decide from the host bundle which Control UI places draw the plugin icon and which never do, and correct `docs/providers/cursor.md` and `CHANGELOG.md` to say so and name the OpenClaw code that decides it. No package or manifest change (the host offers no lever for the other places).

## Boundaries & Constraints

**Always:** Keep `assets/icon.png`, `package.json` `files`, and the manifest unchanged. Record the live browser check as not run.

**Never:** Add a manifest `icon` key (an HTTPS URL honored only for ClawHub catalog icons); use Cursor's brand mark; touch protected files.

</intent-contract>

## Tasks & Acceptance

**Execution:**
- [ ] `docs/providers/cursor.md` -- rewrite the Icon paragraph: where the host draws the plugin icon, where it never does, and the OpenClaw code behind each -- AC1, AC2
- [ ] `CHANGELOG.md` -- one `Unreleased` line (#35) correcting the icon claim -- AC2
- [ ] `MEMORY.md` -- record the findings -- project rule

**Acceptance Criteria:**
- Given `docs/providers/cursor.md`, when read, then it lists the places that draw the plugin icon (plugins page, command palette, channel setup, chat install card) and the places that never do (provider card, Connect provider list, model picker), each with the OpenClaw code that decides it.
- Given `CHANGELOG.md`, when read, then `Unreleased` carries a line with the issue link #35 saying the same.
- Given `npm test`, when run, then it passes (no package or manifest change, so no new test).

## Implementation Notes

Route: oneshot (docs only, about 10 lines). Findings (OpenClaw 2026.10.3, Control UI bundle in `.spike/openclaw/node_modules/openclaw/dist/control-ui/assets`, host modules in `dist`):
- Plugin icon (`assets/icon.png` via `resolvePluginIconSource`, served at `/__openclaw__/plugin-icon/<pluginId>`; `hasIcon` from `plugins.list`): drawn by the plugins page (`plugins-page-*.js`), the command palette plugin entries (`command-palette-*.js`), channel setup (`channels-page-*.js`), and the chat install card (`control-ui-boot-chat-*.js`), all via `pluginIconUrls`.
- Model picker and provider cards: `Wp`/`Lp` in `control-ui-boot-shared-t6Y7fE1z.js` look up a fixed bundled set of brand SVGs (`provider-icons/ProviderIcon-<id>.svg`, set `Gp` plus alias map `Kp`) by provider id; `cursor-cli` is in neither (`cursor` is), so the letter avatar (`Up`) shows. No plugin file is read.
- Connect provider list: `model-setup-page-*.js` `V`/`H` use the same bundled set by `brandId` (= provider id), else the choice `icon`, an HTTPS URL honored only if ClawHub catalog metadata registered it (`catalog-icon-registry-*.mjs`); the manifest docs call it server-owned. Not usable by a plugin installed from npm.
- Live headless-browser check: not run (no browser on this host); decided from the bundle.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm test` -- expected: passes
- `node scripts/changelog.mjs check` -- expected: ok

## Auto Run Result

Status: blocked
Blocking condition: no subagents (step 4 Quick review needs a reviewer subagent; this worker cannot launch one)

- Implemented and verified, left uncommitted in the working tree: `docs/providers/cursor.md` (Icon paragraph and a places table), `CHANGELOG.md` (Unreleased line, #35), `MEMORY.md` (findings).
- Findings: the plugin icon is drawn by the plugins page, command palette, channel setup, and chat install card; the model picker, provider cards, and Connect provider list use bundled brand artwork keyed by provider id (or a ClawHub-registered HTTPS `icon`), so no plugin-side change helps.
- Verification: `npm test` passed (43 files, 1300 tests; 18 files skipped = live); `node scripts/changelog.mjs check` ok. Live headless-browser check not run (no browser on this host); Cursor live check not run.
- Review not run.
