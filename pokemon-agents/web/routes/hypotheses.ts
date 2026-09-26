import type { Database } from "bun:sqlite";
import { escapeHtml, statusBadge, jpStatus } from "../components/layout";
import { q1 } from "../lib/db-helpers";

/**
 * 施策・仮説検証 — 事業グロースのための施策サイクル
 *
 * ゲンガー集団が自律的に仮説を実施する。人間の介入はガードレールに引っかかったときだけ。
 *
 * 状態ライフサイクル:
 *   pending_review  — 承認待ち (ガードレール引っかかり、人間が見る必要あり)
 *   running         — 実施中 (AI 自動実施 or 承認済みで実施中)
 *   validated       — 勝ち (検証済み → 横展開候補)
 *   falsified       — 負け (検証済み → 失敗パターン候補)
 *   abandoned       — 取り下げ
 *
 * UI: 1 シートで全状態を見れる。タブで絞り込み。
 */

type Tab = "all" | "pending_review" | "running" | "validated" | "falsified";

interface Hypothesis {
  id: number;
  created_at: string;
  title: string;
  proposal: string;
  rationale: string | null;
  expected_impact: string | null;
  verification_method: string | null;
  verification_period_days: number | null;
  verification_result: string | null;
  status: string;
  priority: number | null;
  guardrail_reason: string | null;
  executor_agent: string | null;
  started_at: string | null;
  ended_at: string | null;
  executor_pokemon_jp: string | null;
  executor_avatar_url: string | null;
}

export function renderHypotheses(db: Database, params: URLSearchParams): string {
  const raw = params.get("tab") || params.get("view") || "all";
  const tab: Tab =
    raw === "pending_review" || raw === "running" || raw === "validated" || raw === "falsified"
      ? (raw as Tab)
      : "all";

  // 件数集計
  const cnts = {
    all: q1(db, `SELECT COUNT(*) FROM hypotheses`),
    pending: q1(db, `SELECT COUNT(*) FROM hypotheses WHERE status='pending_review'`),
    running: q1(db, `SELECT COUNT(*) FROM hypotheses WHERE status='running'`),
    won: q1(db, `SELECT COUNT(*) FROM hypotheses WHERE status='validated'`),
    lost: q1(db, `SELECT COUNT(*) FROM hypotheses WHERE status='falsified'`),
  };

  const tabLinks = [
    { key: "all", label: "全て", count: cnts.all },
    { key: "pending_review", label: "承認待ち", count: cnts.pending },
    { key: "running", label: "実施中", count: cnts.running },
    { key: "validated", label: "勝ち", count: cnts.won },
    { key: "falsified", label: "負け", count: cnts.lost },
  ];

  const header = `<div class="page-header">
    <div>
      <div class="page-kicker">Hypotheses</div>
      <h1>仮説検証</h1>
    </div>
  </div>
  <div class="list-toolbar">
    <div class="list-tabs">
      ${tabLinks.map((t) => {
        const active = tab === t.key || (t.key === "all" && tab === "all");
        return `<a href="/hypotheses?tab=${t.key}" class="list-tab ${active ? "active" : ""}"><span>${t.label}</span><span class="list-tab-count">${t.count}</span></a>`;
      }).join("")}
    </div>
  </div>`;

  // クエリ
  const where = tab === "all" ? "" : `WHERE h.status = '${tab}'`;
  const rows = db
    .query<Hypothesis, []>(
      `SELECT h.*,
              a.pokemon_jp as executor_pokemon_jp,
              a.avatar_url as executor_avatar_url
       FROM hypotheses h
       LEFT JOIN agents a ON a.slug = h.executor_agent OR a.pokemon_slug = h.executor_agent
       ${where}
       ORDER BY
         CASE h.status
           WHEN 'pending_review' THEN 1
           WHEN 'running' THEN 2
           WHEN 'validated' THEN 3
           WHEN 'falsified' THEN 4
           ELSE 5
         END,
         h.priority DESC, h.id DESC
       LIMIT 200`,
    )
    .all();

  if (rows.length === 0) {
    return header + `<div class="section empty"><p class="muted">該当する仮説がありません</p></div>`;
  }

  const table = `<div class="section compact">
    <table class="runs-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>優先度</th>
          <th style="min-width:320px;">タイトル</th>
          <th>状態</th>
          <th>実行担当</th>
          <th style="min-width:280px;">施策 (要約)</th>
          <th>検証期間</th>
          <th>起案日</th>
        </tr>
      </thead>
      <tbody>${rows.map(renderRow).join("")}</tbody>
    </table>
  </div>${renderModal()}`;

  return header + table;
}

