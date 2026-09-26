# Reflection 4層分離ルール (全エージェント共通)

エージェントの振り返りは **すべて `reflections` テーブルで完結** する。
**`hypotheses` テーブルは別システム** (ゲンガー集団の施策仮説検証サイクル) なので、reflection では触らない。

## 4 層の reflection カラム

| カラム | 中身 | 読む相手 |
|---|---|---|
| `result_full` | 外部アウトプット本文 (Discord 通知 / 記事 URL / 投稿先 URL) | 人間 (ダッシュボード閲覧) |
| `what_done` | やったこと (Markdown 箇条書き) | 人間 + メタエージェント |
| `quality_check` | agent.md ルール準拠の自己診断 (✅/❌ 箇条書き) | 人間 + メタエージェント |
| **`self_improvement`** | 自律改善: agent.md / コード / ルールをどう直すか | **ミューツー** (`git branch` で自動適用) |
| **`content_improvement`** | 事業改善: アウトプット構造の進化案 (項目追加 / レポート形式改善) | **ミュウ** (横断観測してパターン化) |

## `self_improvement` vs `content_improvement` の違い

| | self_improvement (自律改善) | content_improvement (事業改善) |
|---|---|---|
| 観点 | エージェント自身のコード・ルール | アウトプットの構造・項目 |
| 例 | 「agent.md 冒頭に pre-flight check 追加」「エラー時のリトライ上限をルール化」 | 「レポートに WoW 比較セクション追加」「競合比較グラフを Discord 送信に含める」 |
| 読む相手 | ミューツー → agent.md を git branch で修正 | ミュウ → 長期パターン化、次世代エージェントの仕様に反映 |
| 時間軸 | 次回実行で即反映 | 中長期 (数週間〜月単位) |

## `hypotheses` は別システム (触らない)

- `hypotheses` テーブルはゲンガー集団 (haunter → gengar → gastly) が管理する施策仮説検証サイクル専用
- エージェント reflection から `INSERT INTO hypotheses` しない
- 事業 KPI 改善アイデアは `content_improvement` に書く (ミュウが読む)
- 仮説サイクルに乗せたい場合は、ミュウが別途 `hypotheses` に promote する設計

## 🚫 混ぜる間違い

❌ **悪い**:
```
self_improvement: engagedSessions 51.6%→1.9% 崩壊の GA4 計測バグ調査
```
→ これは「事業の発見」。agent のコード修正ではない。`content_improvement` か、もっと適切には「レポートに engagement_rate トレンドグラフを追加」として書く。

✅ **良い**:
```
self_improvement:
- agent.md 冒頭に pre-flight check 追加: scripts/gsc-snapshot.py の存在確認
- compare_search_periods 呼び出しを必須ステップに昇格 (ルール追記)

content_improvement:
- Discord レポート冒頭に engagement_rate の 7 日別トレンドグラフ追加
- ストライキングディスタンスは最低 3 件出す運用に定着 (今回 1 件で不足感)
```

## result_full に何を入れるか (エージェント種別)

| 種別 | result_full の中身 |
|---|---|
| 記事生成 (ポッポ/コイル/キャタピー) | 生成した記事の本番 URL + タイトル + 主要構成要約 |
| SEO レポート (ケーシィ/ユンゲラー) | Discord 通知本文そのまま |
| 仮説/実験 (ゴース/ゲンガー) | 検証結果サマリー + 対象ページ URL |
| 許認可/ガイド (カイロス/ハッサム) | 生成ページ URL + slug + 主要変更点 |
| 被リンク (ロコン/ツボツボ) | 投稿先 URL + target URL + 投稿本文抜粋 |

## 実装テンプレート

```bash
REPORT_FILE=$(mktemp)
cat > "$REPORT_FILE" <<'EOF'
{{Discord or 外部アウトプット本文}}
EOF

bash scripts/notify-discord.sh "$(cat "$REPORT_FILE")"

sqlite3 .claude/db/agents.db "UPDATE reflections SET
  what_done = '- {{やったこと1}}
- {{やったこと2}}',
  quality_check = '- ✅ {{守れたルール}}
- ❌ {{守れなかったルール}}',
  self_improvement = '- {{agent.md のこの部分をこう直す}}
- {{このスクリプトを追加 / 修正}}',
  content_improvement = '- {{アウトプットにこの項目を足す}}
- {{このレポート形式をこう進化させる}}',
  quality_score = {{0-100}},
  result_full = readfile('$REPORT_FILE'),
  reflected_at = datetime('now','localtime')
WHERE id = $AGENT_RUN_ID"

rm -f "$REPORT_FILE"
```

## ダッシュボード連動

- `/logs?view=reflections` (= `/reflections`) の詳細モーダル:
  - 📣 **Discord 通知本文** (`result_full`)
  - 🔍 **エージェント自己振り返り**:
    - 📌 何をしたか (`what_done`)
    - ✅ ルール準拠チェック (`quality_check`)
    - 🔧 自律改善 (`self_improvement`) — ミューツー用
    - 💡 事業改善 (`content_improvement`) — ミュウ用

## 参考実装

`.claude/agents/_seo-metrics/abra-seo-report/agent.md` 「振り返りフェーズ」セクション。
