/**
 * Stripe とのやりとり（申し込み画面、契約の確認、プラン変更・解約画面、契約の検索）。
 * Webhook は使わず、アプリから問い合わせる（参考実装と同じ方式）。
 *
 * 本番のキーは制限付きキーにする。必要な権限:
 *   Checkout Sessions＝作成、Customer Portal＝作成、
 *   Subscriptions・Customers・Products・Prices・Tax Rates＝読み取り
 */
import { PLANS, type PlanId } from "./plans";

const API = process.env.STRIPE_API_BASE ?? "https://api.stripe.com"; // テストでは模擬サーバーに向ける

export class StripeError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
  }
}

/** Stripe のフォーム形式（a[b][c]=v）に変換 */
function encode(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...encode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<T> {
  const body = params ? encode(params).join("&") : undefined;
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? body : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!res.ok) throw new StripeError(data.error?.message ?? `Stripe ${res.status}`, data.error?.code, res.status);
  return data;
}

// ---- 価格 ID（設定に商品 ID を書いた場合は default_price を使う。1 時間キャッシュ） ----
const priceCache = new Map<string, { price: string; product: string; at: number }>();

async function resolvePrice(configured: string): Promise<{ price: string; product: string }> {
  if (configured.startsWith("price_")) return { price: configured, product: "" };
  const hit = priceCache.get(configured);
  if (hit && Date.now() - hit.at < 3600_000) return hit;
  const product = await stripe<{ id: string; default_price: string | { id: string } | null }>("GET", `/v1/products/${configured}`);
  const price = typeof product.default_price === "string" ? product.default_price : product.default_price?.id;
  if (!price) throw new StripeError(`商品 ${configured} に既定の価格がありません`);
  const entry = { price, product: product.id, at: Date.now() };
  priceCache.set(configured, entry);
  return entry;
}

/** Stripe の価格 ID・商品 ID からプランを判定する */
export function planFromStripe(priceId: string, productId: string): PlanId | null {
  for (const p of PLANS) {
    const configured = process.env[p.env] ?? "";
    if (configured && (configured === priceId || configured === productId)) return p.id;
    const cached = priceCache.get(configured);
    if (cached && (cached.price === priceId || cached.product === productId)) return p.id;
  }
  return null;
}

// ---- 申し込み ----
export async function createCheckout(plan: PlanId, code: string, appUrl: string): Promise<string> {
  const conf = PLANS.find((p) => p.id === plan)!;
  const { price } = await resolvePrice(process.env[conf.env]!);
  const back = `${appUrl}/?code=${encodeURIComponent(code)}`;
  const session = await stripe<{ url: string }>("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: { 0: { price, quantity: 1, tax_rates: { 0: process.env.STRIPE_TAX_RATE_ID } } },
    client_reference_id: code,
    metadata: { code },
    subscription_data: { metadata: { code } }, // 「反映されない方」の検索（metadata['code']）に使う
    locale: "ja",
    success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
  });
  return session.url;
}

/** 申し込みから戻ったとき: 自分のコードの完了した申し込みなら契約 ID を返す */
export async function confirmCheckout(sessionId: string, code: string): Promise<{ subscription: string; customer: string } | null> {
  const s = await stripe<{ client_reference_id: string | null; status: string; subscription: string | null; customer: string | null }>(
    "GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (s.client_reference_id !== code || s.status !== "complete" || !s.subscription || !s.customer) return null;
  return { subscription: s.subscription, customer: s.customer };
}

/** 「お支払い済みなのに反映されない方」: コードで契約を探す */
export async function findSubscriptionByCode(code: string): Promise<{ subscription: string; customer: string } | null> {
  const safe = code.replace(/[^A-Za-z0-9_-]/g, "");
  const r = await stripe<{ data: { id: string; customer: string; status: string }[] }>("GET", "/v1/subscriptions/search", {
    query: `metadata['code']:'${safe}'`,
    limit: 10,
  });
  const hit = r.data.find((s) => ["active", "trialing", "past_due"].includes(s.status));
  return hit ? { subscription: hit.id, customer: hit.customer } : null;
}

// ---- 契約の確認（1 分キャッシュ） ----
export type SubscriptionCheck = { state: "active"; plan: PlanId | null } | { state: "none" } | { state: "error" };
const subCache = new Map<string, { result: SubscriptionCheck; at: number }>();

export function forgetSubscription(id: string) {
  subCache.delete(id);
}

export async function checkSubscription(id: string): Promise<SubscriptionCheck> {
  const hit = subCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.result;
  let result: SubscriptionCheck;
  try {
    const s = await stripe<{ status: string; items: { data: { price: { id: string; product: string } }[] } }>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
    if (["active", "trialing", "past_due"].includes(s.status)) {
      const price = s.items?.data?.[0]?.price;
      // 商品 ID で設定している場合に備えて、価格を一度引いておく
      if (price && !planFromStripe(price.id, price.product)) {
        await Promise.all(PLANS.map((p) => resolvePrice(process.env[p.env] ?? "").catch(() => null)));
      }
      result = { state: "active", plan: price ? planFromStripe(price.id, price.product) : null };
    } else {
      result = { state: "none" };
    }
  } catch (e) {
    // サンドボックスの記録を本番のキーで見たときなど、契約が存在しない
    if (e instanceof StripeError && (e.code === "resource_missing" || e.status === 404)) result = { state: "none" };
    else result = { state: "error" };
  }
  if (result.state !== "error") subCache.set(id, { result, at: Date.now() });
  return result;
}

// ---- プラン変更・解約 ----
export async function createPortal(customer: string, code: string, appUrl: string): Promise<string> {
  const s = await stripe<{ url: string }>("POST", "/v1/billing_portal/sessions", {
    customer,
    return_url: `${appUrl}/?code=${encodeURIComponent(code)}&portal=1`,
  });
  return s.url;
}
