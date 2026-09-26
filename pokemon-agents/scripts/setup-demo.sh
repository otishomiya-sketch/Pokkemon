#!/usr/bin/env bash
# setup-demo.sh — 配布用デモ環境をワンコマンドで構築
#
# fresh clone から「中身の入ったダッシュボード」を立ち上げるまでを一気に行う:
#   1. schema.sql を空 DB に適用
#   2. .claude/agents/*.md からエージェント 26 体を seed
#   3. 現実味のあるデモデータを投入 (reflections / logs / hypotheses / improvements /
#      agent_costs / agent_schedules / daily_reports / approvals)
#
# 既存の本番 DB を壊さないよう、デフォルトでは別ファイル (.claude/db/agents-demo.db) に作る。
#
# 使い方:
#   bash pokemon-agents/scripts/setup-demo.sh           # → .claude/db/agents-demo.db
#   bash pokemon-agents/scripts/setup-demo.sh <path>    # 任意のパスに作る
#
# 立ち上げ:
#   AGENTS_DB_PATH=.claude/db/agents-demo.db bun pokemon-agents/web/server.ts
#   → http://localhost:5733/

set -euo pipefail
cd "$(dirname "$0")/../.."

DEMO_DB="${1:-.claude/db/agents-demo.db}"
export AGENTS_DB_PATH="$DEMO_DB"

echo "[setup-demo] target DB: $DEMO_DB"
rm -f "$DEMO_DB" "$DEMO_DB-shm" "$DEMO_DB-wal"

echo "[setup-demo] 1/3 schema.sql 適用..."
sqlite3 "$DEMO_DB" < pokemon-agents/db/schema.sql

echo "[setup-demo] 2/3 エージェント seed..."
bun pokemon-agents/scripts/seed-agents-from-md.ts | tail -1

echo "[setup-demo] 3/3 デモデータ投入..."
bun pokemon-agents/scripts/seed-demo-data.ts | sed 's/^/  /'

echo ""
echo "[setup-demo] ✅ 完了。ダッシュボードを起動するには:"
echo ""
echo "    AGENTS_DB_PATH=$DEMO_DB bun pokemon-agents/web/server.ts"
echo "    → http://localhost:5733/"
echo ""
