#!/usr/bin/env bash
# Isolated OpenClaw for development and live tests.
#
#   scripts/dev-openclaw.sh setup     install Node and OpenClaw into .spike/ when missing
#   scripts/dev-openclaw.sh install   build, pack, and install this plugin into the isolated OpenClaw
#   scripts/dev-openclaw.sh run ...   run `openclaw ...` with the isolated Node, state, and config
#   scripts/dev-openclaw.sh env       print the exports a shell needs to use the isolated setup
#
# Everything lives under .spike/ (gitignored). Your own ~/.openclaw is never read or written.
# Override the versions with NODE_VERSION and OPENCLAW_VERSION.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPIKE="${SPIKE_DIR:-$ROOT/.spike}"
NODE_VERSION="${NODE_VERSION:-24.22.0}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.10.3}"

NODE_DIR="$SPIKE/node"
OPENCLAW_DIR="$SPIKE/openclaw"
OPENCLAW_BIN="$OPENCLAW_DIR/node_modules/.bin/openclaw"
STATE_DIR="$SPIKE/state"
CONFIG_PATH="$SPIKE/openclaw.json"
PACK_DIR="$SPIKE/pack"

use_isolated_env() {
  export PATH="$NODE_DIR/bin:${FAKE_BIN_DIR:+$FAKE_BIN_DIR:}$PATH"
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"
  # Node's fetch ignores HTTP(S)_PROXY unless this is set; the plugin's usage ledger calls need it behind a proxy.
  export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"
}

install_node() {
  if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" --version)" = "v$NODE_VERSION" ]; then
    return
  fi
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  local name="node-v$NODE_VERSION-$os-$arch"
  local ext=tar.xz
  [ "$os" = darwin ] && ext=tar.gz
  echo "Installing Node $NODE_VERSION into $NODE_DIR"
  mkdir -p "$SPIKE"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.$ext" -o "$tmp/node.$ext"
  tar -xf "$tmp/node.$ext" -C "$tmp"
  rm -rf "$NODE_DIR"
  mv "$tmp/$name" "$NODE_DIR"
  rm -rf "$tmp"
}

install_openclaw() {
  if [ -x "$OPENCLAW_BIN" ] && [ "$(PATH="$NODE_DIR/bin:$PATH" "$OPENCLAW_BIN" --version 2>/dev/null | awk '{print $2}')" = "$OPENCLAW_VERSION" ]; then
    return
  fi
  echo "Installing OpenClaw $OPENCLAW_VERSION into $OPENCLAW_DIR"
  mkdir -p "$OPENCLAW_DIR"
  # Without its own package.json, npm would walk up and install into the project root.
  [ -f "$OPENCLAW_DIR/package.json" ] || echo '{"private":true}' > "$OPENCLAW_DIR/package.json"
  (cd "$OPENCLAW_DIR" && PATH="$NODE_DIR/bin:$PATH" npm install --no-audit --no-fund "openclaw@$OPENCLAW_VERSION")
}

cmd="${1:-}"
shift || true
case "$cmd" in
  setup)
    install_node
    install_openclaw
    use_isolated_env
    node --version
    "$OPENCLAW_BIN" --version
    ;;
  env)
    cat <<EOF
export PATH="$NODE_DIR/bin:\$PATH"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"
EOF
    ;;
  install)
    install_node
    install_openclaw
    use_isolated_env
    mkdir -p "$STATE_DIR" "$PACK_DIR"
    rm -f "$PACK_DIR"/openclaw-all-cli-*.tgz
    (cd "$ROOT" && npm run build && npm pack --pack-destination "$PACK_DIR" >/dev/null)
    # The plugin is installed from a packed archive, as a user's install would be. A linked
    # checkout fails: OpenClaw scans the whole plugin root, and .spike/ holds hundreds of packages.
    "$OPENCLAW_BIN" plugins install --force --accept-capabilities "$PACK_DIR"/openclaw-all-cli-*.tgz
    ;;
  run)
    use_isolated_env
    exec "$OPENCLAW_BIN" "$@"
    ;;
  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
