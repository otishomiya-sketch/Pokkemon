import type { Database } from "bun:sqlite";
import { escapeHtml } from "../components/layout";
import { icon as svgIcon } from "../components/icons";
import {
  classifyActor,
  summarize,
  actorBadgeClass,
  buildAgentLookup,
  type AgentMeta,
} from "../lib/actors";

/**
 * Events — 旧 pokemon-dashboard の行動ログストリーム相当
 *
 * - 各 row に actor (Claude Code / scheduled agent / subagent / user) を表示
 * - ポケモンアイコン + 日本語名
 * - tool 要約 (file_path / command / query)
 * - client 側で SSE tick ごとに新 event を prepend (全 fragment swap しない)
 */

export interface EventRow {
  id: number;
  ts: string;
  session_id: string | null;
  agent: string | null;
  hook_event: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  success: number | null;
  duration_ms: number | null;
  prompt: string | null;
  transcript_path: string | null;
  source: string | null;
}

const ROW_LIMIT = 200;

export function renderEvents(db: Database, params: URLSearchParams): string {
  const agentFilter = params.get("agent") || "";
  const toolFilter = params.get("tool") || "";
  const hookFilter = params.get("hook") || "";
  const actorFilter = params.get("actor") || "";
  const q = params.get("q") || "";
  // デフォルトで PreToolUse を隠す (Post と重複表示になり冗長。旧 dashboard と同じ挙動)
  const includePre = params.get("include_pre") === "1";

  const rows = fetchEvents(db, { agentFilter, toolFilter, hookFilter, q, includePre });
  const agentLookup = buildAgentLookup(db);

  // フィルター用 dropdown データ
  const totalCount = db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM logs`).get() as { c: number } | null;
  const todayCount = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) as c FROM logs WHERE date(ts) = date('now','localtime')`,
    )
    .get() as { c: number } | null;
  const agentList = db
    .query<{ a: string; c: number }, []>(
      `SELECT agent as a, COUNT(*) as c FROM logs WHERE agent IS NOT NULL GROUP BY agent ORDER BY c DESC LIMIT 20`,
    )
    .all();
  const toolList = db
    .query<{ t: string; c: number }, []>(
      `SELECT tool_name as t, COUNT(*) as c FROM logs WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC LIMIT 15`,
    )
    .all();
  const hookList = db
    .query<{ h: string; c: number }, []>(
      `SELECT hook_event as h, COUNT(*) as c FROM logs GROUP BY hook_event ORDER BY c DESC`,
    )
    .all();

  const lastId = rows.length > 0 ? rows[0].id : 0;
  const filterJson = JSON.stringify({
    agent: agentFilter,
    tool: toolFilter,
    hook: hookFilter,
    actor: actorFilter,
    q,
    include_pre: includePre ? "1" : "",
  });

  return `
<div class="page-header">
  <div>
    <div class="page-kicker">Activity Log</div>
    <h1>行動ログ</h1>
  </div>
  <div class="events-live" id="events-live-indicator">
    <span class="dot dot-on"></span>
    <span id="events-live-text">ライブ配信中</span>
  </div>
</div>

<div class="list-toolbar">
  <form method="GET" style="display:inline-flex;gap:8px;flex-wrap:wrap;align-items:center;">
    <select name="actor" class="list-sort-select" onchange="this.form.submit()">
        <option value="">実行者 (全て)</option>
        <option value="user" ${actorFilter === "user" ? "selected" : ""}>人間 (Tom)</option>
        <option value="claude" ${actorFilter === "claude" ? "selected" : ""}>Claude Code</option>
        <option value="scheduled" ${actorFilter === "scheduled" ? "selected" : ""}>スケジュール起動</option>
        <option value="subagent" ${actorFilter === "subagent" ? "selected" : ""}>サブエージェント</option>
      </select>
      <select name="agent" class="list-sort-select" onchange="this.form.submit()">
        <option value="">エージェント (全て)</option>
        ${agentList.map((a) => `<option value="${escapeHtml(a.a)}" ${a.a === agentFilter ? "selected" : ""}>${escapeHtml(a.a)} (${a.c})</option>`).join("")}
      </select>
      <select name="tool" class="list-sort-select" onchange="this.form.submit()">
        <option value="">ツール (全て)</option>
        ${toolList.map((t) => `<option value="${escapeHtml(t.t)}" ${t.t === toolFilter ? "selected" : ""}>${escapeHtml(t.t)} (${t.c})</option>`).join("")}
      </select>
      <select name="hook" class="list-sort-select" onchange="this.form.submit()">
        <option value="">フック (全て)</option>
        ${hookList.map((h) => `<option value="${escapeHtml(h.h)}" ${h.h === hookFilter ? "selected" : ""}>${escapeHtml(h.h)} (${h.c})</option>`).join("")}
      </select>
      <input type="search" name="q" value="${escapeHtml(q)}" placeholder="キーワード検索..." class="list-sort-select" style="min-width:160px;">
      <label class="filter-checkbox" title="PreToolUse は PostToolUse と重複するため通常は非表示">
        <input type="checkbox" name="include_pre" value="1" ${includePre ? "checked" : ""} onchange="this.form.submit()">
        <span>Pre も含める</span>
      </label>
    ${agentFilter || toolFilter || hookFilter || actorFilter || q || includePre ? `<a href="/logs" class="btn sm">クリア</a>` : ""}
  </form>
</div>

<div class="section compact" style="padding:0 !important;">
  <table class="events-table">
    <thead>
      <tr>
        <th style="width:78px;">時刻</th>
        <th style="width:180px;">実行者</th>
        <th style="width:100px;">フック</th>
        <th style="width:110px;">ツール</th>
        <th>内容</th>
        <th style="width:66px;text-align:right;">時間</th>
      </tr>
    </thead>
    <tbody id="events-stream" data-last-id="${lastId}" data-filters='${escapeHtml(filterJson)}'>
      ${rows.map((e) => renderRow(e, agentLookup)).filter((r) => !actorFilter || r.includes(`data-actor-kind="${actorFilter}"`)).join("")}
    </tbody>
  </table>
</div>

<script>${streamClientScript(actorFilter)}</script>
`;
}

