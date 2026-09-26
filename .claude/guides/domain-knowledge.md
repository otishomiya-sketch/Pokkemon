# ドメイン知識システム (Wikipedia 方式)

事業グロース・エージェント自律改善の学びを **階層化された Markdown ドキュメント** に集約する体系。
各エージェントは起動時にここから「自分に関係する必読知識」を読み込んで動く。

## 3 つの自律改善ループ

```
┌─────────────────────────────────────────────────────────────┐
│              📚 ドメイン知識 (Wikipedia)                     │
│                  docs/knowledge/                             │
│              全エージェントの「共有脳」                       │
└─────────────────────────────────────────────────────────────┘
              ↑                                ↓
              │ 昇華 (3件以上の同パターン)    │ 起動時に参照
              │                                │
┌─────────────┴──────┐            ┌───────────┴────────────┐
│ ループA: 事業改善   │            │ エージェント実行        │
│ 仮説 → 検証 →     │            │ 必読 md ロード →       │
│ 勝ち/負け判定       │            │ タスク実行 → reflection │
└────────────────────┘            └───────────┬────────────┘
              ↑                                │
              │                                ↓
┌─────────────┴──────┐            ┌─────────────────────────┐
│ ループB: 事業の種   │            │ ループC: 自律改善       │
│ content_improve    │            │ self_improve →         │
│ → ミュウが集約 →   │            │ ミューツーが agent.md  │
│ 新仮説起案          │            │ 修正 + ドメイン知識追記 │
└────────────────────┘            └─────────────────────────┘
```

## ファイル構造

```
docs/knowledge/
├── _index.md                         # 目次 (全体マップ)
├── seo/
│   ├── _index.md
│   ├── title-optimization.md
│   ├── title-optimization-anti-patterns.md
│   ├── structured-data.md
│   └── tag-prefecture-strategy.md
├── infrastructure/
│   ├── _index.md
│   ├── url-structure.md
│   └── url-migration-gotchas.md
└── measurement/
    ├── _index.md
    ├── title-change-impression-dip.md
    └── evaluation-timing.md
```

## Markdown の YAML frontmatter

```yaml
---
title: タイトル最適化で CTR を上げる
category: seo
applicable_agents: [diglett-title-optimizer, pidgey-editorial-writer, scizor-guide-writer]
priority: required          # or 'reference'
confidence: 0.7
evidence_hypothesis_ids: [175, 190, 193]
test_count: 3
win_count: 3
last_validated_at: 2026-04-22
status: active              # or 'deprecated' (反証済み)
---
```

## 優先度 (priority)

| 値 | 意味 | 運用 |
|---|---|---|
| `required` | **起動時に必ず読む** コアルール | 1 エージェントあたり最大 3-5 件、違反すると致命的なもの |
| `reference` | 知ってると有利な詳細ノウハウ | 件数制限なし、タスクに応じて on-demand で読む |

## エージェント起動フロー

```bash
# Phase 0: 必読ドメイン知識ロード
bash scripts/get-agent-knowledge.sh "$AGENT_SLUG" required
# → applicable_agents に自分の slug が含まれる required 知識だけ取得
```

参考知識はエージェントが必要に応じて Read tool で取る (タスクに関連するキーワードで grep → 該当ファイル読む)。

## 編集担当はアルセウス (パターン A)

**ドメイン知識の更新は `arceus-knowledge-editor` が専任で行う** (Wikipedia 編集長)。

### なぜアルセウス専任か (パターン A)

| 観点 | パターン A (アルセウス専任) | パターン B (各集団が自分で) |
|---|---|---|
| 文体の統一性 | ◎ 1 体が書くので自然に統一 | ✗ 書き手ごとにバラバラ |
| 横断的な知見抽出 | ◎ ゲンガー/ミュウ両方を読むので複合知見が出せる | ✗ 各集団は自分の領域しか見えない |
| Wikipedia 編集者役 | ◎ 品質保証の責任者が明確 | ✗ 誰も最終品質に責任持たない |
| ゲンガー/ミュウの負担 | ◎ 本業に集中 | ✗ 本業 + ドキュメント編集の二重役務 |
| 重複・矛盾リスク | ◎ 1 体なので矛盾しない | ✗ 同じテーマで別ファイル作りがち |

### アルセウスの責務

- hypotheses の `validated` / `falsified` 新着をスキャン
- reflections の `self_improvement` / `content_improvement` 新着をスキャン
- 3 件以上の同パターンを検出 → `docs/knowledge/**/*.md` を新規作成 or 更新
- frontmatter メタデータ (`evidence_hypothesis_ids`, `last_validated_at`) を維持
- 反証された既存ドメイン知識を `status: deprecated` に
- 月初に全ドキュメントの陳腐化をチェック
- 変更は git commit → 人間レビュー可能

### スケジュール

毎週月曜 03:00 (週次実行)

## インデックスと検索

- `.claude/db/agents.db` の `knowledge_index` テーブルが `docs/knowledge/**/*.md` の frontmatter をキャッシュ
- サーバ起動時 + `/api/reindex-knowledge` で rebuild
- **Markdown が SSOT、DB は検索インデックスのみ** (書き込みはしない)

## ヘルパースクリプト

```bash
# 指定エージェントの必読知識を取得
bash scripts/get-agent-knowledge.sh diglett-title-optimizer required

# 全て取得 (参考含む)
bash scripts/get-agent-knowledge.sh diglett-title-optimizer all
```

## ダッシュボード

- `/knowledge` でドキュメントを閲覧
- 左: ディレクトリツリー
- 右: Markdown レンダリング
- エージェントアイコン + 日本語名のチップで適用エージェントを表示
- `?agent=X&priority=required` で絞り込み可
