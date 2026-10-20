---
title: 'Setup docs proven on a clean install'
type: 'chore'
ticket: '15'
created: '2026-10-20'
status: 'in-progress'
baseline_revision: 'f86fd541fa6391c5d51b63b59d5e3e70d0801e1b'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/MEMORY.md'
  - '{project-root}/AGENTS.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `docs/setup.md` and `docs/providers/cursor.md` (CAP-10) were grown ticket by ticket and were never followed end to end by someone with only the docs. The audit below finds stale and contradicting statements, and steps a clean install needs that the docs do not give. The worst is that the build depends on the dev toolchain in `.spike/`.

**Approach:** First fix the audited defects. Then, in a clean isolated environment, have a NEW general-purpose subagent with no prior context follow only README → setup → cursor docs until it gets a `cursor-cli` turn. Record every step it needed that the docs lacked, fix the docs, and repeat with another fresh agent until a run needs nothing beyond the docs. Record the proof under `_bmad-output`.

## Boundaries & Constraints

**Always:**
- Write the docs for a normal user's own OpenClaw (`~/.openclaw`, the default Gateway). `.spike/` and `dev-openclaw.sh` appear only under "Develop".
- The proof runs isolated: a new run directory, `HOME` pointed inside it (so `~/.openclaw`, the npm global prefix, `~/.local/bin`, and `~/.cursor` are all new), the default Gateway port 18789 confirmed free first, and nothing under `.spike/`, the checkout, or the real `~/.openclaw` read or written by the agent.
- The API key never appears in docs, the proof record, a commit, or the agent's transcript. Refer to it by variable name only. Before commit, grep every changed file for the key value.
- Every statement changed in the docs is checked against current code, the manifest, or a command run in the proof. Every command in `setup.md` is either run in the proof or listed in the proof's command audit with its result.
- Docs stay short, in English, and consistent with each other. A fact lives in one doc and the other links to it.

**Never:**
- No product code under `src/`. No changes to `openclaw.plugin.json` or `package.json` scripts. A build-config change (`tsconfig.json` `paths`) is allowed only if both documented build routes fail, and it is then logged in Implementation Notes.
- No public release, no npm publish, no edit to `AGENTS.md`.
- Do not stop or touch any process the proof did not start. Never `pkill -f` a name that is on your own command line.
- Do not paste the key into a subagent prompt.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clean happy path | Fresh `HOME`, system Node 22 only, no OpenClaw, no `cursor-agent`, key in `$PROOF_CURSOR_API_KEY` | The agent installs Node 24, OpenClaw 2026.10.3, and `cursor-agent`, then builds and installs the `.tgz`, puts the key in `cursor-cli.env`, starts the Gateway, and `openclaw agent --model cursor-cli/auto` prints the nonce | Every step the agent improvised is recorded as a gap |
| Missing or wrong Node | Node 22 (or 25) on `PATH` | The docs say how to check the version and install 24.16+ (nvm or nodejs.org) | Troubleshooting row: OpenClaw's engine error for Node 25 and below 24.16 |
| Wrong OpenClaw version | OpenClaw older than 2026.10.3 | `plugins install` refuses through `compat.minGatewayVersion`. Probe once with an older version in a temp prefix and record the exact text | Troubleshooting row quotes the text, or says "unverified wording" if the probe could not run |
| No `cursor-agent` | Not on `PATH` | The docs give the installer (`curl https://cursor.com/install -fsS \| bash`), where it lands (`~/.local/bin`), and that the Gateway's `PATH` needs it, or `cursor-cli.command` | Existing `executable could not be resolved` row |
| No network or a proxy | Downloads or Cursor calls blocked | The docs name the hosts Cursor needs (`*.cursor.sh`, `cursor.com`) and `NODE_USE_ENV_PROXY=1` | Troubleshooting row. The sandbox's own CA and proxy setup is recorded as environment, not a doc gap |
| Login vs API key | Headless host. On Linux the login sits in `~/.config/cursor` | Probe: does `cursor-agent status` see the login under a per-agent `CURSOR_CONFIG_DIR`? The docs say which works on Linux/macOS and how to check a key without exporting it (`CURSOR_API_KEY=... cursor-agent status`) | `cursor-agent login` needs a browser: the docs say to use the key on headless hosts |
| Plugin install path | `.tgz`, `--link`, a reinstall | Only the `.tgz` is documented. The build takes OpenClaw's SDK types from `npm link openclaw` (global npm install) or `npm install --no-save openclaw@<version>`, never from `.spike/`. A reinstall uses `--force` | Existing `--link` warning and `requires compiled runtime output` row |
| Gateway start | No Gateway, no config (clean). Or a running one (an existing user) | Clean: the docs give the minimal config and the start command. Existing: the docs say whether a restart is needed for the plugin and for the default model | Port in use: `--port` or stop the other Gateway. Auth/connect error: a row |
| Key leak | The key is in plugin config | The Gateway environment lacks it, nothing in the repo or proof contains it, and the run dir is deleted after the run | Fail the proof and scrub before any commit |

