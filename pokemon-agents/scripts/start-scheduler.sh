#!/bin/bash
# start-scheduler.sh
# Platform v2 heartbeat scheduler を起動する。
# launchd / 手動 両方から呼ばれる想定。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# bun の path (launchd 環境では PATH が狭いので明示)
BUN_BIN="${BUN_BIN:-/Users/tom/.bun/bin/bun}"

if [ ! -x "$BUN_BIN" ]; then
  BUN_BIN="$(command -v bun)"
fi

if [ -z "$BUN_BIN" ]; then
  echo "[start-scheduler] ERROR: bun not found" >&2
  exit 1
fi

cd "$REPO_ROOT"
exec "$BUN_BIN" pokemon-agents/runtime/scheduler.ts
