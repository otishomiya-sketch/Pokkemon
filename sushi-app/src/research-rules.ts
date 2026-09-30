/**
 * リサーチ対象のルール（どの種類のお店の情報を、握り・一品料理のどちらに使ってよいか）。
 * ヨルノズクのトレンド登録（loop.ts add-trends）はこのルールで検査する。
 */

export const SOURCE_KINDS = {
  sushi_shop: "寿司屋・鮨店（回転寿司・立ち食い・持ち帰りを含む）",
  sushi_account: "鮨関連の SNS アカウント（お店・職人・鮨専門の発信者）",
  japanese_restaurant: "日本料理店（割烹・料亭・懐石・和食店）",
  creative_washoku: "創作和食店",
} as const;

export type SourceKind = keyof typeof SOURCE_KINDS;

export const RESEARCH_RULES = {
  nigiri: { kinds: ["sushi_shop", "sushi_account"] as SourceKind[], origins: ["japan"] },
  dish: { kinds: ["sushi_shop", "sushi_account", "japanese_restaurant", "creative_washoku"] as SourceKind[], origins: ["japan", "overseas"] },
  // 握り・一品の両方に使える流行（both）は、両方のルールを満たすもの＝日本の寿司屋・鮨関連アカウントだけ
  both: { kinds: ["sushi_shop", "sushi_account"] as SourceKind[], origins: ["japan"] },
} as const;

/** ルール違反なら理由を返す。問題なければ空文字 */
export function checkResearchRule(category: string, sourceKind: unknown, origin: unknown): string {
  const rule = RESEARCH_RULES[category as keyof typeof RESEARCH_RULES];
  if (!rule) return "";
  if (typeof sourceKind !== "string" || !(sourceKind in SOURCE_KINDS)) {
    return `source_kind は ${Object.keys(SOURCE_KINDS).join(" / ")} のどれか`;
  }
  if (!(rule.kinds as string[]).includes(sourceKind)) {
    return `${category === "nigiri" ? "握り" : category === "both" ? "握り・一品の両方" : "一品料理"}には ${SOURCE_KINDS[sourceKind as SourceKind]} の情報は使えません`;
  }
  if (!(rule.origins as readonly string[]).includes(String(origin))) {
    return `${category === "dish" ? "一品料理" : "握り"}は日本のお店の情報だけです（海外は一品料理のみ）`;
  }
  return "";
}
