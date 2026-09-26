#!/usr/bin/env bun
// seed-agents-from-md.ts
//
// .claude/agents/_{dept}/{agent-name}/agent.md を全部読んで agents テーブルに INSERT/UPDATE。
// agent_edges (reports_to / reviews / triggers) も CLAUDE.md の記述を元に設定。
//
// idempotent: 既存 row は instructions_hash が一致すれば skip、変化あれば UPDATE + agent_revisions に記録。

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DB_PATH = process.env.AGENTS_DB_PATH || resolve(REPO_ROOT, ".claude/db/agents.db");
const AGENTS_DIR = resolve(REPO_ROOT, ".claude/agents");

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

interface Frontmatter {
  name?: string;
  description?: string;
  model?: string;
  pokemon_slug?: string;
  pokemon_jp?: string;
  role?: string;
  role_label?: string;
  timeout_sec?: number;
}

function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  const fm: Frontmatter = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.+?)\s*$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.replace(/^["']|["']$/g, "");
    if (k === "timeout_sec") (fm as any)[k] = Number(val);
    else (fm as any)[k] = val;
  }
  return { fm, body: m[2] };
}

function normalizeRole(raw: string | undefined, slug: string): string {
  const r = (raw || "").toLowerCase();
  const s = slug.toLowerCase();

  // frontmatter で明示された主要 role はそのまま尊重 (slug 推定より優先)
  if (["reviewer", "orchestrator", "supervisor", "solo"].includes(r)) return r;

  // slug に明確に含まれるキーワードを優先 (frontmatter が "worker" のまま残ってるケースが多い)
  if (s.includes("reviewer") || s.includes("review")) return "reviewer";
  if (s.includes("orchestrator") || s.includes("-sync")) return "orchestrator";
  if (s.includes("writer")) return "writer";
  if (s.includes("publisher")) return "publisher";
  if (s.includes("validator")) return "validator";
  if (s.includes("hypothesizer")) return "hypothesizer";
  if (s.includes("selector")) return "selector";
  if (s.includes("supervisor")) return "supervisor";
  if (s.includes("executor")) return "executor";
  if (s.includes("research")) return "researcher";
  if (s.includes("optimizer") || s.includes("refine")) return "optimizer";
  if (s.includes("outreach")) return "outreach";
  if (s.includes("audit") || s.includes("monitor")) return "auditor";

  // slug に該当なしなら frontmatter の role を使う
  if (["writer", "worker"].includes(r)) return "writer";
  if (r === "reviewer") return "reviewer";
  if (r === "publisher") return "publisher";
  if (["orchestrator", "leader"].includes(r)) return "orchestrator";
  if (r === "validator" || r === "stage1") return "validator";
  if (r === "hypothesizer" || r === "stage2") return "hypothesizer";
  if (r === "selector" || r === "stage3") return "selector";
  if (r === "supervisor") return "supervisor";
  if (r === "executor") return "executor";
  if (r === "researcher") return "researcher";
  if (r === "optimizer") return "optimizer";
  if (r === "outreach") return "outreach";
  if (r === "auditor") return "auditor";
  return "solo";
}

function listAgentMdPaths(root: string): string[] {
  const result: string[] = [];
  // フラット定義: root 直下の <name>.md (例: butterfree-subsidy-sync.md)
  // フォルダ定義: <name>/agent.md (references/ や scripts/ 内の .md は拾わない)
  // _shared/ (guidance-protocol.md 等) は agent 定義ではないので除外
  for (const entry of readdirSync(root)) {
    if (entry === "_shared") continue;
    const p = resolve(root, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      const agentMd = resolve(p, "agent.md");
      try {
        if (statSync(agentMd).isFile()) result.push(agentMd);
      } catch {
        /* agent.md なしのフォルダはスキップ */
      }
    } else if (entry.endsWith(".md")) {
      result.push(p);
    }
  }
  return [...new Set(result)].sort();
}

