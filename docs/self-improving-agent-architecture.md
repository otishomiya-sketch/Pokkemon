# 自己改善するエージェント基盤 — アーキテクチャ詳説

> 記事を「書く」エージェントの上に乗り、**記事と自分自身を継続的に改善していくメタ基盤**の解説。
> このリポジトリ (hojokin-agent.jp) の実装をリファレンスに、誰でも自分のドメインに移植できるよう
> ポケモンのコードネームを一般名に対応づけながら説明する。
>
> 対象読者: エージェント運用基盤を自分で組みたい人 / このリポジトリを fork して使いたい人。
> 前提知識: Claude Code の subagent (Task tool)、SQLite、cron/launchd、git。

---

## 0. TL;DR — これは何か

複数の AI エージェントが毎日自動で走る環境で、次の 2 つを**人手を介さず回し続ける**ための OS。

1. **事業 KPI を上げるループ** — 仮説を立て、施策を打ち、実測し、勝ちパターンを蓄える
2. **エージェント自身を直すループ** — 運用ログを観測し、設定やプロンプトの不具合を見つけ、安全に自己修正する

この 2 つのループと、それを支える 3 つの土台（振り返り・可観測性・知識昇華）の **計 5 部品**でできている。
すべての部品は **1 枚の SQLite テーブル `knowledge`** を真実の源（SSOT）として読み書きすることで疎結合に協調する。

| # | 一般名 | コードネーム | 一言で |
|---|---|---|---|
| ① | Structured Reflection | (全エージェント共通) | 実行後に「読み手別」4 層で振り返りを書く。全改善の燃料 |
| ② | DB-native Observability | ダッシュボード (port 5733) | hooks と実行ログを 1 DB に集約しリアルタイム可視化 |
| ③ | Axis A: KPI 改善ループ | ゲンガー集団 | 仮説生成 → 3LLM 選抜 → 実測検証 → playbook 化 |
| ④ | Axis B: 自己改変ループ | ミュウ / ミューツー | 観測 → 改善案 → 安全ゲート → git 適用 → 効果測定 → 自動 revert |
| ⑤ | Knowledge Sublimation | アルセウス | 3 件以上検証された学びを Wiki 化し全員に再配布 |

---

## 1. 設計思想 — なぜこの形なのか

実装の細部より先に、効いている設計判断を 6 つ挙げる。移植する人はここだけ守れば形は変えてよい。

### 1-1. 単一の append-only 知識テーブル (SSOT)
仮説・実験・成功パターン・失敗パターン・指示・運用観測――すべてを `kind` カラムで区別して**1 テーブル**に入れる。
- **状態は遷移するだけで行は消さない** (append-only)。`proposed → executing → validated/falsified` のように `status` が一方向に進む。「なぜ今これをやらないか」の歴史が残る。
- テーブルを分けないので、どのエージェントも「他のループが何を学んだか」を 1 クエリで読める。疎結合の要。

### 1-2. 振り返りは「読み手」で分割する
「うまくいったこと/改善点」のような曖昧な 1 カラムにしない。**誰がそれを読んで何に使うか**で 4〜5 カラムに分ける（§3）。
人間が読む欄、メタ観測が読む欄、自己修正エンジンが読む欄、長期改善が読む欄を**混ぜない**のが品質の肝。

### 1-3. 「事業を直す」と「自分を直す」を別ループにする
KPI 改善 (Axis A) と運用品質改善 (Axis B) は別の周期・別の責任者・別の `kind` 接頭辞で動く。
同じ DB を共有するが、互いの状態機械を踏まない。これで片方が壊れてももう片方は回る。

### 1-4. 「考える人」と「実ファイルを触る人」を分離する
自己改変ループでは、観測・起草する `mew` と、実際に `git apply` する `mewtwo` を**別セッション**にする。
実行体だけに強い権限境界（許可パス allowlist / FORBIDDEN）を課せば、安全壁が 1 か所に集約される。

### 1-5. すべての施策に「検証計画」を強制する
仮説は `+15%` のような願望では受理されない。DB トリガーが以下を必須にする:
`predicted_outcome`（before/after/方向/計測元）と `follow_up_schedule`（T+1d / T+7d で何をどこで測るか）。
**検証不能な施策は最初から作れない**。これが「やりっぱなし」を構造的に防ぐ。

### 1-6. 学びは 3 件たまるまで一般化しない
個別の検証結果（playbook / anti_pattern）が**同パターン 3 件以上**たまって初めて、ドメイン知識 Wiki に昇華する。
単発を一般化すると全エージェントをミスリードするため、昇華担当（アルセウス）が意図的に保守的に振る舞う。

---

## 2. 全体アーキテクチャ

```
                      ┌─────────────────────────────────────────────┐
                      │          SQLite: .claude/db/agents.db        │
                      │                                              │
   ┌──────────────────┤  knowledge  (SSOT, append-only)             │
   │                  │   ├ kind=hypothesis/experiment               │ ← Axis A
   │                  │   ├ kind=playbook/anti_pattern/guidance/fact │
   │   読み書き        │   ├ kind=control_observation/control_*      │ ← Axis B
   │                  │  reflections (4層 振り返り, 1実行=1行)        │ ← ①
   │                  │  logs        (hooks/ツール呼び出しイベント)   │ ← ②
   │                  └──────────────────────────────────────────────┘
   │                          ▲           ▲              ▲
   │                          │ write     │ write        │ read
   │                          │           │              │
   ▼                          │           │              │
┌─────────────────┐  ┌────────┴──────┐  ┌─┴───────────┐ ┌┴──────────────┐
│ ① Reflection    │  │ ③ Axis A      │  │ ④ Axis B    │ │ ⑤ Sublimation │
│ 全エージェントが │  │ ゲンガー集団   │  │ ミュウ       │ │ アルセウス     │
│ 起動時に行作成   │  │ 毎日 2:00     │  │ ミューツー   │ │ 毎週月 3:00   │
│ 完了時に4層記入  │  │ 仮説PDCA      │  │ 毎日 5:00    │ │ 3件→Wiki化   │
└─────────────────┘  └───────────────┘  └─────────────┘ └───────────────┘
        │                                                        │
        │                                              docs/knowledge/**/*.md
        │                                                        │
        ▼                                                        ▼
┌──────────────────────────┐                   ┌────────────────────────────────┐
│ ② Observability (5733)   │                   │ 全エージェントが起動時に          │
│ hooks → logs, 実行ツリー  │                   │ get-agent-knowledge.sh で必読     │
│ ブラウザでリアルタイム表示 │                   │ → 既知パターンを前提に動く        │
└──────────────────────────┘                   └────────────────────────────────┘
```

