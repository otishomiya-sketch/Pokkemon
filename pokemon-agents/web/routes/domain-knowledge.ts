import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { escapeHtml } from "../components/layout";

/**
 * ドメイン知識 — 階層化された Markdown ドキュメント (docs/knowledge/)
 *
 * データソース:
 *   - docs/knowledge 配下の再帰 .md ファイル
 *   - YAML frontmatter でメタデータ (applicable_agents, confidence, evidence_hypothesis_ids 等)
 *
 * 左: ディレクトリツリー、右: 選択されたファイルの Markdown コンテンツを記事風に表示
 *
 * エージェントが起動時に自分の slug が applicable_agents に含まれるドキュメントを読み込み、
 * 既知の勝ちパターン・失敗パターンを前提に動く。これが自律改善ループ。
 */

const KNOWLEDGE_ROOT = resolve(import.meta.dir, "..", "..", "..", "docs", "knowledge");

/**
 * docs/knowledge/ 配下の全 .md をスキャンして knowledge_index テーブルを rebuild。
 * サーバ起動時 + /api/reindex-knowledge で呼ばれる。
 */
export function reindexKnowledge(db: Database): { scanned: number; indexed: number } {
  const allFiles = collectMarkdownFiles(KNOWLEDGE_ROOT, KNOWLEDGE_ROOT);
  // 既存を全削除 → rebuild (ファイル数少ないので全置換で OK)
  db.run("DELETE FROM knowledge_index");
  const stmt = db.prepare(`
    INSERT INTO knowledge_index (path, title, category, agent_slugs, priority, confidence, status, last_validated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
  `);
  let indexed = 0;
  for (const relPath of allFiles) {
    try {
      const raw = readFileSync(resolve(KNOWLEDGE_ROOT, relPath), "utf-8");
      const { frontmatter } = parseFrontmatter(raw);
      const category = relPath.includes("/") ? relPath.split("/")[0] : "root";
      stmt.run(
        relPath,
        frontmatter.title || relPath,
        frontmatter.category || category,
        frontmatter.applicable_agents ? JSON.stringify(frontmatter.applicable_agents) : null,
        frontmatter.priority === "required" ? "required" : "reference",
        frontmatter.confidence ?? null,
        frontmatter.status || "active",
        frontmatter.last_validated_at || null,
      );
      indexed++;
    } catch (err) {
      console.warn(`[knowledge] failed to index ${relPath}:`, err);
    }
  }
  console.log(`[knowledge] reindexed ${indexed}/${allFiles.length} documents`);
  return { scanned: allFiles.length, indexed };
}

function collectMarkdownFiles(currentPath: string, rootPath: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = resolve(currentPath, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      results.push(...collectMarkdownFiles(full, rootPath));
    } else if (entry.endsWith(".md")) {
      results.push(relative(rootPath, full));
    }
  }
  return results;
}

interface Frontmatter {
  title?: string;
  category?: string;
  applicable_agents?: string[];
  confidence?: number;
  evidence_hypothesis_ids?: number[];
  test_count?: number;
  win_count?: number;
  last_validated_at?: string;
  status?: string;
  source?: string;
}

interface KnowledgeDoc {
  path: string;        // docs/knowledge 相対パス
  title: string;
  category: string;
  frontmatter: Frontmatter;
  body: string;
}

