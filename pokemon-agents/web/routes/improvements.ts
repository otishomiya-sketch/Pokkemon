import type { Database } from "bun:sqlite";
import { escapeHtml, statusBadge, jpStatus } from "../components/layout";
import { q1 } from "../lib/db-helpers";

/**
 * 自律改善 — エージェント制御の改善サイクル
 *
 * ミュウが観測、ミューツーが agent.md 修正案を起案、人間承認 → 適用 → 効果測定。
 *
 * 状態ライフサイクル (仮説検証と同じ):
 *   pending_review  — 承認待ち (agent.md 破壊的変更等、ガードレール引っかかり)
 *   running         — 実施中 (ミューツー適用済み、効果測定中)
 *   validated       — 勝ち (効果検証済み → 知識昇華候補)
 *   falsified       — 負け (効果なし → revert or 別案)
 *   abandoned       — 取り下げ
 *
 * 5 フィールド構造 (仮説検証と同じ + 検証期間なし):
 *   1. 何をやるか (proposal)
 *   2. なぜやるか (rationale)
 *   3. どれぐらい効果ありそうか (expected_impact)
 *   4. どうやって検証するか (verification_method)
 *   5. 検証結果 (verification_result)
 *
 * 仮説検証との違い:
 *   - 事業 KPI ではなく **エージェント制御** の改善
 *   - 検証期間は「次のエージェント実行時」なので項目省略
 *   - target_agent カラム (どのエージェントの agent.md を直すか)
 */

type Tab = "all" | "pending_review" | "running" | "validated" | "falsified";

interface Improvement {
  id: number;
  created_at: string;
  title: string;
  proposal: string;
  rationale: string | null;
  expected_impact: string | null;
  verification_method: string | null;
  verification_result: string | null;
  status: string;
  priority: number | null;
  guardrail_reason: string | null;
  target_agent: string | null;
  executor_agent: string | null;
  started_at: string | null;
  ended_at: string | null;
  target_pokemon_jp: string | null;
  target_avatar_url: string | null;
  executor_pokemon_jp: string | null;
  executor_avatar_url: string | null;
}

export function renderImprovements(db: Database, params: URLSearchParams): string {
  const raw = params.get("tab") || params.get("view") || "all";
  const tab: Tab =
    raw === "pending_review" || raw === "running" || raw === "validated" || raw === "falsified"
      ? (raw as Tab)
      : "all";

  const cnts = {
    all: q1(db, `SELECT COUNT(*) FROM improvements`),
    pending: q1(db, `SELECT COUNT(*) FROM improvements WHERE status='pending_review'`),
    running: q1(db, `SELECT COUNT(*) FROM improvements WHERE status='running'`),
    won: q1(db, `SELECT COUNT(*) FROM improvements WHERE status='validated'`),
    lost: q1(db, `SELECT COUNT(*) FROM improvements WHERE status='falsified'`),
  };

  const tabLinks = [
    { key: "all", label: "全て", count: cnts.all },
    { key: "pending_review", label: "承認待ち", count: cnts.pending },
    { key: "running", label: "実施中", count: cnts.running },
    { key: "validated", label: "成功", count: cnts.won },
    { key: "falsified", label: "失敗", count: cnts.lost },
  ];

  const header = `<div class="page-header">
    <div>
      <div class="page-kicker">Improvements</div>
      <h1>自律改善</h1>
    </div>
  </div>
  <div class="list-toolbar">
    <div class="list-tabs">
      ${tabLinks.map((t) => {
        const active = tab === t.key;
        return `<a href="/improvements?tab=${t.key}" class="list-tab ${active ? "active" : ""}"><span>${t.label}</span><span class="list-tab-count">${t.count}</span></a>`;
      }).join("")}
    </div>
  </div>`;

  const where = tab === "all" ? "" : `WHERE i.status = '${tab}'`;
  const rows = db
    .query<Improvement, []>(
      `SELECT i.*,
              ta.pokemon_jp as target_pokemon_jp, ta.avatar_url as target_avatar_url,
              ea.pokemon_jp as executor_pokemon_jp, ea.avatar_url as executor_avatar_url
       FROM improvements i
       LEFT JOIN agents ta ON ta.slug = i.target_agent OR ta.pokemon_slug = i.target_agent
       LEFT JOIN agents ea ON ea.slug = i.executor_agent OR ea.pokemon_slug = i.executor_agent
       ${where}
       ORDER BY
         CASE i.status
           WHEN 'pending_review' THEN 1
           WHEN 'running' THEN 2
           WHEN 'validated' THEN 3
           WHEN 'falsified' THEN 4
           ELSE 5
         END,
         i.priority DESC, i.id DESC
       LIMIT 200`,
    )
    .all();

  if (rows.length === 0) {
    return header + `<div class="section empty"><p class="muted">該当する自律改善案件がありません</p></div>`;
  }

  const table = `<div class="section compact">
    <table class="runs-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>優先度</th>
          <th style="min-width:320px;">タイトル</th>
          <th>状態</th>
          <th>対象エージェント</th>
          <th style="min-width:280px;">施策 (要約)</th>
          <th>起案日</th>
        </tr>
      </thead>
      <tbody>${rows.map(renderRow).join("")}</tbody>
    </table>
  </div>${renderModal()}`;

  return header + table;
}

