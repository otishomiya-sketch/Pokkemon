# Guidance Protocol（実行部隊共通）

実行エージェントが起動時に読み込む**今日の戦略ブリーフ**の取得プロトコル。
毎日 2:00 にメガゲンガー → ゲンガー(gengar-selector) が `kind='guidance'` を発行する。

## 起動直後に必ず実行（1クエリ）

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
        WHERE json_each.value = '{自分のエージェント名}'
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

`{自分のエージェント名}` は自分の `name:` (例: `pidgeot-editorial`) で置換。

## 結果の扱い

| ケース | アクション |
|---|---|
| 該当 guidance あり | **body の指示に従って優先的に作業する**（対象URL、方針、対応experiment_idを activitylog に記録） |
| 該当 guidance なし | 従来通り自己判断で作業（止まらない） |

## 仮説・実験の書込禁止

- `kind='hypothesis'` の直接 INSERT は DB トリガーで **ブロック**されます（`haunter-hypothesizer` 専権）
- 実行エージェントが「この施策を試したい」と考えた場合は、以下のいずれか:
  - `kind='decision'`: 「今回この案件を選んだ」という運用判断の記録（低ノイズ、仮説ではない）
  - Discord に報告 → ゴーストに取り込んでもらう（次回 2:00 のパイプラインで仮説化）

## 絶対ルール

- **起動時に1回読むだけ**: GA/GSC API を叩かない（それはゴース/ゴーストの仕事）
- **guidance は 24時間で失効**: `active_until` を尊重する
- **guidance に従ったことを後で分かるように**: agent_runs の notes や activitylog に `guidance_id: {id}` を残す
- **guidance が自分と関係ない場合はスキップ**: 無理に従わない
