#!/bin/bash
# 全エージェント共通の reflection 開始ヘルパー
#
# 使い方:
#   RUN_ID=$(bash scripts/start-reflection.sh --slug butterfree-subsidy-sync --trigger launchd)
#   RUN_ID=$(bash scripts/start-reflection.sh --slug caterpie-subsidy-writer --parent 38 --trigger subagent)
#
# 戻り値: stdout に新しい reflections.id を出力
# - subagent invocation でも独立した reflection 行が作られるようになる
# - parent_run_id でツリー構造を辿れる (butterfree(38) → caterpie(N) → metapod(M))

set -euo pipefail

SLUG=""
PARENT=""
TRIGGER="manual"

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)    SLUG="$2"; shift 2 ;;
    --parent)  PARENT="$2"; shift 2 ;;
    --trigger) TRIGGER="$2"; shift 2 ;;
    *) echo "[start-reflection] unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$SLUG" ]; then
  echo "[start-reflection] --slug required" >&2
  exit 1
fi

DB="/Users/tom/dev/hojokin-db/.claude/db/agents.db"

# parent カラムは NULL or 整数
PARENT_SQL="NULL"
if [ -n "$PARENT" ] && [ "$PARENT" != "0" ]; then
  PARENT_SQL="$PARENT"
fi

ID=$(sqlite3 "$DB" "
INSERT INTO reflections (agent_id, agent_slug, trigger, status, started_at, parent_run_id)
VALUES (
  (SELECT id FROM agents WHERE slug = '$SLUG' LIMIT 1),
  '$SLUG',
  '$TRIGGER',
  'running',
  datetime('now','localtime'),
  $PARENT_SQL
) RETURNING id;
")

echo "$ID"
