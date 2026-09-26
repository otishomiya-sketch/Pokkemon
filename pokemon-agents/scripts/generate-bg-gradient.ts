#!/usr/bin/env bun
/**
 * gpt-image-2 でダッシュボード背景用のメッシュグラデーションを3パターン並列生成。
 * 保存先: pokemon-agents/web/public/bg/{slug}.jpg
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) process.exit(1);
const OUT_DIR = resolve(import.meta.dir, "..", "web", "public", "bg");
mkdirSync(OUT_DIR, { recursive: true });

const COMMON = `
An abstract background gradient image for a premium SaaS dashboard. Absolutely
NO TEXT, no logos, no objects, no UI elements — just pure smooth abstract color.

Aesthetic: 2026 designer-grade mesh gradient, think Apple Vision OS wallpaper /
Linear.app hero / Framer site hero / Stripe 2026 marketing gradients.

Technical:
- Ultra-smooth color transitions with soft organic blobs of color
- Subtle film-grain / noise texture overlay (very fine, barely visible)
- Natural blur between color zones, NOT harsh edges
- High tonal range so UI panels can layer on top with backdrop-blur and remain readable
- The corners should stay slightly darker to frame content
- One focal bright highlight somewhere (upper-left or upper-center)
- Photographic depth, not flat
- Desktop wallpaper quality

Render 1536x1024 landscape. Pure abstract only.
`;

const PATTERNS = [
  {
    name: "iris",
    prompt: `${COMMON}

Palette: iridescent periwinkle #6E7FE0 → violet #9E7BE6 → soft blush #F0B4D0 →
warm cream #FFE9D6 in the highlight corner. Dreamy, cinematic. Think Apple
Vision OS default wallpaper.`,
  },
  {
    name: "dusk",
    prompt: `${COMMON}

Palette: deep indigo #3A2F7A bottom-right → magenta rose #D85ABD center →
warm amber #F5A662 upper-left highlight → soft peach #FFD3A8. Sophisticated
dusk sky vibe, like a premium fintech hero gradient.`,
  },
  {
    name: "azure",
    prompt: `${COMMON}

Palette: teal-azure #4AA8D8 upper → soft mint #B8E3D6 → lavender #C4B3F0 →
warm pearl #F5E6D3 highlight. Fresh, luminous, Linear.app-esque. Cool but
not cold.`,
  },
];

async function gen(p: (typeof PATTERNS)[number]) {
  const t0 = Date.now();
  console.log(`▶ ${p.name}`);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: p.prompt, size: "1536x1024", n: 1 }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`❌ ${p.name} ${res.status}: ${text.slice(0,250)}`); return; }
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