ポイント: **各部品は互いを直接呼ばない**。`knowledge` テーブルへの読み書きと、起動時の知識ロードだけで連携する。

---

## 3. 部品① Structured Reflection（構造化された振り返り）

全エージェントに共通する「実行を記録する作法」。`reflections` テーブルの 1 行 = 1 実行。

### 3-1. 4 層（+1）のカラム

| カラム | 中身 | **読む相手** | 反映タイミング |
|---|---|---|---|
| `result_full` | 外部アウトプット本文（Discord 通知 / 記事 URL / 投稿先 URL）。Single Source of Truth | 人間（ダッシュボード） | 即時 |
| `what_done` | やったこと（箇条書き） | 人間 + メタ観測 | 即時 |
| `quality_check` | agent.md ルール準拠の自己診断 ✅/❌ | 人間 + メタ観測 | 即時 |
| `self_improvement` | **自分の** agent.md / コード / ルールをどう直すか | **Axis B 実行体（ミューツー）** が git で自動適用 | 次回実行で即 |
| `content_improvement` | **アウトプットの構造**の進化案（項目追加・レポート形式） | **Axis B 観測者（ミュウ）** が長期パターン化 | 数週間〜月 |

`self_improvement` と `content_improvement` の違いが最重要:

| | self_improvement（自律改善） | content_improvement（事業改善） |
|---|---|---|
| 観点 | エージェント自身のコード・ルール | アウトプットの構造・項目 |
| 例 | 「agent.md 冒頭に pre-flight check 追加」「リトライ上限をルール化」 | 「レポートに WoW 比較セクション追加」「比較グラフを通知に含める」 |
| 時間軸 | 次回実行で即反映 | 中長期 |

**禁止事項**: 「engagement が崩壊した GA バグ調査」のような*事業の発見*を `self_improvement`（=コード修正欄）に書かない。層が混ざると自己修正エンジンが誤作動する。

### 3-2. 全エージェント共通の起動プロトコル（agent-bootstrap）

各エージェント定義ファイル（`.claude/agents/<name>.md` または `.claude/agents/<name>/agent.md`）は冒頭で必ずこの 4 ステップを踏む（`.claude/skills/agent-bootstrap/`）。これにより**振り返り・知識ロード・系譜記録**が漏れなく走る。

```
Step 0   : reflections に行を INSERT (status=running)
           Task 経由の subagent は親から PARENT_RUN_ID を受け取り parent_run_id に記録
           → ダッシュボードで「どの親がどの子を呼んだか」が実行ツリーになる
Phase 0  : get-agent-knowledge.sh {slug} required で必読ドメイン知識をロード
           (URL 構造ルール / NG パターン等を "絶対ルール" として読む)
Guidance : kind='guidance' を起動時に1回だけ読む (24h で失効する当日の戦略指示)
Step Final: UPDATE reflections SET status='completed', 4層カラム, quality_score WHERE id=$AGENT_RUN_ID
           → これを忘れると永遠に「running」表示になる
```

実装:
```bash
# Step 0 (subagent の場合)
AGENT_RUN_ID=$(bash scripts/start-reflection.sh --slug <agent> --trigger subagent --parent $PARENT_RUN_ID)
export AGENT_RUN_ID
```

---

## 4. 部品② DB-native Observability（ダッシュボード）

エージェントが今何をしているかを**リアルタイムに見る**ための層。原則は **DB-native = データベースが唯一の真実、UI はそこから動的生成（ハードコード辞書禁止）**。

### 4-1. 構成
- **Bun HTTP サーバ** `pokemon-agents/web/server.ts`（**port 5733**）
- データ源は `.claude/db/agents.db` の 2 テーブル:
  - `logs` … Claude Code の **hooks** が POST してくるツール呼び出しイベント（PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / Stop）
  - `reflections` … §3 の 4 層振り返り
- エージェント一覧は `agents` テーブルから `SELECT`（コードネーム・アイコン・部署をハードコードしない）

### 4-2. hooks による無侵襲な計測
`.claude/settings.json` の hooks が各ツール呼び出しを 5733 に curl POST する:
```jsonc
"PostToolUse": [{ "hooks": [{ "type": "command",
  "command": "curl -s -m 1 -X POST http://localhost:5733/event/PostToolUse --data-binary @- > /dev/null 2>&1 || true" }]}]
```
`|| true` と `-m 1`（1 秒タイムアウト）で、**サーバが落ちていてもエージェント実行は絶対に止まらない**。可観測性は本業に影響しない、が鉄則。

### 4-3. 主要ビュー
- `/` 概要 / `/agents?view=list|org` 一覧・組織図 / `/schedules` / `/costs`
- `/logs?view=events` 行動ログ / `/logs?view=reflections`（= `/reflections`）振り返りの 4 層モーダル
- `/api/events`・`/api/reflections-since` SSE 相当のインクリメンタル取得

---

## 5. 部品③ Axis A — KPI 改善ループ（ゲンガー集団）

**毎日 2:00**、4 体が「検証 → 仮説 → 選抜」を 1 回転させ、SEO KPI を回す PDCA。

### 5-1. 役割と実行順

| 一般名 | コードネーム | model | 役割 |
|---|---|---|---|
| Orchestrator | メガゲンガー | opus | 司令塔。自分は実測も仮説も選抜もしない。順に Task 起動するだけ |
| Validator (Stage 1) | ゴース | sonnet | 前日までの実験を実測し validated/falsified 判定、playbook/anti_pattern に昇華 |
| Hypothesizer (Stage 2) | ゴースト | opus | playbook を踏まえ 3 LLM で仮説を量産 |
| Selector (Stage 3) | ゲンガー | sonnet | 3 LLM Elo トーナメントで選抜、experiment 化、当日 guidance を発行 |

