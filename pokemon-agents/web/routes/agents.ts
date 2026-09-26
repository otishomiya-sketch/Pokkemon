import type { Database } from "bun:sqlite";
import { escapeHtml, fmtInterval, fmtCents, jpRole, jpStatus } from "../components/layout";
import { renderOrgChart } from "./org";
import { renderHeartbeat } from "./heartbeat";
import { renderCosts } from "./costs";

/**
 * Agents — 1 URL で 4 つの view:
 *   ?view=org       (default) ─ SVG 組織図
 *   ?view=list      ─ 部署別カード一覧
 *   ?view=schedule  ─ heartbeat / scheduler 設定
 *   ?view=cost      ─ 予算 / コスト
 */

interface AgentRow {
  id: number;
  slug: string;
  pokemon_jp: string;
  display_name: string;
  role: string;
  role_label: string | null;
  department: string;
  department_label: string | null;   // departments.label (DB native)
  model: string;
  version: number;
  status: string;
  avatar_url: string | null;
}

interface ScheduleRow {
  id: number;
  agent_id: number;
  trigger_type: string;
  interval_sec: number | null;
  cron_expr: string | null;
  next_run_at: string | null;
  last_fired_at: string | null;
  enabled: number;
}

interface BudgetRow {
  id: number;
  agent_id: number | null;
  period: string;
  budget_cents: number;
  used_cents: number;
  status: string;
}

export type AgentsView = "org" | "list" | "cost" | "schedule";

export function renderAgents(db: Database, view: AgentsView = "list", params?: URLSearchParams): string {
  const agents = db
    .query<AgentRow, []>(
      `SELECT id, slug, pokemon_jp, display_name, role, role_label,
              department, department_label,
              model, version, status, avatar_url
       FROM agents ORDER BY department_label, slug`,
    )
    .all();

  const byDept = new Map<string, AgentRow[]>();
  for (const a of agents) {
    if (!byDept.has(a.department)) byDept.set(a.department, []);
    byDept.get(a.department)!.push(a);
  }

  const viewTitle =
    view === "schedule" ? "スケジュール" :
    view === "cost" ? "コスト" :
    "";
  const isOrgOrList = view === "org" || view === "list";
  const titleSuffix = viewTitle ? ` · ${viewTitle}` : "";
  const sortKey = params?.get("sort") || "";
  const header = `<div class="page-header">
  <div>
    <div class="page-kicker">Agents</div>
    <h1>エージェント${titleSuffix}</h1>
  </div>
</div>`;
  const viewSwitcher = isOrgOrList
    ? `<div class="list-tabs" role="group" aria-label="表示切替">
    <a href="/agents" class="list-tab ${view === "list" ? "active" : ""}">一覧</a>
    <a href="/agents?view=org" class="list-tab ${view === "org" ? "active" : ""}">組織図</a>
  </div>`
    : "";

  const toolbar = isOrgOrList
    ? `<div class="list-toolbar">
  ${viewSwitcher}
</div>`
    : "";

  if (agents.length === 0 && (view === "org" || view === "list" || view === "schedule")) {
    return (
      header +
      `<div class="section empty"><p class="muted">エージェント未登録。<code>bun pokemon-agents/scripts/seed-agents-from-md.ts</code> を実行してください.</p></div>`
    );
  }

  if (view === "org") return header + toolbar + renderOrgChart(db, agents);
  if (view === "list") return header + toolbar + renderListTable(db, agents, params);
  if (view === "schedule") return header + renderScheduleTimeline(db, agents);
  if (view === "cost") return header + stripHeader(renderCosts(db));
  return header;
}

function stripHeader(html: string): string {
  const startIdx = html.indexOf('<div class="page-header">');
  if (startIdx === -1) return html;
  let depth = 0;
  let i = startIdx;
  while (i < html.length) {
    if (html.startsWith("<div", i)) {
      depth++;
      i += 4;
    } else if (html.startsWith("</div>", i)) {
      depth--;
      i += 6;
      if (depth === 0) return html.slice(0, startIdx) + html.slice(i);
    } else {
      i++;
    }
  }
  return html;
}

/* ===== Schedule timeline (24h view) ===== */

interface Firing {
  hour: number;
  minute: number;
}

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const arr: number[] = [];
    for (let i = min; i <= max; i++) arr.push(i);
    return arr;
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (!step) return [];
    const arr: number[] = [];
    for (let i = min; i <= max; i += step) arr.push(i);
    return arr;
  }
  return field
    .split(",")
    .map((x) => parseInt(x, 10))
    .filter((x) => !isNaN(x) && x >= min && x <= max);
}

function cronToFirings(cron: string): Firing[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return [];
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const out: Firing[] = [];
  for (const h of hours) for (const m of minutes) out.push({ hour: h, minute: m });
  return out;
}

function intervalToFirings(intervalSec: number): Firing[] {
  if (intervalSec <= 0 || intervalSec > 86400) return [];
  const out: Firing[] = [];
  for (let t = 0; t < 86400; t += intervalSec) {
    out.push({ hour: Math.floor(t / 3600) % 24, minute: Math.floor((t % 3600) / 60) });
    if (out.length >= 288) break; // 5分ごとが上限
  }
  return out;
}

/**
 * cron_expr / interval_sec から「次回起動」を推定。
 * launchd 自身が時刻管理してるので近似だが、UI 表示用には十分。
 *
 * - cron_expr: 直近の hour:minute マッチを from から探す
 * - interval_sec: lastFiredAt + interval (なければ now + interval)
 */
