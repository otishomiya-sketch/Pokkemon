import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { Category, FeedbackSignal, Guideline, TrendRow } from "./db";
import { bandLabel } from "./shop-profile";

export const MODEL = "claude-opus-5";

export const COOKING_METHODS = [
  "生・造り", "締め・漬け・熟成", "焼き・炙り", "蒸し", "揚げ", "煮る・炊く", "椀・汁", "和え・酢の物", "寿司飯を使う（小丼・巻き・押し）",
] as const;

export const DISH_ROLES = ["方針の品", "素材の品", "挑戦の品"] as const;

const Dish = z.object({
  role: z.enum(DISH_ROLES).describe("3品の役割。1品目=方針の品、2品目=素材の品、3品目=挑戦の品"),
  name: z.string().describe("メニュー名"),
  cooking_method: z.enum(COOKING_METHODS).describe("主な調理法（3品で重ねない）"),
  flavor_base: z.string().describe("味の軸を一言で（例: 柑橘と塩、白味噌、煎り酒、酒盗、出汁）。3品で重ねない"),
  concept: z.string().describe("一言コンセプト（40字程度）"),
  trend_basis: z.string().describe("発想の元。流行を使った品はどう活かしたか、使わなかった品は素材や季節からどう組み立てたか"),
  trend_ids: z.array(z.number()).describe("参考にしたトレンドの id（使わなかった品は空）"),
  ingredients: z.array(z.object({ item: z.string(), amount: z.string() })).describe("材料と分量（1貫または1皿あたり）"),
  steps: z.array(z.string()).describe("仕込みから提供までの手順"),
  shokunin_points: z.array(z.string()).describe("職人向けの勘所（包丁・塩・酢・温度・熟成など）"),
  plating: z.string().describe("盛り付け・器"),
  pairing: z.string().describe("合わせる酒・飲み物"),
  cost_note: z.string().describe("原価・価格帯の目安"),
});

export const ProposalResult = z.object({ proposals: z.array(Dish) });
export type ProposalResult = z.infer<typeof ProposalResult>;

export interface ShopContext {
  concept: string | null;
  features: string[];
  price_per_guest: number | null;
  price_band: string | null;
}

export interface ProposeInput {
  shop: ShopContext;
  ingredients: string[];
  category: Category;
  notes: string;
  trends: TrendRow[];
  signals: FeedbackSignal[];
  knowledge: { subject: string; body: string }[];
  guidelines: Guideline[];
  patterns: { kind: string; title: string; action: string }[];
  /** このお店に最近出した品（同じ種類）。似た品の繰り返しを避けるために使う */
  recentDishes: string[];
}

const CATEGORY_LABEL: Record<Category, string> = { nigiri: "握り", dish: "一品料理" };

const SYSTEM = `あなたは日本の寿司店のメニュー開発を支える料理顧問です。
職人が手元の素材を入力するので、その店で今日から出せる新メニューを3品提案してください。

- 提案は職人がそのまま仕込みに使えるレシピにする。分量・塩や酢の加減・温度・寝かせ時間など、手を動かすのに必要な情報を具体的に書く。
- 入力された素材を主役にする。一般的な寿司店にある調味料や薬味は自由に足してよい。
- 「お店の情報」のコンセプト・特徴・客単価に合わせる。とくに客単価に見合った素材の格・手間・原価・提供価格にする（客単価 3,000 円の店に 1 貫 2,000 円の品を出さない、客単価 30,000 円の店に手間の少ない大衆的な品ばかり出さない）。cost_note には、その客単価のお店での値付けの目安を書く。

## 3品の組み立て（偏りを防ぐための決まり）
3品はそれぞれ役割が違う。順番もこのとおりにする。
1. 方針の品：「今週の提案方針」があればそれに沿う。無ければ「最近のトレンド」を1つ活かす。
2. 素材の品：流行には頼らず、素材の持ち味・旬・お店のコンセプトから組み立てる。trend_ids は空にする。
3. 挑戦の品：ほかの2品とは違う発想の一品。意外な組み合わせや、そのお店では珍しい技法に挑む。ただしお店のコンセプトから外れすぎない（江戸前・和の店なら、海外の食材や調味料は 1 つまでにし、寿司店のカウンターで違和感なく出せる形にする）。

- 3品の cooking_method（調理法）はすべて違うものにする。
- 3品の flavor_base（味の軸）も重ねない。酒盗・味噌・柑橘など、同じ調味料を2品以上の主役にしない。
- 同じトレンドを2品以上で使わない。トレンドを使うのは多くても2品まで。
- 「このお店に最近出した品」と同じ料理や、調理法と味の軸が同じよく似た料理は出さない。素材が違っても、同じ型（例:「○○の酒盗炙り」「○○のアラ出汁茶碗蒸し」「○○の部位串」）の繰り返しは避ける。

## そのほか
- 「最近のトレンド」は発想の参考にする。特定の店のメニューを再現したり店名を出したりせず、傾向を踏まえたオリジナルの提案にする。参考にしたトレンドは trend_ids に id を入れる。trend_basis は職人が読む文なので、id や「今週の方針」といった内部の言葉は書かない。
- 「職人の評価」は他店での反応。好評の方向は活かし、不評の方向は避ける。
- 「検証済みの傾向」の勝ちパターンは積極的に使い、負けパターンは避ける。
- 食品衛生上の注意（寄生虫・加熱の要否など）が関わる素材は shokunin_points に必ず書く。アニサキスなどの寄生虫は、目視確認だけでは防げないので「-20℃で24時間以上の冷凍」または「十分な加熱」を対策として書き、目視は補助として扱う。`;

