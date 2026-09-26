#!/bin/bash

# エージェント実行ラッパー — コスト追跡 + 実行ログ自動記録
# 使い方: bash scripts/run-agent.sh <agent-name> <agent-md-path> [model]

AGENT_FULL="$1"
AGENT_MD="$2"
MODEL="${3:-}"

# エージェントファイル解決（フラット .md / subfolder agent.md / パイプラインフォルダ）
# 解決優先順位 (B 案移行・2026-05-07):
#   1. 引数 path がそのまま存在 → 使う
#   2. .claude/agents/<slug>.md (公式フラット配置) → 移行先
#   3. .claude/agents/*/.../<slug>/agent.md (旧サブフォルダ配置) → 移行元、互換維持
if [ ! -f "/Users/tom/dev/hojokin-db/$AGENT_MD" ] && [ ! -f "$AGENT_MD" ]; then
    FLAT="/Users/tom/dev/hojokin-db/.claude/agents/${AGENT_FULL}.md"
    if [ -f "$FLAT" ]; then
        echo "[run-agent] flat resolved: $AGENT_MD -> $FLAT" >&2
        AGENT_MD="$FLAT"
    else
        RESOLVED=$(find /Users/tom/dev/hojokin-db/.claude/agents -type f -name 'agent.md' -path "*/${AGENT_FULL}/agent.md" 2>/dev/null | head -1)
        if [ -n "$RESOLVED" ]; then
            echo "[run-agent] subfolder fallback: $AGENT_MD -> $RESOLVED" >&2
            AGENT_MD="$RESOLVED"
        else
            echo "[run-agent] ERROR: agent.md not found for $AGENT_FULL (tried: $AGENT_MD, $FLAT, **/${AGENT_FULL}/agent.md)" >&2
            exit 1
        fi
    fi
fi

# エージェントの slug は常に full slug を使う（agents テーブルと JOIN 一致させるため）
# 例: butterfree-subsidy-sync, pidgeot-editorial
# 注: 過去 run-agent.sh は `${AGENT_FULL%%-*}` で短縮形にしていたが、agents.slug が
# full の場合 runs との JOIN が失敗するので廃止（2026-04-24）
AGENT_NAME="$AGENT_FULL"

cd /Users/tom/dev/hojokin-db

# モデル: 第3引数 > agent.md frontmatter の model: > claude 既定 の優先順位。
# frontmatter に model: sonnet 等があるのに未指定だと既定(Opus等)で走り高コストになるため、
# frontmatter を source of truth として読む（timeout_sec と同じ方式）。
if [ -z "$MODEL" ]; then
    MODEL=$(awk '/^---$/{n++; next} n==1 && /^model:/{print $2; exit}' "$AGENT_MD" 2>/dev/null)
fi
MODEL_FLAG=""
if [ -n "$MODEL" ]; then
    MODEL_FLAG="--model $MODEL"
    echo "[run-agent] model: $MODEL" >&2
fi

# タイムアウト: agent.md frontmatter の timeout_sec を source of truth として読む
# 未指定時は 1800s (30分) にフォールバック
TIMEOUT_FROM_FM=$(awk '/^---$/{n++; next} n==1 && /^timeout_sec:/{print $2; exit}' "$AGENT_MD" 2>/dev/null)
DEFAULT_TIMEOUT="${TIMEOUT_FROM_FM:-1800}"
TIMEOUT_SEC="${AGENT_TIMEOUT:-$DEFAULT_TIMEOUT}"

# 実行開始時に reflections に running 行を INSERT → RUN_ID を agent 環境変数で渡す
# agent.md は UPDATE reflections SET self_score=... WHERE id=$RUN_ID で reflection を書く
# 共通ヘルパー scripts/start-reflection.sh を使う (subagent も同じヘルパーを使うので統一)
RUN_ID=$(bash /Users/tom/dev/hojokin-db/scripts/start-reflection.sh --slug "$AGENT_NAME" --trigger launchd)
export AGENT_RUN_ID="$RUN_ID"

# macOS互換タイムアウト（バックグラウンド+wait+kill方式）
TMPOUT=$(mktemp)
/Users/tom/.local/bin/claude $MODEL_FLAG -p "$AGENT_MD を読み、そのルールに従って実行せよ。あなたの AGENT_RUN_ID は ${RUN_ID} です。reflection を書く際は UPDATE reflections SET self_score=..., what_went_well=... WHERE id=${RUN_ID}; を使ってください。" --dangerously-skip-permissions --output-format json > "$TMPOUT" 2>&1 &
CLAUDE_PID=$!

# タイムアウト監視
( sleep "$TIMEOUT_SEC" && kill -TERM $CLAUDE_PID 2>/dev/null && sleep 5 && kill -KILL $CLAUDE_PID 2>/dev/null ) &
WATCHDOG_PID=$!

