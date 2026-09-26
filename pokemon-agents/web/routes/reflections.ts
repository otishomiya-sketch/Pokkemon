import type { Database } from "bun:sqlite";
import { escapeHtml, statusBadge, fmtDuration, fmtCost, jpStatus } from "../components/layout";

/**
 * 実行履歴 & 振り返り — runs テーブル単体、テーブル形式。
 * 1 row = 1 実行 + (optional) self-reflection が同じ row の列にインライン。
 */

interface Run {
  id: number;
  agent_slug: string;
  pokemon_jp: string | null;
  avatar_url: string | null;
  role_label: string | null;
  trigger: string | null;
  status: string;
  action: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  result_summary: string | null;
  result_full: string | null;          // 外部アウトプット (Discord 本文 / 記事 URL 一覧)
  error_message: string | null;
  items_processed: number | null;
  items_succeeded: number | null;
  items_failed: number | null;
  // Reflection (4 層)
  what_done: string | null;            // やったこと (箇条書き)
  quality_check: string | null;        // ルール準拠チェック ✅/❌
  self_improvement: string | null;     // 自律改善: agent.md/コードをどう直すか (ミューツーが読む)
  content_improvement: string | null;  // 事業改善: アウトプット構造の進化案 (ミュウが読む)
  quality_score: number | null;
  // legacy (使わない、過去データ保護用)
  output_details: string | null;
  what_went_well: string | null;
  what_to_improve: string | null;
  lesson_learned: string | null;
  self_score: number | null;
  reflected_at: string | null;
  created_at: string;
}

