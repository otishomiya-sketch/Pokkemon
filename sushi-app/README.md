# "鮨"新メニュー開発APP

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

## 店舗情報と価格帯

お店は最初に開いたとき、**コンセプト・特徴・客単価** を登録する（あとから「店舗」タブで変更できる）。客単価から価格帯が決まる（`src/shop-profile.ts`）。

| 価格帯 | 客単価 |
|---|---|
| value | 〜3,000円 |
| casual | 3,000〜8,000円 |
| standard | 8,000〜15,000円 |
| premium | 15,000〜30,000円 |
| luxury | 30,000円〜 |

- ヨルノズクは `loop.ts research-targets` で、登録店舗の価格帯ごとに調べる件数を決め、各トレンドに `price_band` を付けて登録する
- リサーチは日本全国に加えて世界中の鮨店が対象。約 3 分の 1 を海外から集め、各トレンドに `origin`（japan / overseas）と `region`（都市）を付ける。海外の価格は円に直して価格帯を決める
- 提案では、海外のトレンドはそのまま真似ず、日本の素材と寿司店の仕事に置き換えるよう AI に指示している
- 提案では、お店の情報を AI に渡し、同じ価格帯（次に隣の価格帯・価格帯を問わないもの）のトレンドと評価を優先する

## クラウドで公開する（Railway）

アプリと DB はクラウド、毎晩のエージェントは Mac、という分担にする。エージェントは `SUSHI_REMOTE_URL` と `SUSHI_LOOP_TOKEN` があれば、クラウドの `/api/loop` を通して DB を読み書きする。

1. Railway で GitHub のこのリポジトリからサービスを作り、**Root Directory を `sushi-app`** にする（`Dockerfile` と `railway.json` で自動ビルド）
2. **Volume** を追加し、マウント先を `/data` にする（DB `sushi.db` の置き場所。これが無いと再起動でデータが消える）
3. **Variables** に `ANTHROPIC_API_KEY` / `ANTHROPIC_WORKSPACE_ID`（組織単位のキーのときだけ）/ `SUSHI_LOOP_TOKEN` を入れる。`DAILY_PROPOSAL_LIMIT`（既定 30）は任意。`OPENAI_API_KEY` を入れるとメニューのイメージ画像ボタンが出る（`DAILY_IMAGE_LIMIT` 既定 20 枚/店/日）
4. **Networking → Generate Domain** で公開 URL を作る
5. Mac のリポジトリ直下の `.env.local` に `SUSHI_REMOTE_URL=<公開 URL>` と、同じ `SUSHI_LOOP_TOKEN` を書く
6. 手元の学習データを移す: `bun sushi-app/scripts/loop.ts migrate-to-remote`（1 回だけ）
7. 店舗を作る: `bun sushi-app/scripts/loop.ts add-shop --json '{"name":"店名"}'` → 表示された店舗コードを店に渡す

クラウドには見本トレンドとデモ店舗（DEMO）は入らない。1 店舗 1 日の提案回数には上限がある（API の使いすぎ防止）。

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

毎日の自動実行（macOS の launchd）:

```bash
bash scripts/install-schedule.sh            # 登録: 毎日 2:00 メガゲンガー / 毎週月曜 3:00 アルセウス
bash scripts/install-schedule.sh --status   # 登録状況
bash scripts/install-schedule.sh --remove   # 止める
```

- 夜中の実行は `.env.local` の `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` で発行、1 年有効）で認証する。
- プロジェクトがデスクトップにある場合、macOS の「フルディスクアクセス」で `/bin/bash` を許可しておく必要がある（登録時に下見して、読めなければ登録しない）。
- Mac がスリープ中だった場合は、次に起きたときに 1 回だけ実行される。ログは `~/.claude/logs/sushi-<担当>.log`。

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

- 店舗ごとの本格的なログイン・課金
- インターネット上への公開（今は手元の Mac でのみ動く）