wait $CLAUDE_PID 2>/dev/null
EXIT_CODE=$?
kill $WATCHDOG_PID 2>/dev/null; wait $WATCHDOG_PID 2>/dev/null

OUTPUT=$(cat "$TMPOUT")
rm -f "$TMPOUT"

# シグナルで死んだ場合（143=SIGTERM, 137=SIGKILL）
if [ $EXIT_CODE -eq 143 ] || [ $EXIT_CODE -eq 137 ]; then
    echo "[run-agent] TIMEOUT: $AGENT_NAME が${TIMEOUT_SEC}秒でタイムアウト"
    OUTPUT='{"total_cost_usd":0,"usage":{},"duration_ms":'$((TIMEOUT_SEC*1000))',"num_turns":0,"result":"timeout after '${TIMEOUT_SEC}'s","stop_reason":"timeout","is_error":true}'
fi

# JSON解析を1回で済ませる
PARSED=$(echo "$OUTPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except:
    d = {}
u = d.get('usage', {})
print(json.dumps({
    'cost': d.get('total_cost_usd', 0),
    'input_tokens': u.get('input_tokens', 0),
    'output_tokens': u.get('output_tokens', 0),
    'cache_read': u.get('cache_read_input_tokens', 0),
    'cache_create': u.get('cache_creation_input_tokens', 0),
    'duration': d.get('duration_ms', 0),
    'turns': d.get('num_turns', 0),
    'result': (d.get('result', '') or '')[:500],
    'stop_reason': d.get('stop_reason', 'unknown'),
    'is_error': d.get('is_error', False),
}))
" 2>/dev/null || echo '{"cost":0,"input_tokens":0,"output_tokens":0,"cache_read":0,"cache_create":0,"duration":0,"turns":0,"result":"parse error","stop_reason":"error","is_error":true}')

COST=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['cost'])")
INPUT_TOKENS=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['input_tokens'])")
OUTPUT_TOKENS=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['output_tokens'])")
CACHE_READ=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['cache_read'])")
CACHE_CREATE=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['cache_create'])")
DURATION=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['duration'])")
NUM_TURNS=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['turns'])")
RESULT=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")
STOP_REASON=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['stop_reason'])")
IS_ERROR=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin)['is_error'])")

# ステータス判定
if [ "$IS_ERROR" = "True" ] || [ "$STOP_REASON" = "error" ]; then
    STATUS="error"
else
    STATUS="success"
fi

# 偽陽性チェック: resultに認証エラー系キーワードが含まれていたらerrorに変更
if [ "$STATUS" = "success" ]; then
    if echo "$RESULT" | grep -qiE "認証が必要|OAuth|authorize\?|認証を完了|ブラウザで.*開いて|re-authorization|token expired"; then
        STATUS="error"
        RESULT="[偽陽性修正] Supabase認証エラーで実行失敗。$(echo "$RESULT" | head -c 300)"
        echo "[run-agent] 偽陽性検出: $AGENT_NAME のstatusをerrorに修正"
    fi
fi

# SQLite に記録: 値は全て環境変数で渡す (シェル文字列埋め込み禁止)
# 過去バージョンは (1) $RESULT を Python コード文字列展開 → ' で SyntaxError、
# (2) `python3 - <<'PY'` + `echo $RESULT |` で Python が stdin をコードとして読んで $RESULT を捨てる、
# の2バグで silent fail していた (2026-04-24 根治)
# → $RESULT もファイル経由で渡し、Python heredoc と stdin を干渉させない
RESULT_FILE=$(mktemp)
printf '%s' "$RESULT" > "$RESULT_FILE"

export PA_AGENT="$AGENT_NAME"
export PA_COST="$COST"
export PA_INPUT_TOKENS="$INPUT_TOKENS"
export PA_OUTPUT_TOKENS="$OUTPUT_TOKENS"
export PA_CACHE_READ="$CACHE_READ"
export PA_CACHE_CREATE="$CACHE_CREATE"
export PA_DURATION="$DURATION"
export PA_NUM_TURNS="$NUM_TURNS"
export PA_STATUS="$STATUS"
export PA_RUN_ID="$RUN_ID"
export PA_RESULT_FILE="$RESULT_FILE"

python3 <<'PY' || echo "[run-agent] WARN: DB 更新に失敗 (Python エラー)" >&2
import os, sys, json, sqlite3, traceback

