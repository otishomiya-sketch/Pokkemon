# 制御改善の境界定義（Axis B 共有ルール）

ミュウ (mew-supervisor) と ミューツー (mewtwo-executor) が**起動直後に必ず Read** する、自己改変ループの安全境界。
ミュウはこの境界で `gate_classification` を分類し、ミューツーはこの allowlist 内のみ `git apply` する。

## gate_classification（ミュウが起草時に分類）

| 分類 | 対象 | 扱い |
|---|---|---|
| `auto_apply` | `scripts/run-agent.sh` の timeout 数値 / typo 修正 / 通知文言 / ダッシュボード UI 文言 | ミューツーが即適用（`status='proposed'`） |
| `human_gate` | `agent.md` のロジック変更 / 新スケジュール追加 / DB schema 変更 | Discord 通知のみ、人間承認待ち（`status='awaiting_approval'`） |
| `forbidden` | 下記 FORBIDDEN パス | 即中止 + `control_anti_pattern` 化（`status='rejected'`） |

## git apply で変更してよいパス（ミューツーの allowlist）

- `.claude/agents/**/*.md` ← **自分自身 (`mewtwo-executor.md`) は除く**
- `.claude/scripts/*.sh`
- `scripts/run-agent.sh` ← case 文の数値調整のみ
- `.claude/launchd.json` ← schedule の時分調整のみ

## SQL で書き込んでよい

- `knowledge` テーブルの `kind='control_experiment' / 'control_anti_pattern' / 'control_playbook'` の INSERT
- 上記行の `status` / `outcome` / `metadata` UPDATE

## FORBIDDEN（絶対に触らない）

- `src/`, `supabase/`, `next.config.ts` 等のアプリ本体・本番設定
- `git push --force`, `rm -rf`
- `DROP TABLE` / `TRUNCATE`
- `vercel --prod` 等の本番デプロイ
- Supabase MCP 経由の本番 DB 書込
- curl でダウンロードしたコードの実行
- **自分自身 (`mewtwo-executor.md`) の書き換え**（自己改変禁止）

## 安全装置

- 全変更は新規 git branch (`auto/control-YYYY-MM-DD-NNN`) で行い、main 直接 commit 禁止
- 効果測定で改善しなければ `git revert` で自動巻き戻し
- 同一 `control_hypothesis` を 3 回以上 apply しない（無限ループ防止）
- 境界判定はミュウ（起草時）とミューツー（適用前）で二重に確認する
