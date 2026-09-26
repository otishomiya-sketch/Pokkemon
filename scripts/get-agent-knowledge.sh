#!/bin/bash
# 指定エージェントが起動時に読むべき必読ドメイン知識を取得する
#
# Usage:
#   bash scripts/get-agent-knowledge.sh <agent-slug> [priority]
#     priority = "required" (default) | "reference" | "all"
#
# Output:
#   該当する .md ファイルの中身を連結して stdout に出力
#   各ファイルは "=== docs/knowledge/<path> ===" のヘッダで区切る
#
# エージェント起動時 Phase 0 で `cat $(bash scripts/get-agent-knowledge.sh $AGENT_SLUG)` のように使う。

set -euo pipefail

AGENT_SLUG="${1:-}"
PRIORITY="${2:-required}"

if [ -z "$AGENT_SLUG" ]; then
  echo "Usage: $0 <agent-slug> [priority=required|reference|all]" >&2
  exit 1
fi

DB_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.claude/db/agents.db"
KNOWLEDGE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/docs/knowledge"

# priority フィルタ
case "$PRIORITY" in
  required)  WHERE="priority='required'" ;;
  reference) WHERE="priority='reference'" ;;
  all)       WHERE="1=1" ;;
  *)         echo "Invalid priority: $PRIORITY" >&2; exit 1 ;;
esac

# agent_slugs は JSON 配列なので LIKE '%"$AGENT_SLUG"%' で検索
PATHS=$(sqlite3 "$DB_PATH" "
  SELECT path FROM knowledge_index
  WHERE $WHERE
    AND status='active'
    AND agent_slugs LIKE '%\"$AGENT_SLUG\"%'
  ORDER BY confidence DESC
")

if [ -z "$PATHS" ]; then
  echo "# (該当するドメイン知識なし: agent=$AGENT_SLUG priority=$PRIORITY)"
  exit 0
fi

for rel_path in $PATHS; do
  full_path="$KNOWLEDGE_ROOT/$rel_path"
  if [ -f "$full_path" ]; then
    echo "=== docs/knowledge/$rel_path ==="
    cat "$full_path"
    echo ""
  fi
done