function renderRow(h: Hypothesis): string {
  const created = (h.created_at || "").split(" ")[0] || h.created_at;
  const proposalShort = (h.proposal || "").slice(0, 120);
  const priorityBadge = h.priority
    ? `<span class="badge ${h.priority >= 4 ? "failed" : h.priority >= 3 ? "pending" : "queued"}" title="優先度 ${h.priority}/5">${"★".repeat(h.priority)}</span>`
    : '<span class="muted tiny">—</span>';

  const statusCell = h.status === "pending_review"
    ? `${statusBadge(h.status)} ${h.guardrail_reason ? `<span class="muted tiny" title="${escapeHtml(h.guardrail_reason)}">!</span>` : ""}`
    : statusBadge(h.status);

  const executorCell = h.executor_pokemon_jp
    ? `<div style="display:flex;align-items:center;gap:10px;">
         ${h.executor_avatar_url ? `<img src="${escapeHtml(h.executor_avatar_url)}" width="32" height="32" style="border-radius:8px;background:#f3f4f6;object-fit:cover;flex-shrink:0;">` : ""}
         <span style="font-weight:600;color:#0f172a;">${escapeHtml(h.executor_pokemon_jp)}</span>
       </div>`
    : h.executor_agent
      ? `<span class="small muted">${escapeHtml(h.executor_agent)}</span>`
      : '<span class="muted tiny">未割当</span>';

  return `<tr class="run-row run-row-clickable" onclick='openHypoModal(${h.id})' style="cursor:pointer;">
    <td class="mono muted-2 tiny">${h.id}</td>
    <td>${priorityBadge}</td>
    <td><strong>${escapeHtml(h.title)}</strong></td>
    <td>${statusCell}</td>
    <td>${executorCell}</td>
    <td class="what-cell"><span class="muted small" title="${escapeHtml(h.proposal)}">${escapeHtml(proposalShort)}${h.proposal.length > 120 ? "…" : ""}</span></td>
    <td class="mono tiny">${h.verification_period_days ? `${h.verification_period_days} 日` : "—"}</td>
    <td class="mono muted tiny">${escapeHtml(created)}</td>
    <td style="display:none;">
      <script type="application/json" id="hypo-data-${h.id}">${escapeJson({
        id: h.id,
        title: h.title,
        status: h.status,
        status_jp: jpStatus(h.status),
        priority: h.priority,
        guardrail_reason: h.guardrail_reason,
        proposal: h.proposal,
        rationale: h.rationale,
        expected_impact: h.expected_impact,
        verification_method: h.verification_method,
        verification_period_days: h.verification_period_days,
        verification_result: h.verification_result,
        executor_agent: h.executor_agent,
        executor_pokemon_jp: h.executor_pokemon_jp,
        executor_avatar_url: h.executor_avatar_url,
        created_at: h.created_at,
      })}</script>
    </td>
  </tr>`;
}

