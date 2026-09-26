import type { Database } from "bun:sqlite";
import { escapeHtml } from "../components/layout";

interface ReportRow {
  date: string;
  prompt_count: number;
  event_count: number;
  reflection_count: number;
  cost_usd: number;
  agents_used: string | null;
  summary_md: string;
  created_at: string;
}

export function renderReports(db: Database, params: URLSearchParams): string {
  const selectedDate = params.get("date");

  const rows = db
    .query<ReportRow, []>(
      `SELECT date, prompt_count, event_count, reflection_count, cost_usd, agents_used, summary_md, created_at
       FROM daily_reports ORDER BY date DESC LIMIT 60`,
    )
    .all();

  const selected = selectedDate ? rows.find((r) => r.date === selectedDate) : rows[0];

  return `
<div class="page-header">
  <div>
    <div class="page-kicker">Daily Reports</div>
    <h1>日報</h1>
  </div>
  <div class="muted small" style="font-weight:600;">
    生ログは 7 日経過後に自動で日報化される
  </div>
</div>

${
  rows.length === 0
    ? `<div class="section empty"><p class="muted">まだ日報がありません。明日には今日分が出てくるよ。</p></div>`
    : `<div class="reports-layout">
        <aside class="reports-list">
          ${rows
            .map(
              (r) => `<a href="/reports?date=${escapeHtml(r.date)}"
                class="report-item ${selected?.date === r.date ? "active" : ""}">
                <div class="report-item-date">${escapeHtml(r.date)}</div>
                <div class="report-item-stats">
                  <span>指示 ${r.prompt_count}</span>
                  <span>実行 ${r.reflection_count}</span>
                  <span>$${r.cost_usd.toFixed(2)}</span>
                </div>
              </a>`,
            )
            .join("")}
        </aside>
        <article class="report-detail">
          ${
            selected
              ? `<div class="report-detail-md md-body">${renderMd(selected.summary_md)}</div>
                 <div class="report-detail-foot muted tiny">生成: ${escapeHtml(selected.created_at)}</div>`
              : `<div class="muted">日報を選んでください</div>`
          }
        </article>
      </div>`
}

<style>
.reports-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 900px) { .reports-layout { grid-template-columns: 1fr; } }
.reports-list {
  display: flex; flex-direction: column; gap: 4px;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
  background: #ffffff;
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  padding: 8px;
}
.report-item {
  display: block;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  text-decoration: none;
  color: inherit;
  transition: background 0.15s ease;
}
.report-item:hover { background: #f8fafc; }
.report-item.active { background: #0f172a; color: #fff; }
.report-item-date { font-weight: 800; font-size: 13px; letter-spacing: -0.005em; }
.report-item-stats {
  display: flex; gap: 10px;
  font-size: 10.5px; font-weight: 600; color: #94a3b8;
  margin-top: 3px;
}
.report-item.active .report-item-stats { color: rgba(255,255,255,0.7); }

.report-detail {
  background: #ffffff;
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  padding: 28px 32px;
}
.report-detail-md h1 { font-size: 22px; margin-top: 0; }
.report-detail-md h2 { font-size: 15px; color: #475569; margin-top: 20px; }
.report-detail-md ul { padding-left: 20px; }
.report-detail-md li { margin: 4px 0; line-height: 1.7; }
.report-detail-foot { margin-top: 24px; padding-top: 12px; border-top: 1px dashed #e2e8f0; }
</style>
`;
}

// 簡易 markdown 変換 (見出し / 箇条書き / strong だけ)
function renderMd(md: string): string {
  let html = escapeHtml(md);
  html = html
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "<li>$1</li>");
  // <li> 群を <ul> でラップ
  html = html.replace(/(<li>.*?<\/li>(?:\s*<li>.*?<\/li>)*)/gs, "<ul>$1</ul>");
  // 段落
  html = html.replace(/\n\n+/g, "\n");
  return html;
}