export function renderDomainKnowledge(db: Database, params: URLSearchParams): string {
  const selectedPath = params.get("doc") || "_index.md";
  const agentFilter = params.get("agent") || "";
  const priorityFilter = params.get("priority") || "";

  // エージェント一覧 (フィルタ用)
  const agentList = db
    .query<{ slug: string; pokemon_jp: string | null }, []>(
      `SELECT slug, pokemon_jp FROM agents ORDER BY department, slug`,
    )
    .all();

  // 絞り込み条件に該当するパスリスト (左ツリーでハイライト用)
  let filteredPaths: Set<string> | null = null;
  if (agentFilter || priorityFilter) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (agentFilter) {
      where.push(`agent_slugs LIKE ?`);
      args.push(`%"${agentFilter}"%`);
    }
    if (priorityFilter) {
      where.push(`priority = ?`);
      args.push(priorityFilter);
    }
    const rows = db
      .query<{ path: string }, never[]>(`SELECT path FROM knowledge_index WHERE ${where.join(" AND ")}`)
      .all(...(args as never[]));
    filteredPaths = new Set(rows.map((r) => r.path));
  }

  const filterBar = `<div class="list-toolbar">
    <form method="GET" action="/knowledge" style="display:inline-flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <input type="hidden" name="doc" value="${escapeHtml(selectedPath)}">
      <select name="agent" class="list-sort-select" onchange="this.form.submit()">
        <option value="">エージェント (全て)</option>
        ${agentList.map((a) => `<option value="${escapeHtml(a.slug)}" ${a.slug === agentFilter ? "selected" : ""}>${escapeHtml(a.pokemon_jp || a.slug)}</option>`).join("")}
      </select>
      <select name="priority" class="list-sort-select" onchange="this.form.submit()">
        <option value="">優先度 (全て)</option>
        <option value="required" ${priorityFilter === "required" ? "selected" : ""}>必読</option>
        <option value="reference" ${priorityFilter === "reference" ? "selected" : ""}>参考</option>
      </select>
      ${agentFilter || priorityFilter ? `<a href="/knowledge" class="btn sm">クリア</a>` : ""}
    </form>
  </div>`;

  const tree = buildTree(KNOWLEDGE_ROOT);
  const treeHtml = renderTree(tree, selectedPath, filteredPaths);

  // エージェントメタ (slug → pokemon_jp + avatar_url)
  const agentMetaRows = db
    .query<{ slug: string; pokemon_jp: string; avatar_url: string | null; pokemon_slug: string }, []>(
      `SELECT slug, pokemon_jp, avatar_url, pokemon_slug FROM agents`,
    )
    .all();
  const agentMetaMap = new Map<string, { pokemon_jp: string; avatar_url: string | null }>();
  for (const r of agentMetaRows) {
    agentMetaMap.set(r.slug, { pokemon_jp: r.pokemon_jp, avatar_url: r.avatar_url });
    agentMetaMap.set(r.pokemon_slug, { pokemon_jp: r.pokemon_jp, avatar_url: r.avatar_url });
  }

  let docHtml: string;
  try {
    const doc = readDoc(selectedPath);
    docHtml = renderDoc(doc, agentMetaMap);
  } catch (err) {
    docHtml = `<div class="section empty"><p class="muted">ドキュメントが見つかりません: ${escapeHtml(selectedPath)}</p></div>`;
  }

  return `
<div class="page-header">
  <div>
    <div class="page-kicker">Knowledge Base</div>
    <h1>ドメイン知識</h1>
  </div>
</div>

${filterBar}

<div class="knowledge-layout">
  <aside class="knowledge-tree">
    <h3 class="tree-head">📂 ドキュメント</h3>
    ${treeHtml}
  </aside>
  <main class="knowledge-doc">
    ${docHtml}
  </main>
</div>

<style>
.knowledge-layout { display: grid; grid-template-columns: 260px 1fr; gap: 20px; align-items: start; }
.knowledge-tree { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; position: sticky; top: 16px; max-height: calc(100vh - 80px); overflow-y: auto; }
.tree-head { margin: 0 0 10px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.tree-folder { margin: 10px 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
.tree-item { display: block; padding: 5px 8px; font-size: 13px; border-radius: 6px; color: var(--fg); margin-left: 8px; }
.tree-item:hover { background: var(--sidebar-hover); }
.tree-item.active { background: var(--sidebar-active); font-weight: 600; color: var(--primary); }
.tree-item.dimmed { opacity: 0.35; }
.tree-item.dimmed:hover { opacity: 1; }
.tree-root { display: block; padding: 5px 8px; font-size: 13px; font-weight: 600; border-radius: 6px; }
.tree-root.active { background: var(--sidebar-active); color: var(--primary); }
.knowledge-doc { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 28px 32px; min-height: 400px; }
.knowledge-doc .doc-header { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.knowledge-doc .doc-meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.knowledge-doc .doc-agents { margin-top: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.knowledge-doc .agent-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.knowledge-doc .agent-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 4px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; font-size: 12.5px; }
.knowledge-doc .md-body { font-size: 14.5px; line-height: 1.8; }
.knowledge-doc .md-body h1 { font-size: 24px; margin: 0 0 16px; }
.knowledge-doc .md-body h2 { font-size: 18px; margin-top: 24px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.knowledge-doc .md-body h3 { font-size: 15px; margin-top: 20px; }
.knowledge-doc .md-body table { width: 100%; margin: 12px 0; }
.knowledge-doc .md-body table th { background: var(--bg); padding: 8px 12px; font-size: 12.5px; }
.knowledge-doc .md-body table td { padding: 8px 12px; font-size: 13.5px; }
.knowledge-doc .md-body code { font-size: 13px; }
@media (max-width: 900px) { .knowledge-layout { grid-template-columns: 1fr; } .knowledge-tree { position: static; max-height: none; } }
</style>

<script>
// Markdown レンダリング (サーバ側で raw md → HTML にして埋め込むと安定性下がるため client 側 marked 使用)
(() => {
  const docEl = document.getElementById('knowledge-md-body');
  if (!docEl) return;
  const raw = docEl.getAttribute('data-md');
  if (raw && typeof marked !== 'undefined' && marked.parse) {
    try {
      docEl.innerHTML = marked.parse(raw, { breaks: true, gfm: true });
    } catch(e) { console.warn('marked error', e); }
  }
})();
</script>
`;
}

