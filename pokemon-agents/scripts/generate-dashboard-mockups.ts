#!/usr/bin/env bun
/**
 * gpt-image-2 で Pokemon Agents ダッシュボードのデザイン案を3パターン生成する。
 *
 * 生成先: tmp/dashboard-mockups/{pattern-a,pattern-b,pattern-c}.png
 *
 * 使い方: bun pokemon-agents/scripts/generate-dashboard-mockups.ts
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("OPENAI_API_KEY not set");
  process.exit(1);
}

const OUT_DIR = resolve(import.meta.dir, "..", "..", "tmp", "dashboard-mockups");
mkdirSync(OUT_DIR, { recursive: true });

const COMMON_CONTEXT = `
This is a web dashboard called "Pokemon Agents" that monitors 22 autonomous AI agents
working together on a Japanese subsidy (補助金) database website. Each agent is
personified as a different Pokemon (Pidgey, Caterpie, Magnemite, Gengar, Mew, etc.)
and assigned to departments like "記事執筆部", "仮説検証部", "SEO計測部", "監査部".

The dashboard has these main sections visible as a left sidebar:
  - エージェント (Agents: org chart, list, schedule timeline, cost)
  - エージェントログ (Logs: events + reflections)
  - 仮説・検証 (Hypotheses)
  - 自律改善 (Self-improvement)
  - ドメイン知識 (Domain knowledge)

The main content area shows:
  - A 24-hour horizontal timeline of scheduled agent executions
    (each row = one Pokemon agent, dots at firing times, current-time red line)
  - A table listing all agents with columns:
    エージェント | 役割 | 部署 | モデル | スケジュール | 次回起動 | 操作
  - Metric cards at top showing: active agent count, executions today, cost
  - Pokemon avatars next to each agent row (small 32px sprites)

All labels are in Japanese. The overall vibe is a mission-control / operations
dashboard for a fleet of cute autonomous agents.
`;

const PATTERNS = [
  {
    name: "pattern-a-minimal",
    title: "Pattern A — モダン・ミニマル (Linear/Notion風)",
    prompt: `${COMMON_CONTEXT}

Design style: **Modern minimal, Linear/Notion/Vercel-inspired**.
- Ultra-clean white background (#FAFAFA), subtle 1px borders (#E5E7EB)
- Monochrome palette with ONE single accent color (indigo #6366F1)
- Inter / SF Pro typeface, generous white space
- Subtle shadows, no gradients, no decorative illustrations
- The 24-hour timeline uses tiny colored dots aligned on thin grid lines
- Table rows have minimal borders, hover-highlight only
- Pokemon avatars are small circular chips (22px) with soft gray background
- Sidebar is narrow, icon + text, active item has indigo left border stripe
- Metric cards at top are borderless, just large numbers + tiny muted labels

Render this as a full screenshot mockup, 1536x1024 pixels, landscape orientation,
showing the "Agents → Schedule timeline" view as the active page.
Include realistic Japanese text on all labels and buttons.`,
  },
  {
    name: "pattern-b-playful",
    title: "Pattern B — ポケモンゲーム風 (playful)",
    prompt: `${COMMON_CONTEXT}

Design style: **Pokemon game UI inspired, playful and vibrant**.
- Soft pastel background with subtle pokeball-pattern watermark
- Rich palette: red (#EF4444), yellow (#FBBF24), blue (#3B82F6), green (#22C55E)
- Rounded chunky cards with 2px outlined borders (like a Game Boy UI)
- Pixel-art style section dividers, small sprite decorations in corners
- The 24-hour timeline: each Pokemon row is a "pokeball track" with animated-looking dot marks
- Department headers styled like Pokemon gym badges
- Pokemon avatars are slightly larger (40px) with drop shadows, rendered as
  anime-style character portraits (Pikachu, Charmander, etc.)
- Sidebar items have colored icon chips matching each section
- Typography: rounded sans-serif, slightly playful (like Nintendo DS menus)

Render as a full screenshot mockup, 1536x1024 pixels, landscape orientation,
showing the "Agents → List" view with a visible tree structure (supervisor
→ subordinates) and colorful department chips. All labels in Japanese.`,
  },
  {
    name: "pattern-c-mission-control",
    title: "Pattern C — ダーク・ミッションコントロール (Grafana/Sentry風)",
    prompt: `${COMMON_CONTEXT}

Design style: **Dark mission-control / observability cockpit, Grafana + Sentry inspired**.
- Deep near-black background (#0A0E1A), panels are slightly lighter (#111827)
- Neon green (#10B981), amber (#F59E0B), and cyan (#06B6D4) accent colors
- Monospace JetBrains Mono for numbers and log data, sans-serif for headings
- Dense information display with grid lines and subtle glows on active elements
- The 24-hour timeline is the centerpiece: wide dark panel, bright dots, a
  vertical red "NOW" line glowing across all rows
- Table rows are compact (28px), zebra-striped with #1F2937
- Pokemon avatars shown as small rounded thumbnails, de-saturated to fit dark theme,
  with a tiny colored status dot (green/amber/red) in the corner
- Top bar has metric tiles with big glowing numbers + sparkline charts
- Sidebar is very narrow (collapsed), icon-only
- Console-like bottom drawer shows recent hook events streaming

Render as a full screenshot mockup, 1536x1024 pixels, landscape orientation,
showing a dense heads-up view with multiple panels (timeline + table + metrics +
event stream). All labels in Japanese.`,
  },
];

async function generateOne(p: (typeof PATTERNS)[number]) {
  console.log(`\n▶ ${p.title}`);
  console.log(`  generating...`);
  const t0 = Date.now();

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: p.prompt,
      size: "1536x1024",
      n: 1,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`  ❌ ${res.status} ${res.statusText}`);
    console.error(`  body: ${text.slice(0, 500)}`);
    return { pattern: p.name, ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
  }

  const json = JSON.parse(text) as { data: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (!first) {
    console.error(`  ❌ no image in response`);
    return { pattern: p.name, ok: false, error: "no image in response" };
  }

  let buf: Buffer;
  if (first.b64_json) {
    buf = Buffer.from(first.b64_json, "base64");
  } else if (first.url) {
    const imgRes = await fetch(first.url);
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else {
    return { pattern: p.name, ok: false, error: "no b64 or url" };
  }

  const outPath = resolve(OUT_DIR, `${p.name}.png`);
  writeFileSync(outPath, buf);
  const ms = Date.now() - t0;
  console.log(`  ✅ saved ${outPath} (${(buf.length / 1024).toFixed(0)} KB, ${ms}ms)`);
  return { pattern: p.name, ok: true, path: outPath, bytes: buf.length, ms };
}

async function main() {
  console.log(`=== Dashboard Mockup Generator (gpt-image-2) ===`);
  console.log(`output dir: ${OUT_DIR}`);
  const results = [];
  for (const p of PATTERNS) {
    results.push(await generateOne(p));
  }
  console.log(`\n=== Summary ===`);
  for (const r of results) {
    if (r.ok) console.log(`✅ ${r.pattern}: ${r.path}`);
    else console.log(`❌ ${r.pattern}: ${r.error}`);
  }
}

await main();