```
[Orchestrator] 2:00 起動
   ├─Task→ [Validator]   前日 experiment を実測 → validated→playbook / falsified→anti_pattern
   │                     (前段失敗なら後段スキップ・各段で Discord 通知)
   ├─Task→ [Hypothesizer] playbook/anti_pattern/昨日の結果 + GSC/GA → kind=hypothesis を最大9件
   └─Task→ [Selector]     SERP 確認 → 3LLM Elo → 上位を kind=experiment(executing) + kind=guidance
                          ↓
              [実行部隊] 各自の cron で起動時に guidance を読んで作業
                          ↓
              翌日また [Validator] が実測 → ループが閉じる
```

### 5-2. 検証可能性を強制する DB トリガー（最重要）
Hypothesizer が `kind='hypothesis'` を INSERT する際、以下が欠けると **SQLite が ABORT** する:
- `affected_resources`（対象 URL/scope、非空）
- `follow_up_schedule`（最低 2 点: T+1d 早期 + T+7d 最終判定）
- `predicted_outcome.{metric, baseline, target|delta_pct, direction, measurement_source}`

例:
```json
{ "metric":"ctr", "baseline":0.0117, "target":0.0135, "delta_pct":15.4,
  "direction":"increase", "measurement_source":"gsc", "category":"title_improvement" }
```
これで「CTR 1.17% → 1.35% を T+7d に GSC で再測する」という*検証契約*が必ず付く。

### 5-3. 3 LLM による多様性と選抜
- **生成**: Opus（戦略）/ Gemini（検索意図）/ Grok（攻め）で観点を散らし最大 9 仮説
- **選抜**: 同 3 LLM が独立に Elo（初期 1000）を計算 → 平均 Elo でソート。意見が割れた仮説は `metadata.tournament_notes` に記録
- **同時実行制約**: 同一 URL への同時実験禁止 / executing は最大 10 枠
- **学習ループ**: Hypothesizer は生成前に必ず `playbook(confidence≥0.7)` と `anti_pattern` を読み、勝ち筋を踏襲し負け筋を避ける

### 5-4. guidance = 実行部隊への当日指示
Selector は選んだ experiment を「実行部隊が読める当日ブリーフ」に要約し `kind='guidance'`（`active_until` 24h）で発行。実行部隊（記事 Writer 等）は起動時にこれを読むだけで戦略に追従する。

---

## 6. 部品④ Axis B — 自己改変ループ（ミュウ / ミューツー）

**毎日 5:00**、エージェント運用そのものの不具合を見つけ、**安全に自己修正**する。Axis A が「事業」を直すのに対し、これは「エージェント」を直す。

### 6-1. 役割分離 = 安全壁

| 一般名 | コードネーム | model | 役割 |
|---|---|---|---|
| Supervisor / Observer | ミュウ | opus | 観測 + 改善案起草 + ゲート分類。**実ファイルは絶対に触らない** |
| Executor | ミューツー | sonnet | auto_apply 分だけを git branch で適用・効果測定・自動 revert |

```
[ミュウ] 5:00 起動
  ├ Phase1 観測   : 過去7日の実行ログをクラスタリングし異常検知 → kind=control_observation
  ├ Phase2 起草   : 対象ファイルを Read → diff 生成 → gate_classification 分類 → kind=control_hypothesis
  ├ Phase3a       : auto_apply 分 (status=proposed) → Task で [ミューツー] 起動
  └ Phase3b       : human_gate 分 (status=awaiting_approval) → Discord 通知して放置（人間の承認待ち）

[ミューツー] Task 起動
  ├ 境界二重チェック → git checkout -b auto/control-YYYY-MM-DD-NNN → git apply → merge
  ├ kind=control_experiment(executing) に遷移、follow_up_schedule (例 +6h で error_rate 再測)
  └ 次回起動時に効果測定: 改善→control_playbook昇華 / 悪化→git revert + control_anti_pattern
```

### 6-2. 検知ルール（Phase1）

| ルール | severity |
|---|---|
| エラー率 > 50%（過去7日・実行5以上） | critical |
| timeout 3 件以上 | high |
| 差し戻し率 (rejected+sendback) > 30% | medium |
| self_score 平均 < 3.0 | low |
| schedule 有なのに 24h 連続 0 実行 | high |

同じ `metric + target_agent` の observation が 24h 以内にあれば重複スキップ。

### 6-3. 3 段階のゲート分類（Axis B の核）
ミュウは改善案を `gate_classification` で 3 つに振り分ける（境界定義は `control-boundary.md`）:

| 分類 | 対象例 | 扱い |
|---|---|---|
| `auto_apply` | run-agent.sh の timeout 数値 / typo / 通知文言 / ダッシュボード UI | ミューツーが即適用 |
| `human_gate` | agent.md のロジック変更 / 新スケジュール / DB schema | Discord 通知のみ、人間承認待ち |
| `forbidden` | `src/` `supabase/` `next.config.ts` 等 | 即中止 + anti_pattern 化 |

### 6-4. 実行体（ミューツー）の権限境界
**許可された書込パスのみ** git apply 可（`.claude/agents/**`（自分自身除く）/ `.claude/scripts/*.sh` / `scripts/run-agent.sh` の数値調整 等）。
**絶対禁止**: FORBIDDEN パス / `git push --force` / `rm -rf` / `DROP TABLE` / 本番デプロイ / 自分自身の agent.md 改変 / 同一 hypothesis を 3 回以上適用（無限ループ防止）。
すべて新規 branch で行い、効果が出なければ `git revert` で自動巻き戻す → **悪化しても自律で復元する**。

---

## 7. 部品⑤ Knowledge Sublimation（アルセウス）

**毎週月曜 3:00**。個別の検証結果を、全エージェントが参照する**ドメイン知識 Wiki**（`docs/knowledge/**/*.md`）に昇華する編集長。

