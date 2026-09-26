#!/bin/bash
# エージェント実行ログを .claude/db/agents.db の agent_runs テーブルに記録する
#
# Usage:
#   bash scripts/log-agent-run.sh AGENT ACTION STATUS PROCESSED SUCCEEDED FAILED ERROR METADATA_JSON
#
# Example:
#   bash scripts/log-agent-run.sh pidgeot-editorial orchestrate success 5 4 1 "" '{"pages":["/purpose/aircon/kanagawa"]}'
#
# 履歴: 2026-04-21 再作成（アーケウスの指摘でscriptが消えていた問題を解消）
set -euo pipefail

AGENT="${1:-}"
ACTION="${2:-}"
STATUS="${3:-success}"
PROCESSED="${4:-0}"
SUCCEEDED="${5:-0}"
FAILED="${6:-0}"
ERROR="${7:-}"
METADATA="${8:-}"
if [ -z "$METADATA" ]; then
  METADATA="{}"
fi

if [ -z "$AGENT" ] || [ -z "$ACTION" ]; then
  echo "Usage: $0 AGENT ACTION STATUS PROCESSED SUCCEEDED FAILED ERROR METADATA_JSON" >&2
  echo "Example: $0 pidgeot-editorial orchestrate success 5 4 1 '' '{\"pages\":[]}'" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DB_PATH="$REPO_ROOT/.claude/db/agents.db"

if [ ! -f "$DB_PATH" ]; then
  echo "[log-agent-run] agents.db not found: $DB_PATH" >&2
  exit 1
fi

# run-agent.sh が事前に INSERT した行の ID を環境変数 AGENT_RUN_ID で受け取り、
# 存在すれば UPDATE、なければ INSERT する (重複 run 行を作らない)。
RUN_ID="${AGENT_RUN_ID:-}"

python3 - "$AGENT" "$ACTION" "$STATUS" "$PROCESSED" "$SUCCEEDED" "$FAILED" "$ERROR" "$METADATA" "$DB_PATH" "$RUN_ID" <<'PY'
import sqlite3, sys, json

agent, action, status, processed, succeeded, failed, error, metadata_json, db_path, run_id = sys.argv[1:11]

try:
    json.loads(metadata_json)
except Exception:
    metadata_json = "{}"

def to_int(v):
    try:
        return int(v or 0)
    except Exception:
        return 0

conn = sqlite3.connect(db_path)
try:
    did_update = False
    if run_id:
        cur = conn.execute(
            """UPDATE reflections SET
                 action = ?, status = ?,
                 items_processed = ?, items_succeeded = ?, items_failed = ?,
                 error_message = COALESCE(?, error_message),
                 metadata = ?,
                 updated_at = datetime('now','localtime')
               WHERE id = ?""",
            (
                action, status,
                to_int(processed), to_int(succeeded), to_int(failed),
                error if error else None,
                metadata_json,
                to_int(run_id),
            ),
        )
        did_update = cur.rowcount > 0
    if not did_update:
        conn.execute(
            """INSERT INTO reflections
               (agent_slug, action, status, trigger, items_processed, items_succeeded, items_failed, error_message, metadata)
               VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)""",
            (
                agent, action, status,
                to_int(processed), to_int(succeeded), to_int(failed),
                error if error else None,
                metadata_json,
            ),
        )
    conn.commit()
finally:
    conn.close()

mode = "updated" if did_update else "inserted"
print(f"[log-agent-run] {mode}: {agent} / {action} / {status} / p={processed} s={succeeded} f={failed}" + (f" (id={run_id})" if did_update else ""))
PY
