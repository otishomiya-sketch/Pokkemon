#!/bin/bash
# init.sh
# .claude/db/agents.db を新規作成 + schema 適用
#
# 既に agents.db がある場合は CREATE TABLE IF NOT EXISTS なので idempotent
# (data は保持される、新カラム追加は ALTER で別 migration で対応)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB_PATH="$REPO_ROOT/.claude/db/agents.db"
SCHEMA_PATH="$REPO_ROOT/pokemon-agents/db/schema.sql"

mkdir -p "$(dirname "$DB_PATH")"

echo "[init] applying schema to $DB_PATH"
sqlite3 "$DB_PATH" < "$SCHEMA_PATH"

# WAL モード確認
JOURNAL=$(sqlite3 "$DB_PATH" "PRAGMA journal_mode;")
echo "[init] journal_mode = $JOURNAL"

# テーブル一覧
echo "[init] tables:"
sqlite3 "$DB_PATH" ".tables"

echo "[init] done."