### 7-1. なぜ専任 1 体か
文体統一・横断知見（Axis A も B も読む）・品質責任の一元化・各ループを本業に集中させるため。各集団に書かせると矛盾と重複が起きる。

### 7-2. 昇華ルール（保守的に）

| パターン | 昇華先 |
|---|---|
| 同カテゴリの validated 3 件以上 | 新規 `docs/knowledge/seo/*.md` |
| 同カテゴリの falsified 2 件以上 | `docs/knowledge/**/ANTI-pattern.md` |
| 複数 agent の self_improvement に共通 | `docs/knowledge/operations/*.md` |

- **3 件未満は昇華しない**（誤った一般化の防止）
- **反証されても削除せず** `status: deprecated`（歴史として残す）
- frontmatter に `evidence_hypothesis_ids` / `confidence` / `last_validated_at` を必ず記録
- git commit して人間レビュー可能に

### 7-3. ループが閉じる場所
昇華された Wiki は、§3-2 の起動プロトコル `get-agent-knowledge.sh {slug} required` で**全エージェントが起動時に読む**。
こうして「検証で得た学び」が「次回以降の全エージェントの前提」になり、組織全体の学習ループが閉じる。

---

## 8. 中核データモデル — `knowledge` テーブル

全部品が共有する SSOT。主要カラム:

```sql
kind TEXT NOT NULL          -- hypothesis/experiment/playbook/anti_pattern/guidance/fact
                            -- control_observation/control_hypothesis/control_experiment/
                            -- control_playbook/control_anti_pattern
layer TEXT                  -- business (Axis A) | operations (Axis B)
status TEXT                 -- proposed→executing→validated/falsified/retired (一方向)
confidence REAL             -- 0.0-1.0 (複数 validated で段階的に上昇)
predicted_outcome TEXT      -- JSON: metric/baseline/target/delta_pct/direction/measurement_source
affected_resources TEXT     -- JSON array: 対象 URL / scope
follow_up_schedule TEXT     -- JSON array: [{at:"T+1d", metric:"ctr", source:"gsc"}, ...]
follow_up_results TEXT      -- JSON array: 実測の追記
outcome TEXT                -- validated/falsified/inconclusive
derived_from / supersedes   -- 知識の系譜 (どの playbook から派生したか)
metadata TEXT               -- JSON: story{hypothesis,evidence,action} 等。Dashboard はこれを直読み
```

**状態機械**:
```
Axis A:  hypothesis(proposed) ──Elo選抜──▶ experiment(executing) ──実測──▶ validated → playbook
                                                                  └──────▶ falsified  → anti_pattern
Axis B:  control_observation ─▶ control_hypothesis(proposed|awaiting_approval) ─▶ control_experiment(executing)
                                                                  ├ validated → control_playbook
                                                                  └ falsified → control_anti_pattern (+ git revert)
```

**書き込み権限はトリガーで強制**: 例えば `kind='hypothesis'` の直接 INSERT は Hypothesizer 系のみ許可（他は ABORT）。検証契約フィールド欠落も ABORT。

---

## 9. 汎用骨格 vs ドメイン固有 — 移植の境界線

fork して別ドメインで使う場合、**置き換えるのはこれだけ**:

| 層 | 汎用骨格（そのまま使える） | ドメイン固有（差し替える） |
|---|---|---|
| Reflection | `reflections` の 4 層スキーマ・bootstrap 4 ステップ | （なし） |
| Observability | hooks → logs ingestion・5733 サーバ・DB-native UI | 部署ラベル・アイコン（`agents` テーブルの行） |
| `knowledge` | kind/status 状態機械・検証契約トリガー | metric 名（ctr/position…）・計測元（GSC/GA…） |
| Axis A | 仮説→3LLM選抜→実測→playbook の PDCA・Elo | KPI の定義・対象 URL パターン・実行部隊の構成 |
| Axis B | 観測→ゲート分類→git適用→revert・安全境界 | 検知閾値・許可/FORBIDDEN パス |
| Sublimation | 3件昇華ルール・Wiki frontmatter | knowledge カテゴリ名 |
| エージェント定義 | `.claude/agents/<name>.md` と `.claude/agents/<name>/agent.md` の両対応（Claude Code が再帰スキャン・identity は `name` frontmatter）。`department` も frontmatter を SSOT として `agents` テーブルへ seed | エージェントの顔ぶれ |
| 命名 | （任意） | ポケモン → 自分の世界観のコードネーム |

要するに **「枠組み（状態機械・検証契約・安全境界・読み手別振り返り）」は普遍、「KPI・URL・閾値・名前」がドメイン**。

---

## 10. 現状の実装ノート（正直な状態 / 2026-06-23 時点）

移植・配布前に知っておくべき**実態と設計の差**。

- **自己改善ループは現在 launchd で停止中（意図的）**。ゲンガー集団・ミュウ・アルセウスの定期 plist は `.disabled`。ミューツーはミュウから Task 起動される実行体。
  「動く骨格」としては完成しているが、本番では今は回していない。
- **ダッシュボード(5733)は手動起動**。常駐 plist がないため、起動を忘れると `logs` 収集が止まる（実際 2026-05-29〜06-23 停止していた）。
- **テーブル命名**: 振り返りテーブルは歴史的に `runs` → `reflections` にリネームされた（`reflections` が正典）。配布用 `pokemon-agents/db/schema.sql` では自己参照 FK を `parent_run_id REFERENCES reflections(id)` に修正済み。
- **エージェント定義のファイル配置**: 現行 repo は `.claude/agents/<name>.md` と `.claude/agents/<name>/agent.md` の混在。`name` frontmatter が識別子（公式: 再帰スキャン）で、`department` frontmatter がダッシュボード部署分類の SSOT。`seed-agents-from-md.ts` は直下 `.md` と `<name>/agent.md` の両方を読み、`agents.source_md_path` を実在パスへ同期する。

### 2026-06-23 の棚卸しで解消したドリフト（現物⇔設計の一致作業）

