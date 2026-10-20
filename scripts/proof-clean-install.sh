#!/usr/bin/env bash
# Harness for the clean-install proof (see _bmad-output/.../proof-setup-docs-clean-install.md).
#
#   scripts/proof-clean-install.sh new          make a run dir: empty HOME, system Node 22 only, a git origin
#                                               of the working tree, env.sh, a nonce; prints the run dir
#   scripts/proof-clean-install.sh check RUN    after a pass: leftover processes, port, .spike hash,
#                                               where the key text sits inside RUN
#   scripts/proof-clean-install.sh leak PATH..  fail if $CURSOR_API_KEY appears in any of the paths
#   scripts/proof-clean-install.sh clean RUN    delete a run dir
#
# The key is read from $CURSOR_API_KEY and never written to a file or printed. Everything lives in
# one mktemp dir under /tmp; nothing is written to the checkout, .spike/, or the real ~/.openclaw.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEM_NODE="${PROOF_SYSTEM_NODE:-/opt/node22}"
PORT="${PROOF_GATEWAY_PORT:-18789}"

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

# Hash of file names, sizes, and mtimes: proves "untouched" without reading file contents.
tree_hash() {
  local path
  for path in "$@"; do
    if [ -e "$path" ]; then find "$path" -type f -printf '%p %s %T@\n' 2>/dev/null || true; fi
  done | LC_ALL=C sort | sha256sum | cut -c1-16
}

# Pids whose environment has HOME inside the run dir (the agent's Gateway, cursor-agent, node, ...).
run_pids() {
  local run="$1" pid
  for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    [ "$pid" = "$$" ] && continue
    if { tr '\0' '\n' <"/proc/$pid/environ" | grep -qxF "HOME=$run/home"; } 2>/dev/null; then
      echo "$pid"
    fi
  done
}

cmd="${1:-}"
shift || true
case "$cmd" in
  new)
    [ -n "${CURSOR_API_KEY:-}" ] || { echo "CURSOR_API_KEY must be set in this shell" >&2; exit 1; }
    [ -x "$SYSTEM_NODE/bin/node" ] || { echo "No system Node at $SYSTEM_NODE (set PROOF_SYSTEM_NODE)" >&2; exit 1; }
    port_free || { echo "Port $PORT is in use; the proof needs the default Gateway port free" >&2; exit 1; }
    RUN="$(mktemp -d /tmp/proof-clean-install.XXXXXX)"
    mkdir -p "$RUN/home" "$RUN/sys"
    # A private copy of the system Node, so the agent's `npm install -g` cannot touch the real one.
    cp -a "$SYSTEM_NODE" "$RUN/sys/node22"
    # The agent clones this origin: a snapshot of the working tree (uncommitted docs included),
    # without the planning files.
    mkdir "$RUN/origin"
    (cd "$ROOT" && git ls-files -co --exclude-standard | grep -v -e '^_bmad' -e '^MEMORY.md$' | tar cf - -T -) | tar xf - -C "$RUN/origin"
    dirty=clean
    [ -z "$(cd "$ROOT" && git status --porcelain)" ] || dirty=dirty
    (cd "$RUN/origin" && git init -q -b main && git add -A \
      && git -c user.name=proof -c user.email=proof@example.invalid commit -q -m "Snapshot of $(cd "$ROOT" && git rev-parse --short HEAD) ($dirty)")
    echo "$(cd "$ROOT" && git rev-parse HEAD) $dirty" >"$RUN/source-commit"
    echo "NONCE-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" >"$RUN/nonce"
    {
      echo "baseline_spike_openclaw_json=$(sha256sum "$ROOT/.spike/openclaw.json" 2>/dev/null | cut -c1-16)"
      echo "baseline_real_openclaw=$(tree_hash "$HOME/.openclaw")"
      echo "baseline_real_cursor=$(tree_hash "$HOME/.cursor" "$HOME/.config/cursor")"
      echo "baseline_real_local_bin=$(tree_hash "$HOME/.local/bin")"
    } >"$RUN/baseline"
    cat >"$RUN/env.sh" <<EOF