function renderRow(i: Improvement): string {
  const created = (i.created_at || "").split(" ")[0] || i.created_at;
  const proposalShort = (i.proposal || "").slice(0, 120);
  const priorityBadge = i.priority
    ? `<span class="badge ${i.priority >= 4 ? "failed" : i.priority >= 3 ? "pending" : "queued"}" title="優先度 ${i.priority}/5">${"★".repeat(i.priority)}</span>`
    : '<span class="muted tiny">—</span>';

  const statusCell = i.status === "pending_review"
    ? `${statusBadge(i.status)} ${i.guardrail_reason ? `<span class="muted tiny" title="${escapeHtml(i.guardrail_reason)}">!</span>` : ""}`
    : statusBadge(i.status);

  const agentCell = (jp: string | null, avatar: string | null, slug: string | null) => {
    if (jp) {
      return `<div style="display:flex;align-items:center;gap:10px;">
         ${avatar ? `<img src="${escapeHtml(avatar)}" width="32" height="32" style="border-radius:8px;background:#f3f4f6;object-fit:cover;flex-shrink:0;">` : ""}
         <span style="font-weight:600;color:#0f172a;">${escapeHtml(jp)}</span>
       </div>`;
    }
    return slug ? `<span class="small muted">${escapeHtml(slug)}</span>` : '<span class="muted tiny">—</span>';
  };

  return `<tr class="run-row run-row-clickable" onclick='openImproveModal(${i.id})' style="cursor:pointer;">
    <td class="mono muted-2 tiny">${i.id}</td>
    <td>${priorityBadge}</td>
    <td><strong>${escapeHtml(i.title)}</strong></td>
    <td>${statusCell}</td>
    <td>${agentCell(i.target_pokemon_jp, i.target_avatar_url, i.target_agent)}</td>
    <td class="what-cell"><span class="muted small" title="${escapeHtml(i.proposal)}">${escapeHtml(proposalShort)}${i.proposal.length > 120 ? "…" : ""}</span></td>
    <td class="mono muted tiny">${escapeHtml(created)}</td>
    <td style="display:none;">
      <script type="application/json" id="improve-data-${i.id}">${escapeJson({
        id: i.id,
        title: i.title,
        status: i.status,
        status_jp: jpStatus(i.status),
        priority: i.priority,
        guardrail_reason: i.guardrail_reason,
        proposal: i.proposal,
        rationale: i.rationale,
        expected_impact: i.expected_impact,
        verification_method: i.verification_method,
        verification_result: i.verification_result,
        target_agent: i.target_agent,
        target_pokemon_jp: i.target_pokemon_jp,
        target_avatar_url: i.target_avatar_url,
        executor_agent: i.executor_agent,
        executor_pokemon_jp: i.executor_pokemon_jp,
        executor_avatar_url: i.executor_avatar_url,
        created_at: i.created_at,
      })}</script>
    </td>
  </tr>`;
}