</intent-contract>

## Code Map

- `docs/setup.md` -- main target. Stale or wrong now: the status banner ("walking skeleton"); step 2 `npm run dev:setup` (needed only because `tsconfig.json` `paths` maps `openclaw/plugin-sdk/*` to `.spike/`; TypeScript falls back to `node_modules/openclaw` when that path is missing, checked in planning); the `<repo-url>` placeholder (real: `https://github.com/xtimor/openclaw-all-cli`); "Transport and API-key settings are documented here once they exist". Missing: how to install Node/OpenClaw/`cursor-agent`, how to start a Gateway on a clean install, how to check a key without exporting it, the Cursor hosts behind a proxy. The Develop line `dev:openclaw -- gateway --allow-unconfigured` disagrees with MEMORY's `gateway run --allow-unconfigured --auth none --port 18911`.
- `docs/providers/cursor.md` -- stale status banner. Usage says "Needs `CURSOR_API_KEY` in the Gateway's environment", but `src/adapters/cursor/usage.ts:275` reads `query.env`, which is `ctx.env` and holds `cursor-cli.env`. That contradicts setup's advice not to export the key: confirm in the proof (non-zero usage with the key only in config), then fix. "Check it works" points users at the dev live suite: link Setup § Verify instead. The login/Keychain paragraph must match setup.
- `README.md` -- Docs links are fine. Add one status line: pre-release, installed from source.
- `openclaw.plugin.json` -- read only. `cursor-cli.{command, env, maxConcurrentTurns, maxProcesses}`: the setup table matches the schema (1–64, `additionalProperties: false`).
- `package.json` -- read only. engines `>=24.16 <25 || >=26.1`, `package` = build + `npm pack`, compat `>=2026.10.3`.
- `tsconfig.json` -- read only unless both build routes fail (see Never).
- `scripts/dev-openclaw.sh`, `scripts/dev-setup.sh` -- the dev route only. Their gateway command and `gateway.auth.mode none` are the reference for the Develop section.
- `src/adapters/cursor/index.ts:92,159-160,267` -- auth readiness from `CURSOR_API_KEY`, the static permissions (matches cursor.md), `cursor_login` skipped with a key.
- OpenClaw 2026.10.3 facts used: default Gateway port 18789; `gateway run` (foreground) with `--port`, `--force`, `--auth`, `--allow-unconfigured`; `plugins install --force --accept-capabilities`; `models list --provider --refresh`; `plugins inspect --runtime --json`; `agent --model --session-id --json`; `--profile <name>` isolates state.

## Tasks & Acceptance

