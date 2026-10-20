#!/usr/bin/env bash
# Harness for the clean-install proof (see _bmad-output/.../proof-setup-docs-clean-install.md).
#
#   scripts/proof-clean-install.sh new          make a run dir: empty HOME, system Node 22 only, a git origin
#                                               of the working tree, env.sh, a nonce; prints the run dir
#   scripts/proof-clean-install.sh check RUN    after a pass: leftover processes, port, .spike hash,
#                                               where the key text sits inside RUN
#   scripts/proof-clean-install.sh leak PATH..  fail if $CURSOR_API_KEY appears in any of the paths
#   scripts/proof-clean-install.sh check-env RUN  while the Gateway runs: key text in any run process environment
#   scripts/proof-clean-install.sh clean RUN    delete a run dir (refuses anything that is not a run dir)
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
  local run="$1" pid pgrp mypgrp
  mypgrp="$(awk '{print $5}' /proc/$$/stat 2>/dev/null || true)"
  for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    [ "$pid" = "$$" ] && continue
    pgrp="$(awk '{print $5}' "/proc/$pid/stat" 2>/dev/null || true)"
    [ -n "$mypgrp" ] && [ "$pgrp" = "$mypgrp" ] && continue
    if { tr '\0' '\n' <"/proc/$pid/environ" | grep -qxF "HOME=$run/home"; } 2>/dev/null; then
      echo "$pid"
    fi
  done
}

# The key TEXT (not the variable name) in the environment of any process of the run: must be none.
# True when the pid is a Cursor process or a descendant of one. `cursor-cli.env` gives the key to the
# CLI process on purpose, and its children (worker-server, language servers) inherit it.
under_cursor() {
  local pid="$1" comm args
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    # Only the executable path (the first word) counts, never text further along the command line.
    args="$(ps -o args= -p "$pid" 2>/dev/null | awk '{print $1}')"
    case "$args" in *cursor-agent*) return 0 ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

# The Gateway and everything that is not under cursor-agent must not hold the key text: an `exec`
# command is a child of the Gateway. Processes under cursor-agent hold it by design and are listed.
env_scan() {
  local run="$1" pid bad="" ok="" n=0
  for pid in $(run_pids "$run"); do
    n=$((n + 1))
    if { grep -qaF -f <(printf '%s\n' "$CURSOR_API_KEY") "/proc/$pid/environ"; } 2>/dev/null; then
      if under_cursor "$pid"; then ok="$ok $pid"; else bad="$bad $pid"; fi
    fi
  done
  if [ -n "$bad" ]; then echo "FAIL key text in the environment of pids outside the Cursor process tree:$bad"; return 1; fi
  if [ -n "$ok" ]; then echo "ok   key text only in the Cursor process tree (expected, cursor-cli.env), pids:$ok; none of the other $((n - $(echo $ok | wc -w))) run processes hold it"; return 0; fi
  echo "ok   key text in none of $n run process environments"
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
    # The key is delivered once per command through this 0600 file, never exported: the brief reads
    # it as CURSOR_KEY="$(cat RUN/key)" inside one command.
    (umask 077 && printf '%s' "$CURSOR_API_KEY" >"$RUN/key")
    echo "NONCE-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" >"$RUN/nonce"
    {
      echo "baseline_spike_openclaw_json=$(sha256sum "$ROOT/.spike/openclaw.json" 2>/dev/null | cut -c1-16)"
      echo "baseline_real_openclaw=$(tree_hash "$HOME/.openclaw")"
      echo "baseline_real_cursor=$(tree_hash "$HOME/.cursor" "$HOME/.config/cursor")"
      echo "baseline_real_local_bin=$(tree_hash "$HOME/.local/bin")"
    } >"$RUN/baseline"
    cat >"$RUN/env.sh" <<EOF
# Source this before every command of a pass. It holds no key text and exports none.
export HOME="$RUN/home"
export PATH="$RUN/home/.local/bin:$RUN/sys/node22/bin:/usr/bin:/bin"
for v in \$(env | grep -E '^(OPENCLAW_|NPM_CONFIG_|npm_config_|CURSOR_|NVM_)' | cut -d= -f1); do
  [ "\$v" = CURSOR_API_KEY ] || unset "\$v"
done
unset CURSOR_API_KEY PROOF_CURSOR_API_KEY
export PROOF_KEY_FILE="$RUN/key"
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
    if [ "$HOME" = "$RUN/home" ]; then
      echo "Run check from a shell that did not source env.sh (HOME is the run's HOME)" >&2
      exit 1
    fi
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
      env_scan "$RUN" || status=1
      echo "key text inside the run dir (expected: RUN/key, the OpenClaw config and its backups, home/.config/cursor/auth.json):"
      (cd "$RUN" && grep -rlF -f <(printf '%s\n' "$CURSOR_API_KEY") . 2>/dev/null | sed 's/^/     /') || true
    else
      echo "skip key location (CURSOR_API_KEY not set in this shell)"
    fi
    exit "$status"
    ;;
  check-env)
    RUN="${1:?usage: check-env RUN}"
    [ -n "${CURSOR_API_KEY:-}" ] || { echo "CURSOR_API_KEY must be set in this shell" >&2; exit 1; }
    [ "$HOME" != "$RUN/home" ] || { echo "Run from a shell that did not source env.sh" >&2; exit 1; }
    env_scan "$RUN"
    ;;
  leak)
    [ -n "${CURSOR_API_KEY:-}" ] || { echo "CURSOR_API_KEY must be set in this shell" >&2; exit 1; }
    [ "$#" -gt 0 ] || { echo "usage: leak PATH..." >&2; exit 2; }
    for path in "$@"; do
      [ -e "$path" ] || { echo "FAIL no such path: $path" >&2; exit 1; }
    done
    # The pattern file comes from a process substitution, so the key is not on any command line.
    # grep exits 0 = found (fail), 1 = not found (ok), 2 = an error (fail).
    rc=0
    grep -rlF -f <(printf '%s\n' "$CURSOR_API_KEY") -- "$@" || rc=$?
    case "$rc" in
      0) echo "FAIL the key text is in the files above" >&2; exit 1 ;;
      1) ;;
      *) echo "FAIL grep error (status $rc)" >&2; exit 1 ;;
    esac
    echo "ok   key text not found in: $*"
    ;;
  clean)
    RUN="${1:-}"
    [ -n "$RUN" ] || { echo "usage: clean RUN" >&2; exit 2; }
    resolved="$(realpath -e -- "$RUN" 2>/dev/null)" || { echo "Refusing: $RUN does not exist" >&2; exit 1; }
    if [ -L "$RUN" ] || [ -L "${RUN%/}" ] || [ -L "$resolved" ]; then echo "Refusing: $RUN is a symlink" >&2; exit 1; fi
    case "$resolved" in
      /tmp/proof-clean-install.??????) ;;
      *) echo "Refusing: $resolved is not a run dir" >&2; exit 1 ;;
    esac
    [[ "$resolved" =~ ^/tmp/proof-clean-install\.[A-Za-z0-9]{6}$ ]] || { echo "Refusing: bad name $resolved" >&2; exit 1; }
    [ -d "$resolved/home" ] && [ -f "$resolved/nonce" ] && [ -f "$resolved/key" ] && [ -f "$resolved/env.sh" ] \
      || { echo "Refusing: $resolved lacks home, nonce, key, env.sh" >&2; exit 1; }
    if [ -n "$(run_pids "$resolved")" ]; then echo "Processes still run with this HOME; stop them by pid first" >&2; exit 1; fi
    rm -rf -- "$resolved"
    echo "removed $resolved"
    ;;
  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
