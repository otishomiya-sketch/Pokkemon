/**
 * イメージ画像の生成プロンプトを組み立てる。
 * 料理写真のリアルさを守る補助プロンプト（src/prompts/food-photorealism.json）を、
 * 料理に含まれる食材に応じて必要な節だけ差し込む。JSON を差し替えれば内容を更新できる。
 */
import guard from "./prompts/food-photorealism.json";

export interface ImageDish {
  name: string;
  concept?: string;
  plating?: string;
  cooking_method?: string;
  ingredients?: { item: string; amount: string }[];
}

type RuleBlock = { require?: string[]; avoid?: string[]; rules?: string[]; include?: string[]; exclude?: string[] };

const list = (items: string[] | undefined) => (items ?? []).map((x) => `- ${x}`).join("\n");

function block(title: string, b: RuleBlock): string {
  const parts = [`### ${title}`];
  if (b.require?.length) parts.push(`守ること:\n${list(b.require)}`);
  if (b.rules?.length) parts.push(`守ること:\n${list(b.rules)}`);
  if (b.include?.length) parts.push(`入れること:\n${list(b.include)}`);
  if (b.avoid?.length) parts.push(`避けること:\n${list(b.avoid)}`);
  if (b.exclude?.length) parts.push(`避けること:\n${list(b.exclude)}`);
  return parts.join("\n");
}

/** 料理の文章に含まれる語から、差し込む節を決める */
function detect(text: string) {
  const has = (re: RegExp) => re.test(text);
  return {
    rice: has(/握り|シャリ|寿司飯|酢飯|ご飯|飯|丼|巻き|押し寿司|手毬|茶漬け|雑炊|おこげ/),
    // JSON の唐揚げの節は鶏もも肉が前提なので、鶏の唐揚げのときだけ使う（魚の唐揚げは「揚げ物」の節で扱う）
    karaage: has(/唐揚げ|から揚げ|竜田揚げ/) && has(/鶏|チキン|もも肉/),
    fried: has(/揚げ|天ぷら|天麩羅|フライ|フリット|カツ|衣/),
    egg: has(/卵|玉子|黄身|卵黄|卵白|たまご/),
    meat: has(/牛|豚|鶏|鴨|肉|ベーコン|生ハム/),
    noodles: has(/麺|蕎麦|そば|うどん|素麺|そうめん|パスタ/),
    vegetables: has(/野菜|葉|大根|蕪|かぶ|茄子|なす|葱|ねぎ|芽|筍|たけのこ|茸|きのこ|舞茸|椎茸|松茸|菜|芋|南瓜|人参|胡瓜|大葉|紫蘇/),
    sauce: has(/椀|汁|あん|餡|ソース|出汁|だし|ジュレ|タレ|たれ|酢|煮|浸し|吸い地|醤/),
    cheese: has(/チーズ/),
    bread: has(/パン|トースト|ブリオッシュ/),
  };
}

