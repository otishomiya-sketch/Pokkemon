# 寿司メニュー提案アプリ

寿司職人が手元の素材を入力し「握り / 一品料理」を選ぶと、新メニュー3品とレシピを提案するスマホ向けアプリ。
提案は、リサーチで集めたトレンド（`trends`）と、他店の職人の評価（`feedback`）を踏まえて Claude が作る。

## 起動

```bash
cd sushi-app
bun install
bun scripts/seed.ts          # デモ店舗 DEMO と見本トレンドを入れる（初回のみ）
bun server.ts                # → http://localhost:5800/  店舗コード DEMO でログイン
```

- `ANTHROPIC_API_KEY` を `.env.local` に書くと実際の提案が出る（`.env.example` 参照）。未設定ならデモモード。
- スマホ実機で試す: `HOST=0.0.0.0 bun server.ts` → 同じ Wi-Fi のスマホから `http://<MacのIP>:5800/`
- 店舗を追加: `bun scripts/seed.ts --shop CODE 店名`

## 学習ループ（エージェント）

| 担当 | ファイル | 仕事 | 周期 |
|---|---|---|---|
| ヨルノズク | `.claude/agents/noctowl-researcher.md` | SNS・Web から寿司メニューの傾向を集める | 毎日（メガゲンガーから） |
| メガゲンガー | `.claude/agents/megagengar-orchestrator.md` | 下の 4 体を順に動かす司令塔 | 毎日 2:00 |
| ゴース | `.claude/agents/gastly-validator.md` | 実験を職人の評価で測り、勝ち・負けを判定 | 毎日 |
| ゴースト | `.claude/agents/haunter-hypothesizer.md` | 「こう提案すれば評価が上がる」仮説を立てる | 毎日 |
| ゲンガー | `.claude/agents/gengar-selector.md` | 仮説を採点し、上位をアプリの提案方針にする | 毎日 |
| アルセウス | `.claude/agents/arceus-knowledge-editor.md` | 学びを素材ごとの知識にまとめる | 毎週月曜 3:00 |

共通ルールは `.claude/agents/_shared/sushi-loop.md`。エージェントは DB を直接触らず、`scripts/loop.ts` を通して読み書きする。

手動で 1 周まわす（リポジトリ直下で）:

```bash
bash pokemon-agents/scripts/init.sh                      # 初回のみ: 振り返り用 DB を作る
bun pokemon-agents/scripts/seed-agents-from-md.ts         # 初回のみ: ダッシュボードに担当を登録
bash scripts/run-agent.sh megagengar-orchestrator .claude/agents/megagengar-orchestrator.md
```

- 実行には Claude Code（`claude` コマンド）へのログインが必要。実行ごとに利用料がかかる。
- 各担当は frontmatter の `allowed_tools` に書いた道具しか使えない（Web を読む担当が、ページ内の指示で勝手な操作をしないため）。
- 結果はダッシュボード（`bun pokemon-agents/web/server.ts` → http://localhost:5733/ のリフレクションログ）で見られる。

## データの流れ

| テーブル | 書く | 読む |
|---|---|---|
| `trends` | ヨルノズク（SNS・Web の傾向を要約） | アプリ・ゴースト |
| `menu_hypotheses` | ゴースト（仮説）→ ゲンガー（実験開始）→ ゴース（判定・勝ち負けパターン） | アプリ（実行中の方針・勝ち負けパターンを AI に渡す） |
| `knowledge_notes` | アルセウス（素材・技法の知識） | アプリ |
| `proposals` | アプリ（どの実験が効いていたかも記録） | ゴース |
| `feedback` | アプリ（職人の評価） | ゴース・アプリ |

DB は `sushi-app/data/sushi.db`（GitHub には上げない）。

## まだ無いもの

- 毎日の自動実行（launchd の登録）
- 店舗ごとの本格的なログイン・課金
- インターネット上への公開（今は手元の Mac でのみ動く）
