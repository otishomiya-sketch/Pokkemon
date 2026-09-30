/**
 * 顧客ごとの残り素材の計算と、使う前の確保・失敗したときの返却。
 *
 * - 無料デモ: min(上限 − 使用, 全店合計の上限 − 全店の使用の合計)。社内用のお店は数えない
 * - 有料プラン: 月の枠 + 繰越 − 今月の使用。未使用分は翌月に繰り越す（解約で消える）
 * - 社内用: 無制限
 * 処理の前に確保（書き込み）してから処理し、失敗したら返す。同時に使われても上限を超えないため。
 */
import type { Database } from "bun:sqlite";
import { planById, type PlanId } from "./plans";

export interface BillingShop {
  id: number;
  code: string;
  internal: number;
  demo_limit: number | null;
  demo_used: number;
  plan: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  plan_month: string | null;
  month_used: number;
  carryover: number;
}

export type CreditSource = "internal" | "paid" | "demo";

export interface Credits {
  source: CreditSource;
  plan: PlanId | null;
  remaining: number | null; // null = 無制限
  monthly: number | null;
  carryover: number;
  month_used: number;
  demo_limit: number;
  demo_used: number;
  demo_total_left: number;
}

export function billingSetting(db: Database, key: string, fallback: number): number {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM billing_settings WHERE key = ?").get(key);
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : fallback;
}

export function currentMonth(db: Database): string {
  return db.query<{ m: string }, []>("SELECT strftime('%Y-%m', 'now', 'localtime') AS m").get()!.m;
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!);
}

/**
 * 対象月が今月でなければ繰越を計算し直す（書き込みはしない）。
 * 繰越 = max(0, 月枠 + 前の繰越 − 前月の使用) + 月枠 × (丸ごと使わなかった月の数)
 */
export function rolledOver(shop: BillingShop, monthly: number, month: string): { plan_month: string; month_used: number; carryover: number } {
  if (!shop.plan_month || shop.plan_month === month) {
    return { plan_month: shop.plan_month ?? month, month_used: shop.plan_month ? shop.month_used : 0, carryover: shop.plan_month ? shop.carryover : 0 };
  }
  const gap = monthsBetween(shop.plan_month, month);
  if (gap <= 0) return { plan_month: shop.plan_month, month_used: shop.month_used, carryover: shop.carryover };
  const carry = Math.max(0, monthly + shop.carryover - shop.month_used) + monthly * (gap - 1);
  return { plan_month: month, month_used: 0, carryover: carry };
}

export function demoTotalUsed(db: Database): number {
  return db.query<{ s: number }, []>("SELECT COALESCE(SUM(demo_used), 0) AS s FROM shops WHERE internal = 0").get()!.s;
}

/** activePlan: Stripe で確認できた有料プラン（無ければ null） */
export function creditsFor(db: Database, shop: BillingShop, activePlan: PlanId | null): Credits {
  const demoLimit = shop.demo_limit ?? billingSetting(db, "demo_default_limit", 3);
  const totalLeft = Math.max(0, billingSetting(db, "demo_total_limit", 300) - demoTotalUsed(db));
  const base = { demo_limit: demoLimit, demo_used: shop.demo_used, demo_total_left: totalLeft };
  if (shop.internal) {
    return { source: "internal", plan: null, remaining: null, monthly: null, carryover: 0, month_used: 0, ...base };
  }
  const plan = planById(activePlan);
  if (plan) {
    const r = rolledOver(shop, plan.monthly, currentMonth(db));
    return {
      source: "paid", plan: plan.id, remaining: Math.max(0, plan.monthly + r.carryover - r.month_used),
      monthly: plan.monthly, carryover: r.carryover, month_used: r.month_used, ...base,
    };
  }
  return {
    source: "demo", plan: null, remaining: Math.max(0, Math.min(demoLimit - shop.demo_used, totalLeft)),
    monthly: null, carryover: 0, month_used: 0, ...base,
  };
}

/** 1 素材を確保する。確保できたら使った元（返却用）を返す。足りなければ null */
export function reserveCredit(db: Database, shopId: number, activePlan: PlanId | null): CreditSource | null {
  return db.transaction(() => {
    const shop = loadBillingShop(db, shopId);
    if (!shop) return null;
    const c = creditsFor(db, shop, activePlan);
    if (c.remaining !== null && c.remaining < 1) return null;
    if (c.source === "paid") {
      const r = rolledOver(shop, c.monthly!, currentMonth(db));
      db.query("UPDATE shops SET plan_month = ?, month_used = ?, carryover = ?, last_used_at = datetime('now','localtime') WHERE id = ?")
        .run(r.plan_month, r.month_used + 1, r.carryover, shopId);
    } else if (c.source === "demo") {
      db.query("UPDATE shops SET demo_used = demo_used + 1, last_used_at = datetime('now','localtime') WHERE id = ?").run(shopId);
    } else {
      db.query("UPDATE shops SET last_used_at = datetime('now','localtime') WHERE id = ?").run(shopId);
    }
    return c.source;
  })();
}

/** 処理が失敗したときに返す */
export function refundCredit(db: Database, shopId: number, source: CreditSource): void {
  if (source === "paid") db.query("UPDATE shops SET month_used = MAX(0, month_used - 1) WHERE id = ?").run(shopId);
  if (source === "demo") db.query("UPDATE shops SET demo_used = MAX(0, demo_used - 1) WHERE id = ?").run(shopId);
}

export function loadBillingShop(db: Database, shopId: number): BillingShop | null {
  return db
    .query<BillingShop, [number]>(
      `SELECT id, code, internal, demo_limit, demo_used, plan, stripe_subscription_id, stripe_customer_id, plan_month, month_used, carryover
         FROM shops WHERE id = ?`,
    )
    .get(shopId);
}

/** 新しく契約したとき: 対象月＝今月、使用 0、繰越 0 から始める */
export function recordSubscription(db: Database, shopId: number, subscriptionId: string, customerId: string, plan: PlanId): void {
  db.query(
    `UPDATE shops SET stripe_subscription_id = ?, stripe_customer_id = ?, plan = ?, plan_month = ?, month_used = 0, carryover = 0
      WHERE id = ?`,
  ).run(subscriptionId, customerId, plan, currentMonth(db), shopId);
}

/** 契約の確認結果を記録（表示用のプランを最新にする。契約なしなら消す） */
export function recordPlanStatus(db: Database, shopId: number, plan: PlanId | null): void {
  db.query("UPDATE shops SET plan = ? WHERE id = ?").run(plan, shopId);
}