function renderModal(): string {
  return `
<div id="improve-modal" class="modal" style="display:none;">
  <div class="modal-inner modal-lg">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;flex-shrink:0;">
      <h3 id="im-title" style="margin:0;font-size:18px;"></h3>
      <span class="muted small" id="im-subtitle"></span>
      <button class="modal-close" style="margin-left:auto;" onclick="closeImproveModal()" aria-label="閉じる" title="閉じる"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    </div>
    <div class="rm-metrics" style="flex-shrink:0;">
      <div><span class="muted tiny">状態</span><div id="im-status"></div></div>
      <div><span class="muted tiny">優先度</span><div id="im-priority"></div></div>
      <div><span class="muted tiny">対象 agent</span><div id="im-target" style="display:flex;align-items:center;gap:6px;"></div></div>
      <div><span class="muted tiny">実行担当</span><div id="im-executor" style="display:flex;align-items:center;gap:6px;"></div></div>
    </div>

    <!-- 承認待ちアラート -->
    <div id="im-pending-banner" style="display:none;background:rgba(245,158,11,0.12);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;margin:10px 0 0;flex-shrink:0;">
      <strong>人間の承認が必要です</strong>
      <div class="small muted" style="margin-top:4px;"><span id="im-guardrail-reason"></span></div>
    </div>

    <div class="modal-body">
      <section class="report-section">
        <div class="report-head">
          <strong>🔧 施策</strong>
          <span class="muted tiny">何をやるか</span>
        </div>
        <article class="md-body" id="im-proposal" style="padding:4px 0;font-size:14.5px;"></article>
      </section>

      <section class="report-section">
        <div class="report-head">
          <strong>💭 根拠</strong>
          <span class="muted tiny">なぜやるか</span>
        </div>
        <article class="md-body" id="im-rationale" style="padding:4px 0;"></article>
      </section>

      <section class="report-section">
        <div class="report-head">
          <strong>📈 期待する効果</strong>
          <span class="muted tiny">どれぐらい効果がありそうか</span>
        </div>
        <article class="md-body" id="im-impact" style="padding:4px 0;"></article>
      </section>

      <section class="report-section">
        <div class="report-head">
          <strong>🔬 検証方法</strong>
          <span class="muted tiny">どうやって効果を確認するか (次回のエージェント実行で判定)</span>
        </div>
        <article class="md-body" id="im-method" style="padding:4px 0;"></article>
      </section>

      <section class="report-section" style="border-color: var(--success); background: linear-gradient(180deg, rgba(16,185,129,0.04), transparent);">
        <div class="report-head">
          <strong>📊 検証結果</strong>
          <span class="muted tiny">施策をやってみた結果 — ここが埋まると改善完了</span>
        </div>
        <article class="md-body" id="im-result" style="padding:4px 0;"></article>
      </section>
    </div>
  </div>
</div>

<script>
function openImproveModal(id) {
  const dataEl = document.getElementById('improve-data-' + id);
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
  const setAgent = (elId, jp, avatar, slug) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (jp) {
      const img = avatar ? '<img src="' + avatar + '" width="18" height="18" style="border-radius:4px;">' : '';
      el.innerHTML = img + '<span>' + jp + '</span>';
    } else if (slug) {
      el.innerHTML = '<span>' + slug + '</span>';
    } else {
      el.innerHTML = '<span class="muted">—</span>';
    }
  };

  setT('im-title', d.title);
  setT('im-subtitle', 'ID ' + d.id + ' · ' + d.created_at);
  setT('im-status', d.status_jp || d.status);
  setT('im-priority', d.priority ? '★'.repeat(d.priority) + ' (' + d.priority + '/5)' : '—');
  setAgent('im-target', d.target_pokemon_jp, d.target_avatar_url, d.target_agent);
  setAgent('im-executor', d.executor_pokemon_jp, d.executor_avatar_url, d.executor_agent);

  const banner = document.getElementById('im-pending-banner');
  if (banner) {
    if (d.status === 'pending_review') {
      setT('im-guardrail-reason', d.guardrail_reason || '詳細な理由の記載なし');
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  setMd('im-proposal', d.proposal);
  setMd('im-rationale', d.rationale);
  setMd('im-impact', d.expected_impact);
  setMd('im-method', d.verification_method);

  const resultEl = document.getElementById('im-result');
  if (resultEl) {
    if (d.verification_result) {
      resultEl.innerHTML = renderMd(d.verification_result);
    } else {
      resultEl.innerHTML = '<p class="muted" style="margin:0;font-style:italic;">'
        + '⏳ まだ検証されていません。'
        + ' 対象エージェントの次回実行時に効果が判定されます。'
        + '<br><span class="tiny">※ 検証結果が記入されると、この改善は完了扱い (成功 / 失敗 判定) になります</span>'
        + '</p>';
    }
  }

  document.getElementById('improve-modal').style.display = 'flex';
}
function closeImproveModal() { document.getElementById('improve-modal').style.display = 'none'; }
document.getElementById('improve-modal').addEventListener('click', (e) => { if (e.target.id === 'improve-modal') closeImproveModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeImproveModal(); });
</script>`;
}

function escapeJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
