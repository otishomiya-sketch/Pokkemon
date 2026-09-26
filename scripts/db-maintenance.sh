#!/usr/bin/env bash
# agents.db 定期メンテナンス: WAL checkpoint + VACUUM で肥大を回収する。
#
# 背景: logs/events の churn で .claude/db/agents.db は放置すると死領域が肥大する
# (2026-06-23 時点で 1.59GB → VACUUM で 329MB に回収した実績)。
#
# 安全設計: VACUUM INTO で圧縮コピーを作り、integrity_check + 主要テーブルの行数照合に
# 成功した場合のみ原本と入れ替える (照合まで原本は無傷)。
#
# 使い方: bash scripts/db-maintenance.sh
# 定期実行する場合は launchd / cron に登録 (例: 毎週日曜 4:00)。本スクリプトは
# 自動登録しない (スケジューラへの介入は手動判断に委ねる)。

set -euo pipefail
cd "$(dirname "$0")/.."

DB=".claude/db/agents.db"
TMP="$DB.vacuumed.$$"

[ -f "$DB" ] || { echo "DB not found: $DB" >&2; exit 1; }

before=$(stat -f%z "$DB" 2>/dev/null || stat -c%s "$DB")

sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
rm -f "$TMP"
sqlite3 "$DB" "VACUUM INTO '$TMP';"

# 整合性チェック
if [ "$(sqlite3 "$TMP" 'PRAGMA integrity_check;' | head -1)" != "ok" ]; then
  echo "integrity_check failed on vacuumed copy — aborting, original untouched" >&2
  rm -f "$TMP"; exit 1
fi

# 主要テーブルの行数照合
for t in agents reflections knowledge logs schema_migrations; do
  o=$(sqlite3 "$DB" "SELECT COUNT(*) FROM $t;" 2>/dev/null || echo MISSING)
  v=$(sqlite3 "$TMP" "SELECT COUNT(*) FROM $t;" 2>/dev/null || echo MISSING)
  if [ "$o" != "$v" ]; then
    echo "row-count mismatch on $t (orig=$o vac=$v) — aborting, original untouched" >&2
    rm -f "$TMP"; exit 1
  fi
done

# 入れ替え
mv "$DB" "$DB.pre-vacuum.tmp"
mv "$TMP" "$DB"
rm -f "$DB-shm" "$DB-wal" "$DB.pre-vacuum.tmp"

after=$(stat -f%z "$DB" 2>/dev/null || stat -c%s "$DB")
echo "VACUUM done: $((before/1024/1024))MB -> $((after/1024/1024))MB"
