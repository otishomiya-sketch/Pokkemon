#!/usr/bin/env bun
/**
 * テスト用の模擬 Stripe（本物の API を使わずに有料化の流れを確かめる）。
 *   PORT=12111 bun sushi-app/scripts/stripe-mock.ts
 * アプリ側は STRIPE_API_BASE=http://127.0.0.1:12111 で起動する。
 *
 * テスト操作用:
 *   POST /__complete/<checkout_session_id>        申し込みを完了させる（契約を作る）
 *   POST /__subscription/<sub_id>?status=canceled 契約の状態を変える（?price=… でプラン変更）
 *   GET  /__state                                 中身を見る
 */
const PORT = Number(process.env.PORT ?? 12111);
let seq = 0;
const next = (p: string) => `${p}_test_${++seq}`;

type Session = { id: string; url: string; client_reference_id: string | null; metadata: Record<string, string>; status: string; subscription: string | null; customer: string | null; price: string; sub_metadata: Record<string, string> };
type Sub = { id: string; customer: string; status: string; metadata: Record<string, string>; price: string };
const sessions = new Map<string, Session>();
const subs = new Map<string, Sub>();

/** a[b][c]=v 形式を平らな Map にする */
function parseForm(text: string): Map<string, string> {
  return new Map([...new URLSearchParams(text)].map(([k, v]) => [k, v]));
}
const productOf = (price: string) => price.replace(/^price_/, "prod_");
const subJson = (s: Sub) => ({ id: s.id, object: "subscription", customer: s.customer, status: s.status, metadata: s.metadata, items: { data: [{ price: { id: s.price, product: productOf(s.price) } }] } });
const missing = (what: string) => Response.json({ error: { code: "resource_missing", message: `No such ${what}` } }, { status: 404 });

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith("/__") && !(req.headers.get("authorization") ?? "").startsWith("Bearer ")) {
      return Response.json({ error: { message: "No API key" } }, { status: 401 });
    }
    const form = req.method === "POST" ? parseForm(await req.text()) : new Map<string, string>();

    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/products\/([^/]+)$/.exec(path))) return Response.json({ id: m[1], default_price: m[1]!.replace(/^prod_/, "price_") });

    if (path === "/v1/checkout/sessions" && req.method === "POST") {
      const id = next("cs");
      const s: Session = {
        id, url: `https://checkout.stripe.com/c/pay/${id}`, client_reference_id: form.get("client_reference_id") ?? null,
        metadata: { code: form.get("metadata[code]") ?? "" }, status: "open", subscription: null, customer: null,
        price: form.get("line_items[0][price]") ?? "", sub_metadata: { code: form.get("subscription_data[metadata][code]") ?? "" },
      };
      if (!form.get("line_items[0][tax_rates][0]")) return Response.json({ error: { message: "tax rate missing" } }, { status: 400 });
      sessions.set(id, s);
      return Response.json(s);
    }
    if ((m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path))) {
      const s = sessions.get(m[1]!);
      return s ? Response.json(s) : missing("checkout session");
    }
    if (path === "/v1/subscriptions/search") {
      const code = /metadata\['code'\]:'([^']*)'/.exec(url.searchParams.get("query") ?? "")?.[1];
      return Response.json({ data: [...subs.values()].filter((s) => s.metadata.code === code).map(subJson) });
    }
    if ((m = /^\/v1\/subscriptions\/([^/]+)$/.exec(path))) {
      const s = subs.get(m[1]!);
      return s ? Response.json(subJson(s)) : missing("subscription");
    }
    if (path === "/v1/billing_portal/sessions" && req.method === "POST") {
      return Response.json({ url: `https://billing.stripe.com/p/session/${next("bps")}`, return_url: form.get("return_url") });
    }

    // ---- テスト操作 ----
    if ((m = /^\/__complete\/([^/]+)$/.exec(path))) {
      const s = sessions.get(m[1]!);
      if (!s) return missing("checkout session");
      const sub: Sub = { id: next("sub"), customer: next("cus"), status: "active", metadata: s.sub_metadata, price: s.price };
      subs.set(sub.id, sub);
      Object.assign(s, { status: "complete", subscription: sub.id, customer: sub.customer });
      return Response.json(s);
    }
    if ((m = /^\/__subscription\/([^/]+)$/.exec(path))) {
      const s = subs.get(m[1]!);
      if (!s) return missing("subscription");
      if (url.searchParams.get("status")) s.status = url.searchParams.get("status")!;
      if (url.searchParams.get("price")) s.price = url.searchParams.get("price")!;
      return Response.json(subJson(s));
    }
    if (path === "/__state") return Response.json({ sessions: [...sessions.values()], subscriptions: [...subs.values()] });
    return Response.json({ error: { message: `mock: ${req.method} ${path} not implemented` } }, { status: 404 });
  },
});
console.log(`[stripe-mock] http://127.0.0.1:${PORT}`);