function renderModal(): string {
  return `
<div id="hypo-modal" class="modal" style="display:none;">
  <div class="modal-inner modal-lg">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;flex-shrink:0;">
      <h3 id="hm-title" style="margin:0;font-size:18px;"></h3>
      <span class="muted small" id="hm-subtitle"></span>
      <button class="modal-close" style="margin-left:auto;" onclick="closeHypoModal()" aria-label="閉じる" title="閉じる"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    </div>
    <div class="rm-metrics" style="flex-shrink:0;">
      <div><span class="muted tiny">状態</span><div id="hm-status"></div></div>
      <div><span class="muted tiny">優先度</span><div id="hm-priority"></div></div>
      <div><span class="muted tiny">検証期間</span><div id="hm-period"></div></div>
      <div><span class="muted tiny">実行担当</span><div id="hm-executor" style="display:flex;align-items:center;gap:6px;"></div></div>
    </div>

    <!-- 承認待ちアラート (pending_review のときだけ表示) -->
    <div id="hm-pending-banner" style="display:none;background:rgba(245,158,11,0.12);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;margin:10px 0 0;flex-shrink:0;">
      <strong>人間の承認が必要です</strong>
      <div class="small muted" style="margin-top:4px;"><span id="hm-guardrail-reason"></span></div>
    </div>

    <div class="modal-body">
      <section class="report-section">
        <div class="report-head">
          <strong>💡 施策</strong>
          <span class="muted tiny">XX した方がいい</span>
        </div>
        <article class="md-body" id="hm-proposal" style="padding:4px 0;font-size:14.5px;"></article>
      </section>

      <section class="report-section">
        <div class="report-head">
          <strong>💭 根拠</strong>
          <span class="muted tiny">なぜなら</span>
        </div>
        <article class="md-body" id="hm-rationale" style="padding:4px 0;"></article>
      </section>

      <section class="report-section">
        <div class="report-head">
          <strong>📈 期待する効果</strong>
          <span class="muted tiny">どれくらい数字にインパクトがあるか</span>
        </div>
        <article class="md-body" id="hm-impact" style="padding:4px 0;"></article>
      </section>

      <section class="report-section">
        <div class="report-head">
          <strong>🔬 検証方法</strong>
          <span class="muted tiny">どうやって効果を確認するか</span>
        </div>
        <article class="md-body" id="hm-method" style="padding:4px 0;"></article>
      </section>

      <section class="report-section">
        <div class="report-head">
          <strong>検証期間</strong>
          <span class="muted tiny">施策実施後、何日後に検証するか</span>
        </div>
        <article class="md-body" id="hm-period-detail" style="padding:4px 0;"></article>
      </section>

      <!-- 検証結果 (常時表示、未検証なら案内) -->
      <section class="report-section" style="border-color: var(--success); background: linear-gradient(180deg, rgba(16,185,129,0.04), transparent);">
        <div class="report-head">
          <strong>📊 検証結果</strong>
          <span class="muted tiny">施策をやってみた結果、どれくらい効果があったか — ここが埋まると完了</span>
        </div>
        <article class="md-body" id="hm-result" style="padding:4px 0;"></article>
      </section>
    </div>
  </div>
</div>

<script>
function openHypoModal(id) {
  const dataEl = document.getElementById('hypo-data-' + id);
  if (!dataEl) return;
  const d = JSON.parse(dataEl.textContent);
  const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '—'; };
  const renderMd = (text) => {
    if (!text) return '<span class="muted">—</span>';
    if (typeof marked !== 'undefined' && marked.parse) {
      try { return marked.parse(text, { breaks: true, gfm: true }); } catch(_) {}
    }
    return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  };
  const setMd = (id, v) => { const el = document.getElementById(id); if (el) el.innerHTML = renderMd(v); };

  setT('hm-title', d.title);
  setT('hm-subtitle', 'ID ' + d.id + ' · ' + d.created_at);
  setT('hm-status', d.status_jp || d.status);
  setT('hm-priority', d.priority ? '★'.repeat(d.priority) + ' (' + d.priority + '/5)' : '—');
  setT('hm-period', d.verification_period_days ? d.verification_period_days + ' 日' : '—');

  // 実行担当 (pokemon_jp + アバター)
  const execEl = document.getElementById('hm-executor');
  if (execEl) {
    if (d.executor_pokemon_jp) {
      const img = d.executor_avatar_url
        ? '<img src="' + d.executor_avatar_url + '" width="18" height="18" style="border-radius:4px;">' : '';
      execEl.innerHTML = img + '<span>' + d.executor_pokemon_jp + '</span>';
    } else if (d.executor_agent) {
      execEl.innerHTML = '<span>' + d.executor_agent + '</span>';
    } else {
      execEl.innerHTML = '<span class="muted">未割当</span>';
    }
  }

  // 承認待ちバナー
  const banner = document.getElementById('hm-pending-banner');
  if (banner) {
    if (d.status === 'pending_review') {
      setT('hm-guardrail-reason', d.guardrail_reason || '詳細な理由の記載なし');
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  setMd('hm-proposal', d.proposal);
  setMd('hm-rationale', d.rationale);
  setMd('hm-impact', d.expected_impact);
  setMd('hm-method', d.verification_method);
  setMd('hm-period-detail', d.verification_period_days
    ? '施策を実施した **' + d.verification_period_days + ' 日後** に効果を検証する'
    : null);

  // 検証結果 (常時表示)
  const resultEl = document.getElementById('hm-result');
  if (resultEl) {
    if (d.verification_result) {
      resultEl.innerHTML = renderMd(d.verification_result);
    } else {
      resultEl.innerHTML = '<p class="muted" style="margin:0;font-style:italic;">'
        + '⏳ まだ検証されていません。'
        + (d.verification_period_days ? ' 施策を実施して ' + d.verification_period_days + ' 日後に結果を記入してください。' : '')
        + '<br><span class="tiny">※ 検証結果が記入されると、この施策は完了扱い (勝ち / 負け 判定) になります</span>'
        + '</p>';
    }
  }

  document.getElementById('hypo-modal').style.display = 'flex';
}
function closeHypoModal() { document.getElementById('hypo-modal').style.display = 'none'; }
document.getElementById('hypo-modal').addEventListener('click', (e) => { if (e.target.id === 'hypo-modal') closeHypoModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHypoModal(); });
</script>`;
}

function escapeJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
