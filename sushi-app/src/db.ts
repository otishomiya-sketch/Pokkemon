import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { neighborBands, type PriceBand } from "./shop-profile";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

export const DB_PATH = process.env.SUSHI_DB_PATH ?? resolve(appRoot, "data/sushi.db");

export function openDb(): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  // 既存 DB に後から足した列を補う（schema.sql の CREATE TABLE IF NOT EXISTS は既存表を変えないため）
  const addColumn = (table: string, column: string, definition: string) => {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (cols.length > 0 && !cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumn("proposals", "experiment_ids", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("shops", "concept", "TEXT");
  addColumn("shops", "features", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("shops", "price_per_guest", "INTEGER");
  addColumn("shops", "price_band", "TEXT");
  addColumn("trends", "price_band", "TEXT");
  addColumn("trends", "origin", "TEXT");
  addColumn("trends", "source_kind", "TEXT");
  db.exec(readFileSync(resolve(appRoot, "db/schema.sql"), "utf8"));
  return db;
}

export interface Guideline {
  id: number;
  title: string;
  action: string;
}

/** 実行中の実験（ゲンガーが選んだ提案方針）。アプリはこれを AI に渡して提案を作る */
export function activeGuidelines(db: Database, category: Category): Guideline[] {
  return db
    .query<Guideline, [string]>(
      `SELECT id, title, action FROM menu_hypotheses
        WHERE kind = 'experiment' AND status = 'executing' AND category IN (?, 'both')
        ORDER BY started_at DESC`,
    )
    .all(category);
}

/** 検証済みの勝ちパターン・負けパターン（アルセウスやゴースが昇華したもの） */
export function learnedPatterns(db: Database, category: Category): { kind: string; title: string; action: string }[] {
  return db
    .query<{ kind: string; title: string; action: string }, [string]>(
      `SELECT kind, title, action FROM menu_hypotheses
        WHERE kind IN ('playbook','anti_pattern') AND status = 'active' AND category IN (?, 'both')
        ORDER BY updated_at DESC LIMIT 10`,
    )
    .all(category);
}

export type Category = "nigiri" | "dish";

export interface Shop {
  id: number;
  code: string;
  name: string;
  concept: string | null;
  features: string;
  price_per_guest: number | null;
  price_band: string | null;
}

export interface TrendRow {
  id: number;
  category: string;
  title: string;
  summary: string;
  ingredients: string;
  techniques: string;
  season: string | null;
  region: string | null;
  origin: string | null;
  source_kind: string | null;
}

export function findShop(db: Database, code: string): Shop | null {
  return db
    .query<Shop, [string]>(
      "SELECT id, code, name, concept, features, price_per_guest, price_band FROM shops WHERE code = ? COLLATE NOCASE",
    )
    .get(code.trim());
}

/**
 * 入力素材に関係するトレンドを優先し、足りない分は新しいもので埋める。
 * 店舗の価格帯が分かっていれば、同じ価格帯 → 隣の価格帯・価格帯を問わないもの → それ以外、の順に優先する。
 */
export function selectTrends(
  db: Database, category: Category, ingredients: string[], priceBand: string | null = null, limit = 6,
): TrendRow[] {
  const near = priceBand ? new Set(neighborBands(priceBand as PriceBand)) : new Set<string>();
  const bandScore = (band: string | null) =>
    !priceBand ? 0 : band === priceBand ? 2 : band === null || near.has(band) ? 1 : 0;
  const rows = db
    .query<TrendRow & { price_band: string | null }, [string]>(
      `SELECT id, category, title, summary, ingredients, techniques, season, region, origin, source_kind, price_band
         FROM trends
        WHERE status = 'active' AND category IN (?, 'both')
        ORDER BY observed_at DESC, id DESC
        LIMIT 200`,
    )
    .all(category);
  const score = (t: TrendRow & { price_band: string | null }) =>
    ingredients.filter((i) => t.ingredients.includes(i) || t.title.includes(i) || t.summary.includes(i)).length * 3 +
    bandScore(t.price_band);
  // 素材に合うトレンドは必ず入れ、残りは価格帯を考慮しつつ毎回ランダムに選ぶ（毎回同じトレンドばかり渡さないため）
  const scored = rows.map((t) => ({ t, s: score(t), r: Math.random() }));
  const matched = scored.filter((x) => x.s >= 3).sort((a, b) => b.s - a.s || a.r - b.r);
  const others = scored.filter((x) => x.s < 3).sort((a, b) => b.s + b.r * 2 - (a.s + a.r * 2));
  return [...matched, ...others].slice(0, limit).map((x) => x.t);
}

/** このお店に最近出した品の名前（同じ種類）。似た品を繰り返さないよう AI に渡す */
export function recentDishNames(db: Database, shopId: number, category: Category, limit = 30): string[] {
  const rows = db
    .query<{ result: string }, [number, string]>(
      "SELECT result FROM proposals WHERE shop_id = ? AND category = ? ORDER BY id DESC LIMIT 12",
    )
    .all(shopId, category);
  return rows.flatMap((r) => (JSON.parse(r.result).proposals ?? []).map((d: { name: string }) => d.name)).slice(0, limit);
}

export interface FeedbackSignal {
  name: string;
  concept: string;
  rating: string;
}

/**
 * 評価から、好評・不評だった提案の傾向を集める（店舗名は出さない）。
 * 価格帯が分かっていれば同じ価格帯のお店の評価を先に使い、足りなければ全店分で補う。
 */
export function feedbackSignals(db: Database, category: Category, priceBand: string | null = null, limit = 20): FeedbackSignal[] {
  const rows = db
    .query<{ result: string; dish_index: number; rating: string }, [string, string, number]>(
      `SELECT p.result, f.dish_index, f.rating
         FROM feedback f JOIN proposals p ON p.id = f.proposal_id JOIN shops s ON s.id = p.shop_id
        WHERE p.category = ? AND p.mode = 'live'
        ORDER BY (s.price_band IS ?) DESC, f.created_at DESC
        LIMIT ?`,
    )
    .all(category, priceBand ?? "", limit);
  const signals: FeedbackSignal[] = [];
  for (const r of rows) {
    const dish = JSON.parse(r.result).proposals?.[r.dish_index];
    if (dish) signals.push({ name: dish.name, concept: dish.concept, rating: r.rating });
  }
  return signals;
}

/** 入力素材に関係する知識。「戻り鰹」と「鰹」のように片方がもう片方を含めば一致とみなす */
export function knowledgeFor(db: Database, ingredients: string[]): { subject: string; body: string }[] {
  if (ingredients.length === 0) return [];
  return db
    .query<{ subject: string; body: string }, []>(
      "SELECT subject, body FROM knowledge_notes ORDER BY confidence DESC, updated_at DESC",
    )
    .all()
    .filter((n) => ingredients.some((i) => i.includes(n.subject) || n.subject.includes(i)))
    .slice(0, 10);
}