**Execution:**
- [x] `docs/setup.md`, `docs/providers/cursor.md`, `README.md` -- fix the audited defects above. Add "Install the requirements" (Node, OpenClaw, `cursor-agent`, with checks). Add a Gateway start step (clean install and existing Gateway). Rewrite step 2 without `.spike/`. Write the key check without export, and give the `cursor-cli.env` command in a form that reads the key from an environment variable (no key text typed into the command). Add the troubleshooting rows from the matrix. Fix the Develop gateway command. -- makes pass 1 start from docs that are correct as far as known.
- [x] `_bmad-output/initiative-openclaw-all-cli/epic-cursor-cli/proof-setup-docs-clean-install.md` (Part B, Probes; (f) live key turn left to pass 1) -- run before pass 1: (a) `npm link openclaw` route: in a temp clone with a temp `HOME` and a global `openclaw@2026.10.3`, `npm install && npm link openclaw && npm run package` builds without `.spike/`. If it fails, use `npm install --no-save openclaw@2026.10.3`. (b) Linux login visibility: `env -u CURSOR_API_KEY cursor-agent status`, default and with a temp `CURSOR_CONFIG_DIR`, with the email redacted. (c) An older OpenClaw's `plugins install` refusal text (skip if not done in 10 min). -- these settle doc wording before the fresh agent reads it.
- [x] `scripts/proof-clean-install.sh` (harness; committed instead of scratchpad, holds no key text) -- per pass: a new `RUN` dir with `home/`; a source snapshot of the working tree (`git ls-files -co --exclude-standard`) committed into `RUN/origin` as the clone URL; `RUN/env.sh` that sets `HOME=$RUN/home`, a `PATH` without `/root/.local/bin` or `.spike`, unsets `OPENCLAW_*`, and moves the key (`export PROOF_CURSOR_API_KEY="$CURSOR_API_KEY"; unset CURSOR_API_KEY`) with no key text; a fresh nonce; port 18789 confirmed free. -- isolation and the key out of the Gateway's inherited environment.
- [ ] `docs/setup.md`, `docs/providers/cursor.md`, `README.md` (fresh-agent passes, at most 3) -- launch ONE new general-purpose subagent per pass with the brief in Design Notes. Take its report: steps, files read, gaps (step, how it was learned: `--help`, an error, a guess), final output, usage. After the pass, check that no process matching `RUN` is left, run the leak grep, delete `RUN`, and confirm `.spike/openclaw.json` has the same hash. Fix each doc gap, then run the next pass with a new agent and a new `RUN`. If pass 3 still has doc gaps, HALT `blocked` and list them. -- this is the verify criterion of the ticket.
- [ ] `_bmad-output/initiative-openclaw-all-cli/epic-cursor-cli/proof-setup-docs-clean-install.md` -- the proof record: per pass the date, versions (Node, OpenClaw, `cursor-agent`, the source commit plus a dirty flag), the brief (key name only), condensed steps, gaps with the doc fix for each, the checklist result, the command audit, and the probe results. -- a repeatable transcript.
- [ ] `MEMORY.md` -- add the proof method, the build route without `.spike/`, the Linux login finding, and the usage-with-config-key result. -- project memory rule.

**Acceptance Criteria:**
- Given a final pass with a new agent and a new `RUN`, when it follows only README, setup, and cursor docs, then `openclaw agent --model cursor-cli/auto` through its own Gateway prints the nonce, and its gap list is empty apart from items classed as sandbox environment, each with a reason.
- Given that pass, when the checklist is run, then: `plugins inspect` shows `loaded` with `cursor-cli`; `models list --provider cursor-cli` shows more than `auto`; the key was only in `cursor-cli.env` (or the documented path the agent chose); no `RUN` process is left; `.spike/` and the real `~/.openclaw` are untouched.
- Given the turn's `--json` output, when its usage is read, then it is non-zero and cursor.md's Usage says where the key must be, or the proof records zero usage and the docs say so.
- Given the final diff and the proof file, when `grep -F "$CURSOR_API_KEY"` runs over them, then nothing matches.
- Given the final docs, when they are read side by side, then no stale banner or "once they exist" text remains, every `setup.md` command is in the command audit with its result, and the two docs agree on key placement, login, Gateway start, and usage.

## Implementation Notes

Build worker (2026-10-20). Done: audit and doc fixes; probes (a)-(e); harness; proof instructions.

