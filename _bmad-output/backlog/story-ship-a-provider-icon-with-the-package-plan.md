---
title: "Ship a provider icon with the package"
type: 'feature'
ticket: 5
created: '2026-10-24'
status: done
baseline_revision: 'bee43ad79d75380e79f67b5c81f7a09951242d08'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `cursor-cli` shows a generic letter avatar in the model picker and on the provider card, because the package ships no icon and OpenClaw 2026.10.3 reads a plugin icon only from the fixed package path `assets/icon.png`.

**Approach:** Ship a neutral own icon (terminal chevron and block cursor, not Cursor's brand mark) as a square PNG at exactly `assets/icon.png`, add that exact path to `package.json` `files` and to `test/package-contents.test.ts`, and note it in the docs.

## Boundaries & Constraints

**Always:** `files` keeps `dist` and `openclaw.plugin.json` unchanged and gains the single path `assets/icon.png` (no directory, no glob). The PNG is square, small, and readable at 16 px.

**Never:** change any other `package.json` field or other protected file; use Cursor's logo or colors as a brand mark; add a manifest key (the host has none).

</intent-contract>

## Tasks & Acceptance

**Execution:**
- [ ] `assets/icon.png` -- 256x256 RGBA PNG, generated deterministically by a scratchpad script (not committed) -- AC1
- [ ] `package.json` -- append `"assets/icon.png"` to `files` -- AC3, AC4
- [ ] `test/package-contents.test.ts` -- allowlist and packed-file expectation for `assets/icon.png` -- AC3
- [ ] `docs/providers/cursor.md` -- one paragraph: where the icon comes from and that the host reads only that path -- docs rule

**Acceptance Criteria:**
- Given the repository, when `assets/icon.png` is read, then it is a valid square PNG (256x256) that is not Cursor's mark.
- Given the plugin installed in the isolated OpenClaw, when `openclaw plugins inspect` runs, then it reports `hasIcon: true`.
- Given `npm pack --dry-run`, when the list is read, then it holds `assets/icon.png`, `files` names that exact path, and the package test expects it.
- Given `package.json` `files`, when compared with `main`, then `dist` and `openclaw.plugin.json` are unchanged.

## Implementation Notes

Route: oneshot (about 10 changed lines plus a binary). The first run blocked on an intent gap: OpenClaw 2026.10.3 reads a plugin icon only from `assets/icon.png` (`docs/plugins/manifest/surfaces.md` "Plugin icon"; `PORTABLE_PLUGIN_ICON_PATH` in `dist/portable-icon-paths-*.mjs`; `resolvePortablePluginIcons` in `dist/manifest-registry-build-*.mjs`; `hasIcon` comes from `iconPath`), with no manifest key, so an SVG could never give `hasIcon: true`. The retry (issue #9) follows the owner's 2026-10-24 approval: ship it as `assets/icon.png` and add that exact `files` entry and test line. This is the one allowed protected-file change (`docs/agents/implement.md`: an asset's own path in `files`; the host's path wins over the draft's guess).

Built: `assets/icon.png` is a 256x256 RGBA PNG (2.2 kB), drawn by a standard-library Python script in the scratchpad (analytic shapes, 4x4 supersampling, zlib; run twice, byte-identical), a green prompt chevron and a light block cursor on a dark rounded square; a 16 px box downscale stays legible. The imaging package on this host is broken, hence no Pillow. `plugins inspect` (CLI) prints no icon field in 2026.10.3: `hasIcon` is set by the Gateway's `plugins.list` (`management-service-*.mjs`, `resolvePluginIconSource`), so AC2 was checked there.

## Plan Change Log

## Review Triage Log

### 2026-10-24 - Review pass
- verdicts: 3 findings - high 0, medium 0, low 2, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` The docs paragraph said `openclaw plugins inspect` reports `hasIcon: true`, but the CLI prints no icon field; the Gateway's `plugins.list` does -- fixed in `docs/providers/cursor.md` to name `openclaw gateway call plugins.list`.
  - `[low]` `[reject]` The icon test's bounds (width at least 64, under 64 KiB) are arbitrary -- they guard only against an empty, wrong-type, or huge file; no named harm in everyday use.
  - `[low]` `[reject]` The palette (green, white, dark navy) could be read as a brand color -- Cursor's mark is a monochrome cube; nothing here resembles it.
- Note: the Quick lens is a subagent; this worker cannot launch one, so the pass is the worker's own read of the diff and the plan's criteria (`lenses_ran` empty). AC1 to AC4 checked against the diff and the runs below: met.

## Auto Run Result

Status: built

- Summary: ships the neutral own icon at `assets/icon.png` and lists that exact path in `package.json` `files` and `test/package-contents.test.ts`.
- Files: `assets/icon.png` (the icon), `package.json` (`files` gains `assets/icon.png`; nothing else), `test/package-contents.test.ts` (allowlist, packed-file expectation, a PNG shape test), `docs/providers/cursor.md` (Icon paragraph).
- Review: 1 patch applied (docs wording on where `hasIcon` shows), 0 deferred, 2 rejected (arbitrary test bounds, palette worry; reasons in the log). Follow-up review recommended: false (no high, no two mediums patched).
- Verification: `npm pack --dry-run` lists `assets/icon.png`; mutation check (entry removed from `files`) fails `packs the fixed files` with `missing assets/icon.png`, restored; isolated OpenClaw 2026.10.3 after `dev:install`: Gateway `plugins.list` gives `hasIcon: true` for `openclaw-all-cli`, `undefined` with the installed file moved away, `true` again restored; `npm run ci` green (43 files, 1268 tests passed). Live Cursor check not run (no login needed for this change; the look in a real picker is the owner's check).
- Residual risk: none known beyond the owner's visual check of the icon in the picker.

## Verification

**Commands:**
- `npm pack --dry-run` -- expected: lists `assets/icon.png`
- `scripts/dev-openclaw.sh install`, a Gateway, then `gateway call plugins.list` -- expected: `hasIcon: true` for `openclaw-all-cli` (the CLI `plugins inspect` prints no icon field)
- `npm run ci` -- expected: green
