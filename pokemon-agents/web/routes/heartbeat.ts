import type { Database } from "bun:sqlite";
import { escapeHtml, fmtDuration, fmtCost } from "../components/layout";

export function renderHeartbeat(db: Database): string {
  const running = db
    .query<
      {
        id: number;
        agent_slug: string;
        pokemon_jp: string;
        trigger: string;
        started_at: string | null;
      },
      []
    >(
      `SELECT t.id, a.slug as agent_slug, a.pokemon_jp, t.trigger, t.started_at
       FROM reflections t JOIN agents a ON a.id=t.agent_id
       WHERE t.status='running' ORDER BY t.started_at ASC`,
    )
    .all();

  const upcoming = db
    .query<
      {
        agent_slug: string;
        pokemon_jp: string;
        trigger_type: string;
        next_run_at: string | null;
        enabled: number;
      },
      []
    >(
      `SELECT a.slug as agent_slug, a.pokemon_jp, s.trigger_type, s.next_run_at, s.enabled
       FROM agent_schedules s JOIN agents a ON a.id=s.agent_id
       WHERE s.enabled=1 AND s.next_run_at IS NOT NULL
       ORDER BY s.next_run_at ASC LIMIT 20`,
    )
    .all();

  const recent = db
    .query<
      {
        id: number;
        agent_slug: string;
        pokemon_jp: string;
        status: string;
        duration_ms: number | null;
        cost_usd: number | null;
        ended_at: string | null;
        error_message: string | null;
      },
      []
    >(
      `SELECT t.id, a.slug as agent_slug, a.pokemon_jp, t.status,
              t.duration_ms, t.cost_usd, t.ended_at, t.error_message
       FROM reflections t JOIN agents a ON a.id=t.agent_id
       WHERE t.status != 'running' AND t.status != 'queued'
       ORDER BY t.id DESC LIMIT 20`,
    )
    .all();

  return `
<div class="page-header"><h1>スケジューラ</h1><div class="sub">実行中 ${running.length}件 · 予定 ${upcoming.length}件</div></div>

<div class="section">
  <h2>🏃 実行中 (${running.length}件)</h2>
  ${
    running.length === 0
      ? `<p class="muted">現在実行中のタスクはありません</p>`
      : `<ul>${running
          .map(
            (t) => `<li>🏃 <span class="mono">#${t.id}</span> <strong>${escapeHtml(t.pokemon_jp)}</strong> (${escapeHtml(t.agent_slug)}) — 開始 ${escapeHtml(t.started_at || "")} · 起動元 ${escapeHtml(t.trigger)}</li>`,
          )
          .join("")}</ul>`
  }
</div>

<div class="section">
  <h2>🕰️ 次回起動予定 (${upcoming.length}件)</h2>
  ${
    upcoming.length === 0
      ? `<p class="muted">有効なスケジュールはありません</p>`
      : `<ul>${upcoming
          .map(
            (s) => `<li>${s.trigger_type === "automation" ? "🔗" : "🕰️"} <strong>${escapeHtml(s.pokemon_jp)}</strong> (${escapeHtml(s.agent_slug)}) <span class="muted">${escapeHtml(s.next_run_at || "")}</span></li>`,
          )
          .join("")}</ul>`
  }
</div>

<div class="section">
  <h2>✅ 最近の完了タスク (直近20件)</h2>
  ${
    recent.length === 0
      ? `<p class="muted">完了タスクなし</p>`
      : `<table>
        <thead><tr><th>ID</th><th>エージェント</th><th>状態</th><th>所要時間</th><th>コスト</th><th>終了時刻</th><th>エラー</th></tr></thead>
        <tbody>${recent
          .map(
            (t) => `<tr>
          <td class="mono">${t.id}</td>
          <td>${escapeHtml(t.pokemon_jp)} <span class="muted mono">${escapeHtml(t.agent_slug)}</span></td>
          <td><span class="badge ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
          <td>${fmtDuration(t.duration_ms)}</td>
          <td>${fmtCost(t.cost_usd)}</td>
          <td class="muted mono">${escapeHtml(t.ended_at || "")}</td>
          <td class="muted" style="font-size:11px;max-width:300px;">${escapeHtml(t.error_message || "")}</td>
        </tr>`,
          )
          .join("")}</tbody>
      </table>`
  }
</div>
`;
}