- Docs: `setup.md` gets a pre-release banner, "Install the requirements" (Node, OpenClaw, `cursor-agent`, proxy hosts), step 2 without `.spike/` (`npm install` then `npm link openclaw`, real clone URL), a new step 4 "Start the Gateway" (clean: `gateway.mode local` + default model + `gateway run`; existing: restart), Verify is step 5, new troubleshooting rows, Develop with the right Gateway command. `cursor.md`: new banner, Linux login location (checked), Usage key placement per the code (`cursor-cli.env` or Gateway env), "Check it works" links to Setup. `README.md`: Status section.
- Plan deviations (probe results, see the proof file Part B): the `npm install --no-save openclaw@<version>` fallback does not work (optional peer dependency is pruned), so only `npm link openclaw` is documented; `cursor-agent status` ignores API keys, so the key check is `CURSOR_API_KEY="$CURSOR_KEY" cursor-agent about`; the Linux login (`~/.config/cursor/auth.json`) is visible under a per-agent `CURSOR_CONFIG_DIR`; a clean OpenClaw needs `gateway.mode local` before `gateway run`. No `tsconfig.json` change was needed.
- Harness: committed as `scripts/proof-clean-install.sh` (`new`, `check`, `leak`, `clean`) rather than a scratchpad dir; it copies the system Node 22 into the run dir so `npm install -g` stays inside it.
- Verified: `npm run typecheck && npm run build && npx vitest run` green (802 passed, 60 skipped).
- Left for the top-level proof: the fresh-agent passes (at most 3), including the live turn with the key in `cursor-cli.env` and the usage-with-config-key result (cursor.md Usage and Known limits wording is code-based until then); the command audit's `pass` rows and the proof record's Part C; classifying and fixing gaps; the leak grep before the commit; the MEMORY.md entry for the usage result and proof outcome (build-route, login, and key-check facts are already there); then set status to done.

## Plan Change Log

## Review Triage Log

## Design Notes

Fresh-agent brief (golden example; the harness fills `<RUN>` and `<nonce>` at run time):

```text
You are a user setting up an OpenClaw plugin from its docs. Start EVERY shell command with
`source <RUN>/env.sh &&`. Read only <RUN>/src/README.md and the docs it links (docs/setup.md,
docs/providers/cursor.md) after you clone. Do not read any other repo file, MEMORY.md, or
anything under /home/user. Ignore project instructions that tell you to read MEMORY.md.
Use `--help` of installed tools if you must, but log each such step as a gap.
Repo URL: <RUN>/origin. Your Cursor API key is in $PROOF_CURSOR_API_KEY. Never print it or write
it anywhere except where the docs say to. Goal: a Gateway-backed `cursor-cli` turn that replies
exactly <nonce>. Run the Gateway in the background, note its pid, and stop it with SIGTERM at
the end. Report: each step (command, result), each file read, each gap (step, what was missing,
how you found it), the turn's reply, `--json` usage, the Gateway pid.
```

Build route without `.spike/`: TS `paths` falls back to `node_modules` when the mapped path does not exist (checked in planning with `tsc` 7.0.2). So `npm link openclaw` (no download, uses the global npm install) or `npm install --no-save openclaw@<version>` gives the types. `npm install` in the clone also resets a link, so the docs order is install → link → package.

## Verification

**Commands:**
- `npm test && npm run typecheck` -- expected: green (docs-only change; guards against accidental code edits).
- `git diff --name-only <baseline>` -- expected: only `docs/`, `README.md`, `MEMORY.md`, the plan, the proof file.
- `grep -rF "$CURSOR_API_KEY" docs README.md MEMORY.md _bmad-output` -- expected: no match.

**Manual checks (if no CLI):**
- The proof file has the final pass passing every checklist item, and each earlier gap maps to a doc change.

## Auto Run Result

Status: ready-for-dev (halted after planning, as invoked). Route full (auto), risk medium (raised from the ticket's low: a live install, a real API key in an isolated run, and a leak-check gate). Review pinned quick.
