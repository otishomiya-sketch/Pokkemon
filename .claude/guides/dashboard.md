# ダッシュボード (pokemon-agents/web/) は DB-native 必須

ポケモンエージェント管理ダッシュボードは **agents.db の `agents` テーブルを唯一の真実** として動作させる。
ハードコードされた辞書 (ポケモン名・アイコン・画像 URL・日本語ラベル等) を作るのは **禁止**。

## 禁止事項

- TypeScript 側に `POKEMON_EMOJIS` / `POKEMON_JP` / `POKEMON_AVATARS` 的な辞書を定義すること
- slug → 表示名の対応を個別ファイルに書くこと (`seed-agents-from-md.ts` は DB への seed 時のみ許可)
- 「新しいポケモンを追加したらダッシュボードのコードも直す」というワークフローを採用すること

## 正しいパターン

- サーバ起動時 (または fragment 描画時) に `SELECT slug, pokemon_slug, pokemon_jp, avatar_url, role, role_label, department FROM agents` を発行
- `Map<slug, AgentMeta>` を構築して各 view 関数に注入
- agents テーブルに行が無いポケモンは「未登録」として frontier display (灰色 + slug 文字のまま) する — **無理に推測しない**

## 理由

ハードコード辞書と DB がズレると以下の不整合が発生する:
- 新エージェント追加してもダッシュボードが旧辞書の slug しか認識しない
- ダッシュボードには載っているが実体 (agent.md / DB row) が無い「幽霊ポケモン」が発生
- i18n ラベル変更が DB と UI で二重管理になる

**単一ソース (agents テーブル) に寄せる** ことで、seed 経路さえ健全なら UI は自動追随する。