- **port 4711 の legacy ダッシュボードを削除**（`events`/`agent_runs` を参照する死にコード）。現行は 5733 + `logs`/`reflections` に一本化。
- **パス参照を全面修正**: `launchd.json` の `agent_md` 全エントリ + 各 agent.md 内の script/reference 参照（計 30+ 箇所）が実在しない `_dept/...` を指していた → すべて実在パスに修正（`run-agent.sh` の名前フォールバックで動いてはいたが誤解源だった）。
- **`launchd.json` のクリーンアップ**: 定義ファイルの無い幽霊エントリ `diglett-title-optimizer` を削除。「2階層ネスト構造」という誤った `agent_folder_structure` 注釈を実態（直下 `.md` と `<name>/agent.md` の両対応）に修正。
- **クエリのテーブル名修正**: ミュウの観測クエリ `agent_runs`/`agent` → `reflections`/`agent_slug`。アルセウス Phase1 を legacy `hypotheses` → `knowledge`（playbook / anti_pattern / validated experiment）。
- **スキーマ統合**: 分割テーブル構想の incremental migration（`0001_init` の `events`/`agent_runs`/`knowledge_*` 等、`0002`/`0003`/`0004`）を削除し、**現行DBから生成した統合 `pokemon-agents/db/schema.sql`** に一本化（`init.sh` がこれを適用。空DBへの適用＋整合性チェック済み）。
- **seed と管理 UI のパス再生産を修正**: `seed-agents-from-md.ts` は本文 hash が同じでも `source_md_path` / `department` 等のメタ差分を同期する。`schedule-writer.ts` はフラット `.md` を優先し、無ければ `<name>/agent.md` にフォールバックする。
- **欠落ファイルの新設**: Axis B 安全境界 `.claude/agents/_shared/control-boundary.md`（mew/mewtwo が起動時必読だが存在しなかった）を新規作成。
- **DB メンテ**: `agents.db` を VACUUM で 1.59GB → 329MB に回収。`scripts/db-maintenance.sh` で再発防止。

> 残る既知事項は **「ループが意図的に停止中」「ダッシュボードが手動起動」の運用面のみ**。スキーマ・パス・用語のドリフトは解消済みで、配布時は `schema.sql` + 両対応の agent 定義をそのままテンプレートにできる。

---

## 11. 用語対応表（コードネーム ↔ 一般名）

| コードネーム | 一般名 | 部品 |
|---|---|---|
| メガゲンガー | KPI ループ Orchestrator | ③ |
| ゴース | Validator（実測・検証） | ③ Stage1 |
| ゴースト | Hypothesizer（仮説生成） | ③ Stage2 |
| ゲンガー | Selector（選抜・guidance） | ③ Stage3 |
| ミュウ | 自己改変ループ Supervisor/Observer | ④ |
| ミューツー | 自己改変ループ Executor（git 適用） | ④ |
| アルセウス | Knowledge Editor（昇華） | ⑤ |

---

## 参考ファイル

- `.claude/guides/reflection.md` — 4 層振り返りの定義
- `.claude/guides/domain-knowledge.md` — 知識昇華システムの設計
- `.claude/skills/agent-bootstrap/` — 共通起動プロトコル
- `.claude/agents/{megagengar-orchestrator,gastly-validator,haunter-hypothesizer,gengar-selector}.md` — Axis A
- `.claude/agents/{mew-supervisor,mewtwo-executor}.md` — Axis B
- `.claude/agents/_shared/control-boundary.md` — Axis B 安全境界（mew/mewtwo 必読）
- `.claude/agents/arceus-knowledge-editor.md` — Sublimation
- `pokemon-agents/web/server.ts` — ダッシュボード (5733)
- `pokemon-agents/db/schema.sql` — 統合スキーマ（init.sh が適用）
- `scripts/db-maintenance.sh` — DB 肥大回収

---

## 付録A. 登壇・配布資料の構成案（実装解説版・28〜32 ページ）

コミュニティ向けの登壇／配布資料に落とす際のページ割り。これは単発のアーキテクチャ紹介ではなく、**これまで紹介してきた各サブエージェントを、どう統合して「事業を自律改善する仕組み」にするか**を説明する最終まとめパートとして設計する。
各ページは「**狙い**（1 枚で何を伝えるか）／**載せる**（図・表・要点）／**話す**（口頭の補足）」の 3 点セットで設計する。

> 物語の流れ: 個別エージェントは作れた → しかし「改善装置」がない → 実例としてゲンガー集団を分解 → DB / Dashboard で何を管理するかを実演 → 同じ型でミュウ・アルセウスも作る → 自分の事業へ移植する。

この章では「3 つのエンジン」を同じ重さで並べない。最初に **ゲンガー集団を実装例として厚く解説**し、聴衆が「こう作ればいいのか」と掴んでから、ミュウ / アルセウスを同じパターンの応用として見せる。
DB 内部の状態名やカラム名だけを並べると初見では追えないため、P6 以降は同じサンプルケースを通しで使う。英語名は残すが、先に「業務上は何を意味するか」を日本語で説明してから使う。

> 通し例: SEO 記事ページ `/purpose/living-support/hokkaido` の CTR が低い。GSC で「表示はあるがクリックされない」ことが分かったので、タイトル / リード / H2 を改善して CTR を `0.37% → 1.20%` に上げる仮説を作り、ピジョット系のエディトリアル部隊に渡し、T+1d / T+7d で検証する。

---

### P1. 表紙 — 最終回の位置付け
- **狙い**: これまでのサブエージェント紹介の「まとめ回」だと明確にする
- **載せる**: タイトル「サブエージェント群を“自律改善する事業OS”に統合する」／サブ「ゲンガー・アルセウス・ミュウと SQLite ダッシュボード」
- **話す**: 今回は新しい Writer を作る話ではなく、これまで作ってきた Writer / Reviewer / Publisher / SEO 系を、どう1つの学習する組織にするかを話す

