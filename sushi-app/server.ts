#!/usr/bin/env bun
/**
 * "鮨"新メニュー開発APP サーバー
 *
 * 起動: bun sushi-app/server.ts   → http://localhost:5800/
 * スマホ実機で試す場合: HOST=0.0.0.0 bun sushi-app/server.ts（同じWi-Fi内から http://<MacのIP>:5800/）
 * ANTHROPIC_API_KEY が無い場合はデモモード（固定の見本を返す）で動く。
 *
 * クラウドで使う環境変数:
 *   SUSHI_DB_PATH         DB の置き場所（永続ボリューム上に置く）
 *   SUSHI_LOOP_TOKEN      Mac のエージェントが /api/loop で DB を読み書きするための合言葉（無ければ /api/loop は無効）
 *   DAILY_PROPOSAL_LIMIT  1 店舗 1 日あたりの提案回数の上限（既定 30。API の使いすぎ防止）
 *   OPENAI_API_KEY        あればメニューのイメージ画像を作れる（無ければボタンを出さない）
 *   DAILY_IMAGE_LIMIT     1 店舗 1 日あたりの画像の枚数の上限（既定 20）
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb, findShop, selectTrends, feedbackSignals, knowledgeFor, activeGuidelines, learnedPatterns, recentDishNames, type Category } from "./src/db";
import { proposeLive, proposeDemo, hasCredentials, ProposalError, MODEL } from "./src/propose";
import { runLoop, LoopError } from "./src/loop-core";
import { PRICE_BANDS, FEATURE_OPTIONS, parseProfileInput, ProfileError } from "./src/shop-profile";
import type { Shop } from "./src/db";
import { timingSafeEqual } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { IMAGE_DIR, imagesEnabled, existingImage, generateDishImage, imageUrlsFor, ImageError } from "./src/images";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb();
const PORT = Number(process.env.PORT ?? 5800);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOOP_TOKEN = process.env.SUSHI_LOOP_TOKEN ?? "";
const DAILY_LIMIT = Number(process.env.DAILY_PROPOSAL_LIMIT ?? 30);
const DAILY_IMAGE_LIMIT = Number(process.env.DAILY_IMAGE_LIMIT ?? 20);

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
  if (!shop.price_band || !shop.concept) return fail("先にお店の情報（コンセプト・特徴・客単価）を登録してください", 409);

  const today = db
    .query<{ c: number }, [number]>("SELECT COUNT(*) AS c FROM proposals WHERE shop_id = ? AND date(created_at) = date('now','localtime')")
    .get(shop.id)!.c;
  if (today >= DAILY_LIMIT) return fail(`今日の提案回数の上限（${DAILY_LIMIT} 回）に達しました。明日またお使いください`, 429);

  const input = {
    shop: { concept: shop.concept, features: JSON.parse(shop.features), price_per_guest: shop.price_per_guest, price_band: shop.price_band },
    ingredients,
    category,
    notes,
    trends: selectTrends(db, category, ingredients, shop.price_band),
    signals: feedbackSignals(db, category, shop.price_band),
    knowledge: knowledgeFor(db, ingredients),
    // 実行中の実験が複数あっても、1 回の提案に渡すのは 1 つだけ（どの方針が効いたかを分けて測るため）
    guidelines: pickOne(activeGuidelines(db, category)),
    patterns: learnedPatterns(db, category),
    recentDishes: recentDishNames(db, shop.id, category),
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

function shopView(shop: Shop) {
  return {
    code: shop.code,
    name: shop.name,
    concept: shop.concept ?? "",
    features: JSON.parse(shop.features) as string[],
    price_per_guest: shop.price_per_guest,
    price_band: shop.price_band,
    profile_complete: Boolean(shop.concept && shop.price_band),
  };
}

async function handleProfile(req: Request) {
  const shop = shopFrom(req);
  if (!shop) return fail("店舗コードが正しくありません", 401);
  try {
    const p = parseProfileInput(await req.json().catch(() => null));
    db.query("UPDATE shops SET concept = ?, features = ?, price_per_guest = ?, price_band = ? WHERE id = ?")
      .run(p.concept, JSON.stringify(p.features), p.price_per_guest, p.price_band, shop.id);
    return json(shopView(findShop(db, shop.code)!));
  } catch (error) {
    if (error instanceof ProfileError) return fail(error.message);
    throw error;
  }
}

async function handleImage(req: Request, proposalId: number, dishIndex: number) {
  const shop = shopFrom(req);
  if (!shop) return fail("店舗コードが正しくありません", 401);
  if (!imagesEnabled()) return fail("イメージ画像はまだ使えません", 404);
  const proposal = db
    .query<{ id: number; category: string; result: string }, [number, number]>(
      "SELECT id, category, result FROM proposals WHERE id = ? AND shop_id = ?",
    )
    .get(proposalId, shop.id);
  const dish = proposal ? JSON.parse(proposal.result).proposals?.[dishIndex] : null;
  if (!proposal || !dish) return fail("提案が見つかりません", 404);

  const cached = existingImage(db, proposal.id, dishIndex);
  if (cached) return json({ url: cached });

  const today = db
    .query<{ c: number }, [number]>(
      `SELECT COUNT(*) AS c FROM dish_images i JOIN proposals p ON p.id = i.proposal_id
        WHERE p.shop_id = ? AND date(i.created_at) = date('now','localtime')`,
    )
    .get(shop.id)!.c;
  if (today >= DAILY_IMAGE_LIMIT) return fail(`今日の画像の上限（${DAILY_IMAGE_LIMIT} 枚）に達しました。明日またお使いください`, 429);

  try {
    return json({ url: await generateDishImage(db, proposal.id, dishIndex, dish, proposal.category) });
  } catch (error) {
    if (error instanceof ImageError) return fail(error.message, 502);
    console.error(error);
    return fail("画像の作成中にエラーが起きました", 500);
  }
}

function serveImage(name: string) {
  const file = basename(name);
  if (!/^[0-9]+-[0-9]+-[0-9a-f]{16}\.png$/.test(file)) return fail("Not found", 404);
  const path = resolve(IMAGE_DIR, file);
  if (!existsSync(path)) return fail("Not found", 404);
  return new Response(Bun.file(path), { headers: { "cache-control": "public, max-age=31536000, immutable" } });
}

/** Mac のエージェント用。合言葉が一致したときだけ、学習ループのコマンドをこの DB に対して実行する */
async function handleLoop(req: Request) {
  const given = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(LOOP_TOKEN);
  if (!LOOP_TOKEN || given.length !== expected.length || !timingSafeEqual(given, expected)) return fail("認証に失敗しました", 401);
  const body = (await req.json().catch(() => null)) as { cmd?: string; args?: unknown; input?: unknown } | null;
  const args = Array.isArray(body?.args) ? body.args.map(String) : [];
  try {
    return json(runLoop(db, body?.cmd, args, body?.input));
  } catch (error) {
    if (error instanceof LoopError) return fail(error.message, 400);
    console.error(error);
    return fail("コマンドの実行中にエラーが起きました", 500);
  }
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
  const images = imageUrlsFor(db, rows.map((r) => r.id));
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
      images: images[r.id] ?? {},
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
    if (route === "GET /api/status") return json({ mode: hasCredentials() ? "live" : "demo", images: imagesEnabled() });
    const imageRoute = /^POST \/api\/proposals\/(\d+)\/dishes\/(\d+)\/image$/.exec(route);
    if (imageRoute) return handleImage(req, Number(imageRoute[1]), Number(imageRoute[2]));
    if (req.method === "GET" && url.pathname.startsWith("/images/")) return serveImage(url.pathname.slice("/images/".length));
    if (route === "GET /api/shop") {
      const shop = shopFrom(req);
      return shop ? json(shopView(shop)) : fail("店舗コードが見つかりません", 404);
    }
    if (route === "PUT /api/shop/profile") return handleProfile(req);
    if (route === "GET /api/profile-options") return json({ price_bands: PRICE_BANDS.map(({ id, label, examples, max }) => ({ id, label, examples, max: Number.isFinite(max) ? max : null })), features: FEATURE_OPTIONS });
    if (route === "POST /api/propose") return handlePropose(req);
    if (route === "POST /api/feedback") return handleFeedback(req);
    if (route === "GET /api/history") return handleHistory(req);
    if (route === "POST /api/loop") return handleLoop(req);
    return fail("Not found", 404);
  },
});

console.log(`[sushi-app] http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/ (${hasCredentials() ? "live" : "demo"} mode)`);
