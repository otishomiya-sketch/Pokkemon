#!/usr/bin/env bun
/**
 * v2 で失敗した 2 パターンを並列リトライ (P3 はモデレーション回避のため言い換え)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) process.exit(1);
const OUT_DIR = resolve(import.meta.dir, "..", "..", "tmp", "dashboard-mockups", "v2");
mkdirSync(OUT_DIR, { recursive: true });

const COMMON_CONTEXT = `
This is a web dashboard for "Pokemon Agents" — an internal ops console for 22
autonomous AI agents running a Japanese subsidy (補助金) database website.
Each agent is personified as a cute creature character (small mascot avatars).

The dashboard must feel like a serious SaaS product (Linear / Stripe / Vercel /
Notion / Raycast) — clean typography, generous white space, proper data density,
refined shadows, tasteful use of color. But it has a SUBTLE playful layer: tiny
mascot avatars next to agent names, gentle accent colors. Playful is a garnish,
not the main dish.

Left sidebar in Japanese: エージェント / エージェントログ / 仮説・検証 / 自律改善 / ドメイン知識
Main content: metric tiles, 24h schedule timeline (agent rows × time dots with
vertical red "NOW" line), dense table with columns エージェント / 役割 / 部署 /
モデル / スケジュール / 次回起動 / 操作, small 24-28px mascot avatars per row.

All Japanese labels. Full 1536x1024 landscape screenshot mockup.
`;

const PATTERNS = [
  {
    name: "pattern-1-linear-saas",
    prompt: `${COMMON_CONTEXT}

**Design direction: Linear.app / Height.app inspired.**
- Near-white background (#FBFBFD), 1px borders (#E4E4E7), subtle inner shadows
- Single purple-indigo accent (#5E5CE6) used sparingly — only for primary CTA,
  active sidebar item, and the "NOW" timeline line
- Inter font, tight 14px body / 12px meta
- Metric tiles: borderless, huge number + tiny trend arrow
- Table: tight 32px row height, hover highlight only, zebra-free
- Mascot avatars: 24px pixel-art style chip on #F3F4F6 background
- Department column: small colored dot + text (color coded by department)
- 24h timeline is compressed, clean grid ticks every 3 hours
- Feels like a Linear issue tracker but the assignees are cute mascots

Render 1536x1024 landscape, showing "Agents → Schedule" as active view.`,
  },
  {
    name: "pattern-3-raycast-soft",
    prompt: `${COMMON_CONTEXT}

**Design direction: Raycast / Arc browser inspired — soft rounded SaaS.**
- Off-white (#FAFAFA) background with a very subtle vertical gradient
- Heavily rounded corners (16px cards, 8px buttons)
- Soft drop shadows, slight glass/blur effect on the top bar
- Accent: warm coral (#FF6363) primary, lavender (#B4A7FF) secondary
- Department badges use gentle category colors — pill-shaped with tiny icon:
  red for writing team, blue for research team, green for review team,
  purple for strategy team
- Mascot avatars: 32px with soft gradient circular background tinted by team
- Typography is slightly softer (SF Pro Rounded vibe)
- Metric tiles feature a soft gradient accent stripe at the top
- 24h timeline uses rounded pill bars instead of sharp rectangles
- Sidebar is wider, with friendly emoji-style icons per nav item

Render 1536x1024 landscape. Friendly SaaS with a gentle playful accent.`,
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
  if (!res.ok) { console.error(`❌ ${p.name} ${res.status}: ${text.slice(0, 250)}`); return; }
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

await Promise.all(PATTERNS.map((p) => gen(p).catch((e) => console.error(`ex ${p.name}:`, e))));
console.log("done");
