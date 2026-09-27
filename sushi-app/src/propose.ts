import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { Category, FeedbackSignal, Guideline, TrendRow } from "./db";

export const MODEL = "claude-opus-5";

const Dish = z.object({
  name: z.string().describe("メニュー名"),
  concept: z.string().describe("一言コンセプト（40字程度）"),
  trend_basis: z.string().describe("どのトレンドをどう踏まえたか"),
  trend_ids: z.array(z.number()).describe("参考にしたトレンドの id"),
  ingredients: z.array(z.object({ item: z.string(), amount: z.string() })).describe("材料と分量（1貫または1皿あたり）"),
  steps: z.array(z.string()).describe("仕込みから提供までの手順"),
  shokunin_points: z.array(z.string()).describe("職人向けの勘所（包丁・塩・酢・温度・熟成など）"),
  plating: z.string().describe("盛り付け・器"),
  pairing: z.string().describe("合わせる酒・飲み物"),
  cost_note: z.string().describe("原価・価格帯の目安"),
});

export const ProposalResult = z.object({ proposals: z.array(Dish) });
export type ProposalResult = z.infer<typeof ProposalResult>;

export interface ProposeInput {
  ingredients: string[];
  category: Category;
  notes: string;
  trends: TrendRow[];
  signals: FeedbackSignal[];
  knowledge: { subject: string; body: string }[];
  guidelines: Guideline[];
  patterns: { kind: string; title: string; action: string }[];
}

const CATEGORY_LABEL: Record<Category, string> = { nigiri: "握り", dish: "一品料理" };

const SYSTEM = `あなたは日本の寿司店のメニュー開発を支える料理顧問です。
職人が手元の素材を入力するので、その店で今日から出せる新メニューを3品提案してください。

- 提案は職人がそのまま仕込みに使えるレシピにする。分量・塩や酢の加減・温度・寝かせ時間など、手を動かすのに必要な情報を具体的に書く。
- 入力された素材を主役にする。一般的な寿司店にある調味料や薬味は自由に足してよい。
- 3品は方向性を変える（王道寄り・季節感・意外性など）。
- 「最近のトレンド」は発想の参考にする。特定の店のメニューを再現したり店名を出したりせず、傾向を踏まえたオリジナルの提案にする。参考にしたトレンドは trend_ids に id を入れる。
- 「職人の評価」は他店での反応。好評の方向は活かし、不評の方向は避ける。
- 「今週の提案方針」があれば、3品のうち少なくとも1品はその方針に沿わせる。
- 「検証済みの傾向」の勝ちパターンは積極的に使い、負けパターンは避ける。
- 食品衛生上の注意（寄生虫・加熱の要否など）が関わる素材は shokunin_points に必ず書く。`;

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

  return `## 依頼
種類：${CATEGORY_LABEL[input.category]}
素材：${input.ingredients.join("、")}
要望：${input.notes || "特になし"}

## 最近のトレンド
${trends}

## 今週の提案方針
${guidelines}

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
  const client = new Anthropic();
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
  const make = (name: string, concept: string, extra: string) => ({
    name,
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
      make(`${main}の${sub}締め${isNigiri ? "握り" : ""}`, "王道の締めに香りを重ねる一品", "煎り胡麻"),
      make(`炙り${main}と${sub}おろし`, "炙りの香ばしさと季節の香り", "おろし大根"),
      make(`${main}の昆布〆 ${sub}ジュレ`, "食感で驚かせる新しい一手", "ジュレ"),
    ],
  };
}
