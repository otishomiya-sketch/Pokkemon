#!/usr/bin/env bun
/**
 * 初期データ投入
 *   bun sushi-app/scripts/seed.ts                    → デモ店舗 DEMO と見本トレンドを入れる
 *   bun sushi-app/scripts/seed.ts --shop CODE 店名    → 店舗を追加する
 *
 * 見本トレンド（source_type='sample'）は画面確認用の一般的な傾向。
 * リサーチ担当が本物のトレンドを入れ始めたら status='retired' にする。
 */
import { openDb } from "../src/db";

const db = openDb();
const args = process.argv.slice(2);

if (args[0] === "--shop") {
  const [, code, ...nameParts] = args;
  if (!code || nameParts.length === 0) {
    console.error("使い方: bun sushi-app/scripts/seed.ts --shop CODE 店名");
    process.exit(1);
  }
  db.query("INSERT INTO shops (code, name) VALUES (?, ?)").run(code, nameParts.join(" "));
  console.log(`店舗を追加しました: ${code} ${nameParts.join(" ")}`);
  process.exit(0);
}

db.query("INSERT OR IGNORE INTO shops (code, name) VALUES ('DEMO', 'デモ店')").run();

const hasSamples = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM trends WHERE source_type = 'sample'").get()!.c;
if (hasSamples > 0) {
  console.log("見本トレンドは投入済みです");
  process.exit(0);
}

const samples: [string, string, string, string[], string[], string][] = [
  ["nigiri", "熟成魚の握りに柑橘の皮を合わせる", "数日〜数週間寝かせた白身や赤身に、すだち・柚子などの皮を削って香りを立たせる握りが増えている。", ["鯛", "鰆", "柚子", "すだち"], ["熟成", "柑橘"], "autumn"],
  ["nigiri", "赤酢と米酢のシャリを魚で使い分ける", "光り物や赤身には赤酢、白身や貝には米酢と、ネタに合わせてシャリを替える店が話題になっている。", ["赤酢", "米酢", "鯖", "鮪"], ["シャリの使い分け"], "all"],
  ["nigiri", "炙りに焦がし醤油や藁の香りを移す", "皮目を強く炙り、焦がし醤油や藁焼きの香りをまとわせた握りがSNSでよく見られる。", ["鰹", "金目鯛", "のどぐろ"], ["炙り", "藁焼き"], "autumn"],
  ["nigiri", "煮切りの代わりに塩と香り油で仕上げる", "醤油を使わず、藻塩とオリーブオイルや胡麻油を一滴たらして仕上げる軽やかな握りが人気。", ["平目", "帆立", "藻塩"], ["香り油"], "all"],
  ["nigiri", "秋の戻り鰹を薬味ののせ物で変化させる", "脂ののった戻り鰹に、みょうが・新生姜・芽ねぎなど薬味を重ねて食感の変化をつける。", ["鰹", "みょうが", "生姜"], ["薬味"], "autumn"],
  ["nigiri", "いくらを出汁醤油で浅く漬ける", "漬け時間を短くして粒の張りを残し、出汁の香りを軸にしたいくらの軍艦・小丼が増えている。", ["いくら", "出汁"], ["漬け"], "autumn"],
  ["dish", "つまみを小さなコースのように出す", "握りの前に、少量のつまみを3〜5品テンポよく出す構成がSNSで評判を集めている。", ["白身魚", "貝"], ["コース構成"], "all"],
  ["dish", "魚の皮や骨を使った揚げ物・出汁料理", "皮せんべいや骨せんべい、アラの出汁を使った茶碗蒸しなど、端材を活かす一品が注目されている。", ["鯛", "鮭", "アラ"], ["揚げ", "出汁"], "all"],
  ["dish", "茶碗蒸しに季節のあんを重ねる", "蟹あん・きのこあんなど、季節の素材をあんにして茶碗蒸しに重ねる一品が定番化している。", ["蟹", "きのこ", "卵"], ["あん"], "autumn"],
  ["dish", "白子や肝を焼きやポン酢で出す", "冬に向けて白子・あん肝を焼いたり、自家製ポン酢で出したりするつまみが増えている。", ["白子", "あん肝", "ポン酢"], ["焼き"], "winter"],
  ["dish", "魚を洋の技法で仕立てるつまみ", "カルパッチョ風、昆布締めのタルタルなど、洋の技法を取り入れた一品が若い客層に好まれている。", ["鮪", "鯛", "オリーブオイル"], ["昆布締め", "洋の技法"], "all"],
  ["both", "季節の果物を酢の物や握りに添える", "柿・梨・ぶどうなど旬の果物を、酢の物や握りの添えに使って甘みと酸味を加える流れがある。", ["柿", "梨", "ぶどう"], ["果物あわせ"], "autumn"],
];

const insert = db.query(
  `INSERT INTO trends (category, title, summary, ingredients, techniques, season, source_type, collected_by)
   VALUES (?, ?, ?, ?, ?, ?, 'sample', 'seed')`,
);
for (const [category, title, summary, ingredients, techniques, season] of samples) {
  insert.run(category, title, summary, JSON.stringify(ingredients), JSON.stringify(techniques), season);
}
console.log(`デモ店舗 DEMO と見本トレンド ${samples.length} 件を投入しました`);