export function renderReflections(db: Database, params: URLSearchParams): string {
  const agentFilter = params.get("agent") || "";
  const statusFilter = params.get("status") || "";
  const minScore = params.get("min_score");
  const onlyWithRefl = params.get("only_refl") === "1";

  const where: string[] = [];
  const args: unknown[] = [];
  if (agentFilter) {
    where.push("r.agent_slug = ?");
    args.push(agentFilter);
  }
  if (statusFilter) {
    where.push("r.status = ?");
    args.push(statusFilter);
  }
  if (minScore) {
    where.push("r.quality_score >= ?");
    args.push(Number(minScore));
  }
  if (onlyWithRefl) {
    where.push("(r.quality_score IS NOT NULL OR r.what_done IS NOT NULL OR r.what_went_well IS NOT NULL)");
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // JOIN は slug (full) を優先、見つからなければ pokemon_slug (短縮形) で fallback。
  // run-agent.sh の過去バージョンが短縮形を入れていた互換対応 (2026-04-24)。
  const rows = db
    .query<Run, []>(
      `SELECT r.id, r.agent_slug, a.pokemon_jp, a.avatar_url, a.role_label,
              r.trigger, r.status, r.action,
              r.started_at, r.ended_at, r.duration_ms, r.tokens_in, r.tokens_out, r.cost_usd,
              r.result_summary,
              CAST(r.result_full AS TEXT) as result_full,
              r.error_message,
              r.items_processed, r.items_succeeded, r.items_failed,
              r.what_done, r.quality_check, r.self_improvement, r.content_improvement,
              r.output_details, r.what_went_well, r.what_to_improve, r.lesson_learned,
              r.quality_score, r.self_score,
              r.reflected_at, r.created_at
       FROM reflections r
       LEFT JOIN agents a ON a.slug = r.agent_slug OR a.pokemon_slug = r.agent_slug
       ${whereSql}
       ORDER BY r.created_at DESC LIMIT 100`,
    )
    .all(...(args as never[]));

  const stats = db
    .query<{ total: number; refl: number }, []>(
      `SELECT COUNT(*) as total, SUM(CASE WHEN self_score IS NOT NULL THEN 1 ELSE 0 END) as refl FROM reflections`,
    )
    .get() as { total: number; refl: number } | null;

  const agentList = db
    .query<{ agent_slug: string; c: number; pokemon_jp: string | null }, []>(
      `SELECT r.agent_slug, COUNT(*) as c, a.pokemon_jp
       FROM reflections r
       LEFT JOIN agents a ON a.slug = r.agent_slug OR a.pokemon_slug = r.agent_slug
       GROUP BY r.agent_slug ORDER BY c DESC LIMIT 30`,
    )
    .all();

  const statusList = db
    .query<{ status: string; c: number }, []>(
      `SELECT status, COUNT(*) as c FROM reflections GROUP BY status ORDER BY c DESC LIMIT 15`,
    )
    .all();

  return `
<div class="list-toolbar">
  <form method="GET" style="display:inline-flex;gap:8px;flex-wrap:wrap;align-items:center;">
    <select name="agent" class="list-sort-select" onchange="this.form.submit()">
        <option value="">エージェント (全て)</option>
        ${agentList.map((a) => `<option value="${escapeHtml(a.agent_slug)}" ${a.agent_slug === agentFilter ? "selected" : ""}>${escapeHtml(a.pokemon_jp || a.agent_slug)} (${a.c})</option>`).join("")}
      </select>
      <select name="status" class="list-sort-select" onchange="this.form.submit()">
        <option value="">状態 (全て)</option>
        ${statusList.map((s) => `<option value="${escapeHtml(s.status)}" ${s.status === statusFilter ? "selected" : ""}>${escapeHtml(jpStatus(s.status))} (${s.c})</option>`).join("")}
      </select>
      <select name="min_score" class="list-sort-select" onchange="this.form.submit()">
        <option value="">品質スコア (全て)</option>
        <option value="90" ${minScore === "90" ? "selected" : ""}>90点 以上</option>
        <option value="70" ${minScore === "70" ? "selected" : ""}>70点 以上</option>
        <option value="50" ${minScore === "50" ? "selected" : ""}>50点 以上</option>
        <option value="1" ${minScore === "1" ? "selected" : ""}>1点 以上</option>
      </select>
      <label class="filter-checkbox">
        <input type="checkbox" name="only_refl" value="1" ${onlyWithRefl ? "checked" : ""} onchange="this.form.submit()">
        <span>振り返りありのみ</span>
      </label>
    ${agentFilter || statusFilter || minScore || onlyWithRefl ? `<a href="/reflections" class="btn sm">クリア</a>` : ""}
  </form>
</div>

${
  rows.length === 0
    ? `<div class="section empty"><p class="muted">該当なし</p></div>`
    : `<div class="section compact">
  <table class="runs-table">
    <thead>
      <tr>
        <th>ID</th>
        <th>時刻</th>
        <th style="min-width:180px;">エージェント</th>
        <th>状態</th>
        <th>処理時間</th>
        <th>コスト</th>
        <th>品質スコア</th>
        <th style="min-width:380px;">何をしたか</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(renderRow).join("")}
    </tbody>
  </table>
</div>

<!-- Reflection Modal (大きめ + 縦積み) -->
<div id="refl-modal" class="modal" style="display:none;">
  <div class="modal-inner modal-lg">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;flex-shrink:0;">
      <h3 id="rm-title" style="margin:0;font-size:18px;"></h3>
      <span class="muted small" id="rm-subtitle"></span>
      <button class="modal-close" style="margin-left:auto;" onclick="closeReflModal()" aria-label="閉じる" title="閉じる">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="rm-metrics" style="flex-shrink:0;">
      <div><span class="muted tiny">状態</span><div id="rm-status"></div></div>
      <div><span class="muted tiny">品質スコア</span><div id="rm-score"></div></div>
      <div><span class="muted tiny">処理時間</span><div id="rm-dur"></div></div>
      <div><span class="muted tiny">コスト</span><div id="rm-cost"></div></div>
      <div><span class="muted tiny">エラー率</span><div id="rm-err"></div></div>
    </div>
    <div class="modal-body">
      <!-- Discord 通知本文 (= result_full、他エージェントが読む SSOT) -->
      <section id="rm-report-section" class="report-section" style="display:none;">
        <div class="report-head">
          <strong>Discord 通知本文</strong>
          <span class="muted tiny">エージェントが実際に送ったアウトプット</span>
        </div>
        <article class="md-body report-body" id="rm-report"></article>
      </section>

      <!-- エージェント自己振り返り (4層) -->
      <details class="refl-collapsible" open>
        <summary>エージェント自己振り返り</summary>
        <div class="refl-grid">
          <div class="refl-cell"><strong>何をしたか</strong><div class="md-body" id="rm-what-done"></div></div>
          <div class="refl-cell"><strong>ルール準拠チェック</strong><div class="md-body" id="rm-quality-check"></div></div>
          <div class="refl-cell"><strong>自律改善 <span class="muted tiny">(agent.md / コード修正候補 → ミューツーが読む)</span></strong><div class="md-body" id="rm-self-improvement"></div></div>
          <div class="refl-cell"><strong>事業改善 <span class="muted tiny">(アウトプット構造の進化案 → ミュウが読む)</span></strong><div class="md-body" id="rm-content-improvement"></div></div>
        </div>
      </details>
    </div>
  </div>
</div>

<script>
function openReflModal(runId) {
  const dataEl = document.getElementById('refl-data-' + runId);
  if (!dataEl) return;
  const d = JSON.parse(dataEl.textContent);
  const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '—'; };
  // Markdown → HTML (marked が未ロードの場合は素通しで改行だけ <br> に)
  const renderMd = (text) => {
    if (!text) return '<span class="muted">—</span>';
    if (typeof marked !== 'undefined' && marked.parse) {
      try { return marked.parse(text, { breaks: true, gfm: true }); } catch (_) {}
    }
    // フォールバック
    const esc = String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return esc.replace(/\\n/g, '<br>');
  };
  const setMd = (id, v) => { const el = document.getElementById(id); if (el) el.innerHTML = renderMd(v); };
  setT('rm-title', d.agent + (d.role_label ? ' — ' + d.role_label : ''));
  setT('rm-subtitle', d.created_at);
  setT('rm-status', d.status_jp || d.status || '—');
  setT('rm-score', d.quality_score != null ? (d.quality_score + '/100') : '—');
  setT('rm-dur', d.duration_ms != null ? (Math.round(d.duration_ms/1000) + 's') : '—');
  setT('rm-cost', d.cost_usd != null ? ('$' + Number(d.cost_usd).toFixed(4)) : '—');
  setT('rm-err', d.err_rate != null ? (d.err_rate + '%') : '—');
  setMd('rm-what-done', d.what_done);
  setMd('rm-quality-check', d.quality_check);
  setMd('rm-self-improvement', d.self_improvement);
  setMd('rm-content-improvement', d.content_improvement);
  // レポート本文 (result_full) があれば表示、無ければセクション非表示
  // bun:sqlite が BLOB 返す可能性あり → 文字列化してから判定
  const reportSec = document.getElementById('rm-report-section');
  const reportText = typeof d.result_full === 'string' ? d.result_full
                   : d.result_full ? String(d.result_full) : '';
  if (reportText.trim()) {
    setMd('rm-report', reportText);
    reportSec.style.display = 'block';
  } else {
    reportSec.style.display = 'none';
  }
  document.getElementById('refl-modal').style.display = 'flex';
}
function closeReflModal() { document.getElementById('refl-modal').style.display = 'none'; }
document.getElementById('refl-modal').addEventListener('click', (e) => { if (e.target.id === 'refl-modal') closeReflModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReflModal(); });
</script>
`
}
`;
}

