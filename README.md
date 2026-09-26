# Pokémon Agent OS — 自己改善ループ（リファレンス配布版）

AI エージェント群の上に乗り、「事業 KPI」と「エージェント自身」を人手なしで改善し続ける
**メタ自己改善システム** の最小構成。3 つのループ + ダッシュボードからなる。

| ループ | コードネーム | 役割 |
|---|---|---|
| Axis A: KPI 改善 | ゲンガー集団（メガゲンガー / ゴース / ゴースト / ゲンガー） | 仮説 → 3LLM選抜 → 実測検証 → playbook 化 |
| Axis B: 自己改変 | ミュウ / ミューツー | 観測 → 改善案 → 安全ゲート → git 適用 → 自動 revert |
| 知識昇華 | アルセウス | 検証済みの学びを Wiki 化し全エージェントへ再配布 |
| 可観測性 | ダッシュボード（port 5733） | 上記すべてを DB-native に可視化 |

📖 設計の全体像 → [docs/self-improving-agent-architecture.md](docs/self-improving-agent-architecture.md)

## 必要なもの
- [bun](https://bun.sh) / `sqlite3`

## すぐ試す（中身入りデモダッシュボード）
デモ DB を同梱しています。unzip 後そのまま:

```bash
AGENTS_DB_PATH=.claude/db/agents-demo.db bun pokemon-agents/web/server.ts
# → http://localhost:5733/
```

## 含まれるもの / 含まれないもの
- ✅ 含む: メタ7体（ゲンガー集団 / ミュウ・ミューツー / アルセウス）+ ダッシュボード + 共通枠組み（schema / scripts / guides / agent-bootstrap）
- ❌ 含まない: 各ドメインの「実行部隊」エージェント（記事生成など）。**これらはこのメタシステムが管理・改善する対象**であり、利用側で自分のエージェントを足して使う想定。

## 構成
| パス | 役割 |
|---|---|
| `.claude/agents/` | メタ7体（フラット `<name>.md`）+ `_shared/`（安全境界など） |
| `.claude/guides/` | 4層リフレクション / 知識昇華 / ダッシュボード規約 |
| `.claude/skills/agent-bootstrap/` | 全エージェント共通の起動プロトコル |
| `.claude/scripts/`, `scripts/` | reflection 作成 / Discord 通知 / 知識ロード等 |
| `pokemon-agents/web/` | ダッシュボード（Bun HTTP, port 5733） |
| `pokemon-agents/db/schema.sql` | 統合スキーマ |
| `pokemon-agents/scripts/` | seed / setup-demo / scheduler |
| `docs/` | 設計詳説 |

## シークレット
コードに鍵は含めていません。必要な値は `.env.example` をコピーして設定（`cp .env.example .env.local`）。Discord 通知や外部 API は環境変数から読み、未設定なら通知はスキップされます。

## 注意
- ポケモンアイコンは [PokéAPI](https://pokeapi.co/) の公開アート参照（ポケモンは任天堂/Game Freak 著作物）。コードネームは内部運用上の愛称。
- スケジューラ（`launchd.json`）は macOS launchd 前提。自環境のスケジューラに読み替えを。