export function buildImagePrompt(dish: ImageDish, category: string): string {
  const items = (dish.ingredients ?? []).map((i) => i.item).slice(0, 10).join("、");
  const kind = category === "nigiri" ? "握り寿司" : "寿司店の一品料理";
  const dishDescription = [
    `日本の寿司店のカウンターで出す${kind}「${dish.name}」`,
    dish.concept ? `ねらいは${dish.concept}` : "",
    dish.cooking_method ? `主な調理法は${dish.cooking_method}` : "",
    items ? `主な材料は${items}` : "",
    dish.plating ? `盛り付けは${dish.plating}` : "",
  ].filter(Boolean).join("。");

  const text = [dish.name, dish.concept, dish.plating, dish.cooking_method, items, category === "nigiri" ? "握り" : ""].join(" ");
  const d = detect(text);
  const g = guard.global_food_rules;
  const other = guard.other_high_risk_foods;
  const sections: string[] = [];

  // 寿司店の料理なので魚の節は常に入れる
  sections.push(block("魚", other.fish));

  if (d.rice) {
    const r = guard.white_rice;
    sections.push(
      [
        "### ご飯（米粒）",
        `守ること:\n${list(r.grain_structure.require)}`,
        `形: ${r.grain_structure.shape.preferred}（避ける形: ${r.grain_structure.shape.avoid.join("、")}）`,
        `色: ${r.surface.color}`,
        `つや: ${r.surface.gloss}`,
        `水分: ${r.surface.moisture}`,
        `半透明感: ${r.surface.translucency}`,
        `まとまり: ${r.clumping.correct}（誤り: ${r.clumping.incorrect.join("、")}）`,
        category === "nigiri"
          ? "握り寿司のシャリ: 酢飯を俵形に軽く握ったもの。表面に米粒の輪郭が残り、ネタとシャリの境目が自然に接している。茶碗に盛った形や、固めた塊にしない。"
          : `盛り付け: ${r.serving.top_shape} ${r.serving.density}`,
      ].join("\n"),
    );
  }
  if (d.karaage) {
    const k = guard.karaage;
    sections.push(
      [
        "### 唐揚げ",
        `形:\n${list(k.piece_geometry.require)}\n避ける形: ${k.piece_geometry.avoid.join("、")}`,
        `衣（${k.coating.type}）:\n${list(k.coating.correct_texture)}\n避ける衣: ${k.coating.avoid.join("、")}`,
        `色: ${k.color.base}。${k.color.variation}`,
        `油: ${k.oil_behavior.correct.join("、")}（避ける: ${k.oil_behavior.avoid.join("、")}）`,
      ].join("\n"),
    );
  } else if (d.fried) {
    sections.push(block("揚げ物", other.fried_food_general));
  }
  if (d.egg) sections.push(block("卵", other.egg));
  if (d.meat) sections.push(block("肉", other.meat));
  if (d.noodles) sections.push(block("麺", other.noodles));
  if (d.vegetables) sections.push(block("野菜", other.vegetables));
  if (d.sauce) sections.push(block("汁・あん・ソース", other.soup_and_sauce));
  if (d.cheese) sections.push(block("チーズ", other.cheese));
  if (d.bread) sections.push(block("パン", other.bread));

  const separation = guard.food_separation_rules.instructions.filter(
    (x) => d.karaage || !/唐揚げ|キャベツ|レモン/.test(x),
  );

  const negatives = [...guard.negative_prompt_global, ...guard.master_prompt_template.negative_prompt.split(/,\s*/)]
    .filter((x) => (d.karaage || !/karaage|chicken|nugget|breadcrumb/i.test(x)) && (d.rice || !/rice/i.test(x)));
  const uniqueNegatives = [...new Set(negatives.map((x) => x.trim()).filter(Boolean))];

  // master_prompt_template の positive_prompt から、白米・唐揚げに固有の文は該当するときだけ残す
  const positive = guard.master_prompt_template.positive_prompt
    .replace("{dish_description}", dishDescription)
    .split("。")
    .filter((s) => (d.rice || !s.startsWith("白米がある場合")) && (d.karaage || !s.startsWith("唐揚げがある場合")))
    .join("。");

  return `${positive}

## 大切にする順番
${guard.core_principle.priority_order.map((x, i) => `${i + 1}. ${x}`).join("\n")}
${guard.core_principle.important_rule}
目指す写真: ${guard.core_principle.realism_definition}

## すべての食材に共通の決まり
${block("形と配置", g.geometry)}
${block("表面（水分・油分・つや）", g.surface_physics)}
${block("色", g.color)}
${block(`自然な不揃い（${g.natural_variation.rule}）`, g.natural_variation)}

## この料理に含まれる食材の決まり
${sections.join("\n\n")}

## 料理どうしの分け方
${list(separation)}

## 光
${guard.lighting.default}。${guard.lighting.direction}。補助光は${guard.lighting.fill}。
避ける光: ${guard.lighting.avoid.join(", ")}

## カメラ
${guard.camera_and_rendering.style}、${guard.camera_and_rendering.preferred}（${guard.camera_and_rendering.lens}）、${guard.camera_and_rendering.aperture}。
${guard.camera_and_rendering.depth_of_field}。ピントは${guard.camera_and_rendering.focus}。
ホワイトバランス ${guard.camera_and_rendering.white_balance}、露出 ${guard.camera_and_rendering.exposure}。${guard.camera_and_rendering.rendering_rules.join(", ")}。
背景は白木のカウンターや寿司店らしい落ち着いた器まわりにする。

## 描き終える前の確認
${guard.validation_before_output.checks.filter((c) => (d.rice || !/白米/.test(c.check)) && (d.karaage || !/唐揚げ/.test(c.check))).map((c) => `- ${c.check}`).join("\n")}

## 描かないもの
文字、ロゴ、人物、手。
${uniqueNegatives.join(", ")}`;
}
