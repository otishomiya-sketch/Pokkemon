#!/usr/bin/env bun
/**
 * v3 — ブラックベース + ボールド + Noto Sans JP のフラットなモダンSaaS案を2つ並列生成
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) process.exit(1);
const OUT_DIR = resolve(import.meta.dir, "..", "..", "tmp", "dashboard-mockups", "v3");
mkdirSync(OUT_DIR, { recursive: true });

const CONTEXT = `
Internal web dashboard "Pokemon Agents" — ops console for 22 autonomous AI agents
running a Japanese subsidy database site. Each agent is a cute mascot character.

Sidebar nav (Japanese): エージェント / エージェントログ / 仮説・検証 / 自律改善 / ドメイン知識
Main content: a 24-hour schedule timeline (rows = agents, dots = firings, vertical
NOW line), dense data table with columns エージェント / 役割 / 部署 / モデル /
スケジュール / 次回起動 / 操作, plus 4 metric tiles at top.

CRITICAL design direction — must feel like a 2026 product, not 2020:
- **Pure BLACK as the key color** (#000000 or near-black). No pastel tints.
- **Noto Sans JP** typography (Japanese sans-serif). Bold weights for headings
  and key numbers (700-800). Tighter letter-spacing.
- **Flat design** — no shadows on cards. Cards differentiate via background
  color only (#FFFFFF card on #F5F5F5 page bg).
- **Minimal borders** — only one hairline where absolutely needed.
- **Generous white space** and confident large numbers on metric tiles.
- Vibrant accent color is used only 1-2 times per screen (small dot, one pill)
  — everything else is black / white / gray.
`;

const PATTERNS = [
  {
    name: "pattern-v3a-black-bold",
    prompt: `${CONTEXT}

**Design direction: Linear 2026 + Vercel aesthetic — black, bold, flat.**
- Page bg #F5F5F5, cards #FFFFFF with NO border and NO shadow — flat.
- Typography Noto Sans JP, H1 weight 800 tracking -0.03em, body 500.
- Metric tiles: gigantic bold numbers (48-56px weight 800), tiny uppercase
  label above, no decorations, no gradient stripes.
- Active sidebar item: solid BLACK pill background + white text.
  Inactive: plain text in mid gray.
- 24h timeline: rows separated by 1px hairline only, dots are small BLACK
  filled circles. NOW line is a 2px solid black vertical line.
- Table: no borders except one 1px bottom border per row. Header row uppercase
  10px letter-spaced gray.
- Buttons: black solid primary with white text; secondary is text-only with a
  subtle hover. No rounded-16px — use 6-8px radius.
- One tiny green "live" dot in sidebar footer. That's the only color on screen.

Render 1536x1024 landscape. Bold. Confident. 2026.`,
  },
  {
    name: "pattern-v3b-editorial-bold",
    prompt: `${CONTEXT}

**Design direction: editorial/Axiom magazine bold SaaS — 2026 Framer vibe.**
- Page bg pure WHITE (#FFFFFF), no page gradient.
- Section backgrounds subtly differ: a very light gray (#F8F8F8) strip wraps
  the schedule timeline block to set it apart without borders.
- Typography: Noto Sans JP + a SERIF touch in H1 (serif display for number
  readings only, sans everywhere else). H1 is 32px weight 700.
- Metric tiles: borderless, huge 44px black numerals, tiny uppercase 10px
  label, a TINY vertical black bar (3×16px) as a "tick" accent next to the
  number — that's the only decoration.
- Sidebar: super minimal, narrow (220px), nav items are 14px medium weight;
  active has a 3px BLACK left border + black text; no background tint.
- 24h timeline: no background fill on rows, just hairlines. Dots are 6px black
  solid circles. NOW line is 2px electric RED (#E63946) — that's the only
  color pop in the whole interface.
- Table: 10px uppercase tracked header, rows 40px tall, no zebra.
- Avatars: small 24px rounded squares with duotone black/white treatment on
  each Pokemon — no soft pastel backgrounds.

Render 1536x1024 landscape. Editorial, confident, monochrome, precise.`,
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
  console.log(`✅ ${p.name} (${(buf.length/1024).toFixed(0)} KB, ${((Date.now()-t0)/1000).toFixed(0)}s)`);
}

await Promise.all(PATTERNS.map((p) => gen(p).catch((e) => console.error("ex", p.name, e))));
console.log("done");