### P2. ここまで作ってきたもの
- **狙い**: 聴衆の頭を、個別エージェントの文脈に戻す
- **載せる**: 実在チームの一覧: 補助金記事（キャタピー / トランセル / バタフリー）、給付金記事（コイル / レアコイル / ジバコイル）、エディトリアル（ポッポ / ピジョン / ピジョット）、外部記事（ロコン / ツボツボ）、SEO 計測（ケーシィ / ユンゲラー）
- **話す**: ここまでで“実行部隊”は増えた。記事を書く、レビューする、外部記事を入稿する、順位や SEO レポートを見る、という個別自動化はできるようになった

### P3. でも個別自動化だけでは事業は良くならない
- **狙い**: 統合基盤が必要になる理由を腹落ちさせる
- **載せる**: 3 つの穴: ①誰がどの KPI 仮説を持って実行したか分からない ②効果測定の予定が残らない ③成功・失敗が次の agent 起動時に使われない
- **話す**: 実行量が増えても、それだけでは自律改善にならない。必要なのは「実行した」ではなく「何を狙い、何を測り、結果を次にどう渡すか」までを残す仕組み

### P4. 最終的に作りたいもの — 自律改善する事業OS
- **狙い**: この章全体のゴールを1枚で置く
- **載せる**: ループ図: 実行部隊 → DB に結果を残す → 仮説を作る → エージェントを直す → 知識を更新する → 次の実行へ反映
- **話す**: 目標は、たくさんのエージェントを並べることではない。実行部隊の上に、自律改善のための制御層を作ること

### P5. まず厚く見る実例 — ゲンガー集団
- **狙い**: この後の抽象論ではなく、実装済みの改善装置を分解して学ぶと宣言する
- **載せる**: 「事業 KPI 改善ループ」の1行定義: 検証 → 仮説生成 → 選抜 → guidance → 実行 → 再検証
- **話す**: ゲンガー集団は「SEO に効きそうなアイデアを出す係」ではない。対象 URL、測定指標、before/after、検証日程、実行担当まで決める、事業 KPI 改善のパイプライン

### P6. 今日ずっと使うサンプルケース
- **狙い**: 難しい状態名に入る前に、聴衆の頭に具体的な題材を置く
- **載せる**: 1ページの改善対象カード
  - 対象: SEO 記事ページ `/purpose/living-support/hokkaido`
  - 現状: GSC で `815 impressions` / CTR `0.37%` / 平均順位 `6.1`
  - 課題: 順位は悪くないのにクリックされていない
  - 目標: CTR `1.20%`
  - 施策候補: タイトル / リード / H2 を「北海道 生活支援 補助金」の検索意図に寄せる
  - 測定: T+1d impressions、T+7d CTR / position
- **話す**: 以降はこの SEO 記事の例だけを追う。英語のテーブル名は後で出すが、やっていることは「低い CTR を、測れる仮説として改善する」だけ

### P7. DB用語を業務の言葉に翻訳する
- **狙い**: `hypothesis` / `experiment` / `guidance` で迷子にさせない
- **載せる**: 用語対応表
  - hypothesis = 検証できる仮説（何を変えれば、どの数字が、どれだけ動くか）
  - experiment = 実行中の施策（測定日程つき）
  - guidance = 実行部隊への今日の指示書
  - playbook = うまくいった型
  - anti_pattern = やっても効かなかった型
- **話す**: 英語名は DB の状態名。理解すべきなのは「仮説 → 実験 → 成功/失敗の型」の流れ

### P8. ゲンガー集団の4体分担
- **狙い**: 「ゲンガー」と一括りにせず、なぜ4体に分けたかを説明する
- **載せる**: メガゲンガー / ゴース / ゴースト / ゲンガーの表
  - メガゲンガー: 毎日 2:00 に順番を制御する orchestrator
  - ゴース: 実験結果を GSC/GA で測り、validated / falsified を判定
  - ゴースト: playbook / anti_pattern / 最新データから仮説を最大 9 件生成
  - ゲンガー: 3 LLM Elo + SERP 確認で選抜し、experiment / guidance を発行
- **話す**: 1体に全部やらせると責務が混ざる。検証する人、仮説を出す人、選ぶ人、順番を守らせる人を分けたから、品質チェックとデバッグができる

### P9. 1日の実行フロー
- **狙い**: 抽象概念ではなく、実際の起動順序と停止条件を理解させる
- **載せる**: 2:00 メガゲンガー起動 → ゴース → ゴースト → ゲンガー → 実行部隊が guidance を読む → 翌日ゴースが検証、のタイムライン。前段失敗なら後段スキップ、仮説0件なら選抜スキップも明記
- **話す**: 自律改善は「ずっと勝手に考えている」ものではない。毎日同じ順番で、DB を確認しながら小さく1回転させる

### P10. ゴーストは何を読むのか
- **狙い**: 「仮説生成」が何を材料にしているかを具体化する
- **載せる**: 入力の4箱
  - 過去に効いた型: `playbook`
  - 過去に効かなかった型: `anti_pattern`
  - 直近の実測結果: 昨日 validated / falsified になった施策
  - 今日の数字: GSC / GA の低 CTR・順位 5〜15 位・CVR 低下
- **話す**: ゴーストはゼロから思いつくのではない。過去の成功・失敗と今日の数字を読んで、「今回は何を試すべきか」を作る

### P11. ゴーストは何を書くのか — 悪い仮説 / 良い仮説
- **狙い**: 初見の人が「検証可能な仮説」の意味を腹落ちできるようにする
- **載せる**: 左右比較
  - 悪い例: 「SEO記事を良くすると CTR が上がりそう」
  - 良い例: 「`/purpose/living-support/hokkaido` のタイトル / リード / H2 を改善し、GSC CTR を `0.37% → 1.20%` に上げる。T+1d で impressions、T+7d で CTR / position を測る。担当は `pidgeot-editorial`（執筆は `pidgey-editorial-writer`）」
- **話す**: 人間なら悪い例でも意図を汲めるが、翌日検証する agent は困る。だから、対象・数字・測定日・担当まで行にする

### P12. DB契約 — 仮説は「文章」ではなく検証可能な行
- **狙い**: 見た人が真似するときの最重要ポイントを示す
- **載せる**: `knowledge.kind='hypothesis'` の必須 JSON 例
  - `affected_resources`: 対象 URL / scope
  - `predicted_outcome`: `metric`, `baseline`, `target` or `delta_pct`, `direction`, `measurement_source`
  - `follow_up_schedule`: T+1d / T+7d などの測定予定
  - `metadata.executor_agent`: 実行担当
