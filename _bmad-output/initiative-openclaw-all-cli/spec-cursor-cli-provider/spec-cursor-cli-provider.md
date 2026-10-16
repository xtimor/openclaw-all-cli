---
id: SPEC-cursor-cli-provider
companions:
  - claude-cli-parity.md
  - ../architecture-openclaw-all-cli/architecture-openclaw-all-cli.md
  - ../spike-cursor-transport/spike-cursor-transport.md
  - ../research-cursor-agent-openclaw-integration/research-cursor-agent-openclaw-integration.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# cursor-cli: Cursor CLI as an OpenClaw model provider

## Why

A vision with a practical pain behind it. People who pay for a Cursor subscription can't use those models inside OpenClaw the way they use API models. The only existing OpenClaw Cursor plugin was abandoned in 2026-05 and is broken on current OpenClaw (research §3). The goal is an experience and feature set as close as possible to OpenClaw's built-in Anthropic `claude-cli` backend, for several CLI providers through one shared core. Cursor (`cursor-cli/<model>`) comes first, Antigravity next.

## Capabilities

- **CAP-1**
  - **intent:** A user can select `cursor-cli/<model>` in chat, in the agent, and in `/model`, like any provider's model.
  - **success:** `/model` lists the account's Cursor models as available (not `missing-auth`), and `openclaw agent --model cursor-cli/<model>` returns a reply.
- **CAP-2**
  - **intent:** The reply streams to the channel as it is generated, as an API model's does.
  - **success:** Text deltas reach the channel before the turn ends, and the final text equals Cursor's terminal result.
- **CAP-3**
  - **intent:** Each turn's token usage is recorded as it is for an API model.
  - **success:** The assistant transcript entry carries input, output, and cache token counts that match Cursor's result for that turn.
- **CAP-4**
  - **intent:** Follow-up turns continue the same Cursor conversation without resending the history.
  - **success:** A second turn that refers to the first is answered correctly, with only the new prompt sent, including after a Gateway restart.
- **CAP-5**
  - **intent:** A chat continues on `cursor-cli` after a model switch, with access to the prior conversation and no retelling by the user.
  - **success:** After switching from an API model mid-chat, `cursor-cli` correctly answers a question about an earlier turn.
- **CAP-6**
  - **intent:** The Cursor model sees OpenClaw's tools, MCP servers, and skills as its own tools, and OpenClaw executes every call under its policy.
  - **success:** A turn that needs an OpenClaw tool runs it through OpenClaw, and a tool in `tools.deny` is unavailable to the model.
- **CAP-7**
  - **intent:** Cursor's built-in tools (shell, file write, edit, delete, web fetch) do not act on the machine during a turn.
  - **success:** A prompt asking to run a shell command or edit a file produces no Cursor-executed shell command or file change; only OpenClaw tool calls act.
- **CAP-8**
  - **intent:** On request, an agent gets its own Cursor resume, Cursor state directory, and working directory.
  - **success:** Two agents configured as isolated each have a separate chat store and config directory, and neither can resume the other's chat.
- **CAP-9**
  - **intent:** Agents running at the same time never share a resume ID, a lock, or writes to per-agent Cursor state, and turns within one session stay in order. A shared Cursor login and Cursor's shared helper process are allowed.
  - **success:** Two agents run `cursor-cli` turns in parallel and both finish without errors or a corrupted Cursor config, and a second turn in the same session waits for the first.
- **CAP-10**
  - **intent:** A person can set up `cursor-cli` in their own OpenClaw from the project docs alone.
  - **success:** Someone following `docs/setup.md` on a machine with OpenClaw and Cursor gets a working `cursor-cli/<model>` turn, without other help.
- **CAP-11**
  - **intent:** `cursor-cli` behaves like `claude-cli` wherever Cursor allows it.
  - **success:** Every row of `claude-cli-parity.md` is verified by a live test as match or approx, or recorded as a gap with its reason.
- **CAP-12**
  - **intent:** A new CLI provider is added as an adapter on the shared core, without changing the core.
  - **success:** The Antigravity adapter registers `<id>/<model>` and reuses the core's sessions, isolation, locking, and MCP bridge with no core edits.

## Constraints

- Integrates as an OpenClaw CLI-backend plugin (`registerCliBackend`, ID `cursor-cli`), without patching OpenClaw core.
- Uses only official Cursor surfaces (the `cursor-agent` CLI, `@cursor/sdk`). Cursor's private `agent.v1` protocol is excluded (terms-of-service and drift risk).
- Works on a Cursor subscription login. A Cursor API key is optional and is needed only for history reseed and the SDK transport.
- The CLI runs the tool loop with OpenClaw's tools only. OpenClaw owns policy, transcript, and session; it does not run the model's tool loop itself.
- A shared core (sessions, isolation, locking, MCP bridge, stream parsing, docs) plus a thin adapter per CLI. Each adapter picks its transport behind the custom `execute` seam that `claude-cli` itself uses. For Cursor that is spawned `cursor-agent` or `agent acp`, with `@cursor/sdk` as the fallback.
- Targets OpenClaw 2026.10.3 or later and `cursor-agent` 2026.07.06 or later.
- A new CLI provider is added only after Cursor passes every capability above.
- User docs live in `docs/`, linked from `README.md`. Every change to setup, config, or behavior updates them in the same change.

## Non-goals

- CLIs other than Cursor in this stage. Antigravity is the next stage.
- OpenClaw executing the model's tool loop itself (a host-owned loop).
- A separate Cursor login per agent.

## Success signal

- In one OpenClaw chat, a user switches from an API model to `cursor-cli/<model>` and gets a streamed reply that knows the earlier conversation. The model calls an OpenClaw tool that OpenClaw executes, Cursor's own shell and file tools do not run, and usage is recorded. Meanwhile a second, isolated agent finishes a `cursor-cli` turn in parallel without a collision.

## Assumptions

- CAP-5 is met without a Cursor API-key profile when the model answers from prior history through OpenClaw's `sessions_history` tool.
- The Cursor transport is ACP (`agent acp`), per architecture AD-4; `-p` serves only as a secondary usage source.
- Users' Cursor plans allow the headless CLI. Admins can disable it org-wide.
- macOS is the primary platform. The shared-login finding (Keychain) is macOS-specific.

## Open Questions

- Can ACP file edits ask for approval like `claude-cli`'s native tools, rather than only allow or deny?
- Does Antigravity have a headless CLI with streaming output, resume, and MCP? Research it before its adapter.
- Is a Cursor user API key billed against the subscription's included usage (research Q3)?
- Can two processes resume the same Cursor chat safely, and what does the shared helper process share (research Q4)?
- Is OpenClaw #148584 (plugin skipped at Gateway startup) fixed in 2026.10.x (research Q6)?
