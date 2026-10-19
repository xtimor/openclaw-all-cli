#!/bin/bash
# Claude Code cloud sessions only. The work is in scripts/dev-setup.sh, shared with Cursor.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

"${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}/scripts/dev-setup.sh"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi
