# 全エージェント共通: Reflection Lifecycle

このプロトコルは **全エージェントが必須**。subagent (Task ツール経由) でも、launchd 経由でも、同じ reflection 行を作る。

## Step 0 — 起動直後 (必ず最初に実行)

```bash
# AGENT_RUN_ID が既にセットされてれば run-agent.sh 経由 (= top-level)
# されてなければ subagent 起動 → 自分で INSERT
if [ -z "${AGENT_RUN_ID:-}" ]; then
  # parent_run_id は呼び出し元の orchestrator が prompt で渡す。無ければ NULL
  PARENT_ARG=""
  [ -n "${PARENT_RUN_ID:-}" ] && PARENT_ARG="--parent $PARENT_RUN_ID"
  AGENT_RUN_ID=$(bash /Users/tom/dev/hojokin-db/scripts/start-reflection.sh \
    --slug {agent-slug} --trigger subagent $PARENT_ARG)
  export AGENT_RUN_ID
fi
echo "AGENT_RUN_ID=$AGENT_RUN_ID"
```

**注**: `{agent-slug}` を自分の slug に置き換える (例: `caterpie-subsidy-writer`)。

## Step Final — 作業完了直前 (必ず最後に実行)

```bash
sqlite3 /Users/tom/dev/hojokin-db/.claude/db/agents.db "
UPDATE reflections SET
  status = 'completed',
  ended_at = datetime('now','localtime'),
  duration_ms = (strftime('%s','now','localtime') - strftime('%s', started_at)) * 1000,
  what_done = '{箇条書き: 何をやったか}',
  quality_check = '{箇条書き: 品質確認結果 OK/NG}',
  quality_score = {0-100 の数値},
  result_full = '{詳細レポート全文}',
  self_improvement = '{自己改善案}',
  content_improvement = '{コンテンツ進化案}',
  updated_at = datetime('now','localtime')
WHERE id = $AGENT_RUN_ID;
"
```

## Orchestrator が subagent を呼ぶときの prompt 例

```
Task(
  subagent_type="caterpie-subsidy-writer",
  prompt="""
  PARENT_RUN_ID={your_AGENT_RUN_ID}  ← これを必ず先頭に書く

  補助金ID: 190
  タイトル: ...
  この補助金の記事を執筆してください。
  """
)
```

subagent は prompt 先頭の `PARENT_RUN_ID=N` を読んで `export PARENT_RUN_ID=N` してから Step 0 を実行する。

## なぜこれが必要か

旧設計: top-level エージェント (run-agent.sh 経由) のみが reflection を書く。subagent は INSERT されない → ダッシュボードに subagent の活動が見えない。

新設計: 全エージェントが reflection 行を持つ + parent_run_id でツリー構造に紐付ける。これで subagent (キャタピー / トランセル / コイル / レアコイル / ポッポ / ピジョン / ゴース / ゲンガー / ゴースト / ミューツー) の活動も完全可視化される。
