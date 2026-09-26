import type { Database } from "bun:sqlite";
import { escapeHtml, jpRole } from "../components/layout";

/**
 * Org Chart — agent_edges (supervises) を tree として SVG render
 */

interface AgentBasic {
  id: number;
  slug: string;
  pokemon_jp: string;
  role: string;
  role_label?: string | null;
  status: string;
  avatar_url?: string | null;
}

interface OrgNode extends AgentBasic {
  reports: OrgNode[];
}

interface LayoutNode extends OrgNode {
  x: number;
  y: number;
  layoutChildren: LayoutNode[];
}

const CARD_W = 220;
const CARD_H = 90;
const GAP_X = 28;
const GAP_Y = 64;
const PADDING = 30;
const MAX_ROW_WIDTH = 1600;

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((s, c) => s + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function subtreeHeight(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_H;
  return CARD_H + GAP_Y + Math.max(...node.reports.map(subtreeHeight));
}

function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const children: LayoutNode[] = [];
  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((s, c) => s + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;
    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      children.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }
  return { ...node, x: x + (totalW - CARD_W) / 2, y, layoutChildren: children };
}

function flatten(node: LayoutNode, acc: LayoutNode[] = []): LayoutNode[] {
  acc.push(node);
  for (const c of node.layoutChildren) flatten(c, acc);
  return acc;
}

function edges(
  node: LayoutNode,
  acc: { x1: number; y1: number; x2: number; y2: number }[] = [],
): typeof acc {
  for (const c of node.layoutChildren) {
    acc.push({ x1: node.x + CARD_W / 2, y1: node.y + CARD_H, x2: c.x + CARD_W / 2, y2: c.y });
    edges(c, acc);
  }
  return acc;
}

export function renderOrgChart(db: Database, agentsList: AgentBasic[]): string {
  if (agentsList.length === 0) {
    return `<div class="section empty">エージェント未登録</div>`;
  }

  const edgesData = db
    .query<{ supervisor_id: number; subordinate_id: number }, []>(
      `SELECT supervisor_id, subordinate_id FROM agent_edges WHERE edge_type='supervises'`,
    )
    .all();

  const nodeMap = new Map<number, OrgNode>();
  for (const a of agentsList) {
    nodeMap.set(a.id, { ...a, reports: [] });
  }
  const isReport = new Set<number>();
  for (const e of edgesData) {
    const sup = nodeMap.get(e.supervisor_id);
    const sub = nodeMap.get(e.subordinate_id);
    if (sup && sub) {
      sup.reports.push(sub);
      isReport.add(sub.id);
    }
  }
  const roots = agentsList.filter((a) => !isReport.has(a.id)).map((a) => nodeMap.get(a.id)!);

  const layouts: LayoutNode[] = [];
  let cursorX = PADDING;
  let cursorY = PADDING;
  let rowMaxH = 0;
  for (const root of roots) {
    const sw = subtreeWidth(root);
    if (cursorX > PADDING && cursorX + sw > MAX_ROW_WIDTH) {
      cursorX = PADDING;
      cursorY += rowMaxH + GAP_Y * 2;
      rowMaxH = 0;
    }
    const tree = layoutTree(root, cursorX, cursorY);
    layouts.push(tree);
    cursorX += sw + GAP_X * 2;
    const h = subtreeHeight(root);
    if (h > rowMaxH) rowMaxH = h;
  }

  const allNodes = layouts.flatMap((l) => flatten(l));
  const allEdges = layouts.flatMap((l) => edges(l));

  const maxX = Math.max(...allNodes.map((n) => n.x + CARD_W), MAX_ROW_WIDTH) + PADDING;
  const maxY = Math.max(...allNodes.map((n) => n.y + CARD_H)) + PADDING;

  return `
<div class="org-canvas">
  <svg class="org-svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">
    ${allEdges
      .map(
        (e) => `<path class="org-edge" d="M ${e.x1} ${e.y1} C ${e.x1} ${(e.y1 + e.y2) / 2}, ${e.x2} ${(e.y1 + e.y2) / 2}, ${e.x2} ${e.y2}"/>`,
      )
      .join("")}
    ${allNodes
      .map(
        (n) => `<g transform="translate(${n.x},${n.y})">
        <a href="/agents">
          <rect class="org-card-bg ${n.status === "active" ? "active" : "disabled"}" width="${CARD_W}" height="${CARD_H}" rx="8"/>
          ${n.avatar_url ? `<image href="${escapeHtml(n.avatar_url)}" x="10" y="12" width="64" height="64" preserveAspectRatio="xMidYMid meet"/>` : ""}
          <text class="org-card-name" x="${n.avatar_url ? 82 : 14}" y="28">${escapeHtml(n.pokemon_jp)}</text>
          <text class="org-card-role" x="${n.avatar_url ? 82 : 14}" y="46" style="font-size:11px;">${escapeHtml(n.role_label || jpRole(n.role))}</text>
          <text class="org-card-role" x="${n.avatar_url ? 82 : 14}" y="64" style="font-size:10px;">${escapeHtml(n.slug)}</text>
          <text class="org-card-status" x="${CARD_W - 10}" y="22" text-anchor="end" fill="${n.status === "active" ? "#10b981" : "#a1a1aa"}">●</text>
        </a>
      </g>`,
      )
      .join("")}
  </svg>
</div>

<p class="muted small" style="margin-top:12px;">
  ${agentsList.length} agents · ${edgesData.length} edges · ${roots.length} root${roots.length === 1 ? "" : "s"}
</p>
`;
}