// アイコンは PokéAPI の公式アート (GitHub 公開 CDN・図鑑番号で決まる・消えない) を使う。
// 旧 Supabase バケットは消滅したため移行 (2026-06-24)。
const POKEAPI_ART = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork";
// pokemon_slug → 全国図鑑番号 (mega-gengar はメガフォーム id 10038)
const DEX: Record<string, number> = {
  abra: 63, arceus: 493, butterfree: 12, caterpie: 10, delibird: 225, gastly: 92,
  gengar: 94, haunter: 93, kadabra: 64, magnemite: 81, magneton: 82, magnezone: 462,
  "mega-gengar": 10038, metapod: 11, mew: 151, mewtwo: 150, pidgeot: 18, pidgeotto: 17,
  pidgey: 16, "pidgey-solo": 16, pinsir: 127, porygon: 137, scizor: 212, shuckle: 213,
  starmie: 121, vulpix: 37,
};
function avatarUrlFor(pokemonSlug: string): string | null {
  const id = DEX[pokemonSlug];
  return id ? `${POKEAPI_ART}/${id}.png` : null;
}

const ROLE_LABELS: Record<string, string> = {
  "butterfree-subsidy-sync": "補助金パイプライン統括",
  "caterpie-subsidy-writer": "補助金記事ライター",
  "metapod-subsidy-reviewer": "補助金記事レビュアー",
  "scizor-guide-writer": "補助金ガイド執筆",
  "magnezone-benefit-orchestrator": "給付金パイプライン統括",
  "magnemite-benefit-writer": "給付金記事ライター",
  "magneton-kyufukin": "給付金記事レビュアー",
  "pidgeot-editorial": "記事編集パイプライン統括",
  "pidgey-editorial-writer": "記事編集ライター",
  "pidgeotto-editorial-reviewer": "記事編集レビュアー",
  "megagengar-orchestrator": "仮説ライン統括",
  "haunter-hypothesizer": "仮説生成 (Axis A)",
  "gastly-validator": "仮説検証 (Axis A)",
  "gengar-selector": "仮説選抜 (Axis A)",
  "mew-supervisor": "運用観測 (Axis B)",
  "mewtwo-executor": "運用改修実行 (Axis B)",
  "pinsir-permit-writer": "許認可記事ライター",
  "porygon-keyword-research": "キーワード調査",
  "starmie-expert-outreach": "専門家アウトリーチ",
  "abra-seo-report": "SEOレポート",
  "kadabra-rank-monitor": "検索順位モニタリング",
  "vulpix-note-publisher": "note 配信 (被リンク)",
  "shuckle-hatena-publisher": "はてなブログ配信 (被リンク)",
  "delibird-chat": "対話AI (サイト内チャット)",
};

interface AgentDef {
  slug: string;
  pokemon_slug: string;
  pokemon_jp: string;
  display_name: string;
  role: string;
  role_label: string | null;
  department: string;
  model: string;
  source_md_path: string;
  instructions: string;
  instructions_hash: string;
  config: string;
  avatar_url: string | null;
}

function parseAgentMd(mdPath: string): AgentDef {
  const content = readFileSync(mdPath, "utf-8");
  const { fm } = parseFrontmatter(content);
  const rel = mdPath.replace(REPO_ROOT + "/", "");
  const parts = rel.split("/"); // .claude/agents/<slug>/agent.md (フラット化済)
  const dirSlug = parts[2] || "";
  const slug = fm.name || dirSlug;
  // department は frontmatter が SSOT (フラット化前は path から推定してた)
  const dept = (fm.department || "").replace(/^_/, "");
  const pokemon_slug = fm.pokemon_slug || slug.split("-")[0];
  const pokemon_jp = fm.pokemon_jp || pokemon_slug;
  const role = normalizeRole(fm.role, slug);
  const model = fm.model || "sonnet";
  const hash = createHash("sha256").update(content).digest("hex");
  return {
    slug,
    pokemon_slug,
    pokemon_jp,
    display_name: `${pokemon_jp} (${slug})`,
    role,
    role_label: fm.role_label || null,
    department: dept,
    model,
    source_md_path: rel,
    instructions: content,
    instructions_hash: hash,
    config: JSON.stringify({ timeout_sec: fm.timeout_sec || 1800 }),
    avatar_url: avatarUrlFor(pokemon_slug),
  };
}

