---
title: "First replies still take 15-20 s; investigate a warm cursor-agent start per agent"
type: 'bugfix'
ticket: 13
created: '2026-10-26'
status: 'built'
baseline_revision: '36c27d5a5e2a88144bcf02d3733b519470bdc192'
route: 'oneshot'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment'] # run inline by the build session: no subagents in this worker
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md', '{project-root}/docs/providers/cursor.md']
warnings: []
deferred:
  - summary: >-
      The latency numbers rest on scratch probes that are not in the repository.
    evidence: |-
      The ACP split script, the trace shim, and the temporary Gateway live file lived in the session scratchpad and were deleted; MEMORY.md records the method so a recheck can rebuild them. A committed live file would make a recheck one command, but it would add a live file the parity suite must account for.
    location: >-
      MEMORY.md (backlog bug 13 entry)
    severity: low
---

<intent-contract>

## Intent

**Problem:** The first reply of a new `cursor-cli` session takes 15-20 s (issue #38), later turns about 5 s. Nobody knows what the time is made of, or whether a warm start per agent (a kept process, or a pre-loaded Cursor chat forked or copied per session) is safe.

**Approach:** Measure live (process start, `session/new`, bootstrap prompt, model time; ACP fork/resume/close and a chat-store copy with cursor-agent 2026.10.22 and OpenClaw 2026.10.3), judge each warm-start idea on bootstrap tokens, stale bootstrap, idle memory, and isolation, and write numbers and decision in `MEMORY.md` and `docs/providers/cursor.md`. No pool or architecture code; a safe way that needs one becomes a course-correction proposal.

</intent-contract>

## Implementation Notes

Oneshot: an investigation; the output is two docs edits, a MEMORY entry, and a CHANGELOG line (well under 100 lines). No `src/` change.

Measurements done before writing (2026-10-26, about 14 min of live time, `NODE_USE_ENV_PROXY=1`, model `auto`):

- Raw ACP probe (scratch script, 3 reps: spawn, `initialize`, `session/new`, `ask` mode, a 36k-char docs text in the block form as bootstrap, then a short follow-up; a control chat without it; `session/load` of the bootstrapped chat; a copy of its `acp-sessions/<id>` dir under a new UUID): `initialize` 0.63-0.67 s, `session/new` 2.7-4.2 s, `session/load` 2.6-3.0 s, `set_mode` < 20 ms. First text after the prompt: bootstrapped 3.0-3.5 s, no bootstrap 2.1-2.5 s, warm follow-up 2.1-2.5 s. Ledger: bootstrapped turn 23.6k input tokens uncached (control 7.4k, all cache read), so the 36k chars are about 16k tokens.
- Gateway probe (temporary live file, deleted; isolated Gateway, catalog loaded first, main agent with its first-run `BOOTSTRAP.md`, `openclaw agent --session-id <new> --json`, a timing shim as `cursor-cli.command` that logs ACP method, size, and time only): first assistant text of a new session's first turn 22.3, 22.4, 22.8, 24.3, 29.4 s; follow-ups 5.5-9.3 s (6 turns). Per first turn: CLI to `cli exec` 3.0-5.3 s (follow-ups 2.7-3.0 s, so host-side and the same for every turn); spawn to `initialize` 0.6-1.0 s; `session/new` 3.2-3.3 s; prompt 42 KB of JSON; first thought chunk 2.4-3.0 s after the prompt; thinking until the first text 9.3-12.2 s; first-turn output 800-1000 tokens, input about 24k. Follow-up: first text 4.8-6.3 s after the prompt.
- Checks: `initialize` reports `sessionCapabilities: {list: {}}` only; `session/fork`, `unstable/session/fork`, `session/resume`, `session/close` answer `-32601 Method not found`; `session/list` works. A copied chat dir (`meta.json`, `store.db` plus WAL) loads under the new id, recalls the bootstrapped chat's secret word, and a turn in the copy is not seen by the original; but the ledger books every copy turn under the original's `conversationId` (no event carries the copy's id). Idle `cursor-agent acp` after `session/new`: about 870 MB RSS summed over its process group (agent, `worker-server`, `typescript-language-server`, two `tsserver`, `typingsInstaller`; shared pages counted twice), 170 MB after `initialize` alone.

Decision: no safe warm start in the current architecture, nothing built. The largest share (9-12 s) is the model thinking over the agent's bootstrap on the first turn, which no process trick removes; a pre-run warm-up turn would put a fake turn in the chat. Process start plus `session/new` (about 4 s) could be hidden only by a plugin-owned pre-opened process, which the host's live-session ownership and the MCP binding at `session/new` (proxy target and grant exist only once the turn starts; Cursor drops a rejected server for good) forbid today: that is the course-correction proposal below. Fork does not exist; a copy shares Cursor's server conversation id (usage P16 breaks, server-side isolation unknown).

Course correction proposed (not run, owner decides): `bmad-correct-course` on AD-12/AD-13 for "a pre-opened spare `cursor-agent` per agent (spawn + `initialize` only, or + `session/new` with a deferred MCP target)". Gain at most about 1 s (initialize only) or about 4 s (with `session/new`) of a 22-29 s first reply; cost about 170 MB or 870 MB idle per agent, a process outside OpenClaw's live-session registry, and an unverified MCP deferral. Recommendation: do not pursue now.

Files: `docs/providers/cursor.md` (latency section, Known limits), `MEMORY.md` (entry), `CHANGELOG.md` (one Changed line, docs).

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- Lenses run inline by this session (the worker has no subagents; caller's instruction). Diff: `git diff 36c27d5a` (CHANGELOG.md, MEMORY.md, docs/providers/cursor.md) plus this plan.
- verdicts: 7 findings — high 0, medium 1, low 4, false 2, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind-hunter) The table row named "Bootstrap" also carried a follow-up value, where no bootstrap is sent — renamed the row to "From the prompt to the model's first output", the bootstrap named for the first turn only.
  - `[medium]` `[patch]` (edge-case-hunter) The table's plugin-side ranges come from 2 traced sessions while the headline counts 5; a reader would take them as 5-session ranges — the intro now says the plugin's parts come from two traced sessions.
  - `[low]` `[patch]` (edge-case-hunter) Known-limits bullet said the first reply "takes 20 s or more", but an agent without `BOOTSTRAP.md` was not measured — now "can take".
  - `[low]` `[patch]` (intent-alignment) AC2 names the live-session fingerprint; the docs named only the registry — the spare-process bullet now says the registry is checked by a fingerprint of the run and a new session never has a live process to reuse.
  - `[low]` `[defer]` (verification-gap) The numbers are not reproducible from a committed file — deferred (frontmatter); MEMORY records the probe method.
  - `[false]` `[reject]` (verification-gap) No unit test pins the decision — the change has no code path; the decision is a docs statement, and P6 (fork) is already enforced as a gap by `test/parity-suite.test.ts` through the manifest, matrix, and docs.
  - `[false]` `[reject]` (blind-hunter) The CHANGELOG anchor `#first-reply-of-a-new-chat` may not resolve — GitHub's slug of `### First reply of a new chat` is exactly that.

## Verification

**Commands:**
- `npm run ci` -- expected: exit 0
- `git diff --stat` against the baseline -- expected: only `docs/providers/cursor.md`, `MEMORY.md`, `CHANGELOG.md`, this plan; nothing under `src/`, `test/`, or protected paths

**Manual checks (if no CLI):**
- The numbers in `docs/providers/cursor.md` and `MEMORY.md` match the Implementation Notes; the decision names bootstrap tokens, stale bootstrap, idle memory, and isolation.

## Auto Run Result

- Summary: investigation of issue #38 with live measurements (raw ACP probe, Gateway probe with an ACP timing shim, ledger, idle RSS, fork/resume/close and chat-copy checks). Decision: no safe warm start in the current architecture; nothing built. Main cost is model thinking over the bootstrap (9.3-12.2 s of a 22-29 s first reply); process start plus `session/new` is about 4 s; fork is absent and a chat copy shares Cursor's server conversation id. Course correction (AD-12/AD-13: pre-opened spare process per agent) proposed in Implementation Notes and recommended against for now; not run.
- Files: `docs/providers/cursor.md` (new "First reply of a new chat" subsection, Known-limits bullet); `MEMORY.md` (backlog bug 13 entry: numbers, checks, decision, probe method); `CHANGELOG.md` (one Unreleased Changed docs line, #38); this plan.
- Review: 4 patches applied (1 medium, 3 low), 1 deferred (low), 2 rejected as false (reasons in the triage log). Follow-up review recommended: false (patched: high 0, medium 1, low 3).
- Verification: `npm run ci` passed after the docs/MEMORY/CHANGELOG edits (typecheck, unit tests, lint/format checks, pack, install smoke); re-run after the review patches and the commit. `git diff --stat` shows no `src/`, `test/`, or protected path. Isolated OpenClaw config restored (`agents.defaults.model.primary` and `cursor-cli.command` unset); no leftover `cursor-agent` processes.
- Not run: an agent without `BOOTSTRAP.md`, the webchat (`chat.send`) path, models other than `auto`, and the MCP-deferral question for a spare process.
- Residual risk: numbers are from one machine and one account on one day; model thinking time varies with the model and the agent's instructions.