function buildUserPrompt(input: ProposeInput): string {
  const trends = input.trends.length
    ? input.trends
        .map((t) => `- [id:${t.id}] ${t.title}：${t.summary}（素材: ${JSON.parse(t.ingredients).join("、")} / 技法: ${JSON.parse(t.techniques).join("、")}）`)
        .join("\n")
    : "（まだありません）";
  const ratingLabel: Record<string, string> = { adopted: "採用", tried: "試作した", not_fit: "合わなかった" };
  const signals = input.signals.length
    ? input.signals.map((s) => `- ${ratingLabel[s.rating] ?? s.rating}：${s.name}（${s.concept}）`).join("\n")
    : "（まだありません）";
  const guidelines = input.guidelines.length
    ? input.guidelines.map((g) => `- ${g.title}：${g.action}`).join("\n")
    : "（なし）";
  const patterns = input.patterns.length
    ? input.patterns.map((p) => `- ${p.kind === "playbook" ? "勝ち" : "負け"}：${p.title}（${p.action}）`).join("\n")
    : "（まだありません）";
  const knowledge = input.knowledge.length
    ? input.knowledge.map((k) => `- ${k.subject}：${k.body}`).join("\n")
    : "（まだありません）";

  const recent = input.recentDishes.length ? input.recentDishes.map((d) => `- ${d}`).join("\n") : "（まだありません）";

  const shop = input.shop;
  const shopInfo = [
    `コンセプト：${shop.concept || "未登録"}`,
    `特徴：${shop.features.length ? shop.features.join("、") : "未登録"}`,
    `客単価：${shop.price_per_guest ? `${shop.price_per_guest.toLocaleString("ja-JP")}円（${bandLabel(shop.price_band)}）` : "未登録"}`,
  ].join("\n");

  return `## お店の情報
${shopInfo}

## 依頼
種類：${CATEGORY_LABEL[input.category]}
素材：${input.ingredients.join("、")}
要望：${input.notes || "特になし"}

## 最近のトレンド
${trends}

## 今週の提案方針（1品目だけに使う）
${guidelines}

## このお店に最近出した品（似た品は避ける）
${recent}

## 検証済みの傾向
${patterns}

## 職人の評価（他店での反応）
${signals}

## 素材の知識
${knowledge}`;
}

export function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export class ProposalError extends Error {}

export async function proposeLive(input: ProposeInput): Promise<ProposalResult> {
  // 組織単位の API キーは、どのワークスペースで使うかをヘッダーで指定する必要がある
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
  let response;
  try {
    response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(ProposalResult) },
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) console.error(`[propose] API error ${error.status}: ${error.message}`);
    if (error instanceof Anthropic.AuthenticationError) throw new ProposalError("APIキーが正しくありません");
    if (error instanceof Anthropic.RateLimitError) throw new ProposalError("混み合っています。少し待ってからもう一度お試しください");
    if (error instanceof Anthropic.APIError) throw new ProposalError(`AIの呼び出しに失敗しました（${error.status}）`);
    throw error;
  }
  if (response.stop_reason === "refusal") throw new ProposalError("この内容では提案を作れませんでした。素材や要望を変えてお試しください");
  if (response.stop_reason === "max_tokens") throw new ProposalError("提案が長くなりすぎました。もう一度お試しください");
  if (!response.parsed_output) throw new ProposalError("提案の形式が崩れていました。もう一度お試しください");
  return response.parsed_output;
}

/** APIキー未設定時の画面確認用。AIは呼ばず、入力素材を差し込んだ固定の見本を返す */
export function proposeDemo(input: ProposeInput): ProposalResult {
  const main = input.ingredients[0] ?? "旬の魚";
  const sub = input.ingredients[1] ?? "柑橘";
  const trendIds = input.trends.slice(0, 2).map((t) => t.id);
  const isNigiri = input.category === "nigiri";
  const make = (
    role: (typeof DISH_ROLES)[number], cooking_method: (typeof COOKING_METHODS)[number], flavor_base: string,
    name: string, concept: string, extra: string,
  ) => ({
    role,
    name,
    cooking_method,
    flavor_base,
    concept,
    trend_basis: "【デモ表示】APIキーを設定すると、実際のトレンドを踏まえた説明がここに入ります。",
    trend_ids: trendIds,
    ingredients: [
      { item: main, amount: isNigiri ? "12g（1貫）" : "60g" },
      { item: sub, amount: "少々" },
      { item: isNigiri ? "赤酢のシャリ" : "土佐酢", amount: isNigiri ? "14g" : "大さじ1" },
      { item: extra, amount: "適量" },
    ],
    steps: [
      `${main}を下処理し、振り塩をして15分おく`,
      "水気を拭き、身の状態を見て切りつける",
      isNigiri ? `シャリを人肌に保ち、${extra}をのせて握る` : `${sub}と${extra}で和え、器に盛る`,
    ],
    shokunin_points: ["【デモ表示】ここに包丁・塩・温度などの勘所が入ります"],
    plating: isNigiri ? "黒い長皿に1貫ずつ" : "小鉢に高く盛る",
    pairing: "辛口の純米酒",
    cost_note: "【デモ表示】原価の目安が入ります",
  });
  return {
    proposals: [
      make("方針の品", "締め・漬け・熟成", "柑橘と塩", `${main}の${sub}締め${isNigiri ? "握り" : ""}`, "王道の締めに香りを重ねる一品", "煎り胡麻"),
      make("素材の品", "焼き・炙り", "醤油と大根", `炙り${main}と${sub}おろし`, "炙りの香ばしさと季節の香り", "おろし大根"),
      make("挑戦の品", "和え・酢の物", "昆布出汁のジュレ", `${main}の昆布〆 ${sub}ジュレ`, "食感で驚かせる新しい一手", "ジュレ"),
    ],
  };
}