function renderRow(r: Run): string {
  const timeShort = (r.created_at || "").split(" ")[1]?.slice(0, 5) || r.created_at;
  const hasRefl =
    r.quality_score != null || r.self_score != null ||
    Boolean(r.what_done) || Boolean(r.output_details) ||
    Boolean(r.what_went_well) || Boolean(r.what_to_improve) || Boolean(r.lesson_learned);

  // エラー率 (items_failed / items_processed、100% cap、items_failed > items_processed の時は 100%)
  const errRate =
    r.items_processed != null && r.items_processed > 0
      ? Math.min(100, Math.round(((r.items_failed ?? 0) / r.items_processed) * 100))
      : null;

  // Score badge (0-100 点に統一済み、legacy self_score は migration 済)
  const scoreBadge = (() => {
    if (r.quality_score != null) {
      const cls = r.quality_score >= 80 ? "completed" : r.quality_score >= 50 ? "pending" : "failed";
      return `<span class="badge ${cls}">${r.quality_score}/100</span>`;
    }
    return `<span class="muted tiny">—</span>`;
  })();

  // 何をしたか: what_done (agent 自己報告) > result_summary (system) > error_message の優先順
  const whatText = r.what_done || r.result_summary || r.error_message || "";
  const isError = !r.what_done && !r.result_summary && !!r.error_message;
  const whatShort = whatText.slice(0, 160);
  const whatCell = whatText
    ? `<span class="what-text${isError ? ' dot-off' : ''}" title="${escapeHtml(whatText)}">${isError ? '⚠️ ' : ''}${escapeHtml(whatShort)}${whatText.length > 160 ? '…' : ''}</span>`
    : '<span class="muted tiny">—</span>';

  const hasModalContent = !!(hasRefl || r.result_summary || r.error_message || r.result_full);
  const detailScript = hasModalContent
    ? `<script type="application/json" id="refl-data-${r.id}">${escapeJson({
        run_id: r.id,
        agent: r.pokemon_jp || r.agent_slug,
        role_label: r.role_label,
        created_at: r.created_at,
        quality_score: r.quality_score,
        cost_usd: r.cost_usd,
        duration_ms: r.duration_ms,
        err_rate: errRate,
        status: r.status,
        status_jp: jpStatus(r.status),
        what_done: r.what_done,
        quality_check: r.quality_check,
        self_improvement: r.self_improvement,
        content_improvement: r.content_improvement,
        result_summary: r.result_summary,
        // result_full が BLOB として返ってくるケース対策
        result_full: r.result_full == null ? null : String(r.result_full),
        error_message: r.error_message,
      })}</script>`
    : ``;

  const rowClick = hasModalContent ? ` onclick='openReflModal(${r.id})' style='cursor:pointer;'` : "";
  return `<tr class="run-row${hasModalContent ? " run-row-clickable" : ""}"${rowClick}>
    <td class="mono muted-2 tiny">${r.id}</td>
    <td class="mono muted tiny" title="${escapeHtml(r.created_at)}">${escapeHtml(timeShort)}</td>
    <td>
      <div style="display:flex;align-items:center;gap:10px;">
        ${r.avatar_url ? `<img src="${escapeHtml(r.avatar_url)}" alt="" width="36" height="36" style="border-radius:8px;background:#f3f4f6;flex-shrink:0;object-fit:cover;">` : `<span style="display:inline-block;width:36px;height:36px;background:#f1f5f9;border-radius:8px;flex-shrink:0;"></span>`}
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:13px;color:#0f172a;">${escapeHtml(r.pokemon_jp || r.agent_slug)}${!r.pokemon_jp ? ' <span class="muted tiny">(引退)</span>' : ""}</div>
          <div class="muted tiny" style="white-space:nowrap;">${escapeHtml(r.role_label || r.agent_slug)}</div>
        </div>
      </div>
    </td>
    <td>${statusBadge(r.status)}</td>
    <td class="mono tiny">${fmtDuration(r.duration_ms)}</td>
    <td class="mono tiny">${fmtCost(r.cost_usd)}</td>
    <td>${scoreBadge}</td>
    <td class="what-cell">${whatCell}${detailScript}</td>
  </tr>`;
}

function escapeJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