function computeNextRun(s: ScheduleRow, lastFiredAt: string | null, from = new Date()): Date | null {
  if (s.cron_expr) {
    const firings = cronToFirings(s.cron_expr);
    if (firings.length === 0) return null;
    const sortedMinutes = firings
      .map((f) => f.hour * 60 + f.minute)
      .sort((a, b) => a - b);
    const nowMin = from.getHours() * 60 + from.getMinutes();
    const next = sortedMinutes.find((m) => m > nowMin);
    const d = new Date(from);
    d.setSeconds(0, 0);
    if (next != null) {
      d.setHours(Math.floor(next / 60), next % 60);
    } else {
      d.setDate(d.getDate() + 1);
      d.setHours(Math.floor(sortedMinutes[0] / 60), sortedMinutes[0] % 60);
    }
    return d;
  }
  if (s.interval_sec && s.interval_sec > 0) {
    const base = lastFiredAt ? new Date(lastFiredAt.replace(" ", "T")) : from;
    let next = new Date(base.getTime() + s.interval_sec * 1000);
    // 過去になってたら今から interval 後に倒す (launchd は遅延発火しないので近似)
    if (next.getTime() < from.getTime()) {
      next = new Date(from.getTime() + s.interval_sec * 1000);
    }
    return next;
  }
  return null;
}

// エージェントの role 別: 「自分でスケジュールを持てる側」
const SCHEDULABLE_ROLES = new Set(["orchestrator", "supervisor", "solo"]);

interface AgentTree {
  childrenMap: Map<number, { child: AgentRow; edge_type: string }[]>;
  isChild: Set<number>;
}

/**
 * agent_edges から親子関係 tree を組み立てる。
 * supervises を先に処理、その後 triggers。各 child は 1 親のみに割当。
 */
function buildAgentTree(db: Database, agents: AgentRow[]): AgentTree {
  const edges = db
    .query<{ supervisor_id: number; subordinate_id: number; edge_type: string }, []>(
      `SELECT supervisor_id, subordinate_id, edge_type FROM agent_edges
       WHERE edge_type IN ('supervises','triggers')`,
    )
    .all();
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const childrenMap = new Map<number, { child: AgentRow; edge_type: string }[]>();
  const isChild = new Set<number>();
  const ordered = [
    ...edges.filter((e) => e.edge_type === "supervises"),
    ...edges.filter((e) => e.edge_type === "triggers"),
  ];
  for (const e of ordered) {
    const child = agentById.get(e.subordinate_id);
    if (!child) continue;
    if (isChild.has(child.id)) continue;
    isChild.add(child.id);
    if (!childrenMap.has(e.supervisor_id)) childrenMap.set(e.supervisor_id, []);
    childrenMap.get(e.supervisor_id)!.push({ child, edge_type: e.edge_type });
  }
  return { childrenMap, isChild };
}

