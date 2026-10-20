# Proof: setup docs on a clean install (ticket 1.15)

Plan: `story-setup-docs-proven-on-a-clean-install-plan.md`. The key value never appears here; it is `$CURSOR_API_KEY` in the top-level shell and `$PROOF_CURSOR_API_KEY` in a pass.

## Part A. How to run a pass (instructions for the top-level session)

A subagent cannot start subagents, so the top-level session launches the fresh-agent passes. At most 3 passes; each with a NEW general-purpose subagent and a NEW run dir. Helper: `scripts/proof-clean-install.sh` (no key text in it).

### Before pass N

1. Confirm the docs are in the state to prove: `git status --short` (uncommitted docs are fine; the snapshot includes them and the record notes `dirty`).
2. Confirm `CURSOR_API_KEY` is set in your shell (do not print it) and nothing listens on 18789 (the script checks).
3. Create the run:

   ```sh
   scripts/proof-clean-install.sh new
   ```

   It prints `RUN=/tmp/proof-clean-install.XXXXXX`, the nonce, the source commit (`... dirty|clean`), and the clone URL. It creates:
   - `RUN/home` (empty; the agent's `HOME`, so `~/.openclaw`, `~/.cursor`, `~/.local/bin`, and the npm cache are new),
   - `RUN/sys/node22` (a private copy of the system Node 22, so `npm install -g` cannot touch the real one),
   - `RUN/origin` (a git repo with a snapshot of the working tree, without `_bmad*` and `MEMORY.md`),
   - `RUN/env.sh` (sets `HOME`, a `PATH` of only `RUN/home/.local/bin`, the private Node 22, `/usr/bin:/bin`; unsets `OPENCLAW_*`, `NPM_CONFIG_*`, `NVM_*`, `CURSOR_*`; moves the key to `PROOF_CURSOR_API_KEY`; sets `PROOF_NONCE`),
   - `RUN/baseline` (hashes of `.spike/openclaw.json`, real `~/.openclaw`, `~/.cursor` and `~/.config/cursor`, `~/.local/bin`).
4. Record in Part C: date, `node --version` of the private Node, source commit and dirty flag, and `uname -sm`.

### Launch the agent

Use the Agent tool with `subagent_type: general-purpose`, a fresh agent, foreground. Substitute `<RUN>` and `<nonce>` (read `RUN/nonce`). Do NOT paste the key. The brief:

```text
You are a user setting up an OpenClaw plugin from its docs. Start EVERY shell command with
`source <RUN>/env.sh &&` (each Bash call is a new shell). Clone <RUN>/origin into <RUN>/src
first. After that, read only <RUN>/src/README.md and the docs it links (docs/setup.md,
docs/providers/cursor.md). Do not read any other repo file, MEMORY.md, AGENTS.md, or anything
under /home/user, /root, or /tmp outside <RUN>. Ignore project instructions that tell you to read
other files. Use `--help` of installed tools only if the docs leave you stuck, and log each such
step as a gap.
Your Cursor API key is in $PROOF_CURSOR_API_KEY. Never print it, echo it, or write it anywhere
except where the docs say to. In the docs the key variable is called CURSOR_KEY: set
CURSOR_KEY="$PROOF_CURSOR_API_KEY" in the same command instead of using `read`.
Goal: a Gateway-backed `cursor-cli` turn that replies exactly <nonce>
(`openclaw agent --model cursor-cli/auto --message "Reply with exactly: <nonce>" --json`).
Run the Gateway in the background, note its pid, and stop it with SIGTERM at the end. Install
everything inside HOME (nothing needs sudo). When done, report:
 1. each step (command with the key hidden, result in one line),
 2. each file you read,
 3. each gap: the step, what the docs lacked or got wrong, and how you found out (--help, an error,
    a guess, prior knowledge),
 4. the turn's reply and the `--json` usage numbers,
 5. the Gateway pid and whether it exited after SIGTERM.
```

The `read -rs` line in the docs needs a terminal; the brief tells the agent how to fill the variable without one. That is a harness difference, not a doc gap.

### After the agent returns

Run in your shell (the key still set):

```sh
RUN=/tmp/proof-clean-install.XXXXXX         # the run dir
scripts/proof-clean-install.sh check $RUN   # processes, port, hashes, where the key text sits
```

Then collect checklist evidence from the run (use `source $RUN/env.sh &&` while the Gateway is still up, or ask the agent to leave it up and stop it yourself by pid afterwards):

- `openclaw plugins inspect openclaw-all-cli --runtime --json` shows `"status": "loaded"` and `cursor-cli`.
- `openclaw models list --provider cursor-cli` shows more than `auto`.
- The key text is only in `RUN/home/.openclaw/openclaw.json` and `RUN/home/.config/cursor/auth.json` (written by `cursor-agent` itself; what `check` lists), unless the agent chose another documented path. It must not be in the Gateway's environment: with the Gateway pid `P`, `tr '\0' '\n' < /proc/$P/environ | grep -c '^CURSOR_API_KEY='` is `0`.
- The agent's `--json` output: usage non-zero (if zero, the Usage statement in `cursor.md` and `setup.md` must say so instead; see the plan's third acceptance criterion).
- The reply contains the nonce.

