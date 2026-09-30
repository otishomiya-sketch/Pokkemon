/**
 * 提案メニューのイメージ画像（OpenAI の画像生成）。
 * 職人が「イメージ画像を見る」を押したときだけ 1 枚作り、DB の隣の images/ に保存して使い回す。
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { DB_PATH } from "./db";
import { buildImagePrompt, type ImageDish } from "./image-prompt";

export const IMAGE_DIR = resolve(dirname(DB_PATH), "images");
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY; // 任意（例: medium）。未設定ならサービスの既定

export function imagesEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export class ImageError extends Error {}

type Dish = ImageDish;

/** 生成中の重複を防ぐ（同じ品を連打されても 1 回だけ作る） */
const pending = new Map<string, Promise<string>>();

export function existingImage(db: Database, proposalId: number, dishIndex: number): string | null {
  const row = db
    .query<{ file: string }, [number, number]>("SELECT file FROM dish_images WHERE proposal_id = ? AND dish_index = ?")
    .get(proposalId, dishIndex);
  return row && existsSync(resolve(IMAGE_DIR, row.file)) ? `/images/${row.file}` : null;
}

export function imageUrlsFor(db: Database, proposalIds: number[]): Record<number, Record<number, string>> {
  if (proposalIds.length === 0) return {};
  const rows = db
    .query<{ proposal_id: number; dish_index: number; file: string }, number[]>(
      `SELECT proposal_id, dish_index, file FROM dish_images WHERE proposal_id IN (${proposalIds.map(() => "?").join(",")})`,
    )
    .all(...proposalIds);
  const out: Record<number, Record<number, string>> = {};
  for (const r of rows) (out[r.proposal_id] ??= {})[r.dish_index] = `/images/${r.file}`;
  return out;
}

export function generateDishImage(
  db: Database,
  proposalId: number,
  dishIndex: number,
  dish: Dish,
  category: string,
): Promise<string> {
  const key = `${proposalId}:${dishIndex}`;
  const running = pending.get(key);
  if (running) return running;

  const job = (async () => {
    const body: Record<string, unknown> = { model: IMAGE_MODEL, prompt: buildImagePrompt(dish, category), size: "1024x1024", n: 1 };
    if (IMAGE_QUALITY) body.quality = IMAGE_QUALITY;
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[images] OpenAI error ${res.status}: ${text.slice(0, 300)}`);
      if (res.status === 401) throw new ImageError("ただいま画像を作れません。時間をおいてお試しください");
      if (res.status === 429) throw new ImageError("画像サービスが混み合っています。少し待ってからもう一度お試しください");
      if (res.status === 400 && /safety|moderation/i.test(text)) throw new ImageError("この料理は画像にできませんでした");
      throw new ImageError("画像を作れませんでした。時間をおいてお試しください");
    }
    const first = (JSON.parse(text) as { data?: { b64_json?: string; url?: string }[] }).data?.[0];
    let bytes: Buffer;
    if (first?.b64_json) bytes = Buffer.from(first.b64_json, "base64");
    else if (first?.url) bytes = Buffer.from(await (await fetch(first.url)).arrayBuffer());
    else throw new ImageError("画像が返ってきませんでした");

    mkdirSync(IMAGE_DIR, { recursive: true });
    // 推測されない名前にする（画像 URL は店舗コードなしで開けるため）
    const file = `${proposalId}-${dishIndex}-${randomBytes(8).toString("hex")}.png`;
    await Bun.write(resolve(IMAGE_DIR, file), bytes);
    db.query(
      `INSERT INTO dish_images (proposal_id, dish_index, file) VALUES (?, ?, ?)
       ON CONFLICT (proposal_id, dish_index) DO UPDATE SET file = excluded.file, created_at = datetime('now','localtime')`,
    ).run(proposalId, dishIndex, file);
    return `/images/${file}`;
  })();

  pending.set(key, job);
  job.finally(() => pending.delete(key)).catch(() => {});
  return job;
}