function fmtNextRun(d: Date | null, now = new Date()): string {
  if (!d) return "—";
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60000);
  if (diffMin < 0) return "間もなく";
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = d.toDateString() === now.toDateString();
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const stamp = sameDay ? timeStr : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${timeStr}`;
  let rel: string;
  if (diffMin < 60) rel = `${diffMin}分後`;
  else if (diffMin < 1440) rel = `${Math.round(diffMin / 60)}時間後`;
  else rel = `${Math.round(diffMin / 1440)}日後`;
  return `${stamp} <span class="muted tiny">(${rel})</span>`;
}

function firingDescription(s: ScheduleRow): string {
  if (s.cron_expr) {
    const parts = s.cron_expr.trim().split(/\s+/);
    if (parts.length >= 2) {
      const mins = parseCronField(parts[0], 0, 59);
      const hrs = parseCronField(parts[1], 0, 23);
      if (hrs.length <= 6 && mins.length <= 2) {
        return hrs
          .map((h) => mins.map((m) => `${pad2(h)}:${pad2(m)}`).join("/"))
          .join(", ");
      }
    }
    return s.cron_expr;
  }
  if (s.interval_sec) return fmtInterval(s.interval_sec) + "毎";
  return "—";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface TimelineRow {
  agent: AgentRow;
  schedule: ScheduleRow;
  firings: Firing[];
  firstMinutes: number; // ソート用
}

function renderScheduleTimeline(db: Database, agents: AgentRow[]): string {
  const schedules = db
    .query<ScheduleRow, []>(
      `SELECT id, agent_id, trigger_type, interval_sec, cron_expr, next_run_at, last_fired_at, enabled FROM agent_schedules`,
    )
    .all();

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const tree = buildAgentTree(db, agents);
  const schedByAgent = new Map<number, ScheduleRow>();
  for (const s of schedules) {
    if (s.trigger_type === "timer") schedByAgent.set(s.agent_id, s);
  }

  // depth=0 ルートを 部署/slug 順に並べ、子はツリー順で連結
  const roots = agents.filter((a) => !tree.isChild.has(a.id));
  const sortByDept = (xs: AgentRow[]) =>
    xs.slice().sort((a, b) => (a.department + a.slug).localeCompare(b.department + b.slug, "ja"));
  const orderedAgents: { agent: AgentRow; depth: number; parent?: AgentRow; edgeType?: string }[] = [];
  function walk(a: AgentRow, depth: number, parent?: AgentRow, edgeType?: string) {
    orderedAgents.push({ agent: a, depth, parent, edgeType });
    const kids = tree.childrenMap.get(a.id) || [];
    for (const k of kids) walk(k.child, depth + 1, a, k.edge_type);
  }
  for (const r of sortByDept(roots)) walk(r, 0);

  // 親が enabled かつ自身は子なら「連動」扱い (親のスケジュールに紐づく)
  const parentEnabledFor = new Map<number, ScheduleRow>();
  for (const { agent, parent } of orderedAgents) {
    if (!parent) continue;
    const ps = schedByAgent.get(parent.id);
    if (ps && ps.trigger_type === "timer" && ps.enabled === 1) {
      parentEnabledFor.set(agent.id, ps);
    }
  }

  // エージェントを4分類
  type RowKind = "scheduled" | "linked" | "unscheduled";
  interface SchedRow {
    agent: AgentRow;
    depth: number;
    edgeType?: string;
    kind: RowKind;
    schedule?: ScheduleRow;
    firings: Firing[];
    firstMinutes: number;
  }
  const rows: SchedRow[] = [];
  for (const o of orderedAgents) {
    const own = schedByAgent.get(o.agent.id);
    if (own) {
      const firings: Firing[] = own.cron_expr
        ? cronToFirings(own.cron_expr)
        : own.interval_sec
          ? intervalToFirings(own.interval_sec)
          : [];
      firings.sort((x, y) => x.hour * 60 + x.minute - (y.hour * 60 + y.minute));
      rows.push({
        agent: o.agent,
        depth: o.depth,
        edgeType: o.edgeType,
        kind: "scheduled",
        schedule: own,
        firings,
        firstMinutes: firings[0]?.hour * 60 + (firings[0]?.minute || 0),
      });
    } else if (parentEnabledFor.has(o.agent.id)) {
      // 親のスケジュールを継承して点を表示 (連動)
      const ps = parentEnabledFor.get(o.agent.id)!;
      const firings: Firing[] = ps.cron_expr
        ? cronToFirings(ps.cron_expr)
        : ps.interval_sec
          ? intervalToFirings(ps.interval_sec)
          : [];
      firings.sort((x, y) => x.hour * 60 + x.minute - (y.hour * 60 + y.minute));
      rows.push({
        agent: o.agent,
        depth: o.depth,
        edgeType: o.edgeType,
        kind: "linked",
        schedule: ps,
        firings,
        firstMinutes: firings[0]?.hour * 60 + (firings[0]?.minute || 0),
      });
    } else {
      rows.push({
        agent: o.agent,
        depth: o.depth,
        edgeType: o.edgeType,
        kind: "unscheduled",
        firings: [],
        firstMinutes: 99999,
      });
    }
  }

  // 集計用
  const enabledRows = rows.filter((r) => r.kind === "scheduled" && r.schedule?.enabled === 1);
  const linkedRows = rows.filter((r) => r.kind === "linked");
  const disabledRows = rows.filter((r) => r.kind === "scheduled" && r.schedule?.enabled === 0);
  const unscheduled = rows.filter((r) => r.kind === "unscheduled" && SCHEDULABLE_ROLES.has(r.agent.role));
  const enabledFirings = enabledRows.reduce((sum, r) => sum + r.firings.length, 0);

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowPct = (nowMinutes / 1440) * 100;
  const hourMarks = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  const renderRow = (r: SchedRow): string => {
    const a = r.agent;
    const slugJson = JSON.stringify(a.slug).replace(/'/g, "\\'");
    const nameJson = JSON.stringify(a.pokemon_jp).replace(/'/g, "\\'");
    const indent = r.depth * 18;
    const treeMark = r.depth > 0
      ? `<span class="tree-branch" aria-hidden="true">${r.edgeType === "triggers" ? "↳" : "└"}</span>`
      : "";

    let rowClass = "timeline-row";
    let subText: string;
    let dots: string;
    let editBtn: string;

    if (r.kind === "scheduled") {
      const disabled = r.schedule!.enabled === 0;
      if (disabled) rowClass += " disabled";
      subText = `${escapeHtml(firingDescription(r.schedule!))}${disabled ? " · 無効" : ""}`;
      dots = r.firings
        .map((f) => {
          const pct = ((f.hour * 60 + f.minute) / 1440) * 100;
          return `<div class="timeline-dot" style="left:${pct}%;" title="${pad2(f.hour)}:${pad2(f.minute)} — ${escapeHtml(a.pokemon_jp)}"></div>`;
        })
        .join("");
      editBtn = `<button class="btn sm timeline-edit-btn" onclick='openScheduleModal(${slugJson}, ${nameJson})'>スケジュール</button>`;
    } else if (r.kind === "linked") {
      rowClass += " linked";
      const parentJp = orderedAgents.find((o) => o.agent.id === r.agent.id)?.parent?.pokemon_jp || "";
      subText = `<span class="link-pill">連動</span> ${escapeHtml(parentJp)} と同タイミングで実行`;
      dots = r.firings
        .map((f) => {
          const pct = ((f.hour * 60 + f.minute) / 1440) * 100;
          return `<div class="timeline-dot timeline-dot-linked" style="left:${pct}%;" title="${pad2(f.hour)}:${pad2(f.minute)} — ${escapeHtml(a.pokemon_jp)} (連動)"></div>`;
        })
        .join("");
      editBtn = "";
    } else {
      // unscheduled
      const canSchedule = SCHEDULABLE_ROLES.has(a.role);
      if (!canSchedule) {
        rowClass += " call-only";
        subText = `<span class="muted tiny">— 呼び出し専用 —</span>`;
        dots = "";
        editBtn = "";
      } else {
        rowClass += " unscheduled";
        subText = `<span class="muted tiny">スケジュール未設定</span>`;
        dots = "";
        editBtn = `<button class="btn sm timeline-edit-btn" onclick='openScheduleModal(${slugJson}, ${nameJson})'>スケジュール</button>`;
      }
    }

    return `<div class="${rowClass}">
      <div class="timeline-label-col" style="padding-left:${indent}px;">
        ${treeMark}
        ${a.avatar_url ? `<img src="${escapeHtml(a.avatar_url)}" alt="" width="22" height="22" style="border-radius:4px;flex-shrink:0;">` : ""}
        <div class="timeline-label-text">
          <div class="timeline-name">${escapeHtml(a.pokemon_jp)}</div>
          <div class="muted tiny">${subText}</div>
        </div>
      </div>
      <div class="timeline-bar ${dots ? "" : "empty-bar"}">
        ${[3, 6, 9, 12, 15, 18, 21]
          .map((h) => `<div class="timeline-gridline" style="left:${(h / 24) * 100}%;"></div>`)
          .join("")}
        <div class="timeline-now" style="left:${nowPct}%;"></div>
        ${dots}
        ${editBtn}
      </div>
    </div>`;
  };

  return `
