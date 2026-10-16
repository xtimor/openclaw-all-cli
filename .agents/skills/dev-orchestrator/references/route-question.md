---
name: route-question
description: Answer, delegate, or escalate a blocking reason or question raised by a worker
code: RQ
---

# Route a Question

## What success looks like

The question is answered by the cheapest competent party, the answer is grounded in something citable rather than invented, and the user's attention is spent only on calls that are actually theirs. Every routing decision is one line in the run log: the question, where it went, the answer, and the ground it stood on.

A question reaches you as a blocked plan's `blocked_reason` with the unanswered questions under `Auto Run Result` or in the triage log, as an entry's `unknown`, or as a worker that asked something in prose. `bmad-build-auto` never asks the user, so treat all three the same: a question for you, never one to relay.

## The ground you answer from

In this order: `AGENTS.md` (main goal, rules) → the user's decisions in `MEMORY.md` → locked planning artifacts in the initiative folder: the spec (`spec-*/spec-*.md`) with its parity matrix, the architecture spine (`architecture-*/architecture-*.md`, AD-1…), the initiative and epic files, and the entries in each `tickets.toml` → `docs/` and the facts in `MEMORY.md`, then spike write-ups beside their entries → the plan → the existing code and its tests as fact on the ground. When an answer cannot be grounded in one of these, that is the signal it belongs further up the routing ladder, not that you should reason it out alone.

The plan ranks below the artifacts it was derived from, so a plan that contradicts the spec, the spine, or its ticket is wrong about the contradiction and not a competing authority — say so, and route what remains.

Grounding outranks domain, and this is the rule that keeps the run quiet. A question a locked artifact answers outright is answered by you with the citation, however senior its subject looks — a transport choice fixed in an AD is a lookup, not an architecture decision, and routing it anyway spends someone's attention on a decision that was already made. Consult or escalate when the artifacts are silent, contradictory, or genuinely being changed.

An artifact counts as locked when it is the canonical body of its kind — the spec, the architecture spine, the initiative and epic files, `tickets.toml` — and not one of the working notes beside it: research reports and their digests, imports and briefings, `reviews/` folders, and `.memlog.md` build logs. A memlog is the trap worth naming, because its lines are literally prefixed `(decision)` and read like canon while recording decisions that were later reversed. Research is evidence for a decision, not the decision. When a note disagrees with the canonical body it is stale and the body wins, and a note whose own text says a decision is still open is not an answer at all.

When a question rests on a premise the artifacts contradict, correct the premise first and then route whatever is still open. A corrected premise usually shrinks the question rather than dissolving it, and dropping the remainder is how a live decision goes missing.

## The four routes

Every consult below is a sub-agent on `{agent.model_consult}` (fallback `{agent.model_consult_fallback}` per the dispatch rules), and it is bound by the same standing rule as a worker: it answers to you, not to the user. Brainstorm uses `{agent.model_brainstorm}` with `{agent.model_brainstorm_fallback}` the same way.

**Answer it yourself** when the question is operational — which file or path to use, whether committing is allowed here, which shell permissions a live test needs, something already settled earlier in this run, a choice between mechanically equivalent moves inside the ticket's `verify` — or when an artifact settles it outright per the rule above. These two cases are the majority. Answer, log, move on.

**Consult `bmad-agent-pm`** when the question is small but genuinely product-shaped and the artifacts leave the call open: how a behavior fixed in the spec should read to a user, which of two readings of a ticket's `verify` is meant, terminology consistency, whether something sits inside the initiative's scope. Product judgment on a settled product is the PM's, not yours. Wording and meaning go to the PM.

**Consult the profile agent** when the question is a small or medium open call inside a specialty — `bmad-agent-architect` for architecture, ports, and the core/adapter boundary; `bmad-agent-analyst` for requirements and research reading; `bmad-agent-ux-designer` for layout, flow, and interaction, including how a reply, error, or command reads in chat. Confirm any agent you plan to consult is installed before you rely on it; if it is not, do not answer in its place, send the question to brainstorm or escalate instead. Guessing inside someone else's domain is how an architecture decision gets made by accident.

**Brainstorm with `bmad-brainstorming`, then escalate if the question survives it** when the call is complex and genuinely open: the options or their consequences are unclear, two specialists disagree, or the blast radius is wide. Converge on one recommendation. If it lands inside the locked artifacts and is not strategic, take it and continue; if a real fork remains, escalate. When the fork and its options are already obvious, skip the brainstorm and escalate directly — ceremony is not diligence.

A consult can come back with a question of its own rather than an answer. Feed that back through this ladder once. A second lap on the same question means consultation is not converging, and the honest move is to escalate rather than loop an unattended run.

When a consult's answer contradicts a locked artifact, go back to it once with the citation. If the answer stands, that is a conflict between the specialist and the artifact, which is the user's to settle.

## Escalate only for these

Product direction, scope, or priority; anything touching the user's own Node or OpenClaw (`~/.openclaw`) rather than the isolated one; a public release; shipping a capability as a gap that the user asked to be found (Cursor usage above all); a security posture trade-off the artifacts deliberately left open (permissions, credentials, the optional Cursor API key); the core/adapter boundary that the next CLI will reuse; a direct conflict with `AGENTS.md`, the user's decisions in `MEMORY.md`, or a locked artifact that consultation could not resolve; the rework or review limit exhausted or the same blocker recurring; missing credentials or infrastructure that makes a step physically impossible; scope still ambiguous after the PM and the specialist; or a complex question where the brainstorm did not converge.

These are subjects, not triggers. A question that merely touches one of them and is already answered by a locked artifact is a lookup you close yourself — the subject list decides who owns a decision that is genuinely open, never whether one is open.

Escalating is a halt, and a halt with a question outstanding is `waiting_for_user` — reserve `blocked` for a stop that no answer from the user would lift. Hold the run the same way a stop request holds it, per `references/hold-and-resume.md`, so the step that raised the escalation leaves a committed checkpoint rather than dirty work for the resume to trip over. Resume from that checkpoint when the answer arrives, and record the answer as `references/run-step.md` says to lift a question.

## How an escalation reads

One sentence on what is stuck. One line on what you already tried, so the user can see the cheap routes were used. Why it is theirs to decide. Two or three options with their consequences. Your recommendation. Then ask for a decision — not for a design review, and never as an open-ended "what do you think?".

## Never

Ask whether to continue after a green step. Make code review a condition on the user's time. Escalate something operational, or something a consult already closed unless its answer collides with a locked artifact. Change the scope on your own. Let a worker talk to the user around you.
