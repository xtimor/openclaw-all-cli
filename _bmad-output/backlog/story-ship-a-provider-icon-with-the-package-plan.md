---
title: "Ship a provider icon with the package"
ticket: 5
status: blocked
blocked_at: "2026-10-24"
blocked_reason: "intent gap: OpenClaw 2026.10.3 has no manifest icon key and reads only the fixed path assets/icon.png (PNG), so assets/cursor-cli.svg can never give hasIcon: true (AC2); the working fix needs files entry assets/icon.png, which the allowance (only assets/cursor-cli.svg) forbids. Owner must amend the ticket: ship assets/icon.png and allow that files path."
---

# Auto Run Result

Status: blocked
Blocking condition: intent gap (see `blocked_reason`).

Evidence (OpenClaw 2026.10.3, `.spike/openclaw/node_modules/openclaw`):

- `docs/plugins/manifest/surfaces.md` ("Plugin icon"): the icon is the fixed package path `assets/icon.png` (square PNG); "No manifest field is required"; "Top-level plugin-branding icon URLs are not loaded"; provider-auth artwork is server-owned catalog metadata. `docs/plugins/building-plugins.md` says the same and tells authors to check `npm pack --dry-run`.
- `dist/portable-icon-paths-*.mjs` sets `PORTABLE_PLUGIN_ICON_PATH = "assets/icon.png"`. `resolvePortablePluginIcons` (`dist/manifest-registry-build-*.mjs`) resolves only that path (plus `assets/activity.svg` and `assets/activity/<tool>.svg`, which are chat tool-call glyphs, not the plugin identity icon). `plugins inspect` `hasIcon` comes from `iconPath`, set only from `assets/icon.png`.
- So AC1 and AC3 can be met with `assets/cursor-cli.svg`, but AC2 (`hasIcon: true`) cannot: no manifest key points at it, and the host would never read it. Shipping the SVG alone would add an unused file.

Needed from the owner: amend the ticket to ship `assets/icon.png` (neutral terminal-with-cursor art, square, readable at 16 px; optionally keep an SVG source) and allow `assets/icon.png` as the exact `package.json` `files` entry (and in `test/package-contents.test.ts`). No code was changed.