- **話す**: 「CTR が上がりそう」では DB に入れない。「/purpose/living-support/hokkaido の CTR を GSC で 0.37% → 1.20% に上げる。T+1d と T+7d で測る」まで揃って初めて仮説

### P13. ゲンガーは何を選ぶのか
- **狙い**: 選抜の基準を「なんとなく良さそう」から切り離す
- **載せる**: 9件の仮説 → SERP 確認 → 3 LLM が独立採点 → 平均 Elo で順位決定 → 上位を `experiment` に昇格
  - LLM A: 戦略・構造の観点
  - LLM B: 検索意図・SEO技術の観点
  - LLM C: ROI・攻め筋の観点
  - 5軸評価
  - KPIインパクト
  - 実現確度
  - コスト効率
  - 学習価値
  - 緊急性
- **話す**: ゴーストは候補を作るが、どれを今日やるかはゲンガーが決める。1つの LLM の好みで決めず、3つの評価者に独立採点させて、平均 Elo で優先順位を作る

### P14. guidance — 実行部隊に渡す「今日の指示書」
- **狙い**: 改善エンジンと Writer / Publisher の接続を具体化する
- **載せる**: guidance の例
  - 全体方針: 順位 5〜10 位なのに CTR が低い SEO 記事を優先
  - 対象: `/purpose/living-support/hokkaido`
  - 担当: `pidgeot-editorial`（ポッポ執筆・ピジョン査読）
  - やること: title / リード / H2 を「北海道 生活支援 補助金」の検索意図に寄せる
  - 避けること: 過去 anti_pattern の「都道府県名だけを足す」改善
  - KPI: T+7d CTR
- **話す**: 実行部隊に DB の JSON を読ませるのではなく、人間にも agent にも読める指示書へ変換して渡す

### P15. ゴース — 実測して playbook / anti_pattern にする
- **狙い**: Check/Act がどのように実装されているかを具体化する
- **載せる**: `experiment(status='executing')` を取得 → `follow_up_schedule` を確認 → GSC/GA で before 7日平均 vs after を実測 → outcome 判定 → validated は playbook、falsified は anti_pattern
- **話す**: ゴースは新しい仮説を書かない。数字を取りに行く係。ここを分離しているから、思いつきと検証が混ざらない

### P16. 1つの例を最後まで追う
- **狙い**: P10〜P15 の分解を1枚で再結合する
- **載せる**: SEO 記事 `/purpose/living-support/hokkaido` の流れ
  1. ゴースト: CTR 低下を見て仮説を作る
  2. ゲンガー: 3 LLM で候補を採点し、9件から選び experiment 化
  3. guidance: ピジョット系に SEO 記事改善を指示
  4. ポッポ / ピジョン: 記事を書き直し、査読する
  5. ゴース: T+7d に CTR を測る
  6. 結果: validated なら playbook、falsified なら anti_pattern
- **話す**: これで、アイデアが「実行され、測られ、知識に戻る」まで閉じる

### P17. ゲンガー集団を別事業に移植する手順
- **狙い**: 聴衆が自分の事業で作る時の置き換えポイントを示す
- **載せる**: 5 ステップ
  1. KPI を決める（例: CTR / CVR / 返信率 / 継続率）
  2. 実行部隊を決める（誰が施策を実行するか）
  3. `predicted_outcome` の metric と measurement_source を決める
  4. T+1d / T+7d などの follow-up を決める
  5. validated / falsified を playbook / anti_pattern に昇華する
- **話す**: ポケモン名や補助金ドメインは本質ではない。自分の事業で置き換えるべきなのは KPI、実行担当、測定元、検証間隔

### P18. ここで実機デモ — Dashboard でゲンガーを見る
- **狙い**: 抽象説明を画面に落とす
- **載せる**: デモで見る順番: Agents（4体が登録されている）→ Knowledge/Hypotheses（proposed / executing / validated）→ Reflections（各 stage の結果）→ Logs（起動と失敗）→ Guidance（実行部隊向けブリーフ）
- **話す**: デモでは UI の綺麗さではなく、DB に状態が残り、次の agent が読める形になっているかを見る

### P19. ダッシュボードの概念 — エージェント組織の観測窓
- **狙い**: デモで見た画面を、全体アーキテクチャに戻す
- **載せる**: エージェント組織（実行部隊 + ゲンガー + ミュウ + アルセウス）→ `agents.db` → Dashboard の3層図
- **話す**: ダッシュボードは SQL の代替ではなく、エージェント組織の現在地を人間が判断できる形にする観測窓

### P20. 次の応用① ミュウ — エージェント自身を直す
- **狙い**: ゲンガーで理解した「DB に状態を残して改善する」型を、運用改善に拡張する
- **載せる**: 入力: `logs` / `reflections.self_improvement` / running 放置 / timeout / 差し戻し。出力: `control_observation` → `control_hypothesis` → ミューツー実行 or 人間ゲート
- **話す**: ミュウは SEO 施策ではなく、エージェント組織の健康診断。失敗率や曖昧な手順を見て、agent.md や品質ゲートを直す

### P21. ミュウの安全設計 — 自己改変は分離する
- **狙い**: 自律改善の危険性とゲート設計を示す
- **載せる**: ミュウ=観測と起草、ミューツー=適用、`auto_apply` / `human_gate` / `forbidden`、`control-boundary.md`
- **話す**: 自己改善は危険なので、考える agent とファイルを触る agent を分ける。DB に diff と gate_classification を残し、危ない変更は止める

### P22. 次の応用② アルセウス — 検証済みの学びを知識にする
- **狙い**: 単発の validated / falsified を、全員が使える知識に変える方法を説明する
- **載せる**: `knowledge` の playbook / anti_pattern → `docs/knowledge/**/*.md` → `get-agent-knowledge.sh` → 各 agent 起動時ロード
- **話す**: アルセウスは「思いつきを足す係」ではない。検証済みの学びを、次回から読む前提知識に変える保守的な編集長

