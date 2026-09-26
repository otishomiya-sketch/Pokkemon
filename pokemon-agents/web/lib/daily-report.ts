/**
 * Daily Report Generator + Log Purge
 *
 * - 1 日分の活動を **claude -p で LLM 要約** → daily_reports に保存
 * - 失敗時は純集計 markdown にフォールバック
 * - 日報がある日付の生ログ (logs) は 7 日以上前なら安全に削除
 *
 * 自動実行: server.ts boot 時 + 6 時間ごとの setInterval (Tom の指示不要)
 */

import type { Database } from "bun:sqlite";
import { spawn } from "bun";

const RAW_LOG_RETENTION_DAYS = 7;
const CLAUDE_TIMEOUT_MS = 120_000; // 2 分

interface ReportMeta {
  date: string;
  prompt_count: number;
  event_count: number;
  reflection_count: number;
  cost_usd: number;
  agents_used: string[];
}

/**
 * 日付指定で日報を生成して daily_reports に upsert.
 * 1. 集計データ収集 → 2. claude -p で markdown 要約 (失敗時は集計テンプレ) → 3. DB 保存
 */
export async function generateReportForDate(db: Database, date: string): Promise<ReportMeta | null> {
  // 該当日に活動があるか確認 (logs OR reflections)
  const eventRow = db
    .prepare(`SELECT COUNT(*) as c FROM logs WHERE date(ts,'localtime') = ?`)
    .get(date) as { c: number };
  const reflRow = db
    .prepare(`SELECT COUNT(*) as c FROM reflections WHERE date(created_at,'localtime') = ?`)
    .get(date) as { c: number };
  if (eventRow.c === 0 && reflRow.c === 0) return null;

  const promptRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM logs WHERE date(ts,'localtime') = ? AND hook_event = 'UserPromptSubmit'`,
    )
    .get(date) as { c: number };

  const prompts = db
    .prepare(
      `SELECT DISTINCT prompt FROM logs
       WHERE date(ts,'localtime') = ? AND hook_event = 'UserPromptSubmit' AND prompt IS NOT NULL
       ORDER BY ts ASC`,
    )
    .all(date) as { prompt: string }[];

  const agentReflections = db
    .prepare(
      `SELECT agent_slug, status, COUNT(*) as c
       FROM reflections WHERE date(created_at,'localtime') = ?
       GROUP BY agent_slug, status ORDER BY c DESC`,
    )
    .all(date) as { agent_slug: string; status: string; c: number }[];

  const agentNames = db
    .prepare(`SELECT slug, pokemon_jp, role_label FROM agents`)
    .all() as { slug: string; pokemon_jp: string; role_label: string | null }[];
  const nameBy = new Map(agentNames.map((a) => [a.slug, a]));

  const agentTotals = new Map<string, { ok: number; fail: number; total: number }>();
  for (const r of agentReflections) {
    const acc = agentTotals.get(r.agent_slug) || { ok: 0, fail: 0, total: 0 };
    acc.total += r.c;
    if (r.status === "completed") acc.ok += r.c;
    else if (r.status === "failed" || r.status === "timeout" || r.status === "error") acc.fail += r.c;
    agentTotals.set(r.agent_slug, acc);
  }

  const errors = db
    .prepare(
      `SELECT agent_slug, error_message
       FROM reflections WHERE date(created_at,'localtime') = ?
         AND status IN ('failed','timeout','error') AND error_message IS NOT NULL
       LIMIT 30`,
    )
    .all(date) as { agent_slug: string; error_message: string }[];

  const tools = db
    .prepare(
      `SELECT tool_name, COUNT(*) as c FROM logs
       WHERE date(ts,'localtime') = ? AND tool_name IS NOT NULL
       GROUP BY tool_name ORDER BY c DESC LIMIT 15`,
    )
    .all(date) as { tool_name: string; c: number }[];

  const costRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as cost FROM agent_costs
       WHERE date(created_at,'localtime') = ?`,
    )
    .get(date) as { cost: number };

  const agentsUsed = [...agentTotals.keys()];

  // ===== 集計データを JSON 化 → claude -p に渡す =====
  const rawData = {
    date,
    stats: {
      tom_prompts: promptRow.c,
      agent_reflections: reflRow.c,
      raw_events: eventRow.c,
      total_cost_usd: Number(costRow.cost.toFixed(4)),
      agents_count: agentsUsed.length,
    },
    tom_prompts: prompts.map((p) => (p.prompt || "").replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean),
    agent_activity: [...agentTotals.entries()].map(([slug, t]) => ({
      agent: nameBy.get(slug)?.pokemon_jp || slug,
      role: nameBy.get(slug)?.role_label || null,
      total: t.total,
      ok: t.ok,
      fail: t.fail,
    })),
    tool_usage: tools.slice(0, 10),
    errors: errors.slice(0, 10).map((e) => ({
      agent: nameBy.get(e.agent_slug)?.pokemon_jp || e.agent_slug,
      message: (e.error_message || "").replace(/\s+/g, " ").trim().slice(0, 200),
    })),
  };

  let md: string | null = null;

  // 1) Claude で要約を試みる
  try {
    md = await summarizeViaClaude(rawData);
    if (md) console.log(`[daily-report] LLM summary OK for ${date} (${md.length} chars)`);
  } catch (err) {
    console.error(`[daily-report] LLM summary failed for ${date}:`, err);
  }

  // 2) フォールバック: 集計テンプレ
  if (!md) {
    console.warn(`[daily-report] falling back to plain aggregation for ${date}`);
    md = buildFallbackMarkdown(date, rawData);
  }

  db.run(
    `INSERT INTO daily_reports (date, summary_md, prompt_count, event_count, reflection_count, cost_usd, agents_used)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       summary_md = excluded.summary_md,
       prompt_count = excluded.prompt_count,
       event_count = excluded.event_count,
       reflection_count = excluded.reflection_count,
       cost_usd = excluded.cost_usd,
       agents_used = excluded.agents_used,
       created_at = datetime('now','localtime')`,
    [date, md, promptRow.c, eventRow.c, reflRow.c, costRow.cost, JSON.stringify(agentsUsed)],
  );

  return {
    date,
    prompt_count: promptRow.c,
    event_count: eventRow.c,
    reflection_count: reflRow.c,
    cost_usd: costRow.cost,
    agents_used: agentsUsed,
  };
}

