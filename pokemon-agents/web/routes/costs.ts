import type { Database } from "bun:sqlite";
import { escapeHtml, fmtCents } from "../components/layout";
import { q1 } from "../lib/db-helpers";

/**
 * Costs Dashboard
 *
 * - 期間タブ: 過去30日 / 過去12週 / 過去12ヶ月 / 累計
 * - 上部 KPI: 累計 / 今月 / 今週 / 平均日次
 * - メイン: 期間×エージェント の積み上げ棒グラフ (SVG)
 * - 下: エージェント別ランキング (アバター + 利用額 + 割合)
 *
 * データソース: agent_costs (agent: slug, cost_usd, created_at)
 */

type Range = "30d" | "12w" | "12m" | "all";

interface AgentMeta {
  slug: string;
  pokemon_jp: string;
  avatar_url: string | null;
}

const SERIES_COLORS = [
  "#6a8de9", // brand blue
  "#10b981", // green
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#ef4444", // red
  "#84cc16", // lime
];
const OTHERS_COLOR = "#cbd5e1"; // slate-300

export function renderCosts(db: Database, params?: URLSearchParams): string {
  const rawRange = params?.get("range") || "30d";
  const range: Range = (["30d", "12w", "12m", "all"] as const).includes(rawRange as Range)
    ? (rawRange as Range)
    : "30d";

  // ===== KPIs (常時計算) =====
  const totalAll = q1(db, `SELECT COALESCE(SUM(cost_usd),0) FROM agent_costs`);
  const totalMonth = q1(
    db,
    `SELECT COALESCE(SUM(cost_usd),0) FROM agent_costs WHERE date(created_at) >= date('now','start of month','localtime')`,
  );
  const totalWeek = q1(
    db,
    `SELECT COALESCE(SUM(cost_usd),0) FROM agent_costs WHERE date(created_at) >= date('now','-6 days','localtime')`,
  );
  const last7Days = db
    .query<{ d: string; cost: number }, []>(
      `SELECT date(created_at,'localtime') as d, SUM(cost_usd) as cost
       FROM agent_costs WHERE date(created_at) >= date('now','-6 days','localtime')
       GROUP BY d`,
    )
    .all();
  const dailyAvg = last7Days.length > 0 ? totalWeek / last7Days.length : 0;

  // ===== Agent metadata =====
  const agentMetas = db
    .query<AgentMeta, []>(`SELECT slug, pokemon_jp, avatar_url FROM agents`)
    .all();
  const metaBySlug = new Map(agentMetas.map((m) => [m.slug, m]));

  // ===== 期間別ストック (range に応じて bucket = day/week/month) =====
  const { buckets, bucketLabel, bucketKey } = buildBuckets(range);

  // 期間内の全エージェント別 cost を取得
  const rangeWhere = bucketWhere(range);
  const grouped = db
    .query<{ bucket: string; agent: string; cost: number }, []>(
      `SELECT ${bucketKey} as bucket, agent, SUM(cost_usd) as cost
       FROM agent_costs ${rangeWhere}
       GROUP BY bucket, agent
       ORDER BY bucket ASC`,
    )
    .all();

  // ランキング (期間内合計)
  const rankRows = db
    .query<{ agent: string; total: number; cnt: number }, []>(
      `SELECT agent, SUM(cost_usd) as total, COUNT(*) as cnt
       FROM agent_costs ${rangeWhere}
       GROUP BY agent ORDER BY total DESC`,
    )
    .all();

  const rangeTotal = rankRows.reduce((s, r) => s + r.total, 0);

  // 上位 8 体を色付け、それ以外は OTHERS
  const topN = rankRows.slice(0, 8).map((r) => r.agent);
  const colorByAgent = new Map<string, string>();
  topN.forEach((slug, i) => colorByAgent.set(slug, SERIES_COLORS[i] || OTHERS_COLOR));

  // bucket × agent matrix を組み立て
  const matrix = new Map<string, Map<string, number>>(); // bucket → agent → cost
  for (const b of buckets) matrix.set(b, new Map());
  for (const g of grouped) {
    const m = matrix.get(g.bucket);
    if (!m) continue;
    const key = topN.includes(g.agent) ? g.agent : "__others";
    m.set(key, (m.get(key) ?? 0) + g.cost);
  }
  const stackKeys = [...topN, ...(rankRows.length > 8 ? ["__others"] : [])];

  // ===== Render =====
  return `
<div class="page-header">
  <div>
    <div class="page-kicker">Costs</div>
    <h1>コスト</h1>
  </div>
</div>

<div class="list-toolbar">
  <div class="list-tabs">
    ${rangeTab("30d", "過去30日", range)}
    ${rangeTab("12w", "過去12週", range)}
    ${rangeTab("12m", "過去12ヶ月", range)}
    ${rangeTab("all", "累計", range)}
  </div>
</div>

<div class="metric-grid">
  ${kpiCard("累計コスト", `$${totalAll.toFixed(2)}`, `全期間合計`)}
  ${kpiCard("今月", `$${totalMonth.toFixed(2)}`, "1日〜本日")}
  ${kpiCard("今週", `$${totalWeek.toFixed(2)}`, "直近7日")}
  ${kpiCard("平均日次", `$${dailyAvg.toFixed(2)}`, "直近7日の平均")}
</div>

<div class="section">
  <div class="section-header">
    <h2>${rangeTitle(range)} エージェント別コスト</h2>
    <span class="muted small">合計 <strong>$${rangeTotal.toFixed(2)}</strong></span>
  </div>
  ${renderStackedChart(buckets, bucketLabel, stackKeys, matrix, colorByAgent, metaBySlug)}
  ${renderLegend(stackKeys, colorByAgent, metaBySlug)}
</div>

<div class="section compact">
  <table class="runs-table">
    <thead>
      <tr>
        <th>順位</th>
        <th style="min-width:200px;">エージェント</th>
        <th>利用額</th>
        <th>占有率</th>
        <th>実行回数</th>
        <th>1回あたり</th>
      </tr>
    </thead>
    <tbody>
      ${
        rankRows.length === 0
          ? `<tr><td colspan="6" class="muted" style="padding:24px;text-align:center;">この期間のコスト記録なし</td></tr>`
          : rankRows
              .map((r, i) => {
                const meta = metaBySlug.get(r.agent);
                const color = colorByAgent.get(r.agent) || OTHERS_COLOR;
                const pct = rangeTotal > 0 ? (r.total / rangeTotal) * 100 : 0;
                return `<tr>
                  <td class="mono muted-2 tiny">${i + 1}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:10px;">
                      ${
                        meta?.avatar_url
                          ? `<img src="${escapeHtml(meta.avatar_url)}" width="32" height="32" style="border-radius:8px;background:#f3f4f6;object-fit:cover;flex-shrink:0;">`
                          : `<span style="display:inline-block;width:32px;height:32px;background:#f1f5f9;border-radius:8px;flex-shrink:0;"></span>`
                      }
                      <div style="min-width:0;">
                        <div style="font-weight:700;color:#0f172a;font-size:13px;">${escapeHtml(meta?.pokemon_jp || r.agent)}</div>
                        <div class="muted tiny mono">${escapeHtml(r.agent)}</div>
                      </div>
                    </div>
                  </td>
                  <td class="mono"><strong>$${r.total.toFixed(2)}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style="width:120px;height:6px;background:#f1f5f9;border-radius:999px;overflow:hidden;">
                        <div style="width:${pct.toFixed(1)}%;height:100%;background:${color};border-radius:999px;"></div>
                      </div>
                      <span class="mono tiny">${pct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td class="mono">${r.cnt}</td>
                  <td class="mono muted">$${(r.total / r.cnt).toFixed(4)}</td>
                </tr>`;
              })
              .join("")
      }
    </tbody>
  </table>
</div>
`;
}

// ===== Helpers =====

function rangeTab(key: Range, label: string, current: Range): string {
  const active = key === current;
  return `<a href="/costs?range=${key}" class="list-tab ${active ? "active" : ""}">${label}</a>`;
}

function rangeTitle(range: Range): string {
  return ({ "30d": "過去30日", "12w": "過去12週", "12m": "過去12ヶ月", "all": "累計" } as Record<Range, string>)[range];
}

function kpiCard(label: string, value: string, desc: string): string {
  return `<div class="metric-card">
    <div class="head">${escapeHtml(label)}</div>
    <div class="value">${escapeHtml(value)}</div>
    <div class="desc">${escapeHtml(desc)}</div>
  </div>`;
}

function bucketWhere(range: Range): string {
  if (range === "30d") return `WHERE date(created_at) >= date('now','-29 days','localtime')`;
  if (range === "12w") return `WHERE date(created_at) >= date('now','-83 days','localtime')`;
  if (range === "12m") return `WHERE date(created_at) >= date('now','-365 days','localtime')`;
  return "";
}

function buildBuckets(range: Range): { buckets: string[]; bucketLabel: (b: string) => string; bucketKey: string } {
  const today = new Date();
  if (range === "30d") {
    const buckets: string[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      buckets.push(d.toISOString().slice(0, 10));
    }
    return {
      buckets,
      bucketLabel: (b) => b.slice(5).replace("-", "/"),
      bucketKey: `date(created_at,'localtime')`,
    };
  }
  if (range === "12w") {
    const buckets: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i * 7);
      const monday = new Date(d);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      buckets.push(weekKey(monday));
    }
    return {
      buckets,
      bucketLabel: (b) => b.slice(5),
      // sqlite: 月曜日始まり週キー (年-MM-DD of Monday)
      bucketKey: `date(created_at,'localtime','weekday 0','-6 days')`,
    };
  }
  if (range === "12m") {
    const buckets: string[] = [];
    const d = new Date(today.getFullYear(), today.getMonth(), 1);
    for (let i = 11; i >= 0; i--) {
      const m = new Date(d);
      m.setMonth(m.getMonth() - i);
      buckets.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
    }
    return {
      buckets,
      bucketLabel: (b) => b.slice(2).replace("-", "/"),
      bucketKey: `strftime('%Y-%m', created_at, 'localtime')`,
    };
  }
  // all = 月単位 (全期間)
  return {
    buckets: [], // 動的に DB から取得 (空配列でフォールバック)
    bucketLabel: (b) => b,
    bucketKey: `strftime('%Y-%m', created_at, 'localtime')`,
  };
}