export function fetchEvents(
  db: Database,
  opts: {
    agentFilter?: string;
    toolFilter?: string;
    hookFilter?: string;
    q?: string;
    sinceId?: number;
    includePre?: boolean;
  } = {},
): EventRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.agentFilter) {
    where.push("agent = ?");
    args.push(opts.agentFilter);
  }
  if (opts.toolFilter) {
    where.push("tool_name = ?");
    args.push(opts.toolFilter);
  }
  if (opts.hookFilter) {
    where.push("hook_event = ?");
    args.push(opts.hookFilter);
  } else if (!opts.includePre) {
    // 明示的な hookFilter が無い かつ includePre=false なら、PreToolUse を除外
    // (Pre と Post は対で発生、Post 側のみ表示で十分)
    where.push("hook_event != 'PreToolUse'");
  }
  if (opts.q) {
    where.push("(tool_input LIKE ? OR tool_response LIKE ? OR prompt LIKE ?)");
    args.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
  }
  if (opts.sinceId && opts.sinceId > 0) {
    where.push("id > ?");
    args.push(opts.sinceId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .query<EventRow, []>(
      `SELECT id, ts, session_id, agent, hook_event, tool_name, tool_input, tool_response,
              success, duration_ms, prompt, transcript_path, source
       FROM logs ${whereSql}
       ORDER BY id DESC LIMIT ${ROW_LIMIT}`,
    )
    .all(...(args as never[]));
}

export function renderRow(e: EventRow, agentLookup?: Map<string, AgentMeta>): string {
  const actor = classifyActor(e, agentLookup);
  const sum = summarize(e);
  const badgeCls = actorBadgeClass(actor.kind);
  const time = (e.ts || "").split(" ")[1] || e.ts;
  const iconHtml = actor.avatar
    ? `<img class="event-actor-avatar" src="${escapeHtml(actor.avatar)}" alt="${escapeHtml(actor.name)}" width="24" height="24">`
    : `<span class="event-actor-icon">${svgIcon(actor.icon, "size-4")}</span>`;
  return `<tr class="event-row" data-event-id="${e.id}" data-actor-kind="${actor.kind}">
    <td class="event-time mono">${escapeHtml(time)}</td>
    <td><span class="event-actor actor-${badgeCls}" title="${escapeHtml(actor.kind)}">${iconHtml}<span class="event-actor-name">${escapeHtml(actor.name)}</span></span></td>
    <td class="event-hook">${escapeHtml(e.hook_event)}</td>
    <td>${e.tool_name ? `<span class="event-tool">${escapeHtml(e.tool_name)}</span>` : `<span class="muted tiny">—</span>`}</td>
    <td class="event-summary"><span title="${escapeHtml(sum)}">${escapeHtml(sum)}</span>${e.success === 0 ? ' <span class="badge failed">fail</span>' : ""}</td>
    <td class="event-dur mono">${e.duration_ms != null ? `${e.duration_ms}ms` : "—"}</td>
  </tr>`;
}

function streamClientScript(actorFilter: string): string {
  return `
(() => {
  const stream = document.getElementById('events-stream');
  if (!stream) return;
  const liveText = document.getElementById('events-live-text');
  const liveDot = document.querySelector('#events-live-indicator .dot');
  const actorFilter = ${JSON.stringify(actorFilter)};
  const filters = JSON.parse(stream.dataset.filters || '{}');
  let lastId = Number(stream.dataset.lastId || 0);
  const MAX_ROWS = 800;

  function paramsFromFilters(sinceId) {
    const p = new URLSearchParams();
    if (filters.agent) p.set('agent', filters.agent);
    if (filters.tool) p.set('tool', filters.tool);
    if (filters.hook) p.set('hook', filters.hook);
    if (filters.q) p.set('q', filters.q);
    if (filters.include_pre) p.set('include_pre', filters.include_pre);
    if (sinceId) p.set('since', String(sinceId));
    return p.toString();
  }

  function pulseDot() {
    if (!liveDot) return;
    liveDot.classList.add('pulse');
    setTimeout(() => liveDot.classList.remove('pulse'), 500);
  }

  async function fetchNew() {
    try {
      const resp = await fetch('/api/events-since?' + paramsFromFilters(lastId));
      if (!resp.ok) return;
      const { rows, html } = await resp.json();
      if (!rows || rows.length === 0) return;
      // actor filter はサーバ側でかけられないので client 側で
      const filteredHtml = actorFilter
        ? rows.filter(r => r.actorKind === actorFilter).map(r => r.html).join('')
        : html;
      if (!filteredHtml) return;
      // tbody 内の <tr> は template に入れないとパースされない (div.innerHTML だと tr が剥がれる)
      const tmpl = document.createElement('template');
      tmpl.innerHTML = filteredHtml;
      const newNodes = Array.from(tmpl.content.children).reverse();  // 最新を top に
      for (const node of newNodes) {
        node.classList.add('event-enter');
        stream.prepend(node);
      }
      lastId = Math.max(lastId, ...rows.map(r => r.id));
      stream.dataset.lastId = String(lastId);
      // trim to MAX_ROWS
      while (stream.children.length > MAX_ROWS) stream.removeChild(stream.lastChild);
      pulseDot();
      if (liveText) liveText.textContent = 'streaming (+' + rows.length + ')';
    } catch (e) {
      console.warn('[events] fetch error', e);
    }
  }

  // SSE tick 毎に取得
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.hello) return;
      fetchNew();
    } catch(_) {}
  };
  es.onopen = () => { if (liveText) liveText.textContent = 'streaming'; };
  es.onerror = () => { if (liveText) liveText.textContent = 'reconnecting…'; };

  // ページを開いた直後にも一度取得
  setTimeout(fetchNew, 500);
})();
`;
}
