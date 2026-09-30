/**
 * 料金プランと、有料化の設定（環境変数）。
 * 利用単位は「素材」: 1 素材 = 提案 1 回（3 品）。その 3 品のイメージ画像は追加の消費なし。
 */

export const CREDIT_UNIT = "素材";
export const TAX_RATE = 0.1; // 消費税 10%（外税）

export const PLANS = [
  { id: "light", name: "ライト", monthly: 10, price: 19800, env: "STRIPE_PRICE_LIGHT" },
  { id: "standard", name: "スタンダード", monthly: 20, price: 29800, env: "STRIPE_PRICE_STANDARD" },
  { id: "pro", name: "プロ", monthly: 30, price: 39800, env: "STRIPE_PRICE_PRO" },
] as const;

export type PlanId = (typeof PLANS)[number]["id"];

export function planById(id: string | null | undefined) {
  return PLANS.find((p) => p.id === id) ?? null;
}

export const withTax = (price: number) => Math.round(price * (1 + TAX_RATE));

/** Stripe の設定がすべて揃っているときだけ有料プランを出す（段階的に公開できるように） */
export function billingEnabled(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_TAX_RATE_ID &&
      PLANS.every((p) => process.env[p.env]),
  );
}

/** 画面に出す料金表・問い合わせ先 */
export function publicBillingInfo() {
  return {
    enabled: billingEnabled(),
    unit: CREDIT_UNIT,
    plans: PLANS.map((p) => ({ id: p.id, name: p.name, monthly: p.monthly, dishes: p.monthly * 3, price: p.price, price_with_tax: withTax(p.price) })),
    terms_url: process.env.TERMS_URL || null,
    contact: process.env.CONTACT_TEXT || null,
  };
}
