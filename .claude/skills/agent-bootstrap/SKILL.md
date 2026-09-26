---
name: agent-bootstrap
description: hojokin-agent エージェント全員が起動直後に踏む共通プロトコル — reflection 行作成 (Step 0)、ドメイン知識読み込み (Phase 0)、当日 guidance 取得、reflection 完了 (Step Final) の 4 つを 1 セットで提供する。Task ツール経由 (subagent) でも launchd 経由 (top-level) でも同じ手順で動く。各 agent.md の `skills:` frontmatter に追加して使う。
user-invocable: false
---

# Agent Bootstrap (全エージェント共通起動プロトコル)

このスキルは hojokin-agent の全 26 体のサブエージェントに注入される共通起動 boilerplate。Phase 0 知識読込、Step 0 reflection 作成、guidance 取得、Step Final reflection 完了書き込みを集約する。

## 用語

- **Top-level 起動**: `scripts/run-agent.sh` (launchd 経由) で起動された場合。`AGENT_RUN_ID` が既に export 済み。
- **Subagent 起動**: 親エージェントが `Task()` ツールで spawn した場合。prompt 先頭で `PARENT_RUN_ID=N` が渡される。

## Step 0 — 起動直後 (必ず最初に実行)

`{AGENT_SLUG}` は自分のエージェント名 (例: `caterpie-subsidy-writer`) に置換する。

```bash
if [ -z "${AGENT_RUN_ID:-}" ]; then
  PARENT_ARG=""
  [ -n "${PARENT_RUN_ID:-}" ] && PARENT_ARG="--parent $PARENT_RUN_ID"
  AGENT_RUN_ID=$(bash /Users/tom/dev/hojokin-db/scripts/start-reflection.sh \
    --slug {AGENT_SLUG} --trigger subagent $PARENT_ARG)
  export AGENT_RUN_ID
fi
echo "AGENT_RUN_ID=$AGENT_RUN_ID"
```

**親 (orchestrator) が subagent を呼ぶときの prompt 規約**:

```
Task(
  subagent_type="caterpie-subsidy-writer",
  prompt="""
  PARENT_RUN_ID={your_AGENT_RUN_ID}  ← prompt 先頭で必ず渡す

  補助金ID: 190
  この補助金の記事を執筆してください。
  """
)
```

これがないと subagent の reflection が親に紐付かず、ダッシュボードで実行ツリーが切れる。

## Phase 0 — 必読ドメイン知識の読み込み

```bash
bash scripts/get-agent-knowledge.sh {AGENT_SLUG} required
```

取得した内容は **絶対のルール** として扱う:
- URL 構造ルール違反 → 404 を生む
- タイトル最適化 NG パターン違反 → 無駄な施策
- 評価タイミング違反 → 誤判定で勝ち施策を棄却

タスク中に詳細が必要なら on-demand で:

```bash
bash scripts/get-agent-knowledge.sh {AGENT_SLUG} reference
```

全体マップ: [docs/knowledge/_index.md](../../../docs/knowledge/_index.md)

## Guidance 取得 (今日の戦略ブリーフ)

毎日 2:00 にメガゲンガー → ゲンガー (gengar-selector) が `kind='guidance'` を発行する。起動時に 1 クエリ取得し、自分宛てのものがあれば優先する:

```bash
sqlite3 /Users/tom/dev/hojokin-db/.claude/db/agents.db "
  SELECT id, title, body, affected_resources, tags, metadata, derived_from
  FROM knowledge
  WHERE kind = 'guidance'
    AND status = 'active'
    AND (
      metadata IS NULL
      OR json_extract(metadata, '\$.target_agents') IS NULL
      OR EXISTS (
        SELECT 1 FROM json_each(json_extract(metadata, '\$.target_agents'))
        WHERE json_each.value = '{AGENT_SLUG}'
      )
    )
    AND (
      metadata IS NULL
      OR json_extract(metadata, '\$.active_until') IS NULL
      OR datetime(json_extract(metadata, '\$.active_until')) > datetime('now','localtime')
    )
  ORDER BY created_at DESC
  LIMIT 5;
"
```

| ケース | アクション |
|---|---|
| 該当 guidance あり | body の指示に従って優先的に作業し、対応 `experiment_id` を reflections の metadata に記録 |
| 該当 guidance なし | 従来通り自己判断で作業（止まらない） |

### 仮説書込禁止

- `kind='hypothesis'` の直接 INSERT は DB トリガーで **ブロック** される (`haunter-hypothesizer` 専権)
- 試したい施策がある場合は:
  - `kind='decision'`: 「今回この案件を選んだ」という運用判断の記録 (低ノイズ、仮説ではない)
  - Discord に報告 → ゴーストに取り込んでもらう (次回 2:00 のパイプラインで仮説化)

### Guidance 絶対ルール

- **起動時に 1 回読むだけ** (GA/GSC API を叩かない、それはゴース/ゴーストの仕事)
- **guidance は 24 時間で失効** (`active_until` を尊重)
- 従ったら **reflections の metadata に `guidance_id: {id}` を残す**
- 自分と関係ない場合はスキップ (無理に従わない)

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

### 4 層 reflection の役割分担

| カラム | 中身 | 読む相手 |
|---|---|---|
| `result_full` | Discord 通知本文 + 成果物 URL + メトリクス (SSOT) | 人間 |
| `what_done` | やったこと (箇条書き) | 人間 + メタ |
| `quality_check` | agent.md ルール準拠の自己診断 ✅/❌ | 人間 + メタ |
| `self_improvement` | agent.md / コード / ルールの修正候補 | ミューツー (git branch で自動適用) |
| `content_improvement` | アウトプット構造の進化案 | ミュウ (横断観測・パターン化) |

`hypotheses` テーブルへの INSERT は禁止 (ゲンガー集団用)。

### 前回の実行を読む (自己学習)

```bash
sqlite3 /Users/tom/dev/hojokin-db/.claude/db/agents.db "
  SELECT quality_score, what_done, quality_check, self_improvement, content_improvement
  FROM reflections
  WHERE agent_slug='{AGENT_SLUG}' AND quality_score IS NOT NULL
  ORDER BY created_at DESC LIMIT 3
"
```

## なぜ 4 層 reflection が必要か

旧設計: top-level エージェント (run-agent.sh 経由) のみが reflection を書く。subagent は INSERT されない → ダッシュボードに subagent の活動が見えない。

新設計: 全エージェントが reflection 行を持つ + parent_run_id でツリー構造に紐付ける。これで subagent (キャタピー / トランセル / コイル / レアコイル / ポッポ / ピジョン / ゴース / ゲンガー / ゴースト / ミューツー) の活動も完全可視化される。