<div class="section compact">
  <div class="timeline-summary">
    <span>
      <strong>${enabledRows.length}</strong> 体が稼働中
      <span class="muted">(1日あたり ${enabledFirings} 回の実行)</span>
      ${linkedRows.length > 0 ? `<span class="muted tiny"> · ${linkedRows.length} 体が連動</span>` : ""}
      ${disabledRows.length > 0 ? `<span class="muted tiny"> · ${disabledRows.length} 体は無効化中</span>` : ""}
      ${unscheduled.length > 0 ? `<span class="muted tiny"> · ${unscheduled.length} 体は未設定</span>` : ""}
    </span>
    <span class="muted tiny">現在 ${pad2(now.getHours())}:${pad2(now.getMinutes())}</span>
  </div>

  <div class="timeline-wrap">
    <div class="timeline-now-global" style="left: calc(200px + 12px + (100% - 200px - 12px) * ${nowPct / 100});"></div>
    <div class="timeline-header">
      <div class="timeline-label-col"></div>
      <div class="timeline-hours">
        ${hourMarks
          .map((h) => `<div class="hour-tick" style="left:${(h / 24) * 100}%;">${h}時</div>`)
          .join("")}
      </div>
    </div>

    ${rows.map(renderRow).join("")}

    ${
      rows.length === 0
        ? `<div class="empty"><p class="muted">エージェントが登録されていません。</p></div>`
        : ""
    }
  </div>
</div>

${renderScheduleEditModal()}
`;
}

function renderScheduleEditModal(): string {
  return `
<div id="schedule-modal" class="modal" style="display:none;">
  <div class="modal-inner" style="max-width:560px;">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:16px;">
      <h3 id="sm-title" style="margin:0;font-size:16px;"></h3>
      <button class="btn sm" style="margin-left:auto;" onclick="closeScheduleModal()">閉じる ✕</button>
    </div>

    <div class="modal-field">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:700;color:#0f172a;font-size:13px;">トリガーを有効化</div>
          <div class="muted tiny" style="margin-top:2px;">オフにすると .plist.disabled として保存 (launchd から外される)</div>
        </div>
        <label class="toggle-switch" aria-label="有効化">
          <input type="checkbox" id="sm-enabled">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="modal-field">
      <span>実行モード</span>
      <div class="mode-tabs" role="tablist" style="display:flex;gap:4px;background:#f1f5f9;padding:4px;border-radius:10px;width:fit-content;">
        <button type="button" class="mode-tab" data-mode="calendar" onclick="setScheduleMode('calendar')" role="tab">時刻指定</button>
        <button type="button" class="mode-tab" data-mode="interval" onclick="setScheduleMode('interval')" role="tab">間隔指定</button>
      </div>
    </div>

    <div id="sm-calendar-pane" class="modal-field">
      <span>実行時刻 (毎日)</span>
      <div id="sm-times" style="display:flex;flex-direction:column;gap:6px;"></div>
      <button class="btn sm" type="button" onclick="addScheduleTime()" style="margin-top:6px;">+ 時刻を追加</button>
      <div class="preset-row" style="margin-top:8px;">
        <span class="muted tiny" style="align-self:center;">プリセット:</span>
        <button class="btn sm" type="button" onclick="applyTimePreset([{h:9,m:0}])">毎朝 9:00</button>
        <button class="btn sm" type="button" onclick="applyTimePreset([{h:0,m:15},{h:6,m:15},{h:12,m:15},{h:18,m:15}])">6時間毎 (4回)</button>
        <button class="btn sm" type="button" onclick="applyTimePreset([{h:3,m:0}])">毎朝 3:00 (低負荷)</button>
        <button class="btn sm" type="button" onclick="applyTimePreset([])">全削除</button>
      </div>
    </div>

    <div id="sm-interval-pane" class="modal-field" style="display:none;">
      <span>実行間隔</span>
      <div style="display:flex;gap:6px;align-items:center;">
        <input id="sm-interval-num" type="number" min="1" value="1" oninput="onIntervalChange()" style="width:80px;padding:4px 8px;">
        <select id="sm-interval-unit" onchange="onIntervalChange()" style="padding:6px 8px;">
          <option value="60">分</option>
          <option value="3600" selected>時間</option>
          <option value="86400">日</option>
        </select>
        <span class="muted tiny" id="sm-interval-resolved" style="margin-left:8px;"></span>
      </div>
      <div class="preset-row" style="margin-top:8px;">
        <span class="muted tiny" style="align-self:center;">プリセット:</span>
        <button class="btn sm" type="button" onclick="applyIntervalPreset(1800)">30分毎</button>
        <button class="btn sm" type="button" onclick="applyIntervalPreset(3600)">1時間毎</button>
        <button class="btn sm" type="button" onclick="applyIntervalPreset(21600)">6時間毎</button>
        <button class="btn sm" type="button" onclick="applyIntervalPreset(86400)">1日毎</button>
      </div>
      <div class="muted tiny" style="margin-top:8px;">
        ※ launchd 起動からの相対時間で発火。Mac スリープ中は次回起動時にまとめて発火。
      </div>
    </div>

    <div class="modal-actions" style="margin-top:20px;">
      <button class="btn danger" type="button" onclick="deleteSchedule()">削除</button>
      <button class="btn" type="button" onclick="closeScheduleModal()">キャンセル</button>
      <button class="btn primary" type="button" onclick="saveSchedule()">保存</button>
    </div>
    <div id="sm-status" class="muted tiny" style="margin-top:10px;min-height:1em;"></div>
  </div>
</div>

<script>
let SCHEDULE_STATE = { agent_slug: '', agent_jp: '', mode: 'calendar', times: [], interval_sec: 0, enabled: true };