### P23. 3つは同じDBパターンでできている
- **狙い**: ゲンガー / ミュウ / アルセウスがバラバラの魔法ではないと示す
- **載せる**: 共通パターン表
  - 入力を読む
  - 構造化された仮説 / 観測 / 知識候補を書く
  - gate で壊れたデータを拒否する
  - 実行後に reflection を残す
  - Dashboard で人間が確認する
- **話す**: 本質は名前ではなく、DB に状態機械を作ること

### P24. 実装の最小セット
- **狙い**: 聴衆が自分で作るときの入口を示す
- **載せる**: ①`schema.sql` で SQLite 作成 ②agent.md frontmatter（`name` / `department` / `role` / `model`）を書く ③`seed-agents-from-md.ts` で `agents` 同期 ④`start-reflection.sh` で実行記録 ⑤`knowledge` に状態機械を作る ⑥Dashboard で読む
- **話す**: いきなり全部作らなくていい。まず agent 台帳、実行ログ、reflection、dashboard。次にゲンガーの小さい版を1つ作る

### P25. 最小版ゲンガーを作るなら
- **狙い**: 具体的な初期実装を渡す
- **載せる**: 最小構成: Validator 1体、Hypothesizer 1体、Selector 1体、SQLite 1個。まずは 3 仮説 / 1 KPI / 1 measurement_source だけで始める
- **話す**: 最初から 3 LLM Elo や 11体 guidance は不要。自分の事業なら「問い合わせ返信率を上げる」など1 KPI で小さく回す

### P26. 移植時に差し替えるチェックリスト
- **狙い**: hojokin 固有部分と汎用骨格を切り分ける
- **載せる**: 差し替えるもの: KPI、measurement_source、実行部隊、対象リソース、follow_up 間隔、playbook 化条件、コードネーム。残すもの: `agents/logs/reflections/knowledge`、状態遷移、gate、dashboard
- **話す**: 補助金ドメインやポケモン名は置き換えられる。本質は、仮説を検証可能な行にし、結果を知識に戻す構造

### P27. 正直な現状とハマりどころ
- **狙い**: 過大広告にせず、実運用で起きたズレから学びを渡す
- **載せる**: ループは意図的に停止中、ダッシュボード手動起動、DB 肥大は VACUUM、schema/パス/seed のドリフトを解消済み
- **話す**: 動く骨格はあるが、常時フル自律にする前に安全側へ倒している。実運用では schema と agent.md と dashboard のズレが一番怖い

### P28. まとめ — 個別エージェントから自律改善組織へ
- **狙い**: 最後に記憶に残す
- **載せる**: 3 つの持ち帰り ①ゲンガー=検証可能な KPI 仮説を回す ②ミュウ=エージェント運用を直す ③アルセウス=検証済みの学びを知識にする。中央に DB / Dashboard
- **話す**: サブエージェントは“人手の代替”で終わらせない。DB に状態を残し、仮説を検証し、知識に変え、エージェント自身も直すことで、事業を自律改善するシステムにする

---

**コア 22 ページに削る場合**: P20/P21 を 1 枚に統合、P22/P23 を 1 枚に統合、P25 を落とす。ゲンガー集団の P5〜P18 は削らない。
**逆に厚くする場合**: P12 / P14 / P18 をそれぞれ「概念」と「実際の DB 行・ダッシュボード画面」の 2 枚に割ると、実装寄りの 35 ページ版にできる。

---

## 付録B. 配布デモのセットアップ（空 DB だと魅力が伝わらない問題への対処）

fresh clone は DB が空のため、ダッシュボードを立ち上げても各ビューが真っ白で「何ができるか」が伝わらない。
そこで**現実味のあるダミーデータ**を投入し、全ビューが埋まった状態で中身を見られるようにする。

### ワンコマンド

```bash
bash pokemon-agents/scripts/setup-demo.sh          # → .claude/db/agents-demo.db を生成
AGENTS_DB_PATH=.claude/db/agents-demo.db bun pokemon-agents/web/server.ts
# → http://localhost:5733/
```

`setup-demo.sh` は ① `schema.sql` 適用 → ② `seed-agents-from-md.ts`（26体）→ ③ `seed-demo-data.ts` を順に実行する。
本番 DB を壊さないよう**デフォルトで別ファイル** `.claude/db/agents-demo.db` に作る（`.claude/db/` は gitignore 済みなので配布物には含まれない＝各自が生成する）。

### 投入されるダミーデータ（= ダッシュボードが実際に読むテーブル）

| テーブル | 内容 | 見えるビュー |
|---|---|---|
| `reflections` | 13件。Axis A の親子木（メガゲンガー→ゴース/ゴースト/ゲンガー）、Axis B（ミュウ→ミューツー）、実行部隊の日次、failed/running の例 | `/` `/reflections` |
| `logs` | 60件。hooks 由来のツール呼び出しイベント | `/logs?view=events` |
| `hypotheses` | 6件。pending/running/validated/falsified の施策仮説 | `/hypotheses` |
| `improvements` | 5件。Axis B 制御改善（timeout調整・FORBIDDEN却下 等） | `/improvements` |
| `agent_costs` | 7日×11体のコスト | `/costs` |
| `agent_schedules` | 8件のスケジュール | `/schedules` |
| `daily_reports` | 5日分の日次サマリ | `/reports` |
| `approvals` | 2件の人間ゲート待ち | overview バッジ |

`knowledge_index`（ドメイン知識ビュー）は `docs/knowledge/*.md` から自動再構築されるため投入不要。

### 安全装置（`seed-demo-data.ts`）

- `reflections` に**デモでない行が既にある＝実運用 DB** と判断したら中止（`--force` で上書き可）。本番 DB を誤って汚さない。
- デモ行は識別可能（`reflections`/`logs` は `session_id='demo-*'`）。`--clear` でデモ行のみ削除。
- 何度実行しても重複しない（冪等）。
- `AGENTS_DB_PATH` 環境変数で対象 DB を差し替え可能（`seed-agents-from-md.ts` / `server.ts` も対応）。
