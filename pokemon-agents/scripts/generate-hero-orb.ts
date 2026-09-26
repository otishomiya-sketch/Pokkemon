#!/usr/bin/env bun
/**
 * gpt-image-2 でダッシュボード中央に置くヒーロー3Dオーブを並列生成。
 * 保存先: pokemon-agents/web/public/hero/{slug}.png
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) process.exit(1);
const OUT_DIR = resolve(import.meta.dir, "..", "web", "public", "hero");
mkdirSync(OUT_DIR, { recursive: true });

const PATTERNS = [
  {
    name: "pokeball-orb",
    prompt: `A cinematic 3D render hero illustration for a dashboard centerpiece.
Subject: a large translucent glass sphere (like a clear marble/bubble) floating
in soft sunlight, and INSIDE the sphere we see a cute rendered Mew-like
pink-purple small creature curled up peacefully, glowing softly. Surrounding the
big sphere are smaller floating 3D bubbles of various pastel colors (peach,
mint, periwinkle, blush) scattered at different depths.

Background: a soft pale mint / lavender gradient matching the rest of the scene
(very similar to #D4DFF7 → #E6DAF0 — almost invisible), so the orb integrates
naturally when placed on a similar dashboard background.

Style: Dribbble 2026 hero illustration, Apple Vision OS aesthetic, glossy
glass, soft shadows, luxurious, dreamy. Render 1024x1024. Center the main orb.
No text, no UI, no labels.`,
  },
  {
    name: "crystal-flock",
    prompt: `A cinematic 3D render hero illustration for a dashboard centerpiece.
Subject: a cluster of 3 floating translucent crystal orbs of varying sizes,
iridescent (holographic) surfaces catching light, arranged in a loose triangle
composition, with tiny sparkle particles floating around them. Pastel gradient
interior tint — pink, mint, periwinkle, peach.

The image itself must have a FULLY TRANSPARENT background (no color), pure PNG
transparency.

Style: Dribbble 2026, Apple Vision OS, dreamy luxurious glass, soft shadows.
Render 1024x1024 square. No text, no UI, no logos.`,
  },
];

async function gen(p: (typeof PATTERNS)[number]) {
  const t0 = Date.now();
  console.log(`▶ ${p.name}`);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: p.prompt,
      size: "1024x1024",
      n: 1,
    }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`❌ ${p.name} ${res.status}: ${text.slice(0,300)}`); return; }
  const json = JSON.parse(text) as { data: Array<{ b64_json?: string; url?: string }> };
  const f = json.data?.[0]; if (!f) return;
  let buf: Buffer;
  if (f.b64_json) buf = Buffer.from(f.b64_json, "base64");
  else if (f.url) { const r = await fetch(f.url); buf = Buffer.from(await r.arrayBuffer()); }
  else return;
  const out = resolve(OUT_DIR, `${p.name}.png`);
  writeFileSync(out, buf);
  console.log(`✅ ${p.name} (${(buf.length/1024).toFixed(0)} KB, ${((Date.now()-t0)/1000).toFixed(0)}s) → ${out}`);
}

await Promise.all(PATTERNS.map((p) => gen(p).catch((e) => console.error("ex", p.name, e))));
console.log("done");
