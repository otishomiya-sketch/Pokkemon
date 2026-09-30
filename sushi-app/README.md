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
- リサーチ対象のルール（`src/research-rules.ts`、登録時に検査）
  - 握り: 日本の寿司屋・鮨店・鮨関連アカウントのみ（`source_kind` = sushi_shop / sushi_account、`origin` = japan）
  - 一品料理: 上記に加えて日本料理店・創作和食店（japanese_restaurant / creative_washoku）。海外も可
  - 全体の約 3 分の 1 を海外の一品料理から集める。海外の価格は円に直して価格帯を決める
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

## 有料化と顧客管理（無料デモ → 有料月額プラン）

参考: Menu Photo Pro（otishomiya-sketch/oishikunaare）の仕組みを、このアプリ（Bun + Railway）向けに置き換えたもの。

- 会員登録・パスワードは作らない。お店の名前を入れるだけで、店舗コード（`DEMO-` ＋ 6 文字）と無料デモの枠ができる
- コードは URL（`?code=…`）とブラウザ（localStorage）の両方に保存。次回は同じリンクを開くだけで続きから使える
- 利用単位は **素材**: 1 素材 = 提案 1 回（3 品）。その 3 品のイメージ画像は追加の消費なし
- 無料デモ: 1 店 3 素材、全店合計 300 素材（社内用のお店は数えない）
- 有料プラン（月額・税別、消費税 10% を外税で加算。未使用分は翌月に繰り越し、解約で消える）

| プラン | 月の素材 | 税別 | 税込 |
|---|---|---|---|
| ライト | 10（30 品） | 19,800 円 | 21,780 円 |
| スタンダード | 20（60 品） | 29,800 円 | 32,780 円 |
| プロ | 30（90 品） | 39,800 円 | 43,780 円 |

- 顧客データは Railway のデータベース（`shops` 表）。処理の前に 1 素材を確保し、失敗したら返す
- 決済は Stripe Checkout（申し込み）と Customer Portal（変更・解約）。Webhook は使わず、アプリから契約を問い合わせる（1 分キャッシュ）
  - active / trialing / past_due を有料として扱う。存在しない契約（resource_missing）は契約なし。通信エラーのときは最後に確認できたプランで使わせる
  - 戻る前に画面を閉じた人向けに「お支払い済みなのに反映されない方」ボタン（契約の metadata.code で検索）
- Stripe の設定が揃うまでは、料金プランや案内を一切出さず、無料デモだけで動く（段階的に公開できる）
- 繰越 = max(0, 月枠 + 前の繰越 − 前月の使用) + 月枠 × (丸ごと使わなかった月の数)。読み取り時に計算し、使うときにまとめて書き込む

### 管理画面
`https://<公開URL>/admin` を開き、管理用パスワード（Railway の Variables の `ADMIN_PASSWORD`）でログインする。`ADMIN_PASSWORD` が無いと管理画面は開けない。
- 全体の数字（登録店舗・有料の内訳・無料デモの使用・月の売上見込み・今月の提案・評価・画像）
- 無料デモの設定（全店合計の上限・新しいお店の上限）の変更
- 店舗ごとの利用状況（残り・提案・評価・画像・最終利用・お店の情報・最近の提案）と、社内用・無料デモの上限・使用・メモの変更
- ログインは 12 時間有効。同じ接続元から 10 分で 5 回失敗すると止まる。有料プランの表示は最後に確認できたもの（Stripe には問い合わせない）

### 管理のコマンド（リポジトリ直下で）
```bash
bun sushi-app/scripts/loop.ts shop-stats              # 店舗ごとの契約・無料デモの使用・今月の使用・繰越
bun sushi-app/scripts/loop.ts billing-settings        # 無料デモの上限を見る
bun sushi-app/scripts/loop.ts set-billing-settings --json '{"demo_total_limit":300,"demo_default_limit":3}'
bun sushi-app/scripts/loop.ts set-shop-billing --json '{"code":"…","internal":true}'          # 社内用（無制限）にする
bun sushi-app/scripts/loop.ts set-shop-billing --json '{"code":"…","demo_limit":5,"memo":"…"}' # 1 店だけ無料枠を変える
```

### Stripe の初回設定（管理者）
1. まずサンドボックス（テストモード）で試す
2. 商品を 3 つ作り（ライト・スタンダード・プロ、月額の継続課金）、ID を `STRIPE_PRICE_LIGHT / STANDARD / PRO` に入れる（商品 ID `prod_…` なら既定の価格を使う）
3. 税率「消費税 10%・税別（exclusive）」を作り、`STRIPE_TAX_RATE_ID` に入れる（Stripe Tax は使わない）
4. Customer Portal をダッシュボードで設定して保存する: キャンセルは期間の終了時、アップグレードは日割りですぐ請求、ダウングレードは期間の終了時
5. 本番のキーは **制限付きキー** にする。権限は Checkout Sessions＝作成、Customer Portal＝作成、Subscriptions・Customers・Products・Prices・Tax Rates＝読み取り の 7 つだけ
6. 本番の有効化には、会社のサイトに特定商取引法に基づく表記、本人確認書類の提出、セキュリティ・チェックリストへの回答（カード情報を保持しない など）が必要
7. Railway の Variables に上の値と `APP_URL`・`TERMS_URL`・`CONTACT_TEXT` を入れて Deploy

### テスト（本物の Stripe を使わない）
`sushi-app/scripts/stripe-mock.ts` が模擬 Stripe。`.claude/launch.json` の `stripe-mock` と `sushi-app-billing-test` を起動し、`POST /__complete/<checkout_session_id>` で申し込みを完了させて流れを確かめる。

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