interface TreeNode {
  kind: "dir" | "file";
  name: string;                // 表示名
  path: string;                // docs/knowledge 相対パス (files only)
  children?: TreeNode[];        // dirs only
  title?: string;              // frontmatter.title (files only)
}

function buildTree(rootPath: string): TreeNode[] {
  return walkDir(rootPath, rootPath);
}

function walkDir(currentPath: string, rootPath: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    return nodes;
  }

  for (const entry of entries.sort()) {
    const full = resolve(currentPath, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      nodes.push({
        kind: "dir",
        name: entry,
        path: relative(rootPath, full),
        children: walkDir(full, rootPath),
      });
    } else if (entry.endsWith(".md")) {
      const rel = relative(rootPath, full);
      const { title } = parseFrontmatterQuick(full);
      nodes.push({ kind: "file", name: entry, path: rel, title: title || entry });
    }
  }
  return nodes;
}

function parseFrontmatterQuick(fullPath: string): { title: string | null } {
  try {
    const text = readFileSync(fullPath, "utf-8");
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return { title: null };
    const tm = m[1].match(/^title:\s*(.+)$/m);
    return { title: tm ? tm[1].trim().replace(/^["']|["']$/g, "") : null };
  } catch {
    return { title: null };
  }
}

function renderTree(nodes: TreeNode[], selectedPath: string, filteredPaths: Set<string> | null): string {
  // 絞り込みフィルタ: filteredPaths に含まれないファイルは薄くする (hidden はせず、関連性だけ明示)
  const itemClass = (filePath: string) => {
    let c = "tree-item";
    if (selectedPath === filePath) c += " active";
    if (filteredPaths && !filteredPaths.has(filePath)) c += " dimmed";
    return c;
  };

  const rootIndex = nodes.find((n) => n.kind === "file" && n.name === "_index.md");
  const dirs = nodes.filter((n) => n.kind === "dir");
  const others = nodes.filter((n) => n.kind === "file" && n.name !== "_index.md");

  let html = "";
  if (rootIndex) {
    const active = selectedPath === rootIndex.path;
    html += `<a href="/knowledge?doc=${encodeURIComponent(rootIndex.path)}" class="tree-root ${active ? "active" : ""}">🏠 目次</a>`;
  }
  for (const other of others) {
    html += `<a href="/knowledge?doc=${encodeURIComponent(other.path)}" class="${itemClass(other.path)}">📄 ${escapeHtml(other.title || other.name)}</a>`;
  }
  for (const dir of dirs) {
    const categoryIndex = dir.children?.find((c) => c.kind === "file" && c.name === "_index.md");
    const categoryTitle = categoryIndex?.title || dir.name;
    const catHref = categoryIndex
      ? `/knowledge?doc=${encodeURIComponent(categoryIndex.path)}`
      : "#";
    const catActive = categoryIndex && selectedPath === categoryIndex.path;
    html += `<div class="tree-folder"><a href="${catHref}" class="${catActive ? "active" : ""}" style="color:inherit;text-decoration:none;">📁 ${escapeHtml(categoryTitle)}</a></div>`;
    const files = (dir.children || []).filter((c) => c.kind === "file" && c.name !== "_index.md");
    for (const f of files) {
      html += `<a href="/knowledge?doc=${encodeURIComponent(f.path)}" class="${itemClass(f.path)}">📄 ${escapeHtml(f.title || f.name)}</a>`;
    }
  }
  return html;
}

function readDoc(relPath: string): KnowledgeDoc {
  const fullPath = resolve(KNOWLEDGE_ROOT, relPath);
  // 安全のため docs/knowledge 配下に限定
  if (!fullPath.startsWith(KNOWLEDGE_ROOT)) {
    throw new Error("Invalid path");
  }
  const raw = readFileSync(fullPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const category = dirname(relPath) === "." ? "root" : dirname(relPath);
  return {
    path: relPath,
    title: frontmatter.title || relPath,
    category,
    frontmatter,
    body,
  };
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const yaml = m[1];
  const body = m[2];
  const fm: Frontmatter = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val: string = kv[2].trim();
    // 配列 [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      const items = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      (fm as Record<string, unknown>)[key] = items.every((i) => /^\d+$/.test(i))
        ? items.map((n) => Number(n))
        : items;
    } else {
      const stripped = val.replace(/^["']|["']$/g, "");
      // 数値推定
      if (/^-?\d+(\.\d+)?$/.test(stripped)) {
        (fm as Record<string, unknown>)[key] = Number(stripped);
      } else {
        (fm as Record<string, unknown>)[key] = stripped;
      }
    }
  }
  return { frontmatter: fm, body };
}

function renderDoc(doc: KnowledgeDoc, agentMetaMap: Map<string, { pokemon_jp: string; avatar_url: string | null }>): string {
  const fm = doc.frontmatter;
  const pathLabel = doc.path === "_index.md" ? "目次" : doc.path;

  // 優先度バッジ (必読 / 参考)
  const priorityBadge = fm.priority === "required"
    ? '<span class="badge failed" style="font-weight:600;">⭐ 必読</span>'
    : fm.priority === "reference"
      ? '<span class="badge queued">📖 参考</span>'
      : "";

  // 廃止時のみ状態バッジ表示 (active は表示しない)
  const statusBadge = fm.status && fm.status !== "active"
    ? `<span class="badge failed">⚠️ ${escapeHtml(fm.status)}</span>`
    : "";

  // 適用エージェント (アバター + 日本語名のチップ列)
  const agentChips = (fm.applicable_agents || []).map((slug) => {
    const meta = agentMetaMap.get(slug);
    if (meta) {
      const avatar = meta.avatar_url
        ? `<img src="${escapeHtml(meta.avatar_url)}" width="22" height="22" style="border-radius:4px;background:#f3f4f6;">`
        : `<span style="display:inline-block;width:22px;height:22px;background:#e4e4e7;border-radius:4px;"></span>`;
      return `<span class="agent-chip">${avatar}<span>${escapeHtml(meta.pokemon_jp)}</span></span>`;
    }
    return `<span class="agent-chip"><span class="muted">${escapeHtml(slug)}</span></span>`;
  }).join("");

  const agentsRow = agentChips
    ? `<div class="doc-agents">
         <span class="muted small">👥 このドキュメントを読むエージェント:</span>
         <div class="agent-chips">${agentChips}</div>
       </div>`
    : "";

  return `
    <div class="doc-header">
      <div class="doc-meta">
        <span class="mono tiny muted">📄 ${escapeHtml(pathLabel)}</span>
        ${priorityBadge}
        ${statusBadge}
      </div>
      ${agentsRow}
    </div>
    <article class="md-body" id="knowledge-md-body" data-md="${escapeHtml(doc.body)}"></article>
  `;
}
