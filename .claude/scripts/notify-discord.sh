#!/bin/bash
# Discord Webhook通知（オーバーライド方式）
# 1つのWebhookで全エージェントが共有。username/avatar_urlをペイロードで上書き。
#
# Usage: bash notify-discord.sh --agent NAME "メッセージ"
#        bash notify-discord.sh "メッセージ"   （汎用、エージェント指定なし）
#
# キャラクタートーン（Discord通知専用。ライティングには影響させないこと）
#   キャタピー（Subsidy Writer）: 一生懸命。「記事書いたよ！トランセルにレビューお願い！」
#   トランセル（Subsidy Reviewer）: 堅実に硬化。「…チェック完了。3件修正した」
#   バタフリー（Subsidy Sync）: 軽やかに正確。「ひらひら〜データ運んできたよ」
#   コイル（Benefit Writer）: 素朴に電磁波。「ビビビ…記事できた」
#   レアコイル（Benefit Reviewer）: 磁力で精査。「…検証した。2件修正、再保存」
#   ポッポ（Editorial Writer）: 元気に飛ぶ。「書いてきた！ピジョンよろしく！」
#   ピジョン（Editorial Reviewer）: 鋭い目で校閲。「上空からチェック。問題なし」
#   ピジョット（Editorial）: 颯爽と的確。「上空から見渡してきた。5ページ最適化したよ」
#   ケーシィ（SEO Report）: 眠そうだけど鋭い。「…zzz…あ、このデータ面白いね」
#   ユンゲラー（Rank Monitor）: 予知能力で順位変動を読む。「…順位を視てきたよ」
#   アルセウス（Agent Auditor）: 全てを見通す。「…監査完了」
#   ウミディグダ（Title Optimizer）: 地中から顔を出す。「お、いいタイトル見つけた」
#   ゲンガー（Orchestrator）: 影から操る。「…仮説、検証完了」
#   カイリキー（Ranking）: 力強く。「ランキング、決まった！」
#   ミュウ（Meta Review）: 自由自在。「全体を俯瞰してみたよ〜」
#   カイロス（Permit Writer）: ガッチリ。「許認可データ、投入した」
#   ポリゴン（KW Research）: デジタルに。「キーワードデータ、処理完了」
#   ハッサム（Guide Writer）: 切れ味鋭く。「ガイドページ、仕上げた」
#   ツボツボ（Hatena Publisher）: 地道に。「はてな、投稿できたよ…」
#   スターミー（Expert Outreach）: 冷静で的確。「…分析完了」
#   ロコン（Note Publisher）: 小さいけど頑張り屋。「記事できたよ〜！」

set -euo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || true

# jq check
if ! command -v jq &>/dev/null; then
  echo "jq not found, skipping notification"
  exit 0
fi

# Supabase Storage (public bucket)
AVATAR="https://wnvqzhryhftpusunvueq.supabase.co/storage/v1/object/public/pokemon-icons"

# Agent → display name + avatar mapping
AGENT_NAME=""
AGENT_AVATAR=""
if [ "${1:-}" = "--agent" ]; then
  case "${2:-}" in
    caterpie-subsidy-writer)     AGENT_NAME="キャタピー";  AGENT_AVATAR="$AVATAR/caterpie.png" ;;
    metapod-subsidy-reviewer)    AGENT_NAME="トランセル";  AGENT_AVATAR="$AVATAR/metapod.png" ;;
    butterfree-subsidy-sync)     AGENT_NAME="バタフリー";  AGENT_AVATAR="$AVATAR/butterfree.png" ;;
    magnemite-benefit-writer)    AGENT_NAME="コイル";      AGENT_AVATAR="$AVATAR/magnemite.png" ;;
    magneton-kyufukin)           AGENT_NAME="レアコイル";  AGENT_AVATAR="$AVATAR/magneton.png" ;;
    magnezone-benefit-orchestrator) AGENT_NAME="ジバコイル"; AGENT_AVATAR="$AVATAR/magnezone.png" ;;
    pidgey-editorial-writer)     AGENT_NAME="ポッポ";      AGENT_AVATAR="$AVATAR/pidgey.png" ;;
    pidgeotto-editorial-reviewer) AGENT_NAME="ピジョン";   AGENT_AVATAR="$AVATAR/pidgeotto.png" ;;
    pidgeot-editorial)           AGENT_NAME="ピジョット";  AGENT_AVATAR="$AVATAR/pidgeot.png" ;;
    abra-seo-report)             AGENT_NAME="ケーシィ";    AGENT_AVATAR="$AVATAR/abra.png" ;;
    kadabra-rank-monitor)        AGENT_NAME="ユンゲラー";  AGENT_AVATAR="$AVATAR/kadabra.png" ;;
    arceus-agent-auditor)        AGENT_NAME="アルセウス";  AGENT_AVATAR="$AVATAR/arceus.png" ;;
    diglett-title-optimizer)     AGENT_NAME="ディグダ";    AGENT_AVATAR="$AVATAR/diglett.png" ;;
    gengar-orchestrator)         AGENT_NAME="ゲンガー";    AGENT_AVATAR="$AVATAR/gengar.png" ;;
    machamp-ranking)             AGENT_NAME="カイリキー";  AGENT_AVATAR="$AVATAR/machamp.png" ;;
    mew-meta-review)             AGENT_NAME="ミュウ";      AGENT_AVATAR="$AVATAR/mew.png" ;;
    pinsir-permit-writer)        AGENT_NAME="カイロス";    AGENT_AVATAR="$AVATAR/pinsir.png" ;;
    porygon-keyword-research)    AGENT_NAME="ポリゴン";    AGENT_AVATAR="$AVATAR/porygon.png" ;;
    scizor-guide-writer)         AGENT_NAME="ハッサム";    AGENT_AVATAR="$AVATAR/scizor.png" ;;
    shuckle-hatena-publisher)    AGENT_NAME="ツボツボ";    AGENT_AVATAR="$AVATAR/shuckle.png" ;;
    starmie-expert-outreach)     AGENT_NAME="スターミー";  AGENT_AVATAR="$AVATAR/starmie.png" ;;
    vulpix-note-publisher)       AGENT_NAME="ロコン";      AGENT_AVATAR="$AVATAR/vulpix.png" ;;
    delibird-chat)               AGENT_NAME="デリバード";  AGENT_AVATAR="$AVATAR/delibird.png" ;;
    *)
      echo "Unknown agent: ${2:-}"
      exit 1
      ;;
  esac
  shift 2
fi

# Webhook URL（全エージェント共通）
WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
if [ -z "$WEBHOOK_URL" ]; then echo "notify-discord: DISCORD_WEBHOOK_URL 未設定 (.env.local に設定してください)" >&2; exit 0; fi

# Build payload
message="${1:-}"
if [ -z "$message" ]; then
  echo "Usage: notify-discord.sh [--agent NAME] \"メッセージ\""
  exit 1
fi

if [ -n "$AGENT_NAME" ]; then
  payload=$(jq -n \
    --arg msg "$message" \
    --arg name "$AGENT_NAME" \
    --arg avatar "$AGENT_AVATAR" \
    '{content: $msg, username: $name, avatar_url: $avatar}')
else
  payload=$(jq -n --arg msg "$message" '{content: $msg}')
fi

curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$WEBHOOK_URL"
