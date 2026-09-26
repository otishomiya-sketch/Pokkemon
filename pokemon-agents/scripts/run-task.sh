#!/bin/bash
# run-task.sh <task_id>
#
# Scheduler が task を enqueue した後、この script に task_id を渡して実行させる。
# 責務:
#   1. Atomic checkout (二重起動防止)
#   2. Budget hard stop check
#   3. Agent 情報解決 (agents テーブル + agent.md 読み込み)
#   4. claude -p 起動 (Claude Code CLI)
#   5. 終了時 task row UPDATE + budget 加算 + completion hook fire

set -uo pipefail

TASK_ID="${1:-}"
if [ -z "$TASK_ID" ]; then
  echo "usage: $0 <task_id>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="$REPO_ROOT/.claude/db/agents.db"
WORKER_ID="$$:$(hostname -s)"
NOW() { date '+%Y-%m-%d %H:%M:%S'; }

# SQLite は JSON/Boolean リテラル扱いが面倒なので関数化
sql() {
  sqlite3 -bail "$DB" "$@"
}
sql_escape() {
  # シングルクオート escape: 引数 or stdin から
  if [ $# -gt 0 ]; then
    printf "%s" "$1" | sed "s/'/''/g"
  else
    sed "s/'/''/g"
  fi
}

log() {
  echo "[$(NOW)] [task $TASK_ID] $*" >&2
}

# ------------------------------------------------------------------
# 1. Atomic checkout
# ------------------------------------------------------------------
log "attempting atomic checkout as $WORKER_ID"
CHECKED_OUT=$(sql "
  UPDATE reflections
  SET checked_out_by='$WORKER_ID',
      checked_out_at=datetime('now','localtime'),
      checkout_expires_at=datetime('now','+30 minutes','localtime'),
      status='running',
      started_at=datetime('now','localtime')
  WHERE id=$TASK_ID
    AND checked_out_by IS NULL
    AND status='queued'
  RETURNING id;
")
if [ -z "$CHECKED_OUT" ]; then
  log "already checked out, skipping"
  exit 0
fi

# ------------------------------------------------------------------
# 2. Agent 情報解決
# ------------------------------------------------------------------
AGENT_ROW=$(sql "
  SELECT a.id || '|' || a.slug || '|' || a.model || '|' || a.source_md_path
  FROM agents a
  JOIN reflections t ON t.agent_id = a.id
  WHERE t.id = $TASK_ID;
")
IFS='|' read -r AGENT_ID AGENT_SLUG AGENT_MODEL AGENT_MD_PATH <<< "$AGENT_ROW"

if [ -z "$AGENT_ID" ]; then
  log "ERROR: agent not found for task"
  sql "UPDATE reflections SET status='failed', error_message='agent_not_found', ended_at=datetime('now','localtime') WHERE id=$TASK_ID;"
  exit 1
fi

FULL_MD_PATH="$REPO_ROOT/$AGENT_MD_PATH"
if [ ! -f "$FULL_MD_PATH" ]; then
  log "ERROR: agent.md not found: $FULL_MD_PATH"
  sql "UPDATE reflections SET status='failed', error_message='agent_md_missing', ended_at=datetime('now','localtime') WHERE id=$TASK_ID;"
  exit 1
fi

log "resolved agent: $AGENT_SLUG (id=$AGENT_ID, model=$AGENT_MODEL)"

# ------------------------------------------------------------------
# 3. Budget hard stop check
# ------------------------------------------------------------------
PERIOD=$(date '+%Y-%m')
BUDGET_STATUS=$(sql "
  SELECT status FROM agent_budgets
  WHERE agent_id=$AGENT_ID AND period='$PERIOD'
  LIMIT 1;
")
if [ "$BUDGET_STATUS" = "halted" ]; then
  log "budget halted for period $PERIOD, exit without running"
  sql "
    UPDATE reflections
    SET status='budget_halted',
        error_message='budget_halted_$PERIOD',
        ended_at=datetime('now','localtime')
    WHERE id=$TASK_ID;
  "
  exit 0
fi

# ------------------------------------------------------------------
# 4. claude -p 起動 (v1 run-agent.sh パターン継承)
# ------------------------------------------------------------------
WORK_DIR=$(mktemp -d "/tmp/pokemon-agents-task-${TASK_ID}-XXXXXX")
OUTPUT_LOG="$WORK_DIR/output.json"
log "work_dir=$WORK_DIR"

sql "UPDATE reflections SET work_dir='$WORK_DIR' WHERE id=$TASK_ID;"

# timeout は agent.config.timeout_sec から取得 (default 1800s = 30min)
TIMEOUT_SEC=$(sql "SELECT COALESCE(json_extract(config,'\$.timeout_sec'), 1800) FROM agents WHERE id=$AGENT_ID;")
log "timeout_sec=$TIMEOUT_SEC"

START_MS=$(( $(date +%s%N) / 1000000 ))

# Claude Code CLI 設定:
# - -p "<md>を読み、ルールに従って実行せよ" : v1 と同じパターン (md は Read tool で取得)
# - --dangerously-skip-permissions : sqlite3 / bash tool 実行を許可 (single-host 自律運用前提)
# - --output-format json : cost/tokens を capture
# - 環境変数 PLATFORM_* : agent.md 内から task ID 等を参照
PROMPT="${FULL_MD_PATH} を Read してから、そのルールに従って実行してください。Platform v2 のタスクです (task_id=${TASK_ID})。環境変数 PLATFORM_TASK_ID / PLATFORM_AGENT_ID / PLATFORM_AGENT_SLUG が定義されています。"

if [ "${PLATFORM_DRY_RUN:-0}" = "1" ]; then
  echo '{"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"duration_ms":4,"num_turns":0,"result":"DRY_RUN ok","stop_reason":"end_turn","is_error":false}' > "$OUTPUT_LOG"
  EXIT_CODE=0
else
  # 本番呼び出し (background + watchdog timeout)
  set +e
  (
    export PLATFORM_TASK_ID="$TASK_ID"
    export PLATFORM_AGENT_ID="$AGENT_ID"
    export PLATFORM_AGENT_SLUG="$AGENT_SLUG"
    cd "$REPO_ROOT"
    claude --model "$AGENT_MODEL" -p "$PROMPT" \
      --dangerously-skip-permissions --output-format json \
      > "$OUTPUT_LOG" 2>&1 &
    CLAUDE_PID=$!
    ( sleep "$TIMEOUT_SEC" && kill -TERM $CLAUDE_PID 2>/dev/null && sleep 5 && kill -KILL $CLAUDE_PID 2>/dev/null ) &
    WATCHDOG_PID=$!
    wait $CLAUDE_PID 2>/dev/null
    INNER_EXIT=$?
    kill $WATCHDOG_PID 2>/dev/null; wait $WATCHDOG_PID 2>/dev/null
    exit $INNER_EXIT
  )
  EXIT_CODE=$?
  set -e
fi

END_MS=$(( $(date +%s%N) / 1000000 ))
DURATION_MS=$((END_MS - START_MS))

log "claude exited code=$EXIT_CODE duration_ms=$DURATION_MS"

# ------------------------------------------------------------------
# 5. Result 集計 (JSON parse) + tasks UPDATE + budget 加算
# ------------------------------------------------------------------
PARSED=$(python3 -c "
import sys, json
try:
    d = json.load(open('$OUTPUT_LOG'))
except Exception as e:
    print(json.dumps({'error': str(e), 'cost': 0, 'tokens_in': 0, 'tokens_out': 0, 'result': '', 'is_error': True}))
    sys.exit(0)
u = d.get('usage', {}) or {}
print(json.dumps({
    'cost': d.get('total_cost_usd', 0) or 0,
    'tokens_in': (u.get('input_tokens', 0) or 0) + (u.get('cache_read_input_tokens', 0) or 0),
    'tokens_out': u.get('output_tokens', 0) or 0,
    'result': (d.get('result', '') or '')[:500],
    'stop_reason': d.get('stop_reason', 'unknown'),
    'is_error': bool(d.get('is_error', False)),
}))
" 2>/dev/null)

COST=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cost',0))" 2>/dev/null || echo 0)
TOKENS_IN=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tokens_in',0))" 2>/dev/null || echo 0)
TOKENS_OUT=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tokens_out',0))" 2>/dev/null || echo 0)
RESULT_SUMMARY=$(echo "$PARSED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','')[:400])" 2>/dev/null | sql_escape)
IS_ERROR=$(echo "$PARSED" | python3 -c "import sys,json; print('1' if json.load(sys.stdin).get('is_error',False) else '0')" 2>/dev/null || echo 0)

# シグナル kill (timeout) 判定
if [ "$EXIT_CODE" = "143" ] || [ "$EXIT_CODE" = "137" ]; then
  FINAL_STATUS="timeout"
  ERROR_MSG="'timeout_after_${TIMEOUT_SEC}s'"
elif [ "$EXIT_CODE" -eq 0 ] && [ "$IS_ERROR" = "0" ]; then
  FINAL_STATUS="completed"
  ERROR_MSG="NULL"
else
  FINAL_STATUS="failed"
  ERR_SHORT=$(tail -c 300 "$OUTPUT_LOG" | sql_escape)
  ERROR_MSG="'exit=${EXIT_CODE} is_error=${IS_ERROR}: ${ERR_SHORT}'"
fi

sql "
  UPDATE reflections
  SET status='$FINAL_STATUS',
      ended_at=datetime('now','localtime'),
      duration_ms=$DURATION_MS,
      tokens_in=$TOKENS_IN,
      tokens_out=$TOKENS_OUT,
      cost_usd=$COST,
      result_summary='$RESULT_SUMMARY',
      error_message=$ERROR_MSG
  WHERE id=$TASK_ID;
"

# Budget 加算
COST_CENTS=$(python3 -c "print(int(round(float('$COST') * 100)))")
PERIOD=$(date '+%Y-%m')
sql "
  UPDATE agent_budgets
  SET used_cents = used_cents + $COST_CENTS,
      updated_at = datetime('now','localtime')
  WHERE (agent_id=$AGENT_ID OR agent_id IS NULL) AND period='$PERIOD';
  -- 80% 超過で警告 status へ
  UPDATE agent_budgets
  SET status='warning'
  WHERE (agent_id=$AGENT_ID OR agent_id IS NULL) AND period='$PERIOD'
    AND status='active'
    AND used_cents * 100 >= budget_cents * COALESCE(warning_threshold_pct, 80);
  -- 100% 超過で halt
  UPDATE agent_budgets
  SET status='halted', halted_at=datetime('now','localtime')
  WHERE (agent_id=$AGENT_ID OR agent_id IS NULL) AND period='$PERIOD'
    AND status IN ('active','warning')
    AND used_cents >= budget_cents;
"
log "cost=\$$COST tokens_in=$TOKENS_IN tokens_out=$TOKENS_OUT"

# ------------------------------------------------------------------
# 6. Completion hooks fire (automation chain)
# ------------------------------------------------------------------
if [ $EXIT_CODE -eq 0 ]; then
  # このエージェントから triggered される schedule を取得
  HOOKS=$(sql "
    SELECT target_schedule_id FROM task_completion_hooks
    WHERE source_agent_id=$AGENT_ID AND enabled=1;
  ")
  for HOOK_SCHED_ID in $HOOKS; do
    # target schedule を fire: next_run_at=now にして scheduler が次 tick で拾う
    sql "
      UPDATE agent_schedules
      SET next_run_at=datetime('now','localtime')
      WHERE id=$HOOK_SCHED_ID AND enabled=1;
    "
    log "automation chain: triggered schedule id=$HOOK_SCHED_ID"
  done
fi

log "done (status=$FINAL_STATUS)"
exit 0