function upsertAgent(def: AgentDef): { id: number; created: boolean; updated: boolean } {
  const existing = db
    .query<
      {
        id: number; instructions_hash: string; version: number; instructions: string;
        source_md_path: string | null; role: string | null; role_label: string | null;
        department: string | null; model: string | null; config: string | null;
        pokemon_slug: string | null; pokemon_jp: string | null; display_name: string | null;
        avatar_url: string | null;
      },
      [string]
    >(`SELECT id, instructions_hash, version, instructions, source_md_path, role, role_label,
              department, model, config, pokemon_slug, pokemon_jp, display_name, avatar_url
       FROM agents WHERE slug=?`)
    .get(def.slug);

  if (!existing) {
    const r = db
      .query<{ id: number }, [string, string, string, string, string, string | null, string, string, string, string, string, string, string]>(
        `INSERT INTO agents (slug, pokemon_slug, pokemon_jp, display_name, role, role_label, department, model,
                             source_md_path, instructions, instructions_hash, version, config, status, avatar_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', ?) RETURNING id`,
      )
      .get(
        def.slug,
        def.pokemon_slug,
        def.pokemon_jp,
        def.display_name,
        def.role,
        def.role_label,
        def.department,
        def.model,
        def.source_md_path,
        def.instructions,
        def.instructions_hash,
        def.config,
        def.avatar_url,
      ) as { id: number };
    db.run(
      `INSERT INTO agent_revisions (agent_id, version, new_instructions, changed_by, reason)
       VALUES (?, 1, ?, 'seed:agents-from-md', 'initial-seed')`,
      [r.id, def.instructions],
    );
    return { id: r.id, created: true, updated: false };
  }

  if (existing.instructions_hash === def.instructions_hash) {
    // instructions 本文は同一。ただし source_md_path / role / model などのメタ情報が
    // ズレている場合 (例: agent.md のリネーム・フラット化) は、version を上げず revision も
    // 作らずにメタだけ同期する。これがないと live DB が旧パスを指したまま agent_md_missing になる。
    const metaDrift =
      existing.source_md_path !== def.source_md_path ||
      existing.role !== def.role ||
      existing.role_label !== def.role_label ||
      existing.department !== def.department ||
      existing.model !== def.model ||
      existing.config !== def.config ||
      existing.pokemon_slug !== def.pokemon_slug ||
      existing.pokemon_jp !== def.pokemon_jp ||
      existing.display_name !== def.display_name ||
      existing.avatar_url !== def.avatar_url;
    if (!metaDrift) return { id: existing.id, created: false, updated: false };
    db.run(
      `UPDATE agents SET
         pokemon_slug=?, pokemon_jp=?, display_name=?, role=?, role_label=?, department=?, model=?,
         source_md_path=?, config=?, avatar_url=?, updated_at=datetime('now','localtime')
       WHERE id=?`,
      [
        def.pokemon_slug, def.pokemon_jp, def.display_name, def.role, def.role_label,
        def.department, def.model, def.source_md_path, def.config, def.avatar_url, existing.id,
      ],
    );
    return { id: existing.id, created: false, updated: true };
  }

  // hash differ → UPDATE + revision
  db.run(
    `UPDATE agents SET
       pokemon_slug=?, pokemon_jp=?, display_name=?, role=?, role_label=?, department=?, model=?,
       source_md_path=?, instructions=?, instructions_hash=?, version=version+1,
       config=?, avatar_url=?, updated_at=datetime('now','localtime')
     WHERE id=?`,
    [
      def.pokemon_slug,
      def.pokemon_jp,
      def.display_name,
      def.role,
      def.role_label,
      def.department,
      def.model,
      def.source_md_path,
      def.instructions,
      def.instructions_hash,
      def.config,
      def.avatar_url,
      existing.id,
    ],
  );
  db.run(
    `INSERT INTO agent_revisions (agent_id, version, prev_instructions, new_instructions, changed_by, reason)
     VALUES (?, ?, ?, ?, 'seed:agents-from-md', 'md-sync')`,
    [existing.id, existing.version + 1, existing.instructions, def.instructions],
  );
  return { id: existing.id, created: false, updated: true };
}

