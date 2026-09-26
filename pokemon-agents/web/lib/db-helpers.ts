import type { Database } from "bun:sqlite";

/**
 * 単一の数値を返すクエリヘルパ。
 * `SELECT COUNT(*)` でも `SELECT SUM(x)` でも動くよう、結果の最初の列を取り出す。
 */
export function q1(db: Database, sql: string): number {
  const r = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!r) return 0;
  const v = Object.values(r)[0];
  return typeof v === "number" ? v : Number(v) || 0;
}
