#!/usr/bin/env bun
/**
 * gpt-image-2 で "SaaS ベース + 少しゲーム風味" のデザイン案を5パターン並列生成。
 *
 * 生成先: tmp/dashboard-mockups/v2/{pattern-*}.png
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("OPENAI_API_KEY not set");
  process.exit(1);
}

const OUT_DIR = resolve(import.meta.dir, "..", "..", "tmp", "dashboard-mockups", "v2");
mkdirSync(OUT_DIR, { recursive: true });

const COMMON_CONTEXT = `
This is a web dashboard for "Pokemon Agents" — an internal ops console for 22
autonomous AI agents running a Japanese subsidy (補助金) database website.
Each agent is personified as a different Pokemon (Pidgey, Caterpie, Magnemite,
Gengar, Mew, etc.), assigned to departments (記事執筆部, 仮説検証部, SEO計測部,
監査部, etc.).

The dashboard must feel like a **serious SaaS product** (think Linear / Stripe /
Vercel / Notion / Raycast) — clean typography, generous white space, proper data
density, refined shadows, tasteful use of color. But it should have a SUBTLE
game-flavored layer: tiny Pokemon sprite avatars next to agent names, playful
accent colors, maybe a faint pokeball dot pattern. The game element is a
GARNISH, not the main dish.

Left sidebar navigation in Japanese:
  エージェント / エージェントログ / 仮説・検証 / 自律改善 / ドメイン知識

Main content shows:
  - Top row: 4 metric tiles (active agents, today's runs, cost ¥, status)
  - A 24-hour horizontal schedule timeline (rows = agents, dots = firing times,
    a vertical red "NOW" line crossing all rows)
  - A dense table with columns: エージェント / 役割 / 部署 / モデル / スケジュール / 次回起動 / 操作
  - Small 24-28px pokemon sprite/avatar for each agent row

All Japanese labels. Full 1536x1024 landscape screenshot mockup.
`;

const PATTERNS = [
  {
    name: "pattern-1-linear-saas",
    title: "P1 — Linear.app 風 SaaS + pixel sprite avatars",
    prompt: `${COMMON_CONTEXT}

**Design direction: Linear.app / Height.app inspired.**
- Near-white background (#FBFBFD), 1px borders (#E4E4E7), subtle inner shadows
- Single purple-indigo accent (#5E5CE6) used SPARINGLY — only for primary CTA,
  active sidebar item, and the "NOW" timeline line
- Inter font, tight 14px body / 12px meta
- Metric tiles: borderless, huge number + tiny trend arrow, no card chrome
- Table: very tight 32px row height, hover highlight only, zebra-free
- Pokemon avatars: 24px pixel-art style sprites (like Gen 3 GBA graphics),
  chip-style background #F3F4F6, tiny but recognizable
- Department column: small colored dot + text (color coded by department)
- The 24h timeline is compressed, clean grid ticks every 3 hours
- Overall feel: a Linear issue tracker, but the assignees are Pokemon

Render as 1536x1024 landscape, showing "Agents → Schedule timeline" as the active view.`,
  },
  {
    name: "pattern-2-stripe-saas",
    title: "P2 — Stripe Dashboard + subtle gamification",
    prompt: `${COMMON_CONTEXT}

**Design direction: Stripe Dashboard inspired — data-dense, professional.**
- Neutral light-gray bg (#F6F9FC), cards have very subtle shadow + 1px border
- Stripe purple (#635BFF) for primary actions, slate (#425466) for text
- Multiple narrow columns of data, compact but not cramped
- Metric tiles feature small sparkline charts next to big numbers
- Table has a clean "gradient" divider between header and body, sticky header
- Each agent row shows: 28px semi-realistic Pokemon avatar (soft colored chip
  background matching department), agent name, small "Lv.12" style badge that
  hints at gamification without being loud
- Department shown as pill-shaped badge with muted color
- 24h timeline: compact horizontal strip at top, dots color-coded by department
- Bottom: a recent activity feed showing "✓ Pidgey completed run at 18:30"

Render as 1536x1024 landscape. Stripe's ops console, but for Pokemon agents.`,
  },
  {
    name: "pattern-3-raycast-soft",
    title: "P3 — Raycast 風 ソフトグラデーション + type-badge",
    prompt: `${COMMON_CONTEXT}

**Design direction: Raycast / Arc browser inspired — soft rounded SaaS.**
- Off-white (#FAFAFA) bg with very subtle vertical gradient
- Heavily rounded corners everywhere (16px on cards, 8px on buttons)
- Soft drop shadows, slight glass/blur effect on top bar
- Accent: warm coral (#FF6363) for primary, lavender (#B4A7FF) secondary
- Pokemon-type colored badges for departments: fire-type red, water-type blue,
  grass-type green, etc. (pill-shaped with tiny type icon)
- Pokemon avatars: 32px, soft gradient circular background tinted by type
- Typography: slightly softer (e.g., SF Pro Rounded feel)
- Metric tiles have a soft gradient accent stripe at top (coral → lavender)
- 24h timeline has rounded bars instead of hard rectangles
- Sidebar: wider, with emoji-style icons next to each nav item

Render as 1536x1024 landscape. Friendly SaaS, gaming flavor via type-badges.`,
  },
  {
    name: "pattern-4-notion-dots",
    title: "P4 — Notion 風 + subtle pokeball dot pattern",
    prompt: `${COMMON_CONTEXT}

**Design direction: Notion inspired — calm, document-like, knowledge-worker.**
- Warm off-white bg (#FDFDFC), minimal borders (only where needed)
- Subtle pokeball-inspired dot pattern as WATERMARK on header band only
  (very faint #F5F5F4 on #FDFDFC, almost invisible)
- Typography: -apple-system with occasional serif touches for section titles
- Accent: muted moss green (#6B8068) for primary, terracotta (#C97B63) for alerts
- Cards: no shadow, 1px border #E7E5E4, generous padding
- Each agent row shows: 28px semi-cartoon Pokemon avatar (not pixel art), name,
  subtle emoji next to department (🔥 for combat agents, 📝 for writers etc.)
- Metric tiles are simple bordered boxes, big number + small label below
- 24h timeline uses thin vertical tick marks (like a ruler) + small solid
  circles for firings, very calm visual
- Sidebar matches Notion's left pane — icon + text, no heavy highlights

Render as 1536x1024 landscape. A knowledge-worker's calm ops dashboard.`,
  },
  {
    name: "pattern-5-vercel-geist",
    title: "P5 — Vercel/Geist 風 モノクロ + accent dots",
    prompt: `${COMMON_CONTEXT}

**Design direction: Vercel Dashboard / Geist UI inspired — black & white minimal.**
- Pure white (#FFFFFF) or pure black option (this mockup should use WHITE/LIGHT)
- Strict monochrome base: black (#000), gray-900 (#111), gray-500, gray-100
- ONE vibrant accent color used only for "live/now" indicators: electric
  blue (#0070F3)
- Geist font throughout, small but readable
- Extremely tight grid, hairline 1px borders (#EAEAEA), no shadows at all
- Pokemon avatars: 28px, rendered in slight duotone (2-color treatment matching
  the monochrome theme) — like Vercel's duotone team avatars
- Status indicators: small solid circles, colored per state (green/amber/gray)
- The 24h timeline is the hero: a wide black-on-white strip with dot firings;
  current time = a single thin electric-blue vertical line with a glow
- Metric tiles: no card chrome, just big black numbers with tiny trend arrows
- Top bar has a small "Pokemon Agents" wordmark in Geist Mono

Render as 1536x1024 landscape. Feels like Vercel shipped a Pokemon product.`,
  },
];

async function generateOne(p: (typeof PATTERNS)[number]) {
  const t0 = Date.now();
  console.log(`▶ start ${p.name}`);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: p.prompt, size: "1536x1024", n: 1 }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`❌ ${p.name}: ${res.status} — ${text.slice(0, 300)}`);
    return { pattern: p.name, ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
  }
  const json = JSON.parse(text) as { data: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (!first) return { pattern: p.name, ok: false, error: "no image" };
  let buf: Buffer;
  if (first.b64_json) buf = Buffer.from(first.b64_json, "base64");
  else if (first.url) {
    const imgRes = await fetch(first.url);
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else return { pattern: p.name, ok: false, error: "no b64 or url" };
  const outPath = resolve(OUT_DIR, `${p.name}.png`);
  writeFileSync(outPath, buf);
  const ms = Date.now() - t0;
  console.log(`✅ ${p.name} (${(buf.length / 1024).toFixed(0)} KB, ${(ms / 1000).toFixed(0)}s)`);
  return { pattern: p.name, ok: true, path: outPath, bytes: buf.length, ms };
}

console.log(`=== Dashboard Mockup v2 (gpt-image-2, parallel x${PATTERNS.length}) ===`);
console.log(`output: ${OUT_DIR}\n`);
const t0 = Date.now();
const results = await Promise.all(PATTERNS.map((p) => generateOne(p).catch((e) => ({ pattern: p.name, ok: false, error: String(e) }))));
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n=== Summary (${elapsed}s total) ===`);
for (const r of results) {
  if (r.ok) console.log(`✅ ${r.pattern}`);
  else console.log(`❌ ${r.pattern}: ${r.error}`);
}
