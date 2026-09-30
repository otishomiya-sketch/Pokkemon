/**
 * 管理画面の API（/admin）。環境変数 ADMIN_PASSWORD があるときだけ使える。
 * ログインすると署名付きの Cookie（12 時間・HttpOnly）を渡し、以降はそれで確認する。
 */
import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "crypto";
import { creditsFor, loadBillingShop, billingSetting, demoTotalUsed, currentMonth } from "./credits";
import { planById, PLANS } from "./plans";
import { runLoop, LoopError } from "./loop-core";

const COOKIE = "sushi_admin";
const SESSION_MS = 12 * 3600_000;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const fail = (message: string, status = 400) => json({ error: message }, status);

export const adminEnabled = () => Boolean(process.env.ADMIN_PASSWORD);

function sign(value: string): string {
  return createHmac("sha256", `sushi-admin:${process.env.ADMIN_PASSWORD}`).update(value).digest("base64url");
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isAdmin(req: Request): boolean {
  if (!adminEnabled()) return false;
  const cookie = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const [expires, sig] = decodeURIComponent(cookie.slice(COOKIE.length + 1)).split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  return sameText(sig, sign(expires));
}

// ログインの失敗が続いたら止める（接続元ごとに 10 分で 5 回まで）
const failures = new Map<string, { n: number; until: number }>();

export async function handleAdminLogin(req: Request): Promise<Response> {
  if (!adminEnabled()) return fail("Not found", 404);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "local";
  const f = failures.get(ip);
  if (f && f.n >= 5 && f.until > Date.now()) return fail("ログインの失敗が続いたため、10分ほどしてからお試しください", 429);
  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  if (!body?.password || !sameText(body.password, process.env.ADMIN_PASSWORD!)) {
    const n = f && f.until > Date.now() ? f.n + 1 : 1;
    failures.set(ip, { n, until: Date.now() + 10 * 60_000 });
    return fail("パスワードが違います", 401);
  }
  failures.delete(ip);
  const expires = String(Date.now() + SESSION_MS);
  const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return json({ ok: true }, 200, {
    "set-cookie": `${COOKIE}=${encodeURIComponent(`${expires}.${sign(expires)}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`,
  });
}

export function handleAdminLogout(): Response {
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
}

/** 一覧と全体の数字。有料プランは最後に確認できたもの（shops.plan）で表示する（Stripe には問い合わせない） */
export function adminOverview(db: Database) {
  const month = currentMonth(db);
  const shops = db
    .query<Record<string, any>, [string]>(
      `SELECT s.id, s.code, s.name, s.concept, s.features, s.price_per_guest, s.price_band, s.internal, s.plan, s.memo,
              s.demo_limit, s.demo_used, s.plan_month, s.month_used, s.carryover, s.created_at, s.last_used_at,
              s.stripe_customer_id,
              (SELECT COUNT(*) FROM proposals p WHERE p.shop_id = s.id) AS proposals,
              (SELECT COUNT(*) FROM proposals p WHERE p.shop_id = s.id AND strftime('%Y-%m', p.created_at) = ?) AS proposals_month,
              (SELECT COUNT(*) FROM feedback f JOIN proposals p ON p.id = f.proposal_id WHERE p.shop_id = s.id) AS ratings,
              (SELECT COUNT(*) FROM dish_images i JOIN proposals p ON p.id = i.proposal_id WHERE p.shop_id = s.id) AS images
         FROM shops s ORDER BY COALESCE(s.last_used_at, s.created_at) DESC`,
    )
    .all(month)
    .map((s) => {
      const credits = creditsFor(db, loadBillingShop(db, s.id)!, planById(s.plan)?.id ?? null);
      return {
        ...(s as Record<string, any>),
        features: JSON.parse(s.features || "[]"),
        status: s.internal ? "internal" : s.plan ? "paid" : "demo",
        remaining: credits.remaining,
        demo_limit_effective: credits.demo_limit,
      };
    });

  const paid = shops.filter((s) => s.status === "paid") as Record<string, any>[];
  const count = (sql: string, ...p: string[]) => db.query<{ c: number }, string[]>(sql).get(...p)!.c;
  return {
    month,
    totals: {
      shops: shops.length,
      demo: shops.filter((s) => s.status === "demo").length,
      paid: paid.length,
      internal: shops.filter((s) => s.status === "internal").length,
      by_plan: PLANS.map((p) => ({ id: p.id, name: p.name, count: paid.filter((s) => s.plan === p.id).length })),
      monthly_revenue: paid.reduce((sum, s) => sum + (planById(s.plan)?.price ?? 0), 0), // 税別・最後に確認できたプランで計算
      new_shops_7d: count("SELECT COUNT(*) AS c FROM shops WHERE created_at >= datetime('now','localtime','-7 days')"),
      proposals_month: count("SELECT COUNT(*) AS c FROM proposals WHERE strftime('%Y-%m', created_at) = ?", month),
      ratings_total: count("SELECT COUNT(*) AS c FROM feedback"),
      images_total: count("SELECT COUNT(*) AS c FROM dish_images"),
      demo_used_total: demoTotalUsed(db),
    },
    settings: {
      demo_total_limit: billingSetting(db, "demo_total_limit", 300),
      demo_default_limit: billingSetting(db, "demo_default_limit", 3),
    },
    shops,
  };
}

export function adminRecentProposals(db: Database, code: string) {
  const shop = db.query<{ id: number }, [string]>("SELECT id FROM shops WHERE code = ? COLLATE NOCASE").get(code);
  if (!shop) return null;
  return db
    .query<{ id: number; category: string; ingredients: string; result: string; created_at: string }, [number]>(
      "SELECT id, category, ingredients, result, created_at FROM proposals WHERE shop_id = ? ORDER BY id DESC LIMIT 10",
    )
    .all(shop.id)
    .map((p) => ({
      id: p.id,
      category: p.category,
      created_at: p.created_at,
      ingredients: JSON.parse(p.ingredients),
      dishes: (JSON.parse(p.result).proposals ?? []).map((d: { name: string }) => d.name),
    }));
}

/** 変更は学習ループのコマンドと同じ検査を通す */
export function adminCommand(db: Database, cmd: "set-shop-billing" | "set-billing-settings", input: unknown): Response {
  try {
    return json(runLoop(db, cmd, [], input).data);
  } catch (e) {
    if (e instanceof LoopError) return fail(e.message);
    throw e;
  }
}