async function openScheduleModal(slug, jp) {
  SCHEDULE_STATE.agent_slug = slug;
  SCHEDULE_STATE.agent_jp = jp;
  document.getElementById('sm-title').textContent = jp + ' (' + slug + ') のスケジュール';
  document.getElementById('sm-status').textContent = '';
  try {
    const r = await fetch('/api/schedule/read?slug=' + encodeURIComponent(slug));
    const d = await r.json();
    SCHEDULE_STATE.mode = d.mode || 'calendar';
    SCHEDULE_STATE.times = d.times || [];
    SCHEDULE_STATE.interval_sec = d.interval_sec || 0;
    SCHEDULE_STATE.enabled = d.enabled !== false;
  } catch(e) {
    SCHEDULE_STATE.mode = 'calendar';
    SCHEDULE_STATE.times = [];
    SCHEDULE_STATE.interval_sec = 0;
    SCHEDULE_STATE.enabled = true;
  }
  document.getElementById('sm-enabled').checked = SCHEDULE_STATE.enabled;
  setScheduleMode(SCHEDULE_STATE.mode);
  if (SCHEDULE_STATE.mode === 'interval' && SCHEDULE_STATE.interval_sec > 0) {
    populateIntervalInputs(SCHEDULE_STATE.interval_sec);
  }
  renderScheduleTimes();
  document.getElementById('schedule-modal').style.display = 'flex';
}

function setScheduleMode(mode) {
  SCHEDULE_STATE.mode = mode;
  document.getElementById('sm-calendar-pane').style.display = mode === 'calendar' ? '' : 'none';
  document.getElementById('sm-interval-pane').style.display = mode === 'interval' ? '' : 'none';
  document.querySelectorAll('.mode-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  if (mode === 'interval') {
    if (!SCHEDULE_STATE.interval_sec || SCHEDULE_STATE.interval_sec < 60) {
      populateIntervalInputs(3600);
    }
    onIntervalChange();
  }
}

function populateIntervalInputs(sec) {
  let unit = 3600, num = Math.round(sec / 3600);
  if (sec % 86400 === 0 && sec >= 86400) { unit = 86400; num = sec / 86400; }
  else if (sec < 3600 || sec % 3600 !== 0) { unit = 60; num = Math.max(1, Math.round(sec / 60)); }
  document.getElementById('sm-interval-num').value = num;
  document.getElementById('sm-interval-unit').value = String(unit);
  SCHEDULE_STATE.interval_sec = num * unit;
}

function onIntervalChange() {
  const num = Math.max(1, Number(document.getElementById('sm-interval-num').value) || 1);
  const unit = Number(document.getElementById('sm-interval-unit').value) || 3600;
  SCHEDULE_STATE.interval_sec = num * unit;
  const totalMin = SCHEDULE_STATE.interval_sec / 60;
  const human = totalMin >= 1440
    ? (totalMin / 1440).toFixed(1) + ' 日毎'
    : totalMin >= 60
      ? (totalMin / 60).toFixed(1) + ' 時間毎'
      : totalMin + ' 分毎';
  document.getElementById('sm-interval-resolved').textContent = '= ' + human + ' (' + SCHEDULE_STATE.interval_sec + ' 秒)';
}

function applyIntervalPreset(sec) {
  populateIntervalInputs(sec);
  onIntervalChange();
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').style.display = 'none';
}

