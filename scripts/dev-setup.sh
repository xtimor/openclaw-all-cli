#!/usr/bin/env bash
# One-shot development environment: Node 24 + OpenClaw in .spike/, npm deps, and cursor-agent.
# Agent-neutral and idempotent: Claude Code (.claude/hooks/session-start.sh) and Cursor
# (.cursor/environment.json) both call it. Put no logic anywhere else.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

scripts/dev-openclaw.sh setup

# The project needs Node 24; run npm from the isolated one, not the host's.
PATH="$ROOT/.spike/node/bin:$PATH" npm ci --no-audit --no-fund

export PATH="$HOME/.local/bin:$PATH"
if ! command -v cursor-agent >/dev/null 2>&1; then
  curl -fsSL https://cursor.com/install | bash
fi
cursor-agent --version