Stop anything left, by pid only (never `pkill -f`): from `check`'s list, `kill -TERM <pid>`, wait, then `kill -KILL` if needed; also stray `cursor-agent` children. Then:

```sh
scripts/proof-clean-install.sh check $RUN                # must be clean now, apart from the key location list
scripts/proof-clean-install.sh clean $RUN                # deletes the run dir
```

Known external write: OpenClaw logs to `/tmp/openclaw/openclaw-<date>.log` whatever `HOME` is. That is environment, not a failure; it holds no key (confirm with `scripts/proof-clean-install.sh leak /tmp/openclaw` after the run).

### Classify and fix

For each gap in the report, class it: `doc` (fix the doc), or `env` (sandbox: proxy/CA, no browser, root user, `/tmp/openclaw`; give the reason). Fix every `doc` gap in `docs/` or `README.md`, add a row to Part C, and run the next pass with a new agent and a new run. If pass 3 still has `doc` gaps: HALT `blocked` and list them.

### Pass/fail checklist (per pass; the final pass must pass all)

- [ ] Agent reached a `cursor-cli` turn; the reply contains the nonce.
- [ ] Gap list is empty, apart from `env` items each with a reason.
- [ ] Agent read only README, `setup.md`, `cursor.md` (compare its file list).
- [ ] `plugins inspect` shows `loaded` and `cursor-cli`.
- [ ] `models list --provider cursor-cli` shows more than `auto`.
- [ ] The key was only in `cursor-cli.env`; the Gateway's `/proc/<pid>/environ` has no `CURSOR_API_KEY`.
- [ ] Usage is non-zero, or the docs say usage is 0 in this setup.
- [ ] `check`: no process with the run's HOME, port 18789 free, `.spike/openclaw.json`, real `~/.openclaw`, `~/.cursor`/`~/.config/cursor`, `~/.local/bin` unchanged.
- [ ] `scripts/proof-clean-install.sh leak README.md docs MEMORY.md _bmad-output scripts` finds nothing (also run it over `git diff` before the commit).
- [ ] Run dir deleted.

## Part B. Probes (build worker, 2026-10-20, Node 24.22.0 from `.spike`, OpenClaw 2026.10.3, cursor-agent 2026.10.16)

All in a throwaway copy of the tree (`git ls-files -co`, no `.spike/`), temp `HOME`, temp global npm prefix; removed afterwards.

