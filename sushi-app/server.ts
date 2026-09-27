#!/usr/bin/env bun
/**
 * 寿司メニュー提案アプリ サーバー
 *
 * 起動: bun sushi-app/server.ts   → http://localhost:5800/
 * スマホ実機で試す場合: HOST=0.0.0.0 bun sushi-app/server.ts（同じWi-Fi内から http://<MacのIP>:5800/）
 * ANTHROPIC_API_KEY が無い場合はデモモード（固定の見本を返す）で動く。
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb, findShop, selectTrends, feedbackSignals, knowledgeFor, activeGuidelines, learnedPatterns, type Category } from "./src/db";
import { proposeLive, proposeDemo, hasCredentials, ProposalError, MODEL } from "./src/propose";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb();
const PORT = Number(process.env.PORT ?? 5800);
const HOST = process.env.HOST ?? "127.0.0.1";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const pickOne = <T,>(items: T[]): T[] => (items.length ? [items[Math.floor(Math.random() * items.length)]!] : []);
const fail = (message: string, status = 400) => json({ error: message }, status);

function shopFrom(req: Request) {
  const code = req.headers.get("x-shop-code") ?? "";
  return code ? findShop(db, code) : null;
}

async function handlePropose(req: Request) {
  const shop = shopFrom(req);
  if (!shop) return fail("店舗コードが正しくありません", 401);

  const body = (await req.json().catch(() => null)) as
    | { ingredients?: unknown; category?: unknown; notes?: unknown }
    | null;
  const ingredients = Array.isArray(body?.ingredients)
    ? body.ingredients.map((s) => String(s).trim()).filter(Boolean).slice(0, 8)
    : [];
  const category = body?.category as Category;
  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 300) : "";
  if (ingredients.length === 0) return fail("素材を1つ以上入力してください");
  if (category !== "nigiri" && category !== "dish") return fail("握りか一品料理を選んでください");

  const input = {
    ingredients,
    category,
    notes,
    trends: selectTrends(db, category, ingredients),
    signals: feedbackSignals(db, category),
    knowledge: knowledgeFor(db, ingredients),
    // 実行中の実験が複数あっても、1 回の提案に渡すのは 1 つだけ（どの方針が効いたかを分けて測るため）
    guidelines: pickOne(activeGuidelines(db, category)),
    patterns: learnedPatterns(db, category),
  };
  const live = hasCredentials();

  let result;
  try {
    result = live ? await proposeLive(input) : proposeDemo(input);
  } catch (error) {
    if (error instanceof ProposalError) return fail(error.message, 502);
    console.error(error);
    return fail("提案の作成中にエラーが起きました", 500);
  }

  const trendIds = [...new Set(result.proposals.flatMap((p) => p.trend_ids))];
  const { id } = db
    .query<{ id: number }, [number, string, string, string, string, string, string, string, string | null]>(
      `INSERT INTO proposals (shop_id, ingredients, category, notes, result, trend_ids, experiment_ids, mode, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      shop.id,
      JSON.stringify(ingredients),
      category,
      notes,
      JSON.stringify(result),
      JSON.stringify(trendIds),
      JSON.stringify(input.guidelines.map((g) => g.id)),
      live ? "live" : "demo",
      live ? MODEL : null,
    )!;

  return json({ id, mode: live ? "live" : "demo", ...result });
}

async function handleFeedback(req: Request) {
  const shop = shopFrom(req);
  if (!shop) return fail("店舗コードが正しくありません", 401);
  const body = (await req.json().catch(() => null)) as
    | { proposal_id?: number; dish_index?: number; rating?: string; comment?: string }
    | null;
  if (!body || !["adopted", "tried", "not_fit"].includes(body.rating ?? "")) return fail("評価が正しくありません");

  const owned = db
    .query<{ id: number }, [number, number]>("SELECT id FROM proposals WHERE id = ? AND shop_id = ?")
    .get(Number(body.proposal_id), shop.id);
  if (!owned) return fail("提案が見つかりません", 404);

  db.query(
    `INSERT INTO feedback (proposal_id, dish_index, rating, comment) VALUES (?, ?, ?, ?)
     ON CONFLICT (proposal_id, dish_index) DO UPDATE SET rating = excluded.rating, comment = excluded.comment,
       created_at = datetime('now','localtime')`,
  ).run(owned.id, Number(body.dish_index) || 0, body.rating!, (body.comment ?? "").slice(0, 500));
  return json({ ok: true });
}

function handleHistory(req: Request) {
  const shop = shopFrom(req);
  if (!shop) return fail("店舗コードが正しくありません", 401);
  const rows = db
    .query<
      { id: number; ingredients: string; category: string; notes: string; result: string; mode: string; created_at: string },
      [number]
    >(
      `SELECT id, ingredients, category, notes, result, mode, created_at
         FROM proposals WHERE shop_id = ? ORDER BY id DESC LIMIT 30`,
    )
    .all(shop.id);
  const ratings = db
    .query<{ proposal_id: number; dish_index: number; rating: string }, [number]>(
      `SELECT f.proposal_id, f.dish_index, f.rating FROM feedback f
         JOIN proposals p ON p.id = f.proposal_id WHERE p.shop_id = ?`,
    )
    .all(shop.id);
  return json(
    rows.map((r) => ({
      id: r.id,
      ingredients: JSON.parse(r.ingredients),
      category: r.category,
      notes: r.notes,
      mode: r.mode,
      created_at: r.created_at,
      ...JSON.parse(r.result),
      ratings: Object.fromEntries(ratings.filter((f) => f.proposal_id === r.id).map((f) => [f.dish_index, f.rating])),
    })),
  );
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /") return new Response(Bun.file(resolve(here, "public/index.html")));
    if (route === "GET /api/status") return json({ mode: hasCredentials() ? "live" : "demo" });
    if (route === "GET /api/shop") {
      const shop = shopFrom(req);
      return shop ? json({ code: shop.code, name: shop.name }) : fail("店舗コードが見つかりません", 404);
    }
    if (route === "POST /api/propose") return handlePropose(req);
    if (route === "POST /api/feedback") return handleFeedback(req);
    if (route === "GET /api/history") return handleHistory(req);
    return fail("Not found", 404);
  },
});

console.log(`[sushi-app] http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/ (${hasCredentials() ? "live" : "demo"} mode)`);
