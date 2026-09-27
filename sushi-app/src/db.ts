import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

export const DB_PATH = process.env.SUSHI_DB_PATH ?? resolve(appRoot, "data/sushi.db");

export function openDb(): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  // 既存 DB に後から足した列を補う（schema.sql の CREATE TABLE IF NOT EXISTS は既存表を変えないため）
  const proposalCols = db.query<{ name: string }, []>("PRAGMA table_info(proposals)").all().map((c) => c.name);
  if (proposalCols.length > 0 && !proposalCols.includes("experiment_ids")) {
    db.exec("ALTER TABLE proposals ADD COLUMN experiment_ids TEXT NOT NULL DEFAULT '[]'");
  }
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
}

export interface TrendRow {
  id: number;
  category: string;
  title: string;
  summary: string;
  ingredients: string;
  techniques: string;
  season: string | null;
}

export function findShop(db: Database, code: string): Shop | null {
  return db
    .query<Shop, [string]>("SELECT id, code, name FROM shops WHERE code = ? COLLATE NOCASE")
    .get(code.trim());
}

/** 入力素材に関係するトレンドを優先し、足りない分は新しいもので埋める */
export function selectTrends(db: Database, category: Category, ingredients: string[], limit = 12): TrendRow[] {
  const rows = db
    .query<TrendRow, [string]>(
      `SELECT id, category, title, summary, ingredients, techniques, season
         FROM trends
        WHERE status = 'active' AND category IN (?, 'both')
        ORDER BY observed_at DESC, id DESC
        LIMIT 200`,
    )
    .all(category);
  const score = (t: TrendRow) =>
    ingredients.filter((i) => t.ingredients.includes(i) || t.title.includes(i) || t.summary.includes(i)).length;
  return rows
    .map((t, order) => ({ t, s: score(t), order }))
    .sort((a, b) => b.s - a.s || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.t);
}

export interface FeedbackSignal {
  name: string;
  concept: string;
  rating: string;
}

/** 全店舗の評価から、好評・不評だった提案の傾向を集める（店舗名は出さない） */
export function feedbackSignals(db: Database, category: Category, limit = 20): FeedbackSignal[] {
  const rows = db
    .query<{ result: string; dish_index: number; rating: string }, [string, number]>(
      `SELECT p.result, f.dish_index, f.rating
         FROM feedback f JOIN proposals p ON p.id = f.proposal_id
        WHERE p.category = ? AND p.mode = 'live'
        ORDER BY f.created_at DESC
        LIMIT ?`,
    )
    .all(category, limit);
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
