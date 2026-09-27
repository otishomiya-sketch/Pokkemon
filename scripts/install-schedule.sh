#!/bin/bash
# 寿司メニュー学習ループの自動実行を macOS の launchd に登録する
#
#   bash scripts/install-schedule.sh            登録（毎日 2:00 メガゲンガー / 毎週月曜 3:00 アルセウス）
#   bash scripts/install-schedule.sh --remove   登録を外す
#   bash scripts/install-schedule.sh --status   登録状況を見る
#
# Mac がスリープ中だった場合は、次に起きたときに 1 回だけ実行される（launchd の仕様）。
# ログ: ~/.claude/logs/sushi-<担当>.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.claude/logs"
DOMAIN="gui/$(id -u)"

# ラベル|担当|agent.md|時刻（plist の StartCalendarInterval の中身）
JOBS=(
  "com.claude.sushi.megagengar-orchestrator|megagengar-orchestrator|.claude/agents/megagengar-orchestrator.md|<key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer>"
  "com.claude.sushi.arceus-knowledge-editor|arceus-knowledge-editor|.claude/agents/arceus-knowledge-editor.md|<key>Weekday</key><integer>1</integer><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer>"
)

case "${1:-}" in
  --remove)
    for job in "${JOBS[@]}"; do
      IFS='|' read -r label _ _ _ <<< "$job"
      launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
      rm -f "$AGENT_DIR/$label.plist"
      echo "外しました: $label"
    done
    exit 0
    ;;
  --status)
    for job in "${JOBS[@]}"; do
      IFS='|' read -r label _ _ _ <<< "$job"
      if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then echo "登録済み: $label"; else echo "未登録:   $label"; fi
    done
    exit 0
    ;;
  "") ;;
  *) echo "使い方: bash scripts/install-schedule.sh [--remove|--status]" >&2; exit 1 ;;
esac

mkdir -p "$AGENT_DIR" "$LOG_DIR"

if [ ! -f "$REPO_ROOT/.env.local" ] || ! grep -q '^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-' "$REPO_ROOT/.env.local"; then
  echo "⚠️  .env.local に CLAUDE_CODE_OAUTH_TOKEN がありません。夜中の実行はログイン切れで失敗する可能性があります。" >&2
fi

# 1) 下見: launchd から起動したプロセスがこのフォルダを読めるか確かめる
#    （macOS は「デスクトップ」フォルダへのバックグラウンドからのアクセスを止めることがある）
CHECK_LABEL="com.claude.sushi.access-check"
CHECK_OUT="$LOG_DIR/sushi-access-check.log"
rm -f "$CHECK_OUT"
cat > "$AGENT_DIR/$CHECK_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$CHECK_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>head -c 1 "$REPO_ROOT/scripts/run-agent.sh" >/dev/null &amp;&amp; echo ok || echo denied</string>
  </array>
  <key>StandardOutPath</key><string>$CHECK_OUT</string>
  <key>StandardErrorPath</key><string>$CHECK_OUT</string>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
launchctl bootout "$DOMAIN/$CHECK_LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$AGENT_DIR/$CHECK_LABEL.plist"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$CHECK_OUT" ] && break; sleep 1; done
launchctl bootout "$DOMAIN/$CHECK_LABEL" 2>/dev/null || true
rm -f "$AGENT_DIR/$CHECK_LABEL.plist"

if ! grep -q '^ok' "$CHECK_OUT" 2>/dev/null; then
  echo "❌ 自動実行からこのフォルダ（$REPO_ROOT）を読めませんでした。"
  echo "   macOS が「デスクトップ」フォルダへのバックグラウンドからのアクセスを止めています。"
  echo "   対処: プロジェクトをデスクトップ以外（例: ~/dev/）に移すと確実です。"
  echo "   登録は行っていません。"
  exit 1
fi
echo "✅ 下見 OK: 自動実行からフォルダを読めます"

# 2) 本登録
for job in "${JOBS[@]}"; do
  IFS='|' read -r label agent md calendar <<< "$job"
  plist="$AGENT_DIR/$label.plist"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/scripts/run-agent.sh</string>
    <string>$agent</string>
    <string>$md</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>StartCalendarInterval</key><dict>$calendar</dict>
  <key>StandardOutPath</key><string>$LOG_DIR/sushi-$agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/sushi-$agent.log</string>
</dict></plist>
PLIST
  plutil -lint "$plist" >/dev/null
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
  echo "登録しました: $label"
done

echo ""
echo "毎日 2:00 にメガゲンガー、毎週月曜 3:00 にアルセウスが動きます。"
echo "止めたいとき: bash scripts/install-schedule.sh --remove"
