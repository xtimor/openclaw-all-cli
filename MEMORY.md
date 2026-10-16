# Memory

## Where things are

- Plan of record: `_bmad-output/initiative-openclaw-all-cli/`: spec (`spec-cursor-cli-provider/`), architecture spine (`architecture-openclaw-all-cli/`, AD-1..AD-14), parity matrix (`spec-cursor-cli-provider/claude-cli-parity.md`), tickets (`tickets.toml`, `epic-cursor-cli/tickets.toml`).
- Spike harness: `.spike/` (gitignored). OpenClaw 2026.10.3 in `.spike/openclaw`, Node 24 in `.spike/node` (system Node 25 is rejected by OpenClaw), test MCP server `.spike/mcp/server.mjs`, ACP probe `.spike/acp-probe.mjs`.

## Decisions (user)

- Goal: `claude-cli` experience and features for every CLI; Cursor first, Antigravity next.
- The agent decides design; the user decides strategy only.
- Work only against the isolated OpenClaw; the user's own Node and OpenClaw (`~/.openclaw`, 2026.2.22) are upgraded at the end (epic entry 18).
- A host without a Cursor login still develops. It installs Node 24 and OpenClaw 2026.10.3 into `.spike` when they are missing. The live `cursor-agent` check waits for a machine that has the login, and that wait is not a question (user, 2026-10-16).
- Cursor API key optional. No public release in this initiative.
- Cursor usage must be found; shipping without it is a last resort.

## Facts learned the hard way

- `cursor-agent -p` reads project `.cursor/mcp.json` only at the workspace's git root, and ignores project `.cursor/cli.json` permissions; permissions work from `CURSOR_CONFIG_DIR/cli-config.json`.
- `cursor-agent acp` honors `session/new.mcpServers` (HTTP + headers), asks permission for shell, auto-applies edits unless `Write(**)` is denied, and reports no usage.
- `deny: Read(**)` does not block grep/glob.
- OpenClaw mints a new loopback MCP token per run; a warm session needs the per-turn MCP proxy (AD-12).
- OpenClaw owns session binding (`ctx.sessionId`/`useResume`) and per-session lanes with `liveSession`; do not duplicate them.
- Sandboxed shells can't read the Cursor login from the Keychain; run `cursor-agent` with full permissions.
- OpenClaw scans a plugin's whole root dir. A `--link` install of the checkout fails (`.spike/` holds hundreds of nested packages; state under the root trips "directory changed during admission"). Install a packed `.tgz` (`npm run dev:install`); copy install needs built `dist/` (`openclaw.runtimeExtensions`).
- Manifest `providers: ["<backend>"]` is required for `providerCatalogEntry` (synthetic auth) to load; `cliBackends` alone leaves `models status` at `[indeterminate]`. Entry may export an array.
- A CLI backend's `execute` yields records; OpenClaw JSON-stringifies them into `parseJsonlEvent`. Records with `type: "result"` end the turn. `useResume` needs non-empty `resumeArgs`; `sessionMode: "existing"` passes only the stored ID.
- Vitest env makes OpenClaw mute output; strip `VITEST*` when a test spawns it.
- Host-less checks use `test/fixtures/fake-cursor-agent.mjs` (ACP stand-in; steer with `[[hang]]`, `[[crash]]`, `[[ask-permission]]`, `say:<text>`). It proves wiring only, not Cursor behavior.
- Plugin startup loading (#148584, OpenClaw 2026.10.3): with no config naming `cursor-cli`, the Gateway loads the plugin on the first turn selecting it; with `agents.defaults.model.primary = cursor-cli/auto` it loads at startup.