function weekKey(monday: Date): string {
  return monday.toISOString().slice(0, 10);
}

function renderStackedChart(
  buckets: string[],
  bucketLabel: (b: string) => string,
  stackKeys: string[],
  matrix: Map<string, Map<string, number>>,
  colorByAgent: Map<string, string>,
  metaBySlug: Map<string, AgentMeta>,
): string {
  if (buckets.length === 0 || stackKeys.length === 0) {
    return `<div class="empty muted" style="padding:40px;text-align:center;">この期間のデータがありません</div>`;
  }

  // 各 bucket の合計を計算して max を出す
  const totals = buckets.map((b) => {
    const m = matrix.get(b);
    if (!m) return 0;
    return [...m.values()].reduce((s, v) => s + v, 0);
  });
  const maxTotal = Math.max(...totals, 0.01);

  const W = 1000;
  const H = 240;
  const PAD_LEFT = 50;
  const PAD_RIGHT = 16;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 36;
  const chartW = W - PAD_LEFT - PAD_RIGHT;
  const chartH = H - PAD_TOP - PAD_BOTTOM;
  const barW = (chartW / buckets.length) * 0.7;
  const slotW = chartW / buckets.length;

  // Y 軸目盛 (4 本)
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0].map((t) => ({
    y: PAD_TOP + chartH - t * chartH,
    label: `$${(maxTotal * t).toFixed(maxTotal < 1 ? 2 : 1)}`,
  }));

  const bars = buckets
    .map((b, i) => {
      const m = matrix.get(b) || new Map();
      const x = PAD_LEFT + i * slotW + (slotW - barW) / 2;
      let yCursor = PAD_TOP + chartH;
      const segs: string[] = [];
      for (const key of stackKeys) {
        const v = m.get(key) || 0;
        if (v <= 0) continue;
        const segH = (v / maxTotal) * chartH;
        yCursor -= segH;
        const color = key === "__others" ? OTHERS_COLOR : colorByAgent.get(key) || OTHERS_COLOR;
        const meta = metaBySlug.get(key);
        const titleText = `${meta?.pokemon_jp || key} — $${v.toFixed(2)}`;
        segs.push(
          `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${color}"><title>${escapeHtml(titleText)}</title></rect>`,
        );
      }
      const labelX = PAD_LEFT + i * slotW + slotW / 2;
      const showLabel =
        buckets.length <= 12 ||
        i === 0 ||
        i === buckets.length - 1 ||
        i % Math.ceil(buckets.length / 8) === 0;
      const labelEl = showLabel
        ? `<text x="${labelX.toFixed(1)}" y="${(PAD_TOP + chartH + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="#94a3b8">${escapeHtml(bucketLabel(b))}</text>`
        : "";
      return segs.join("") + labelEl;
    })
    .join("");

  const yAxis = yTicks
    .map(
      (t) =>
        `<line x1="${PAD_LEFT}" x2="${W - PAD_RIGHT}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="#f1f5f9" stroke-width="1"/>
         <text x="${PAD_LEFT - 8}" y="${(t.y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#94a3b8">${t.label}</text>`,
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:280px;">
    ${yAxis}
    ${bars}
  </svg>`;
}

function renderLegend(
  stackKeys: string[],
  colorByAgent: Map<string, string>,
  metaBySlug: Map<string, AgentMeta>,
): string {
  if (stackKeys.length === 0) return "";
  return `<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid #f1f5f9;">
    ${stackKeys
      .map((key) => {
        const color = key === "__others" ? OTHERS_COLOR : colorByAgent.get(key) || OTHERS_COLOR;
        const meta = metaBySlug.get(key);
        const label = key === "__others" ? "その他" : meta?.pokemon_jp || key;
        return `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#475569;">
          <span style="width:10px;height:10px;border-radius:3px;background:${color};display:inline-block;"></span>
          ${escapeHtml(label)}
        </span>`;
      })
      .join("")}
  </div>`;
}