try:
    with open(os.environ["PA_RESULT_FILE"], "r", encoding="utf-8") as f:
        result = f.read()
    preview = result[:500]

    agent = os.environ["PA_AGENT"]
    cost = float(os.environ.get("PA_COST") or 0)
    input_tokens = int(os.environ.get("PA_INPUT_TOKENS") or 0)
    output_tokens = int(os.environ.get("PA_OUTPUT_TOKENS") or 0)
    cache_read = int(os.environ.get("PA_CACHE_READ") or 0)
    cache_create = int(os.environ.get("PA_CACHE_CREATE") or 0)
    duration = int(os.environ.get("PA_DURATION") or 0)
    num_turns = int(os.environ.get("PA_NUM_TURNS") or 0)
    status = os.environ.get("PA_STATUS") or "success"
    run_id = int(os.environ.get("PA_RUN_ID") or 0)

    conn = sqlite3.connect(".claude/db/agents.db")
    conn.execute(
        """INSERT INTO agent_costs (agent, cost_usd, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, duration_ms, num_turns)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (agent, cost, input_tokens, output_tokens, cache_read, cache_create, duration, num_turns),
    )

    metadata = json.dumps({
        "cost_usd": cost, "duration_ms": duration, "turns": num_turns,
        "result_preview": preview,
    })
    error_msg = preview if status == "error" else None

    if run_id > 0:
        # result_full は agent が既に書いてれば (reflection で Discord 本文を入れてる) 尊重する
        # 空/未設定の時だけ Claude の最終 response で埋める
        conn.execute(
            """UPDATE reflections SET
                 action = COALESCE(action, 'run'), status = ?,
                 items_processed = ?, items_succeeded = ?, items_failed = 0,
                 error_message = ?, tokens_in = ?, tokens_out = ?,
                 cost_usd = ?, duration_ms = ?,
                 ended_at = datetime('now','localtime'),
                 metadata = COALESCE(metadata, ?),
                 result_full = CASE
                   WHEN result_full IS NULL OR result_full = '' THEN ?
                   ELSE result_full
                 END,
                 updated_at = datetime('now','localtime')
               WHERE id = ?""",
            (status, num_turns, num_turns, error_msg,
             input_tokens + cache_read, output_tokens, cost, duration, metadata, result, run_id),
        )
    conn.commit()
    conn.close()
except Exception:
    traceback.print_exc()
    sys.exit(1)
PY

# tempfile を片付け
rm -f "$RESULT_FILE" 2>/dev/null

# ログ出力
echo "[$(date '+%Y-%m-%d %H:%M:%S')] $AGENT_NAME | $STATUS | cost: \$$COST | turns: $NUM_TURNS | ${DURATION}ms"
echo "$RESULT"

# Discord 通知: 完了時に reflections テーブルの reflection と併せて post
# (agent が UPDATE reflections SET what_done=..., quality_score=... を済ませた後の内容を読む)
if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
  python3 <<PYEOF 2>/dev/null || true
import os, json, sqlite3, urllib.request, urllib.error

conn = sqlite3.connect('.claude/db/agents.db')
row = conn.execute("""
  SELECT agent_slug, what_done, output_details, what_went_well, what_to_improve,
         lesson_learned, quality_score, cost_usd, duration_ms,
         items_processed, items_failed, status, error_message
  FROM reflections WHERE id = ?
""", ($RUN_ID,)).fetchone()
conn.close()
if not row:
    raise SystemExit
(agent, what_done, output_details, went_well, to_improve,
 lesson, qscore, cost, dur_ms, items_p, items_f, status, err) = row

err_rate = round((items_f / items_p) * 100) if items_p and items_p > 0 else None
dur_min = round(dur_ms / 60000, 1) if dur_ms else None

qscore_str = f"{qscore}/100" if qscore is not None else "—"
lines = [
    f"**🏁 {agent}** [{status}]",
]
if what_done:
    lines.append(f"📌 **{what_done[:200]}**")
if output_details:
    lines.append(f"📤 {output_details[:200]}")
metrics = [f"品質 {qscore_str}", f"コスト \${cost:.4f}" if cost else "コスト —",
           f"時間 {dur_min}分" if dur_min else "時間 —"]
if err_rate is not None:
    metrics.append(f"エラー率 {err_rate}%")
lines.append("• " + " · ".join(metrics))
if went_well:
    lines.append(f"👍 {went_well[:200]}")
if to_improve:
    lines.append(f"🔧 {to_improve[:200]}")
if lesson:
    lines.append(f"💡 {lesson[:200]}")
if status == 'error' and err:
    lines.append(f"⚠️ {err[:300]}")

content = "\n".join(lines)[:1900]
req = urllib.request.Request(
    os.environ['DISCORD_WEBHOOK_URL'],
    data=json.dumps({"content": content, "username": agent}).encode(),
    headers={"Content-Type": "application/json"},
)
try:
    urllib.request.urlopen(req, timeout=3)
except Exception:
    pass
PYEOF
fi

# Post-agent品質検証（ハッサム専用）
if [[ "$AGENT_FULL" == scizor* ]] && [ "$STATUS" = "success" ]; then
  echo "[post-check] ガイドページ品質検証を実行中..."
  if bash scripts/validate-guide.sh --notify; then
    echo "[post-check] ✅ 品質検証合格"
  else
    echo "[post-check] ❌ 品質検証で問題を検出（Discordに通知済み）"
  fi
fi