# Source this before every command of a pass. It holds no key text.
export HOME="$RUN/home"
export PATH="$RUN/home/.local/bin:$RUN/sys/node22/bin:/usr/bin:/bin"
for v in \$(env | grep -E '^(OPENCLAW_|NPM_CONFIG_|npm_config_|CURSOR_|NVM_)' | cut -d= -f1); do
  [ "\$v" = CURSOR_API_KEY ] || unset "\$v"
done
export PROOF_CURSOR_API_KEY="\${PROOF_CURSOR_API_KEY:-\${CURSOR_API_KEY:-}}"
unset CURSOR_API_KEY
export PROOF_NONCE="$(cat "$RUN/nonce")"
export PROOF_RUN="$RUN"
EOF
    echo "RUN=$RUN"
    echo "nonce=$(cat "$RUN/nonce")"
    echo "source=$(cat "$RUN/source-commit")"
    echo "origin=$RUN/origin  (clone with: git clone $RUN/origin $RUN/src)"
    echo "node: $(PATH="$RUN/sys/node22/bin:/usr/bin:/bin" node --version)"
    ;;
  check)
    RUN="${1:?usage: check RUN}"
    [ -d "$RUN/home" ] || { echo "Not a run dir: $RUN" >&2; exit 1; }
    status=0
    pids="$(run_pids "$RUN" | tr '\n' ' ')"
    if [ -n "${pids// /}" ]; then echo "FAIL leftover processes (HOME in run dir): $pids"; status=1; else echo "ok   no process with the run's HOME"; fi
    if port_free; then echo "ok   port $PORT is free"; else echo "FAIL port $PORT is in use"; status=1; fi
    now_spike="$(sha256sum "$ROOT/.spike/openclaw.json" 2>/dev/null | cut -c1-16)"
    while IFS='=' read -r name value; do
      case "$name" in
        baseline_spike_openclaw_json) now="$now_spike" ;;
        baseline_real_openclaw) now="$(tree_hash "$HOME/.openclaw")" ;;
        baseline_real_cursor) now="$(tree_hash "$HOME/.cursor" "$HOME/.config/cursor")" ;;
        baseline_real_local_bin) now="$(tree_hash "$HOME/.local/bin")" ;;
        *) continue ;;
      esac
      if [ "$now" = "$value" ]; then echo "ok   ${name#baseline_} unchanged"; else echo "FAIL ${name#baseline_} changed"; status=1; fi
    done <"$RUN/baseline"
    if [ -n "${CURSOR_API_KEY:-}" ]; then
      echo "key text inside the run dir (expected: only the OpenClaw config of the run's HOME):"
      (cd "$RUN" && grep -rlF -f <(printf '%s\n' "$CURSOR_API_KEY") . 2>/dev/null | sed 's/^/     /') || true
    else
      echo "skip key location (CURSOR_API_KEY not set in this shell)"
    fi
    exit "$status"
    ;;
  leak)
    [ -n "${CURSOR_API_KEY:-}" ] || { echo "CURSOR_API_KEY must be set in this shell" >&2; exit 1; }
    [ "$#" -gt 0 ] || { echo "usage: leak PATH..." >&2; exit 2; }
    # The pattern file comes from a process substitution, so the key is not on any command line.
    if grep -rlF -f <(printf '%s\n' "$CURSOR_API_KEY") -- "$@" 2>/dev/null; then
      echo "FAIL the key text is in the files above" >&2
      exit 1
    fi
    echo "ok   key text not found in: $*"
    ;;
  clean)
    RUN="${1:?usage: clean RUN}"
    case "$RUN" in /tmp/proof-clean-install.*) ;; *) echo "Refusing to delete $RUN" >&2; exit 1 ;; esac
    if [ -n "$(run_pids "$RUN")" ]; then echo "Processes still run with this HOME; stop them by pid first" >&2; exit 1; fi
    rm -rf "$RUN"
    echo "removed $RUN"
    ;;
  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