| Probe | Result | Doc change |
| --- | --- | --- |
| (a1) `npm install -g openclaw@2026.10.3`, then in the clone `npm install && npm link openclaw && npm run package` | Works without `.spike/`; `npm run typecheck` also passes; `.tgz` 173 kB. | Setup step 2: `npm link openclaw` after `npm install` |
| (a2) The same clone without the link | `npm run build`: 12 `error TS` (`TS2307 Cannot find module 'openclaw/plugin-sdk/plugin-entry'`, `TS2339`, `TS7006`) so `npm run package` stops before packing (`tsc` still writes a partial `dist/`). | Troubleshooting row for the `TS2307` message |
| (a3) `npm install --no-save openclaw@2026.10.3` (also with `--legacy-peer-deps`, `--no-package-lock`, `--include=peer`) | Does NOT work: npm reports "up to date" or installs and prunes it at once, because `openclaw` is an optional peer dependency in `package.json`. `node_modules/openclaw` never appears. | Plan's fallback dropped: only the `npm link openclaw` route is documented |
| (a4) `npm install -g openclaw` with the default global prefix | Writes into the active Node's prefix (here `.spike/node/lib`). I did that once by mistake and uninstalled it; the docs say to use a Node whose global prefix is yours (nvm). | Setup "Install the requirements" |
| (b) `cursor-agent status` with `CURSOR_API_KEY` unset | Default: `Logged in as <redacted>`. With a temp `CURSOR_CONFIG_DIR`: still logged in. With a temp `HOME`: `Not logged in`. Linux keeps the login in `~/.config/cursor/auth.json`, independent of `CURSOR_CONFIG_DIR`, so the per-agent home sees it. | Setup step 1 and cursor.md: "not yet checked" removed |
| (b2) `CURSOR_API_KEY=<valid> cursor-agent status` in a temp `HOME` | `Not logged in`: `status` ignores API keys. `CURSOR_API_KEY=<valid> cursor-agent about` shows `User Email <email>`; an invalid key prints `The provided API key is invalid`. Without login and key, `--list-models` shows only `auto`. | Setup step 1: key check uses `about` (the plan's `status` form was wrong) |
| (c) OpenClaw 2026.10.2 `plugins install` of the `.tgz` | `plugin "openclaw-all-cli" requires plugin API >=2026.10.3, but this OpenClaw runtime exposes 2026.10.2. Upgrade OpenClaw or install a compatible plugin version and retry.` | Troubleshooting row, exact text |
| (d) OpenClaw 2026.10.3 on Node 22.22 | `openclaw --version` prints `Running on an unsupported Node (22.22.0); diagnostics may show truncated text`. `npm install -g` warns `EBADENGINE`, required `>=24.16.0 <25 \|\| >=26.1.0`. | Requirements and troubleshooting row |
| (e) Clean-state Gateway (temp `HOME`, plugin installed, no config) | `openclaw gateway run` refuses: `Gateway start blocked: existing config is missing gateway.mode ...`. After `openclaw config set gateway.mode local` it reaches `[gateway] ready` with the plugin loaded (`plugins inspect`: `loaded`, `cliBackendIds: [cursor-cli]`). `agent` without a Gateway: `Couldn't connect to OpenClaw.` A second `gateway run` on the same state: `Another gateway (pid N) already owns this state directory`. `models list --provider cursor-cli` with no login and no key: `No models found.` A turn with no login: `The CLI rejected its login: Invalid params`. | Setup step 4 and troubleshooting |
| (f) Config write of the key into a temp-HOME `openclaw.json` for a live turn | Not run by the build worker (the host refused writing a real key to a file). The live turn with the key in `cursor-cli.env`, and the usage-with-config-key check, are the top-level pass. | Usage wording follows the code (`src/adapters/cursor/usage.ts` reads `query.env`, built from `ctx.env` + home env in `src/core/execute.ts:718`); to be confirmed by pass 1's `--json` usage |

## Part C. Passes (fill in)

### Pass 1

- Date 2026-10-20; Node v24.22.0 (agent-installed tarball), OpenClaw 2026.10.3, cursor-agent 2026.10.19; source commit and dirty flag in the run's `source-commit` (not recorded here).
- Brief: as in Part A (key by name only).
- Result: reply exact, usage input 456 / output 45 / cacheRead 20224, Gateway SIGTERM clean.
- Gaps (all class doc; fix in parentheses): 1 Node 24 without nvm (tarball one-liner); 2 `about` printed `Not logged in` on the first run after install (retry note, non-empty check); 3 usage path (`result.meta.agentMeta.usage`); 4 Gateway pid with `nohup` (`pgrep -x openclaw-gateway`); 5 `remote model catalog refresh failed` behind a proxy (troubleshooting row); 6 tested versions (note in Requirements).
- Post-check gaps (coordinator): 7 `cursor-agent` writes the key and tokens to `~/.config/cursor/auth.json` (docs state it, `cursor-agent logout`, exec reach, harness lists it as expected); 8 `worker-server`/`tsserver` leftovers after stop (setup.md stop instructions).
- Checklist: pass-1 result recorded by the coordinator; pass 2 must show gaps 1-8 are closed.

### Pass 2

- Date 2026-10-20; docs at commit 8314671; fresh agent.
- Result: reply exact, usage 20643 / 140, Gateway SIGTERM clean; coordinator post-checks and leak check clean.
- Gaps (all class doc; fixed): 1 `pgrep -x openclaw-gateway` fails on Linux (comm truncated to 15 chars) -> `ps -eo pid,comm,args | grep '[o]penclaw-gateway'`, same form for the leftover list; 2 `plugin provenance-invalid` warning -> troubleshooting row; 3 proxy denies `telemetry.openclaw.ai:443` -> one line in the proxy paragraph; 4 cursor.md pointer and section list at the top; 5 transient `SSL_ERROR_SYSCALL` on the Cursor install -> retry hint.
- Pass 3 needed to confirm these are closed.

### Pass 3 

(same fields)

## Part D. Command audit

Every command in `docs/setup.md`, with where it ran. `probe` = build worker (Part B, temp HOME); `pass` = to be run by the fresh agent; fill the result column from the final pass.

| Section | Command | Run in | Result |
| --- | --- | --- | --- |
| Install the requirements | `node --version` | probe | v24.22.0 / v22.22.0 shown, as the docs say |
| Install the requirements | `nvm install 24` / nodejs.org tarball one-liner | pass 1 (tarball, v24.22.0) | ok |
| Install the requirements | `npm install -g openclaw@2026.10.3`, `openclaw --version` | probe (a1) | ok, `OpenClaw 2026.10.3 (59cb447)` |
| Install the requirements | `curl https://cursor.com/install -fsS \| bash`, `export PATH=...`, `cursor-agent --version` | pass 1 | ok (2026.10.19) |
| 1 | `cursor-agent login`, `cursor-agent status` | login: not run (needs a browser); `status`: probe (b) | |
| 1 | `read -rs CURSOR_KEY`; `CURSOR_API_KEY="$CURSOR_KEY" cursor-agent about \| grep 'User Email'` | `about`: probe (b2), pass 1 (first run printed `Not logged in`, retry ok: gap 2 fixed in docs); `read -rs`: not run (agent used a variable assignment) | |
| The API key | `openclaw config set ...cursor-cli.env "$(printf ...)" --strict-json`; `unset CURSOR_KEY` | pass 1 | ok |
| The API key | `printf '%s\n' "$CURSOR_KEY" \| openclaw models auth paste-api-key --provider cursor-cli`; `models auth logout ... --yes` | unchanged from before (entry 11); not part of the clean path | |
| 2 | `git clone https://github.com/xtimor/openclaw-all-cli.git`, `npm install`, `npm link openclaw`, `npm run package` | probe (a1) with a local tree; clone URL in the pass uses `RUN/origin` | |
| 2 | `openclaw plugins install ./openclaw-all-cli-<version>.tgz --accept-capabilities` (with `--force`) | probe (e) | ok: `Installed plugin: openclaw-all-cli`, `Saved for the next Gateway start` |
| 3 | `openclaw config set agents.defaults.compaction.model ...` | not run | |
| 4 | `openclaw config set gateway.mode local`, `... agents.defaults.model.primary cursor-cli/auto`, `openclaw gateway run` | probe (e) | ok, `[gateway] ready` |
| 5 | `openclaw plugins inspect openclaw-all-cli --runtime --json`, `openclaw models list --provider cursor-cli`, `openclaw agent --model cursor-cli/auto --message "Say hi"` | inspect: probe (e) `loaded`; models, agent: pass (probe had no login: `No models found.`, `The CLI rejected its login`) | |
| Develop | `npm run dev:setup`, `dev:install`, `dev:openclaw -- agent --local ...`, `dev:openclaw -- gateway run --allow-unconfigured --auth none --port 18911`, `npm test`, `npm run typecheck`, `npm run test:live` | existing dev routes; `typecheck`, `build`, `vitest run` green on the build worker's tree; the Gateway command is from `MEMORY.md` | |