// ============================================================================
// Edges (reports_to / reviews / triggers) — CLAUDE.md の構成から導出
// ============================================================================
const EDGES: Array<{ sup: string; sub: string; type: string }> = [
  // Subsidy pipeline (Writer → Reviewer → Orchestrator)
  { sup: "butterfree-subsidy-sync", sub: "caterpie-subsidy-writer", type: "supervises" },
  { sup: "butterfree-subsidy-sync", sub: "metapod-subsidy-reviewer", type: "supervises" },
  { sup: "metapod-subsidy-reviewer", sub: "caterpie-subsidy-writer", type: "reviews" },

  // Benefit pipeline
  { sup: "magnezone-benefit-orchestrator", sub: "magnemite-benefit-writer", type: "supervises" },
  { sup: "magnezone-benefit-orchestrator", sub: "magneton-kyufukin", type: "supervises" },
  { sup: "magneton-kyufukin", sub: "magnemite-benefit-writer", type: "reviews" },

  // Editorial pipeline
  { sup: "pidgeot-editorial", sub: "pidgey-editorial-writer", type: "supervises" },
  { sup: "pidgeot-editorial", sub: "pidgeotto-editorial-reviewer", type: "supervises" },
  { sup: "pidgeotto-editorial-reviewer", sub: "pidgey-editorial-writer", type: "reviews" },

  // Hypothesis pipeline (Axis A)
  { sup: "megagengar-orchestrator", sub: "gastly-validator", type: "supervises" },
  { sup: "megagengar-orchestrator", sub: "haunter-hypothesizer", type: "supervises" },
  { sup: "megagengar-orchestrator", sub: "gengar-selector", type: "supervises" },
  { sup: "haunter-hypothesizer", sub: "gastly-validator", type: "triggers" },
  { sup: "gengar-selector", sub: "haunter-hypothesizer", type: "triggers" },

  // Control / Self-improvement (Axis B)
  { sup: "mew-supervisor", sub: "mewtwo-executor", type: "triggers" },
];

function upsertEdges(slugToId: Map<string, number>) {
  db.run(`DELETE FROM agent_edges`); // idempotent full replace
  for (const e of EDGES) {
    const supId = slugToId.get(e.sup);
    const subId = slugToId.get(e.sub);
    if (!supId || !subId) {
      console.warn(`[seed] edge skipped: ${e.sup} → ${e.sub} (missing)`);
      continue;
    }
    db.run(
      `INSERT OR REPLACE INTO agent_edges (supervisor_id, subordinate_id, edge_type) VALUES (?, ?, ?)`,
      [supId, subId, e.type],
    );
  }
}

// ============================================================================
// Main
// ============================================================================
console.log(`[seed] db=${DB_PATH}`);
console.log(`[seed] agents_dir=${AGENTS_DIR}`);

const paths = listAgentMdPaths(AGENTS_DIR);
console.log(`[seed] found ${paths.length} agent.md files`);

let created = 0;
let updated = 0;
let unchanged = 0;
const slugToId = new Map<string, number>();

db.transaction(() => {
  for (const mdPath of paths) {
    const def = parseAgentMd(mdPath);
    const r = upsertAgent(def);
    slugToId.set(def.slug, r.id);
    if (r.created) {
      created++;
      console.log(`[seed] ✓ created: ${def.slug} (${def.pokemon_jp}, dept=${def.department}, role=${def.role})`);
    } else if (r.updated) {
      updated++;
      console.log(`[seed] ↻ updated: ${def.slug}`);
    } else {
      unchanged++;
    }
  }
  upsertEdges(slugToId);
})();

console.log(`\n[seed] done: ${created} created, ${updated} updated, ${unchanged} unchanged`);
console.log(`[seed] edges: ${EDGES.length} configured`);
db.close();