function renderScheduleTimes() {
  const cont = document.getElementById('sm-times');
  if (SCHEDULE_STATE.times.length === 0) {
    cont.innerHTML = '<div class="muted tiny" style="padding:8px 0;">時刻が設定されていません。プリセットを使うか、下の「+ 時刻を追加」で設定してください。</div>';
    return;
  }
  cont.innerHTML = SCHEDULE_STATE.times.map((t, i) => \`
    <div style="display:flex;gap:6px;align-items:center;">
      <input type="number" min="0" max="23" value="\${t.hour}" onchange="SCHEDULE_STATE.times[\${i}].hour=Math.max(0,Math.min(23,Number(this.value)||0))" style="width:70px;padding:4px 8px;">
      <span>時</span>
      <input type="number" min="0" max="59" value="\${t.minute}" onchange="SCHEDULE_STATE.times[\${i}].minute=Math.max(0,Math.min(59,Number(this.value)||0))" style="width:70px;padding:4px 8px;">
      <span>分</span>
      <button class="btn sm danger" type="button" onclick="removeScheduleTime(\${i})" style="margin-left:auto;">削除</button>
    </div>
  \`).join('');
}

function addScheduleTime() {
  SCHEDULE_STATE.times.push({ hour: 9, minute: 0 });
  renderScheduleTimes();
}

function removeScheduleTime(i) {
  SCHEDULE_STATE.times.splice(i, 1);
  renderScheduleTimes();
}

function applyTimePreset(preset) {
  SCHEDULE_STATE.times = preset.map(p => ({ hour: p.h, minute: p.m }));
  renderScheduleTimes();
}

async function saveSchedule() {
  const status = document.getElementById('sm-status');
  status.textContent = '保存中...';
  const enabled = document.getElementById('sm-enabled').checked;
  const payload = {
    agent_slug: SCHEDULE_STATE.agent_slug,
    mode: SCHEDULE_STATE.mode,
    enabled,
  };
  if (SCHEDULE_STATE.mode === 'calendar') {
    payload.times = SCHEDULE_STATE.times;
  } else {
    if (!SCHEDULE_STATE.interval_sec || SCHEDULE_STATE.interval_sec < 60) {
      status.textContent = '❌ 間隔は 60 秒以上を指定';
      return;
    }
    payload.interval_sec = SCHEDULE_STATE.interval_sec;
  }
  try {
    const r = await fetch('/api/schedule/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.ok) {
      const detail = SCHEDULE_STATE.mode === 'calendar'
        ? SCHEDULE_STATE.times.length + ' 時刻'
        : Math.round(SCHEDULE_STATE.interval_sec / 60) + ' 分毎';
      status.textContent = '✅ ' + d.action + ' (' + detail + ')';
      setTimeout(() => location.reload(), 500);
    } else {
      status.textContent = '❌ ' + (d.error || 'エラー');
    }
  } catch(e) {
    status.textContent = '❌ ' + e.message;
  }
}

async function deleteSchedule() {
  if (!confirm(SCHEDULE_STATE.agent_jp + ' の plist を削除しますか？')) return;
  const status = document.getElementById('sm-status');
  status.textContent = '削除中...';
  try {
    const r = await fetch('/api/schedule/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_slug: SCHEDULE_STATE.agent_slug, times: [], enabled: false }),
    });
    const d = await r.json();
    if (d.ok) {
      status.textContent = '✅ 削除しました';
      setTimeout(() => location.reload(), 500);
    } else {
      status.textContent = '❌ ' + (d.error || 'エラー');
    }
  } catch(e) {
    status.textContent = '❌ ' + e.message;
  }
}

document.getElementById('schedule-modal').addEventListener('click', (e) => {
  if (e.target.id === 'schedule-modal') closeScheduleModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeScheduleModal(); });
</script>

<style>
.timeline-row.unscheduled .timeline-bar.empty-bar { display: flex; align-items: center; justify-content: flex-end; padding-right: 10px; }
.timeline-row.unscheduled { opacity: 0.6; }
.timeline-row.unscheduled:hover { opacity: 1; }
/* 無効化されたスケジュール (.plist.disabled) は薄く表示 + dot をグレーに */
.timeline-row.disabled { opacity: 0.45; }
.timeline-row.disabled:hover { opacity: 1; }
.timeline-row.disabled .timeline-dot { background: var(--muted-2); }
.timeline-row.linked { opacity: 0.85; }
.timeline-row.linked .timeline-dot-linked { background: #cbd5e1; border: 1.5px solid #94a3b8; }
.timeline-row.call-only { opacity: 0.4; }
.timeline-row.call-only:hover { opacity: 0.7; }
.tree-branch { display: inline-block; width: 14px; color: #94a3b8; font-size: 11px; flex-shrink: 0; margin-right: 2px; }
.link-pill { display: inline-block; background: #e0e7ff; color: #4338ca; font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-right: 4px; letter-spacing: 0.02em; }
.timeline-edit-btn { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); z-index: 2; font-size: 10px; padding: 2px 8px; }
.mode-tab { background: transparent; border: 0; padding: 6px 14px; font-size: 12px; font-weight: 700; color: #64748b; border-radius: 7px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
.mode-tab:hover { color: #0f172a; }
.mode-tab.active { background: #0f172a; color: #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
</style>
`;
}

function sortableTh(
  key: string,
  label: string,
  activeKey: string,
  activeDir: "asc" | "desc",
  style?: string,
): string {
  const isActive = activeKey === key;
  const nextDir = isActive && activeDir === "asc" ? "desc" : "asc";
  const href = `/agents?sort=${key}&dir=${nextDir}`;
  const arrow = isActive ? (activeDir === "asc" ? "▲" : "▼") : "⇅";
  const cls = `sortable-th${isActive ? " sortable-active" : ""}`;
  return `<th${style ? ` style="${style}"` : ""}><a href="${href}" class="${cls}"><span>${label}</span><span class="sort-arrow">${arrow}</span></a></th>`;
}

function renderListTable(db: Database, agents: AgentRow[], params?: URLSearchParams): string {
  const sortKey = params?.get("sort") || "";
  const sortDir = (params?.get("dir") === "desc" ? "desc" : "asc") as "asc" | "desc";
  // ===== Metric strip (today / yesterday delta / 7-day sparkline) =====
  const totalAgents = agents.length;
  const activeAgents = agents.filter((a) => a.status === "active").length;

  const metrics = db
    .query<{ window: string; total: number; ok: number; fail: number; dur: number }, []>(
      `SELECT CASE
          WHEN date(created_at,'localtime') = date('now','localtime') THEN 'today'
          WHEN date(created_at,'localtime') = date('now','-1 day','localtime') THEN 'y'
        END AS window,
        COUNT(*) AS total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status IN ('failed','timeout','error') THEN 1 ELSE 0 END) AS fail,
        COALESCE(SUM(duration_ms),0) AS dur
       FROM reflections
       WHERE date(created_at,'localtime') >= date('now','-1 day','localtime')
       GROUP BY window`,
    )
    .all();
  const m = { today: { total: 0, ok: 0, fail: 0, dur: 0 }, y: { total: 0, ok: 0, fail: 0, dur: 0 } };
  for (const r of metrics) if (r.window === "today" || r.window === "y") m[r.window] = r;
  const okToday = m.today.ok, okY = m.y.ok;
  const durHoursToday = m.today.dur / 3_600_000;
  const durHoursY = m.y.dur / 3_600_000;
  const errRateToday = m.today.total > 0 ? (m.today.fail / m.today.total) * 100 : 0;
  const errRateY = m.y.total > 0 ? (m.y.fail / m.y.total) * 100 : 0;
  const pctDelta = (now: number, prev: number): string => {
    if (prev === 0) return now > 0 ? "新規" : "—";
    const d = ((now - prev) / prev) * 100;
    const sign = d >= 0 ? "+" : "";
    return `${sign}${d.toFixed(1)}%`;
  };
  const ppDelta = (now: number, prev: number): string => {
    const d = now - prev;
    const sign = d >= 0 ? "+" : "";
    return `${sign}${d.toFixed(1)}%`;
  };

  // 7日 sparkline data (per metric)
  const spark7 = db
    .query<{ day: string; total: number; ok: number; fail: number; dur: number }, []>(
      `SELECT date(created_at,'localtime') AS day,
              COUNT(*) AS total,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status IN ('failed','timeout','error') THEN 1 ELSE 0 END) AS fail,
              COALESCE(SUM(duration_ms),0) AS dur
       FROM reflections
       WHERE date(created_at,'localtime') >= date('now','-6 days','localtime')
       GROUP BY day ORDER BY day ASC`,
    )
    .all();

  // ===== Schedules =====
  const schedules = db
    .query<ScheduleRow, []>(
      `SELECT id, agent_id, trigger_type, interval_sec, cron_expr, next_run_at, last_fired_at, enabled FROM agent_schedules`,
    )
    .all();

  const schedByAgent = new Map<number, ScheduleRow[]>();
  for (const s of schedules) {
    if (!schedByAgent.has(s.agent_id)) schedByAgent.set(s.agent_id, []);
    schedByAgent.get(s.agent_id)!.push(s);
  }

  // 各 agent の最終発火時刻 (reflections の最新 created_at)
  const lastFireRows = db
    .query<{ agent_id: number; last_at: string }, []>(
      `SELECT agent_id, MAX(created_at) AS last_at FROM reflections
       WHERE agent_id IS NOT NULL GROUP BY agent_id`,
    )
    .all();
  const lastFireByAgent = new Map(lastFireRows.map((r) => [r.agent_id, r.last_at]));

  // agent_edges から親子関係を解決
  const { childrenMap, isChild } = buildAgentTree(db, agents);

  // Tree 順に行を並べる
  interface TreeRow {
    agent: AgentRow;
    depth: number;
    isLast: boolean;
    // 各 depth レベルでの「この行より先に『最後』に到達した」列 (tree line 描画用)
    ancestorLast: boolean[];
    edgeType?: string; // 親子間 edge
    parent?: AgentRow;
  }
  const rows: TreeRow[] = [];

  function emitSubtree(
    agent: AgentRow,
    depth: number,
    isLast: boolean,
    ancestorLast: boolean[],
    parent?: AgentRow,
    edgeType?: string,
  ) {
    rows.push({ agent, depth, isLast, ancestorLast: [...ancestorLast], parent, edgeType });
    const kids = childrenMap.get(agent.id) || [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      emitSubtree(
        k.child,
        depth + 1,
        last,
        [...ancestorLast, isLast],
        agent,
        k.edge_type,
      );
    });
  }

  // Roots: エージェントのうち、誰かの子でないもの
  const roots = agents.filter((a) => !isChild.has(a.id));
  // Order: orchestrator/supervisor を先に (tree あり)、solo/その他を後に
  const rootsWithChildren = roots.filter((a) => childrenMap.has(a.id));
  const rootsStandalone = roots.filter((a) => !childrenMap.has(a.id));
  // さらに部署順に並べる
  const sortByDept = (xs: AgentRow[]) =>
    xs.sort((a, b) => (a.department + a.slug).localeCompare(b.department + b.slug, "ja"));
  sortByDept(rootsWithChildren);
  sortByDept(rootsStandalone);

  for (const r of rootsWithChildren) emitSubtree(r, 0, true, []);
  for (const r of rootsStandalone) emitSubtree(r, 0, true, []);

  // ヘッダクリックで並べ替え。sort 指定時はツリー構造をフラット化。
  // status 順は status_pill のロジックと一致させるため、各行に rank を計算しておく。
  const statusRank = (a: AgentRow, hasTimer: boolean, isChild: boolean): number => {
    const isActive = a.status === "active" && (hasTimer || isChild);
    if (isActive) return 0;
    if (a.status === "active") return 1;
    return 2;
  };
  const flatten = rows.map((r) => ({ ...r, depth: 0 } as TreeRow));
  let filteredRows: TreeRow[];
  if (sortKey === "name") {
    filteredRows = [...flatten].sort((x, y) =>
      x.agent.pokemon_jp.localeCompare(y.agent.pokemon_jp, "ja"),
    );
  } else if (sortKey === "role") {
    filteredRows = [...flatten].sort((x, y) =>
      (x.agent.role_label || x.agent.role).localeCompare(y.agent.role_label || y.agent.role, "ja"),
    );
  } else if (sortKey === "dept") {
    filteredRows = [...flatten].sort((x, y) =>
      (x.agent.department_label || x.agent.department).localeCompare(
        y.agent.department_label || y.agent.department, "ja",
      ),
    );
  } else if (sortKey === "model") {
    filteredRows = [...flatten].sort((x, y) =>
      (x.agent.model || "").localeCompare(y.agent.model || "", "ja"),
    );
  } else if (sortKey === "status") {
    filteredRows = [...flatten].sort((x, y) => {
      const xT = (schedByAgent.get(x.agent.id) || []).find((s) => s.trigger_type === "timer");
      const yT = (schedByAgent.get(y.agent.id) || []).find((s) => s.trigger_type === "timer");
      return statusRank(x.agent, !!(xT?.enabled), !!x.parent) - statusRank(y.agent, !!(yT?.enabled), !!y.parent);
    });
  } else {
    filteredRows = rows;       // ツリー構造維持 (デフォルト)
  }
  if (sortKey && sortDir === "desc") filteredRows = [...filteredRows].reverse();

  // ===== Sparkline helper =====
  const sparkline = (values: number[], color: string): string => {
    if (values.length === 0) return "";
    const w = 90, h = 28;
    const max = Math.max(...values, 1);
    const step = values.length > 1 ? w / (values.length - 1) : 0;
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`);
    const line = pts.map((p, i) => (i === 0 ? `M ${p}` : `L ${p}`)).join(" ");
    const area = `${line} L ${w},${h} L 0,${h} Z`;
    return `<svg class="spark-mini" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${area}" fill="${color}" opacity="0.18"/>
      <path d="${line}" stroke="${color}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  };
  const day7Keys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    day7Keys.push(d.toISOString().slice(0, 10));
  }
  const byDay = new Map(spark7.map((r) => [r.day, r]));
  const okSeries = day7Keys.map((k) => byDay.get(k)?.ok ?? 0);
  const durSeries = day7Keys.map((k) => (byDay.get(k)?.dur ?? 0) / 3_600_000);
  const errRateSeries = day7Keys.map((k) => {
    const r = byDay.get(k);
    return r && r.total > 0 ? (r.fail / r.total) * 100 : 0;
  });

  const activePct = totalAgents > 0 ? Math.round((activeAgents / totalAgents) * 100) : 0;

  return `
<!-- Table -->
<div class="section compact list-table-wrap">
  <table class="agents-table ${sortKey ? "" : "agents-tree"} list-table">
    <thead>
      <tr>
        ${sortableTh("name", "エージェント", sortKey, sortDir, "min-width:280px;")}
        ${sortableTh("role", "役割", sortKey, sortDir)}
        ${sortableTh("dept", "部署", sortKey, sortDir)}
        ${sortableTh("model", "モデル", sortKey, sortDir)}
        <th style="min-width:140px;">スケジュール</th>
        <th>次回起動</th>
        <th style="width:80px;text-align:right;">操作</th>
      </tr>
    </thead>
    <tbody>
      ${filteredRows
        .map((r) => {
          const a = r.agent;
          const scheds = schedByAgent.get(a.id) || [];
          const timer = scheds.find((s) => s.trigger_type === "timer");
          const automation = scheds.find((s) => s.trigger_type === "automation");
          // schedulable は厳密に: orchestrator/supervisor/solo OR (parent なし)
          // ※ DB に古い agent_schedules 行が残ってても、子なら編集 UI を出さない (孤立スケジュール扱い)
          const schedulable = SCHEDULABLE_ROLES.has(a.role) || !r.parent;
          const orphanedTimer = !!timer && !schedulable; // 子なのに古い schedule が残ってる

          let schedDesc: string;
          if (timer && schedulable) {
            const label = timer.cron_expr
              ? `<span class="mono tiny">${fmtInterval(timer.interval_sec) || "時刻指定"}毎</span>`
              : `<span class="mono tiny">${fmtInterval(timer.interval_sec)}毎</span>`;
            const dot = timer.enabled
              ? `<span class="sched-dot sched-dot-on" title="稼働中"></span>`
              : `<span class="sched-dot sched-dot-off" title="無効化中"></span>`;
            schedDesc = `${label} ${dot}`;
          } else if (r.parent) {
            schedDesc = `<span class="muted tiny">${r.edgeType === "triggers" ? "自動連鎖で起動" : "Task で起動"}${orphanedTimer ? " · 孤立 schedule あり" : ""}</span>`;
          } else if (schedulable) {
            schedDesc = `<span class="muted">未設定</span>`;
          } else {
            schedDesc = `<span class="muted tiny">— 呼び出し専用 —</span>`;
          }

          const rowClass = r.depth === 0 && childrenMap.has(a.id) ? "tree-root" : r.depth > 0 ? "tree-child" : "tree-standalone";

          // 操作: schedulable (orchestrator/supervisor/solo OR 親なし) のみ編集可
          //       子エージェント (parent あり + role が schedulable でない) は呼出専用 → "—"
          let actionBtn: string;
          if (schedulable) {
            const slugJson = JSON.stringify(a.slug);
            const nameJson = JSON.stringify(a.pokemon_jp);
            const onclick = `event.preventDefault(); openScheduleModal(${slugJson}, ${nameJson});`;
            const checked = timer?.enabled ? "checked" : "";
            const title = timer
              ? (timer.enabled ? "実行中 — クリックでスケジュール編集" : "停止中 — クリックでスケジュール編集")
              : "未設定 — クリックでスケジュール設定";
            actionBtn = `<label class="toggle-switch row-toggle" title="${escapeHtml(title)}" aria-label="スケジュール編集" onclick='${onclick}'><input type="checkbox" disabled ${checked}><span class="toggle-slider"></span></label>`;
          } else {
            actionBtn = `<span class="muted tiny" title="呼び出し専用">—</span>`;
          }

          return `<tr class="${rowClass}">
        <td>
          <div class="list-agent-cell">
            ${a.avatar_url ? `<img src="${escapeHtml(a.avatar_url)}" alt="" width="36" height="36" class="list-avatar">` : `<span class="list-avatar list-avatar-placeholder"></span>`}
            <div class="list-agent-text">
              <div class="list-agent-name">
                <span style="font-weight:${r.depth === 0 ? 700 : 600};">${escapeHtml(a.pokemon_jp)}</span>
                <span class="dept-pill dept-${escapeHtml(a.department)}">${escapeHtml(a.department_label || a.department)}</span>
              </div>
              <div class="list-agent-slug">${escapeHtml(a.slug)}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(a.role_label || jpRole(a.role))}</td>
        <td class="muted">${escapeHtml(a.department_label || a.department)}</td>
        <td class="mono muted">${escapeHtml(a.model)}</td>
        <td>${schedDesc}</td>
        <td class="mono muted tiny">${
          timer && timer.enabled
            ? fmtNextRun(computeNextRun(timer, lastFireByAgent.get(a.id) || null))
            : "—"
        }</td>
        <td style="text-align:right;">${actionBtn}</td>
      </tr>`;
        })
        .join("")}
    </tbody>
  </table>
  ${filteredRows.length === 0 ? `<div class="empty"><p class="muted">該当するエージェントがいません</p></div>` : ""}
</div>

<script>
function runAgentNow(slug, name) {
  if (!confirm(name + ' (' + slug + ') を今すぐ実行しますか？')) return;
  alert('手動実行は未実装です (TODO)。');
}
function openAgentMenu(id) {
  alert('詳細メニューは未実装です (TODO agent id: ' + id + ')。');
}
// 行内トグルのクリックは label の onclick で openScheduleModal を直接呼ぶ
// (旧 data-toggle-trigger / data-open-schedule の delegation 廃止 — 統一 modal に集約)
</script>

${renderScheduleEditModal()}
`;
}

function trigJp(t: string): string {
  return ({ timer: "タイマー", automation: "自動連鎖", on_demand: "手動", assignment: "割当" } as Record<string, string>)[t] || t;
}