/**
 * Claude Code CLI (claude -p) で日報 markdown を要約生成
 */
async function summarizeViaClaude(rawData: unknown): Promise<string | null> {
  const PROMPT = `あなたは Pokemon Agents プラットフォームの日報執筆者です。
以下の生データから、その日の Tom (人間オペレーター) と AI エージェントの動きを
**400-700 字程度** の日本語 markdown で要約してください。

# 出力フォーマット
## 概要
（2-3 文で全体の流れ、何にフォーカスしていたか）

## やったこと
- （主要トピック 3-6 件、似たやつはまとめる）

## 課題・気付き
- （あれば 1-3 件）

## 数値
- 指示数 / 実行数 / コスト

# ルール
- 絵文字は禁止
- 「キャタピー」「レアコイル」など pokemon_jp は名前で呼ぶ
- 重複したり似た指示はまとめる、生データの羅列は避ける
- 出力は markdown 本文のみ (前置きや「以下が日報です」等は不要)

# 生データ
\`\`\`json
${JSON.stringify(rawData, null, 2)}
\`\`\`
`;

  const proc = spawn(
    [
      "claude",
      "-p",
      PROMPT,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // タイムアウト
  const timer = setTimeout(() => {
    try { proc.kill(); } catch (_) {}
  }, CLAUDE_TIMEOUT_MS);

  try {
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    if (!text) return null;
    const parsed = JSON.parse(text) as { result?: string; is_error?: boolean };
    if (parsed.is_error) return null;
    const md = (parsed.result || "").trim();
    return md.length > 0 ? md : null;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * フォールバック: 純集計の markdown
 */
function buildFallbackMarkdown(date: string, raw: { stats: { tom_prompts: number; agent_reflections: number; raw_events: number; total_cost_usd: number; agents_count: number; }; tom_prompts: string[]; agent_activity: Array<{ agent: string; role: string | null; total: number; ok: number; fail: number }>; tool_usage: { tool_name: string; c: number }[]; errors: Array<{ agent: string; message: string }>; }): string {
  const lines: string[] = [];
  lines.push(`# ${date} の活動日報 (集計のみ)`);
  lines.push("## 概要");
  lines.push(`- Tom からの指示 ${raw.stats.tom_prompts} 件 / エージェント実行 ${raw.stats.agent_reflections} 件 / コスト $${raw.stats.total_cost_usd.toFixed(2)}`);
  if (raw.tom_prompts.length > 0) {
    lines.push("## Tom の指示");
    for (const p of raw.tom_prompts.slice(0, 20)) lines.push(`- ${p}`);
  }
  if (raw.agent_activity.length > 0) {
    lines.push("## エージェント別");
    for (const a of raw.agent_activity) lines.push(`- **${a.agent}**: ${a.total} 回 (成功 ${a.ok} / 失敗 ${a.fail})`);
  }
  if (raw.errors.length > 0) {
    lines.push("## エラー");
    for (const e of raw.errors) lines.push(`- ${e.agent}: ${e.message}`);
  }
  return lines.join("\n");
}

/**
 * 過去 30 日の中で、まだ日報未生成の日を全部生成 (今日は除外、まだ動き続けるので)
 */
export async function generateMissingReports(db: Database, lookbackDays = 30): Promise<number> {
  const existing = db
    .prepare(
      `SELECT date FROM daily_reports
       WHERE date >= date('now','-${lookbackDays} days','localtime')
         AND date < date('now','localtime')`,
    )
    .all() as { date: string }[];
  const have = new Set(existing.map((r) => r.date));

  let generated = 0;
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    if (have.has(dateStr)) continue;
    const meta = await generateReportForDate(db, dateStr);
    if (meta) {
      generated++;
      console.log(`[daily-report] generated ${dateStr} (events=${meta.event_count}, refls=${meta.reflection_count})`);
    }
  }
  return generated;
}

/**
 * 7 日以上前 + 日報がある日付の生ログのみ削除 (情報ロス無し)
 */
export function purgeOldLogs(db: Database): number {
  const r = db.run(
    `DELETE FROM logs
     WHERE date(ts,'localtime') < date('now','-${RAW_LOG_RETENTION_DAYS} days','localtime')
       AND date(ts,'localtime') IN (SELECT date FROM daily_reports)`,
  );
  if (r.changes > 0) console.log(`[daily-report] purged ${r.changes} log rows (replaced by daily reports)`);
  return r.changes;
}

export async function dailyReportTask(db: Database): Promise<void> {
  try {
    const n = await generateMissingReports(db, 30);
    if (n > 0) console.log(`[daily-report] generated ${n} reports`);
    purgeOldLogs(db);
  } catch (err) {
    console.error("[daily-report] task error:", err);
  }
}
