#!/usr/bin/env bun
/**
 * Pokemon Agents Dashboard Server
 *
 * Bun.serve() で HTTP server を起動。
 * - scheduler と統合: 同じプロセスで heartbeat tick も実行
 * - localhost 専用、auth なし
 * - bun:sqlite で .claude/db/agents.db を直接読み書き
 * - HTML を SSR (テンプレート文字列、ビルド不要)
 *
 * 起動: bun pokemon-agents/web/server.ts
 *      → http://localhost:5733/
 */

import { Database } from "bun:sqlite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { startScheduler } from "../runtime/scheduler-loop";
import { renderLayout, escapeHtml } from "./components/layout";
import { renderOverview } from "./routes/overview";
import { renderAgents } from "./routes/agents";
import { renderHeartbeat } from "./routes/heartbeat";
import { renderApprovalActions } from "./routes/approvalActions";
import { renderCosts } from "./routes/costs";
import { fetchEvents, renderRow } from "./routes/events";
import { renderLogs } from "./routes/logs";
import { renderHypotheses } from "./routes/hypotheses";
import { renderImprovements } from "./routes/improvements";
import { renderDomainKnowledge, reindexKnowledge } from "./routes/domain-knowledge";
import { syncLaunchdToDb } from "./lib/launchd-sync";
import { saveSchedule, toggleSchedule, readScheduleTimes, type TimeSpec } from "./lib/schedule-writer";
import { classifyActor, buildAgentLookup } from "./lib/actors";
import { sseHandler } from "./sse";

function getBadges(db: Database): {
  approvals: number;
  running: number;
  totalAgents: number;
  activeAgents: number;
  healthPct: number;
  healthMood: string;
  events24h: number;
  errors7d: number;
} {
  const a = db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM approvals WHERE status='pending'`).get() as
    | { c: number } | null;
  const r = db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM reflections WHERE status='running'`).get() as
    | { c: number } | null;
  const t = db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM agents`).get() as { c: number } | null;
  const ac = db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM agents WHERE status='active'`).get() as
    | { c: number } | null;
  const ev = db.query<{ c: number }, []>(
    `SELECT COUNT(*) as c FROM logs WHERE ts >= datetime('now','-24 hours','localtime')`,
  ).get() as { c: number } | null;
  const health = db
    .query<{ total: number; success: number; failed: number }, []>(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status IN ('completed','success','validated','applied','approved','fixed') THEN 1 ELSE 0 END) as success,
              SUM(CASE WHEN status IN ('failed','error','timeout','failure','falsified') THEN 1 ELSE 0 END) as failed
       FROM reflections WHERE created_at >= date('now','-7 days','localtime')`,
    )
    .get() as { total: number; success: number; failed: number } | null;
  const total = health?.total ?? 0;
  const succ = health?.success ?? 0;
  const fail = health?.failed ?? 0;
  const healthPct = total > 0 ? Math.round((succ / total) * 1000) / 10 : 0;
  const healthMood =
    healthPct >= 95 ? "絶好調！" : healthPct >= 80 ? "好調" : healthPct >= 60 ? "普通" : healthPct >= 40 ? "要観察" : "要対応";

  return {
    approvals: a?.c ?? 0,
    running: r?.c ?? 0,
    totalAgents: t?.c ?? 0,
    activeAgents: ac?.c ?? 0,
    healthPct,
    healthMood,
    events24h: ev?.c ?? 0,
    errors7d: fail,
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DB_PATH = process.env.AGENTS_DB_PATH || resolve(REPO_ROOT, ".claude/db/agents.db");
const PORT = Number(process.env.POKEMON_AGENTS_PORT || 5733);

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// scheduler を同プロセスで開始 (環境変数で抑止可)
if (process.env.POKEMON_AGENTS_SCHEDULER !== "off") {
  startScheduler({ db, repoRoot: REPO_ROOT });
}

// scheduled セッションの attribution を復元 (起動前から走ってる agent のため)

// Claude Code hook ingestion: POST /event/{HookName}
// legacy .claude/pokemon-dashboard/server.ts から移植。transcript tailer は統合しない
// (hook 由来のみ記録 → 過去ログ復元なしのクリーンな観測が可能)
const insertEvent = db.prepare(`
  INSERT INTO logs (session_id, cwd, agent, hook_event, tool_name, tool_input, tool_response, success, duration_ms, prompt, transcript_path, tool_use_id, source, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// session_id → { agentSlug, source } のマップ (scheduled agent の attribution 用)
// UserPromptSubmit / SessionStart の payload を見て推定し、以降同セッションの全 event に適用
// 起動時に DB から既存の scheduled セッションを復元 (進行中 agent の attribution が途切れないように)
type SessionInfo = { agentSlug: string | null; source: "scheduled" | "claude" };
const sessionSource = new Map<string, SessionInfo>();

function hydrateSessionSource(db: Database): void {
  const rows = db
    .query<{ session_id: string; agent: string }, []>(
      `SELECT DISTINCT session_id, agent FROM logs
       WHERE source='scheduled' AND agent IS NOT NULL AND session_id IS NOT NULL`,
    )
    .all();
  for (const r of rows) {
    sessionSource.set(r.session_id, { agentSlug: r.agent, source: "scheduled" });
  }
  console.log(`[hook] hydrated ${rows.length} scheduled sessions`);
}

function extractAgentFromPrompt(prompt: string): string | null {
  // prompt 例: "/Users/tom/dev/hojokin-db/.claude/agents/_seo-metrics/abra-seo-report/agent.md を読み..."
  const m = prompt.match(/\.claude\/agents\/(?:_[a-z-]+\/)?([a-z][a-z0-9-]+)\/agent\.md/);
  return m ? m[1] : null;
}

hydrateSessionSource(db);

// サーバ起動時に agents を agent.md から自動 seed (DB-native)
// agent.md frontmatter が SSOT、DB は自動 derive
try {
  const seedScript = resolve(REPO_ROOT, "pokemon-agents/scripts/seed-agents-from-md.ts");
  const proc = Bun.spawnSync(["bun", seedScript], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString();
  const lastLine = out.trim().split("\n").slice(-2).join(" | ");
  console.log(`[seed] ${lastLine || "done"}`);
  if (proc.exitCode !== 0) {
    console.warn("[seed] exit code:", proc.exitCode, proc.stderr.toString().slice(0, 200));
  }
} catch (err) {
  console.warn("[seed] startup seed failed:", err);
}

// サーバ起動時にドメイン知識インデックスを rebuild
try {
  reindexKnowledge(db);
} catch (err) {
  console.warn("[knowledge] startup reindex failed:", err);
}

// サーバ起動時に launchd plist → agent_schedules を同期 (plist が SSOT)
try {
  syncLaunchdToDb(db);
} catch (err) {
  console.warn("[launchd-sync] startup sync failed:", err);
}

function pickAgentFromInput(hookEvent: string, payload: Record<string, unknown>): string | null {
  if ((hookEvent === "PreToolUse" || hookEvent === "PostToolUse")) {
    const toolName = payload?.tool_name as string | undefined;
    const toolInput = payload?.tool_input as Record<string, unknown> | undefined;
    if ((toolName === "Agent" || toolName === "Task") && toolInput?.subagent_type) {
      return String(toolInput.subagent_type);
    }
  }
  return null;
}

/**
 * session_id 単位で「scheduled(launchd で起動した agent.md) / claude (対話中)」を判定。
 * UserPromptSubmit の prompt に agent.md path があれば scheduled として記録。
 * 以降の event は session map を参照して attribution を自動解決。
 */
function resolveSessionAttribution(
  hookEvent: string,
  payload: Record<string, unknown>,
): SessionInfo | null {
  const sid = payload?.session_id as string | undefined;
  if (!sid) return null;
  const existing = sessionSource.get(sid);
  if (existing) return existing;

  // 初回: UserPromptSubmit / SessionStart の prompt から推定
  if (hookEvent === "UserPromptSubmit" || hookEvent === "SessionStart") {
    const prompt = (payload?.prompt as string) || "";
    const slug = extractAgentFromPrompt(prompt);
    const info: SessionInfo = slug
      ? { agentSlug: slug, source: "scheduled" }
      : { agentSlug: null, source: "claude" };
    sessionSource.set(sid, info);
    return info;
  }
  return null;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // localhost のみ
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // POST: approve / reject / schedule / budget actions / hook ingestion
      if (req.method === "POST") {
        // Claude Code hook: POST /event/{PreToolUse,PostToolUse,UserPromptSubmit,SessionStart,Stop}
        if (path.startsWith("/event/")) {
          const hookEvent = path.slice("/event/".length);
          try {
            const payload = (await req.json()) as Record<string, unknown>;
            const toolInput = payload?.tool_input;
            const toolResponse = payload?.tool_response as Record<string, unknown> | undefined;
            const successRaw = toolResponse?.success;
            const sid = (payload?.session_id as string) ?? null;

            // session_id 単位で scheduled agent を特定
            const sessionInfo = resolveSessionAttribution(hookEvent, payload);
            // agent 列: subagent_type (Agent/Task tool) > session 由来 agentSlug
            const agent =
              pickAgentFromInput(hookEvent, payload) ??
              sessionInfo?.agentSlug ??
              (sid ? sessionSource.get(sid)?.agentSlug ?? null : null);
            // source 列: hook 由来かつ session が scheduled なら "scheduled"、それ以外 "hook"
            const source = sessionInfo?.source === "scheduled" ? "scheduled" :
              (sid && sessionSource.get(sid)?.source === "scheduled") ? "scheduled" : "hook";

            insertEvent.run(
              sid,
              (payload?.cwd as string) ?? null,
              agent,
              hookEvent,
              (payload?.tool_name as string) ?? null,
              toolInput ? JSON.stringify(toolInput) : null,
              toolResponse ? JSON.stringify(toolResponse) : null,
              successRaw == null ? null : successRaw ? 1 : 0,
              (payload?.duration_ms as number) ?? null,
              (payload?.prompt as string) ?? null,
              (payload?.transcript_path as string) ?? null,
              (payload?.tool_use_id as string) ?? null,
              source,
              JSON.stringify(payload),
            );
            // logs threshold チェック (Claude Code compaction 風)
            (globalThis as { __triggerCompactCheck?: () => void }).__triggerCompactCheck?.();
            return new Response("ok", { status: 200 });
          } catch (err) {
            console.error("[hook]", hookEvent, err);
            return new Response("error", { status: 500 });
          }
        }
        if (path === "/api/approve" || path === "/api/reject") {
          return await renderApprovalActions(db, path, await req.formData());
        }
        // plist 書き出しによるスケジュール編集 (ダッシュボードから launchd に反映)
        if (path === "/api/schedule/save") {
          try {
            const body = (await req.json()) as {
              agent_slug: string;
              mode?: "calendar" | "interval";
              times?: TimeSpec[];
              interval_sec?: number;
              enabled: boolean;
            };
            const result = saveSchedule(body);
            // DB も即 rebuild
            syncLaunchdToDb(db);
            return new Response(JSON.stringify({ ok: true, ...result }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            return new Response(JSON.stringify({ ok: false, error: String(err) }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        if (path === "/api/schedule/toggle") {
          try {
            const body = (await req.json()) as { agent_slug: string; enabled: boolean };
            const result = toggleSchedule(body.agent_slug, body.enabled);
            syncLaunchdToDb(db);
            return new Response(JSON.stringify({ ok: true, ...result }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            return new Response(JSON.stringify({ ok: false, error: String(err) }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        if (path === "/api/schedule") {
          const form = await req.formData();
          const agentId = Number(form.get("agent_id"));
          const triggerType = String(form.get("trigger_type") || "timer");
          // interval_num + interval_unit (新 UI) or interval_sec (旧) を両対応
          let intervalSec: number;
          const num = Number(form.get("interval_num") || "0");
          const unit = Number(form.get("interval_unit") || "0");
          if (num > 0 && unit > 0) {
            intervalSec = num * unit;
          } else {
            intervalSec = Number(form.get("interval_sec") || "3600");
          }
          const enabled = form.get("enabled") === "1" ? 1 : 0;
          const next =
            triggerType === "timer" ? nowPlusSec(intervalSec) : null;
          db.run(
            `INSERT INTO agent_schedules (agent_id, trigger_type, interval_sec, enabled, next_run_at)
             VALUES (?, ?, ?, ?, ?)`,
            [agentId, triggerType, triggerType === "timer" ? intervalSec : null, enabled, next],
          );
          return redirect("/agents?view=list");
        }
        return new Response("Not Found", { status: 404 });
      }

      // Static styles
      if (path === "/styles.css") {
        return new Response(stylesheet(), {
          headers: { "Content-Type": "text/css" },
        });
      }
      // Static assets under public/ (bg/*, hero/*)
      if (path.startsWith("/bg/") || path.startsWith("/hero/")) {
        if (path.includes("..")) return new Response("Not Found", { status: 404 });
        const file = Bun.file(`${import.meta.dir}/public${path}`);
        if (await file.exists()) {
          return new Response(file, {
            headers: { "Cache-Control": "public, max-age=86400" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }
      // SSE: live update broadcaster
      if (path === "/api/events") {
        return sseHandler(db);
      }
      // Live fragments (SSE 受信時に部分 swap で取得)
      if (path === "/api/fragments/heartbeat") {
        return new Response(renderHeartbeat(db), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/api/fragments/dashboard") {
        return new Response(renderOverview(db), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/api/fragments/badges") {
        const b = getBadges(db);
        return new Response(JSON.stringify(b), {
          headers: { "Content-Type": "application/json" },
        });
      }
      // スケジュール編集モーダル用: 既存 plist の時刻リストを返す
      if (path === "/api/schedule/read") {
        const slug = url.searchParams.get("slug") || "";
        if (!/^[a-z][a-z0-9-]+$/.test(slug)) {
          return new Response(JSON.stringify({ times: [], enabled: true, exists: false }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        const result = readScheduleTimes(slug);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      }
      // /api/reflections-since?since=<id> — 新しい reflections (= ポケモンの活動報告) を返す
      if (path === "/api/reflections-since") {
        const sinceId = Number(url.searchParams.get("since") || "0");
        const { fetchReflectionsSince, renderReflectionPost } = await import("./routes/overview");
        const rows = fetchReflectionsSince(db, sinceId, 30);
        return new Response(
          JSON.stringify({
            rows: rows.map((r) => ({ id: r.id, html: renderReflectionPost(r, 0) })),
            html: rows.map((r) => renderReflectionPost(r, 0)).join(""),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      // /api/events-since?since=<id>&agent=&tool=&hook=&q=&include_pre= — 新しい events を JSON で返す
      if (path === "/api/events-since") {
        const sinceId = Number(url.searchParams.get("since") || "0");
        const rows = fetchEvents(db, {
          agentFilter: url.searchParams.get("agent") || "",
          toolFilter: url.searchParams.get("tool") || "",
          hookFilter: url.searchParams.get("hook") || "",
          q: url.searchParams.get("q") || "",
          includePre: url.searchParams.get("include_pre") === "1",
          sinceId,
        });
        const agentLookup = buildAgentLookup(db);
        const result = {
          rows: rows.map((e) => ({
            id: e.id,
            actorKind: classifyActor(e, agentLookup).kind,
            html: renderRow(e, agentLookup),
          })),
          html: rows.map((e) => renderRow(e, agentLookup)).join(""),
        };
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const badges = getBadges(db);
      const currentPath = path + (url.search || "");
      const lay = (title: string, body: string) =>
        html(renderLayout({ title, body, currentPath, badges }));

      // ===== 4-menu structure =====
      if (path === "/" || path === "") return lay("Dashboard", renderOverview(db));
      // ===== Flat URL = DB table name =====
      // /agents       (table: agents)         一覧 (default) — ?view=org で組織図
      // /schedules    (table: agent_schedules) スケジュール
      // /costs                                  コスト
      // /runs         (table: runs)            リフレクションログ
      // /events       (table: events)          行動ログ
      // /hypotheses   (table: hypotheses)      仮説検証
      // /improvements (table: improvements)    自律改善
      // /knowledge                              ドメイン知識
      if (path === "/agents") {
        const raw = url.searchParams.get("view") || "list";
        const view = (raw === "org" ? "org" : "list") as "org" | "list";
        return lay("エージェント", renderAgents(db, view, url.searchParams));
      }
      if (path === "/schedules") {
        return lay("エージェントスケジュール", renderAgents(db, "schedule", url.searchParams));
      }
      if (path === "/costs") {
        return lay("コスト", renderCosts(db, url.searchParams));
      }
      if (path === "/reflections") {
        const p = new URLSearchParams(url.searchParams);
        p.set("view", "reflections");
        return lay("リフレクションログ", renderLogs(db, p));
      }
      if (path === "/logs") {
        const p = new URLSearchParams(url.searchParams);
        p.set("view", "events");
        return lay("行動ログ", renderLogs(db, p));
      }
      if (path === "/hypotheses") return lay("仮説検証", renderHypotheses(db, url.searchParams));
      if (path === "/improvements") return lay("自律改善", renderImprovements(db, url.searchParams));
      if (path === "/knowledge") return lay("ドメイン知識", renderDomainKnowledge(db, url.searchParams));
      if (path === "/reports") {
        const { renderReports } = await import("./routes/reports");
        return lay("日報", renderReports(db, url.searchParams));
      }
      if (path === "/api/reindex-knowledge") {
        const result = reindexKnowledge(db);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      }

      // ===== Legacy redirects =====
      if (path === "/runs") return redirect("/reflections");
      if (path === "/events") return redirect("/logs");
      if (path === "/org") return redirect("/agents?view=org");
      if (path === "/heartbeat") return redirect("/schedules");
      if (path === "/tasks") return redirect("/reflections");
      if (path === "/activity") return redirect("/logs");
      if (path === "/inbox") return redirect("/improvements");
      if (path === "/approvals") return redirect("/improvements");
      if (path === "/issues") return redirect("/improvements");

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      const err = e as Error;
      console.error(`[server] ${req.method} ${path}:`, err);
      return html(
        renderLayout({
          title: "Error",
          body: `<div class="error"><h2>Server Error</h2><pre>${escapeHtml(err.message)}\n\n${escapeHtml(err.stack || "")}</pre></div>`,
          currentPath: req.url,
        }),
        500,
      );
    }
  },
});

console.log(`[pokemon-agents] dashboard ready at http://localhost:${server.port}/`);
console.log(`[pokemon-agents] db: ${DB_PATH}`);
console.log(`[pokemon-agents] scheduler: ${process.env.POKEMON_AGENTS_SCHEDULER === "off" ? "DISABLED" : "running"}`);

// ゾンビ reflection の自動回収 (process 死亡 + DB が running のまま放置されたもの)
//   ・boot 時に 1 回 + 30 分毎の定期スキャン
//   ・閾値: status='running' で 2 時間以上経過 (通常 timeout 30 分・最長 90 分なので余裕見て 2h)
function reapZombieReflections() {
  const r = db.run(`
    UPDATE reflections SET
      status = 'aborted',
      ended_at = datetime('now','localtime'),
      error_message = COALESCE(error_message, 'Auto-marked aborted: stale running > 2h with no completion signal'),
      updated_at = datetime('now','localtime')
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND ended_at IS NULL
      AND (julianday('now','localtime') - julianday(started_at)) * 24 > 2
  `);
  if (r.changes > 0) console.log(`[zombie-reaper] aborted ${r.changes} stale running reflections`);
}
reapZombieReflections();
setInterval(reapZombieReflections, 30 * 60 * 1000);

// 日報生成 + 古い生ログ削除 — Claude Code の compacting 風 threshold トリガー
//   ・boot 時に 1 回 (backlog 解消)
//   ・logs が COMPACT_THRESHOLD 行を超えたら自動発動 (hook 内で 100 回毎にチェック)
//   ・安全網として 6 時間毎にもチェック (アイドル時の遅延回収)
const COMPACT_THRESHOLD = 5000;
let logInsertSinceCheck = 0;
let compactRunning = false;

import("./lib/daily-report").then(({ dailyReportTask }) => {
  dailyReportTask(db).catch(console.error);
  setInterval(() => {
    if (!compactRunning) dailyReportTask(db).catch(console.error);
  }, 6 * 60 * 60 * 1000);

  // hook insert からの threshold トリガー — グローバル関数として export
  (globalThis as { __triggerCompactCheck?: () => void }).__triggerCompactCheck = () => {
    logInsertSinceCheck++;
    if (logInsertSinceCheck < 100) return;
    logInsertSinceCheck = 0;
    if (compactRunning) return;
    const row = db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM logs`).get();
    if (!row || row.c < COMPACT_THRESHOLD) return;
    console.log(`[daily-report] threshold tripped (logs=${row.c}), running compaction`);
    compactRunning = true;
    dailyReportTask(db).finally(() => { compactRunning = false; });
  };
});

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function redirect(to: string): Response {
  return new Response(null, { status: 303, headers: { Location: to } });
}

function nowPlusSec(sec: number): string {
  const d = new Date(Date.now() + sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function stylesheet(): string {
  return `
:root {
  /* Apple system colors (light) — iOS 26 / macOS Tahoe palette */
  --ios-blue:    #6a8de9;
  --ios-green:   #34C759;
  --ios-red:     #FF3B30;
  --ios-orange:  #FF9500;
  --ios-yellow:  #FFCC00;
  --ios-purple:  #AF52DE;
  --ios-indigo:  #5856D6;
  --ios-pink:    #FF2D55;
  --ios-teal:    #30B0C7;

  /* Capsell brand */
  --brand:           #6a8de9;
  --brand-hover:     #5a7dd9;
  --brand-tint-bg:   rgba(106,141,233,0.10);

  --label-primary:   #0f172a;            /* slate-900 */
  --label-secondary: #475569;            /* slate-600 */
  --label-tertiary:  #94a3b8;            /* slate-400 */
  --label-quat:      #cbd5e1;            /* slate-300 */
  --separator:       rgba(15,23,42,0.08);

  --bg:                #F4F7FE;          /* capsell body bg */
  --card:              #ffffff;
  --fg:                var(--label-primary);
  --muted:             #64748b;          /* slate-500 */
  --muted-2:           #94a3b8;          /* slate-400 */
  --accent:            var(--brand);
  --accent-fg:         #ffffff;
  --primary:           var(--brand);
  --success:           var(--ios-green);
  --warn:              var(--ios-orange);
  --danger:            var(--ios-red);
  --info:              var(--brand);

  /* capsell ラウンド: rounded-xl 12 / rounded-2xl 16 / rounded-3xl 24 */
  --r-sm: 12px;
  --r-md: 16px;
  --r-lg: 24px;
  --r-xl: 28px;
  --r-pill: 999px;

  /* シャドー — capsell は控えめ。"白カードが lavender bg から浮く" 設計 */
  --shadow-card: 0 1px 2px rgba(15,23,42,0.04);
  --shadow-soft: 0 1px 3px rgba(15,23,42,0.06), 0 4px 12px rgba(15,23,42,0.04);
  --shadow-float: 0 1px 2px rgba(15,23,42,0.04);
  --shadow-pop:  0 24px 48px rgba(15,23,42,0.22), 0 8px 16px rgba(15,23,42,0.08);

  /* hairline border (capsell は border 多用) */
  --hairline: 1px solid #e2e8f0;       /* slate-200 */
  --hairline-soft: 1px solid #f1f5f9;  /* slate-100 */

  /* 内側タイル (ソリッド) */
  --tile-bg:         #FAFAFB;
  --tile-bg-soft:    #F2F2F7;
  --tile-bg-strong:  #ffffff;
  --header-bg:       #FAFAFB;
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  font-family: "Poppins", "LINE Seed JP", -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  color: var(--fg);
  font-size: 14px; line-height: 1.55;
  font-weight: 500;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
body { background-color: var(--bg); min-height: 100vh; }
a { color: inherit; text-decoration: none; font-weight: 600; }
button { font-family: inherit; }
strong, b { font-weight: 700; color: #000; }

/* App layout — capsell スタイル: outer padding 20 + gap 0 (sidebar 自身の margin で間隔) */
.app { display: grid; grid-template-columns: 280px 1fr; gap: 4px; padding: 20px; min-height: 100vh; }

/* Sidebar — capsell-style floating white card */
.sidebar {
  position: sticky; top: 20px;
  display: flex; flex-direction: column;
  width: 280px;
  height: calc(100vh - 40px);
  padding: 24px 16px;
  gap: 12px;
  background: #ffffff;
  border-radius: 20px;
  overflow: hidden;
}
.sidebar-header { padding: 4px 8px 8px; }
.sidebar-header .brand { display: flex; align-items: center; gap: 12px; font-weight: 800; font-size: 15.5px; letter-spacing: -0.01em; color: #000; }
.sidebar-header .brand-mark {
  width: 34px; height: 34px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #EF4444;
  background: #FEE2E2;
  border-radius: var(--r-sm);
}
.sidebar-header .brand-mark svg { width: 19px; height: 19px; }
.sidebar-header .brand-sub { color: var(--muted); font-size: 11.5px; margin-top: 6px; padding-left: 46px; font-weight: 600; }

.sidebar-nav { flex: 1; overflow-y: auto; padding: 4px 4px; display: flex; flex-direction: column; gap: 3px; }
.sidebar-nav::-webkit-scrollbar { width: 6px; }
.sidebar-nav::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 999px; }
.nav-section { display: flex; flex-direction: column; gap: 3px; }
.nav-section-label { font-size: 10.5px; font-weight: 800; color: var(--muted-2); padding: 14px 10px 6px; text-transform: uppercase; letter-spacing: 0.12em; }

.nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  color: #0f172a;                  /* slate-900 */
  font-size: 12.15px;              /* -10% (user指定維持) */
  font-weight: 700;                /* capsell font-bold */
  letter-spacing: -0.005em;
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-item:hover { background: #f1f5f9; color: #0f172a; }   /* slate-100 */
.nav-item.active {
  background: #0f172a;              /* slate-900 (黒系) */
  color: #ffffff;
}

/* nav icon — capsell スタイルでは flat svg をそのまま表示 */
.sidebar .nav-icon-chip {
  width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent;
  color: #94a3b8;          /* slate-400 — capsell muted icon */
  flex-shrink: 0;
  transition: color 0.15s ease;
}
.sidebar .nav-item:hover .nav-icon-chip,
.sidebar .nav-child:hover .nav-icon-chip { color: #0f172a; }
.sidebar .nav-item.active .nav-icon-chip,
.sidebar .nav-child.active .nav-icon-chip { color: #ffffff; }
/* サイドバー外の icon chip (使われていれば) — colored rounded square 形式 */
.nav-icon-chip {
  width: 28px; height: 28px;
  border-radius: var(--r-sm);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--tile-bg);
  color: #6B7280;
  flex-shrink: 0;
  transition: background 0.1s ease, color 0.1s ease;
}
.nav-icon-chip svg { width: 15px; height: 15px; }
.nav-icon-chip-sm { width: 24px; height: 24px; border-radius: 8px; }
.nav-icon-chip-sm svg { width: 13px; height: 13px; }

/* Color each nav item's icon chip by function */
/* 旧: data-nav 別カラーチップ — capsell スタイルでは flat、サイドバー外でのみ有効 */
.nav-item:not(.sidebar *)[data-nav="agents"] .nav-icon-chip   { background: rgba(106,141,233,0.12); color: var(--brand); }
.nav-item:not(.sidebar *)[data-nav="activity"] .nav-icon-chip { background: #E0F2FE; color: #0369A1; }
.nav-item:not(.sidebar *)[data-nav="zap"] .nav-icon-chip      { background: #FEF3C7; color: #B45309; }
.nav-item:not(.sidebar *)[data-nav="knowledge"] .nav-icon-chip{ background: #DCFCE7; color: #166534; }
.nav-item.active .nav-icon-chip { background: rgba(255,255,255,0.18); color: #fff; }

.nav-label { flex: 1; }
.nav-badge {
  background: #EF4444; color: #fff;
  padding: 2px 8px; border-radius: var(--r-pill);
  font-size: 10.5px; font-weight: 800;
  min-width: 22px; text-align: center; line-height: 1.5;
  box-shadow: var(--shadow-card);
}
.nav-item.active .nav-badge { background: #fff; color: #0f172a; }

.nav-children { display: flex; flex-direction: column; gap: 2px; padding: 2px 0 6px 14px; position: relative; }
.nav-children {
  margin-left: 12px;
  padding-left: 12px;
  border-left: 1px solid rgba(15,23,42,0.08);   /* capsell border-slate-200/60 */
}
.nav-child {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  color: #475569;                  /* slate-600 */
  font-size: 11.7px;
  font-weight: 700;
  letter-spacing: -0.005em;
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-child:hover { background: #f1f5f9; color: #0f172a; }
.nav-child.active { background: #0f172a; color: #ffffff; }

/* Sidebar footer — inner tile */
.sidebar-footer {
  padding: 14px;
  background: #FAFAFB;
  border-radius: var(--r-md);
  display: flex; flex-direction: column; gap: 12px;
}
.sys-status-card {
  display: flex; align-items: center; gap: 10px;
}
.sys-status-mark {
  width: 40px; height: 40px; border-radius: var(--r-sm);
  background: #FEE2E2;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.sys-status-body { min-width: 0; }
.sys-status-label { font-size: 10.5px; font-weight: 700; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
.sys-status-state { font-size: 13px; color: #000; display: flex; align-items: center; gap: 6px; margin-top: 2px; font-weight: 700; }
.sys-status-state strong { font-weight: 800; }
.sys-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #22C55E; box-shadow: 0 0 0 3px rgba(34,197,94,0.25); }
.sys-status-metric { padding: 0 2px; }
.sys-status-metric-label { font-size: 11px; color: var(--muted); font-weight: 700; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
.sys-status-metric-val { font-size: 24px; font-weight: 800; letter-spacing: -0.025em; color: #000; font-variant-numeric: tabular-nums; line-height: 1.1; }
.sys-status-metric-val span { font-size: 13px; color: var(--muted-2); font-weight: 700; margin-left: 4px; }

.env-pill {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 12px;
  border-radius: var(--r-pill);
  background: #18181b;
  color: #fff;
  font-size: 11px;
  align-self: flex-start;
  font-weight: 700;
}
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dot-on { background: #22C55E; box-shadow: 0 0 0 2px rgba(34,197,94,0.35); }
.dot-off { background: #EF4444; box-shadow: 0 0 0 2px rgba(239,68,68,0.3); }

/* Main */
.main { padding: 20px 28px 32px; min-width: 0; width: 100%; }
.page-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 20px; gap: 16px; flex-wrap: wrap; }
.page-header h1 { margin: 0; font-size: 28px; font-weight: 700; color: #000; letter-spacing: -0.025em; line-height: 1.15; }
.page-header .sub { color: var(--muted); font-size: 13px; font-weight: 600; }
/* English kicker label above the title (magazine style) */
.page-kicker {
  font-size: 10.5px;
  font-weight: 800;
  color: var(--brand);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  margin-bottom: 6px;
  display: inline-flex; align-items: center; gap: 8px;
}
.page-kicker::after {
  content: ""; display: inline-block;
  width: 24px; height: 1.5px;
  background: var(--brand);
  border-radius: 999px;
}
h2 { margin: 0 0 14px; font-size: 13px; font-weight: 600; color: var(--label-secondary); text-transform: uppercase; letter-spacing: 0.06em; }
h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; color: #000; letter-spacing: -0.01em; }
p { margin: 4px 0; }

/* Metric cards (card-style, no border, shadow) */
.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 24px; }
.metric-card { display: block; background: #ffffff; border-radius: var(--r-md); padding: 20px 22px; box-shadow: var(--shadow-card); transition: background 0.15s ease; }
.metric-card:hover { background: #FAFAFB; }
.metric-card .head { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.metric-card .head svg { width: 14px; height: 14px; }
.metric-card .value { font-size: 32px; font-weight: 700; margin-top: 8px; line-height: 1.05; color: #000; letter-spacing: -0.028em; font-variant-numeric: tabular-nums; }
.metric-card .desc { color: var(--muted); font-size: 12px; margin-top: 4px; font-weight: 600; }
.metric-card.warn   { background: linear-gradient(180deg, rgba(245,158,11,0.10), #fff 60%); }
.metric-card.danger { background: linear-gradient(180deg, rgba(239,68,68,0.10), #fff 60%); }
.metric-card.success { background: linear-gradient(180deg, rgba(16,185,129,0.10), #fff 60%); }

/* Sections */
.section { background: #ffffff; border-radius: var(--r-md); padding: 24px; margin-bottom: 16px; box-shadow: var(--shadow-card); }
.section.compact { padding: 16px; }
.section-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
.section-header h2 { margin: 0; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
.chart-card { background: #ffffff; border-radius: var(--r-md); padding: 18px 20px; min-height: 130px; box-shadow: var(--shadow-card); }
.chart-card .head { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.chart-card .head .sub { color: var(--muted-2); font-size: 10px; }
.chart-card .body { display: flex; align-items: flex-end; height: 70px; margin-top: 8px; }

/* Lists / rows — separator は極薄シャドー/背景で表現 */
.list { display: flex; flex-direction: column; }
.list-row { display: flex; align-items: center; gap: 10px; padding: 12px 14px; font-size: 13px; border-radius: var(--r-sm); margin: 2px 0; transition: background 0.1s; }
.list-row:hover { background: rgba(0,0,0,0.035); }
.list-row .ico { display: flex; align-items: center; color: var(--muted); }
.list-row .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #000; }

/* Tables — no borders, zebra + hover で判別 */
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
th { text-align: left; padding: 10px 12px; color: var(--muted); font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; background: var(--tile-bg); position: sticky; top: 0; z-index: 2; }
th:first-child { border-top-left-radius: var(--r-sm); }
th:last-child { border-top-right-radius: var(--r-sm); }
td { padding: 12px; vertical-align: top; color: #000; font-weight: 500; }
tr:hover td { background: rgba(0,0,0,0.025); }
tbody tr + tr td { box-shadow: inset 0 1px 0 rgba(0,0,0,0.04); }

/* Status badges — 単色背景 + 白テキスト */
.badge { display: inline-block; padding: 3px 10px; border-radius: var(--r-pill); font-size: 11px; font-weight: 700; line-height: 1.4; color: #fff; letter-spacing: 0.01em; white-space: nowrap; }
.badge.completed     { background: #059669; }
.badge.running       { background: #2563EB; animation: pulse 1.5s ease-in-out infinite; }
.badge.queued        { background: #6B7280; }
.badge.failed        { background: #DC2626; }
.badge.timeout       { background: #D97706; }
.badge.budget_halted { background: #B45309; }
.badge.skipped       { background: #9CA3AF; }
.badge.cancelled     { background: #9CA3AF; }
.badge.pending       { background: #D97706; }
.badge.rejected      { background: #B91C1C; }
.badge.applied       { background: #059669; }
.badge.approved      { background: #059669; }
.badge.entity        { background: #0f172a; }
.badge.todo          { background: #6B7280; }
.badge.in_progress   { background: #2563EB; }
.badge.in_review     { background: #D97706; }
.badge.done          { background: #059669; }
.badge.blocked       { background: #DC2626; }
.badge.warning       { background: #D97706; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.65} }

/* Misc */
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; }
.muted { color: var(--muted); font-weight: 500; }
.muted-2 { color: var(--muted-2); font-weight: 500; }
.small { font-size: 12px; }
.tiny { font-size: 11px; }
/* Apple Liquid Glass button — glass-pill */
/* capsell button — secondary は border + bg-white、primary は rounded-full bg-brand */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 9px 16px;
  border: 1px solid #e2e8f0;
  border-radius: var(--r-sm);
  background: #ffffff;
  color: #334155;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.btn:hover  { background: #f8fafc; color: #0f172a; }
.btn.primary { border: 0; border-radius: var(--r-pill); background: #0f172a; color: #fff; padding: 10px 20px; }
.btn.primary:hover  { background: #1e293b; }      /* slate-800 */
.btn.success { border: 0; border-radius: var(--r-pill); background: var(--ios-green); color: #fff; padding: 10px 20px; }
.btn.success:hover  { background: #2BB14F; }
.btn.danger  { color: var(--ios-red); border-color: #fecaca; }
.btn.danger:hover  { background: #fef2f2; }
.btn.sm { padding: 6px 12px; font-size: 12px; }
.btn.primary.sm, .btn.success.sm { padding: 6px 14px; }
.error { background: #FEE2E2; padding: 16px; border-radius: var(--r-md); color: #991B1B; font-weight: 600; box-shadow: var(--shadow-card); }
.error pre { white-space: pre-wrap; font-size: 12px; }
details > summary { cursor: pointer; font-size: 12px; color: var(--primary); margin-top: 6px; font-weight: 700; }
details pre { background: #18181b; color: #e4e4e7; padding: 12px; border-radius: var(--r-sm); overflow-x: auto; font-size: 11px; max-height: 320px; overflow-y: auto; line-height: 1.5; }
.flash { padding: 12px 14px; border-radius: var(--r-sm); margin-bottom: 16px; font-size: 13px; font-weight: 700; box-shadow: var(--shadow-card); }
.flash.ok { background: #059669; color: #fff; }
.flash.err { background: #DC2626; color: #fff; }

/* Approval cards */
.approval-card { background: #ffffff; border-radius: var(--r-md); padding: 20px 24px; margin-bottom: 16px; box-shadow: var(--shadow-card); position: relative; overflow: hidden; }
.approval-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--warn); }
.approval-card .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.approval-card .head .id { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; }
.approval-card .head h3 { margin: 0; font-size: 14px; color: #000; font-weight: 700; }
.approval-card .meta { font-size: 11px; color: var(--muted); margin-bottom: 8px; font-weight: 600; }
.approval-card .body-text { font-size: 13px; color: #000; white-space: pre-wrap; margin-bottom: 10px; font-weight: 500; }
.approval-card .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.approval-card form { display: inline; }

/* Org chart */
.org-canvas { background: #ffffff; border-radius: var(--r-md); padding: 24px; overflow: auto; box-shadow: var(--shadow-card); }
.org-svg { display: block; }
.org-card-bg { fill: var(--card); stroke: none; filter: drop-shadow(0 1px 3px rgba(16,24,40,0.08)); }
.org-card-bg.active { stroke: #10B981; stroke-width: 2; }
.org-card-bg.disabled { opacity: 0.5; }
.org-card-name { font-size: 13px; font-weight: 700; fill: #000; }
.org-card-role { font-size: 11px; fill: var(--muted); font-weight: 600; }
.org-card-status { font-size: 10px; font-weight: 700; }
.org-edge { stroke: #D4D4D8; stroke-width: 1.5; fill: none; }

/* Kanban */
.kanban { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.kanban-col { background: var(--tile-bg-soft); border-radius: var(--r-md); padding: 14px; min-height: 200px; }
.kanban-col h3 { margin: 0 0 10px; font-size: 12px; color: #000; font-weight: 800; display: flex; justify-content: space-between; text-transform: uppercase; letter-spacing: 0.04em; }
.kanban-col h3 .count { background: var(--tile-bg); border-radius: var(--r-pill); padding: 2px 10px; font-size: 11px; font-weight: 700; }
.kanban-issue { background: #ffffff; border-radius: var(--r-sm); padding: 12px 14px; margin-bottom: 8px; font-size: 12px; box-shadow: var(--shadow-card); transition: background 0.15s ease; }
.kanban-issue:hover { background: #f8fafc; }
.kanban-issue .title { font-weight: 700; color: #000; }
.kanban-issue .meta { color: var(--muted); font-size: 11px; margin-top: 5px; display: flex; gap: 6px; font-weight: 600; }

/* Agent / dept blocks */
.dept-section { background: #ffffff; border-radius: var(--r-md); padding: 24px; margin-bottom: 16px; box-shadow: var(--shadow-card); }
.agent-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.agent-card { border-radius: var(--r-sm); padding: 14px 16px; background: #f8fafc; transition: background 0.15s ease; }
.agent-card:hover { background: #f1f5f9; }
.agent-card .name { font-weight: 700; font-size: 13.5px; color: #000; }
.agent-card .meta { font-size: 11px; color: var(--muted); margin-top: 3px; font-weight: 600; }
.agent-card .body { font-size: 12px; color: #000; margin-top: 8px; font-weight: 500; }
.agent-card .body > div { margin-top: 2px; }

/* Sparkline chart */
.spark { width: 100%; height: 100%; }
.spark-bar { fill: var(--accent); opacity: 0.8; }
.spark-bar.zero { opacity: 0.15; }

/* Events stream */
.events-live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #000; background: #ffffff; padding: 5px 12px; border-radius: var(--r-pill); font-weight: 700; box-shadow: var(--shadow-card); }
.events-live .dot.pulse { box-shadow: 0 0 0 6px rgba(16,185,129,0.4); transition: box-shadow 0.5s ease-out; }
.events-filter { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 12px !important; }
.events-filter select { padding: 7px 12px; font-size: 12px; border: 1px solid #e2e8f0; border-radius: var(--r-sm); background: #ffffff; font-weight: 600; color: #0f172a; }
.events-filter select:focus { outline: none; border-color: #0f172a; box-shadow: 0 0 0 1px #0f172a; }
.include-pre-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #000; cursor: pointer; user-select: none; padding: 6px 10px; border-radius: var(--r-sm); font-weight: 600; }
.include-pre-toggle input[type=checkbox] { margin: 0; }
.include-pre-toggle:hover { background: rgba(0,0,0,0.04); }
/* Events table — セルごとに幅固定 + overflow ellipsis で文字被り防止 */
.events-table { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; font-size: 12px; }
.events-table thead th { position: sticky; top: 0; background: var(--tile-bg); z-index: 1; padding: 10px 12px; font-size: 10px; text-align: left; color: var(--muted); font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
.events-table tbody td { padding: 9px 12px; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #000; font-weight: 500; box-shadow: inset 0 1px 0 rgba(0,0,0,0.04); }
.events-table tbody tr:hover td { background: rgba(0,0,0,0.025); }
.event-row.event-enter td { background: rgba(59,130,246,0.08); animation: rowEnter 1.2s ease-out forwards; }
@keyframes rowEnter { from { background: rgba(59,130,246,0.22); } to { background: transparent; } }
.event-time { color: var(--muted-2); font-size: 11px; font-weight: 600; }
.event-actor { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--r-pill); font-size: 11px; font-weight: 700; max-width: 100%; overflow: hidden; color: #fff; }
.event-actor-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-actor-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex-shrink: 0; }
.event-actor-icon svg { width: 16px; height: 16px; }
.event-actor-avatar { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; display: inline-block; vertical-align: middle; flex-shrink: 0; background: #f3f4f6; }
.event-actor.actor-user      { background: #7C3AED; color: #fff; }
.event-actor.actor-claude    { background: #2563EB; color: #fff; }
.event-actor.actor-scheduled { background: #059669; color: #fff; }
.event-actor.actor-subagent  { background: #D97706; color: #fff; }
.event-actor.actor-unknown   { background: #6B7280; color: #fff; }
.event-hook { color: var(--muted); font-size: 11px; font-weight: 600; }
.event-tool { display: inline-block; background: #0f172a; color: #fff; padding: 2px 8px; border-radius: var(--r-sm); font-size: 10px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 700; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.event-summary { color: #000; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; font-weight: 500; }
.event-summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; vertical-align: middle; }
.event-dur { color: var(--muted-2); font-size: 11px; text-align: right; font-weight: 600; }

/* Schedule timeline (24h view) */
.timeline-summary { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 8px 12px; font-size: 12px; font-weight: 600; }
.timeline-wrap { display: flex; flex-direction: column; position: relative; }
/* 全行を貫く 1 本の現在時刻線 (各行の .timeline-now は非表示) */
.timeline-now-global { position: absolute; top: 22px; bottom: 0; width: 1.5px; background: var(--danger); box-shadow: 0 0 4px rgba(239,68,68,0.5); z-index: 3; pointer-events: none; }
.timeline-header, .timeline-row { display: grid; grid-template-columns: 200px 1fr; align-items: center; gap: 12px; }
.timeline-header { padding: 4px 0 8px; margin-bottom: 4px; }
.timeline-label-col { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 8px 0 4px; }
.timeline-label-text { min-width: 0; overflow: hidden; }
.timeline-name { font-weight: 700; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #000; }
.timeline-hours { position: relative; height: 16px; }
.hour-tick { position: absolute; top: 0; transform: translateX(-50%); font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 600; }
.timeline-row { padding: 5px 0; border-radius: var(--r-sm); }
.timeline-row:hover { background: rgba(0,0,0,0.025); }
.timeline-row.disabled { opacity: 0.45; }
.timeline-bar { position: relative; height: 22px; background: linear-gradient(90deg, rgba(79,70,229,0.04) 0%, rgba(79,70,229,0.09) 100%); border-radius: var(--r-sm); }
.timeline-gridline { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(0,0,0,0.06); }
/* 各行の個別赤線は廃止 (timeline-now-global で全体を貫く方式に) */
.timeline-now { display: none; }
.timeline-dot { position: absolute; top: 50%; width: 9px; height: 9px; margin-left: -4.5px; margin-top: -4.5px; background: var(--primary); border: 1.5px solid #fff; border-radius: 50%; box-shadow: 0 1px 2px rgba(0,0,0,0.2); z-index: 1; cursor: help; transition: transform 0.1s; }
.timeline-dot:hover { transform: scale(1.4); z-index: 3; }
.timeline-unsched { margin-top: 16px; padding: 12px 14px; background: var(--tile-bg); border-radius: var(--r-md); box-shadow: var(--shadow-card); }
.timeline-unsched summary { cursor: pointer; list-style: none; font-weight: 700; color: #000; }
.timeline-unsched summary::-webkit-details-marker { display: none; }
.timeline-unsched summary::before { content: "▸"; display: inline-block; margin-right: 6px; transition: transform 0.15s; color: var(--muted); }
.timeline-unsched[open] summary::before { transform: rotate(90deg); }
.timeline-unsched-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 10px; margin-top: 10px; }
.timeline-unsched-item { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 4px; font-weight: 600; color: #000; }

/* View toggle (segmented control) */
/* capsell stepper / segmented control: bg-slate-100 + brand active */
.view-toggle { display: inline-flex; background: #f1f5f9; border-radius: var(--r-pill); padding: 4px; gap: 2px; }
.view-toggle a { padding: 7px 16px; border-radius: var(--r-pill); font-size: 12px; font-weight: 700; color: #64748b; transition: all 0.15s; }
.view-toggle a:hover { color: #0f172a; }
.view-toggle a.active { background: #0f172a; color: #fff; }

/* sortable column header */
th .sortable-th {
  display: inline-flex; align-items: center; gap: 6px;
  color: inherit; font: inherit;
  cursor: pointer;
  user-select: none;
}
th .sortable-th:hover { color: #0f172a; }
th .sort-arrow {
  font-size: 9px;
  color: #cbd5e1;            /* slate-300 — inactive arrows */
  transition: color 0.15s;
}
th .sortable-th:hover .sort-arrow { color: #64748b; }
th .sortable-active { color: #0f172a; }
th .sortable-active .sort-arrow { color: #0f172a; }

/* iOS-style on/off toggle switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px; height: 26px;
  flex-shrink: 0;
}
.toggle-switch input {
  position: absolute; opacity: 0; width: 0; height: 0;
}
.toggle-slider {
  position: absolute; inset: 0;
  background: #cbd5e1;             /* slate-300 (off) */
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.2s ease;
}
.toggle-slider::before {
  content: "";
  position: absolute;
  height: 20px; width: 20px;
  left: 3px; top: 3px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  transition: transform 0.2s ease;
}
.toggle-switch input:checked + .toggle-slider { background: #0f172a; }    /* slate-900 (on) */
.toggle-switch input:checked + .toggle-slider::before { transform: translateX(18px); }
.toggle-switch input:focus-visible + .toggle-slider { box-shadow: 0 0 0 3px rgba(15,23,42,0.15); }
/* 行内 (table cell) サイズ — 少し小さく */
.row-toggle { width: 36px; height: 22px; }
.row-toggle .toggle-slider::before { width: 16px; height: 16px; left: 3px; top: 3px; }
.row-toggle input:checked + .toggle-slider::before { transform: translateX(14px); }

/* view-switcher (一覧/組織図 アイコントグル — sort select の左) */
.view-switcher { display: inline-flex; background: #f1f5f9; border-radius: var(--r-sm); padding: 3px; gap: 2px; }
.view-switch-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border-radius: calc(var(--r-sm) - 3px);
  color: #64748b;            /* slate-500 */
  transition: all 0.15s;
}
.view-switch-btn:hover { color: #0f172a; }
.view-switch-btn.active { background: #ffffff; color: #0f172a; box-shadow: var(--shadow-card); }

/* Agents tree table */
.agents-tree tbody tr.tree-root td:not(:last-child) { font-weight: 700; }
.agents-tree tbody tr.tree-root:not(:first-child) td { padding-top: 14px; box-shadow: inset 0 1px 0 rgba(0,0,0,0.06); }
.agents-tree tbody tr.tree-child td { font-size: 12.5px; }
.agents-tree tbody tr.tree-standalone:not(:first-child) td { box-shadow: inset 0 1px 0 rgba(0,0,0,0.04); }

/* Tree connector は CSS border で L字 を描画 (構造線なので残す) */
.agents-tree tbody tr.tree-child td:first-child {
  position: relative;
  padding-left: 52px;
}
.agents-tree tbody tr.tree-child td:first-child::before {
  content: "";
  position: absolute;
  left: 20px;
  top: 0;
  width: 20px;
  height: 50%;
  border-left: 1.5px solid #d4d4d8;
  border-bottom: 1.5px solid #d4d4d8;
  border-bottom-left-radius: 6px;
}

/* Modal */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 24px; }
.modal-inner { background: #ffffff; border-radius: var(--r-lg); padding: 26px 30px; min-width: 360px; box-shadow: var(--shadow-pop); display: flex; flex-direction: column; max-height: calc(100vh - 48px); overflow: hidden; }
.modal-inner.modal-lg { width: min(920px, 100%); }
.modal-body { overflow-y: auto; padding-right: 4px; }
.modal-field { display: block; margin-bottom: 14px; }
.modal-field > span:first-child { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.modal-field input, .modal-field select { width: 100%; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: var(--r-sm); font-size: 13px; background: #ffffff; color: #0f172a; font-weight: 600; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.modal-field input::placeholder { color: #94a3b8; }
.modal-field input:focus, .modal-field select:focus { outline: none; border-color: #0f172a; box-shadow: 0 0 0 1px #0f172a; }
.modal-field input[type=checkbox] { width: auto; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
.preset-row { display: flex; gap: 4px; flex-wrap: wrap; }
.preset-row .btn { padding: 5px 12px; font-size: 11px; }

/* Runs table */
.runs-table { table-layout: auto; }
.runs-table th { font-size: 10px; padding: 10px 12px; }
.runs-table td { font-size: 12px; padding: 12px; vertical-align: middle; font-weight: 500; }
.runs-table tr.run-row-clickable { transition: background 0.12s ease; }
.runs-table tr.run-row-clickable:hover td { background: #f8fafc; }
.runs-table tr:not(.run-row-clickable):hover td { background: rgba(0,0,0,0.025); }

/* modal close (icon-only round button) */
.modal-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.modal-close:hover { background: #f1f5f9; color: #0f172a; }
.runs-table details > summary { font-size: 11px; color: var(--primary); cursor: pointer; font-weight: 700; }
.runs-table details[open] { padding: 8px; background: rgba(99,102,241,0.06); border-radius: var(--r-sm); margin-top: 4px; }
.refl-inline { display: grid; gap: 6px; margin-top: 6px; font-size: 11px; line-height: 1.5; }
.refl-inline > div { background: var(--tile-bg); padding: 8px 10px; border-radius: var(--r-sm); box-shadow: var(--shadow-card); white-space: pre-wrap; }
.refl-inline strong { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800; }

/* Reflection modal metrics row */
.rm-metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; padding: 12px 14px; background: var(--tile-bg); border-radius: var(--r-sm); box-shadow: inset 0 1px 2px rgba(16,24,40,0.06); }
.rm-metrics > div { font-size: 13px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; font-size: 10.5px; }
.rm-metrics > div > div { font-weight: 800; margin-top: 3px; color: #000; font-size: 13px; text-transform: none; letter-spacing: 0; }

/* Reflection inline preview */
.refl-inline-preview { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
.refl-short { font-size: 11px; color: #000; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }

/* Reflection フラット表示 (見出し + 箇条書きのみ、box 装飾なし) */
.refl-grid { display: flex; flex-direction: column; gap: 16px; margin-top: 4px; font-size: 13.5px; line-height: 1.75; }
.refl-cell { background: transparent; padding: 0; word-break: break-word; }
.refl-cell > strong:first-child { display: block; color: #000; font-size: 13px; font-weight: 800; margin-bottom: 4px; letter-spacing: 0; text-transform: none; }
.refl-cell .md-body { color: #000; font-size: 13px; }
.refl-cell .md-body ul { padding-left: 1.3em; margin: 2px 0; }
.refl-cell .md-body li { margin: 2px 0; }

/* Report section (レポート本文 — Discord と同内容) */
.report-section, .hypo-section { background: #ffffff; border-radius: var(--r-md); padding: 20px 24px; margin: 14px 0 16px; box-shadow: var(--shadow-card); }
.hypo-section { background: linear-gradient(180deg, rgba(79,70,229,0.06), #fff 70%); }
.report-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; padding-bottom: 10px; }
.report-head strong { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 800; }
.report-body { font-size: 14px; line-height: 1.8; color: #000; font-weight: 500; }

/* Collapsible reflection */
.refl-collapsible { background: var(--tile-bg); border-radius: var(--r-md); margin-top: 8px; box-shadow: var(--shadow-card); }
.refl-collapsible > summary { padding: 12px 16px; cursor: pointer; font-size: 12px; color: #000; font-weight: 700; list-style: none; user-select: none; }
.refl-collapsible > summary::-webkit-details-marker { display: none; }
.refl-collapsible > summary::before { content: "▸"; display: inline-block; margin-right: 6px; transition: transform 0.15s; }
.refl-collapsible[open] > summary::before { transform: rotate(90deg); }
.refl-collapsible > .refl-grid { padding: 12px 16px; }

/* Markdown (記事風) */
.md-body { color: #000; font-weight: 500; }
.md-body p { margin: 0.5em 0; }
.md-body p:first-child { margin-top: 0; }
.md-body p:last-child { margin-bottom: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 { margin: 0.8em 0 0.4em; font-weight: 800; line-height: 1.3; color: #000; }
.md-body h1 { font-size: 18px; }
.md-body h2 { font-size: 16px; padding-bottom: 4px; }
.md-body h3 { font-size: 14px; }
.md-body h4 { font-size: 13px; color: var(--muted); }
.md-body ul, .md-body ol { margin: 0.4em 0; padding-left: 1.4em; }
.md-body li { margin: 0.15em 0; }
.md-body li > p { margin: 0.1em 0; }
.md-body strong { font-weight: 800; color: #000; }
.md-body em { font-style: italic; }
.md-body code { background: rgba(0,0,0,0.08); padding: 2px 7px; border-radius: 6px; font-size: 0.92em; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 700; }
.md-body pre { background: #18181b; color: #e4e4e7; padding: 14px 16px; border-radius: var(--r-sm); overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 0.6em 0; box-shadow: var(--shadow-card); }
.md-body pre code { background: none; padding: 0; color: inherit; font-size: inherit; font-weight: 500; }
.md-body blockquote { background: var(--tile-bg); padding: 8px 14px; margin: 0.5em 0; color: #000; border-radius: var(--r-sm); box-shadow: inset 3px 0 0 #6a8de9; font-weight: 600; }
.md-body a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; font-weight: 700; }
.md-body a:hover { color: #5a7dd9; }
.md-body hr { border: none; height: 1px; background: rgba(0,0,0,0.08); margin: 0.8em 0; }
.md-body table { font-size: 12px; margin: 0.5em 0; }
.md-body table th, .md-body table td { padding: 6px 10px; }
.md-body img { max-width: 100%; border-radius: var(--r-sm); box-shadow: var(--shadow-card); }

/* Empty state */
.empty { text-align: center; padding: 40px 20px; color: var(--muted); font-weight: 600; }
.empty svg { width: 32px; height: 32px; margin-bottom: 8px; opacity: 0.5; }

/* =========================================================
 * Agent list (refined — metric strip + dept tabs + actions)
 * =======================================================*/
.page-header h1 .title-spark { font-size: 16px; margin-left: 4px; }

.list-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.list-metric {
  background: #ffffff;
  border-radius: var(--r-md);
  padding: 22px 24px 20px;
  box-shadow: var(--shadow-card);
}
.list-metric-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.list-metric-ico {
  width: 34px; height: 34px;
  border-radius: var(--r-sm);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px;
  flex-shrink: 0;
}
.mt-ico-indigo { background: rgba(106,141,233,0.10); color: #6a8de9; }
.mt-ico-green  { background: #DCFCE7; color: #16803D; }
.mt-ico-amber  { background: #FEF3C7; color: #B45309; }
.mt-ico-blue   { background: #DBEAFE; color: #1D4FD7; }
.list-metric-label { font-size: 12px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.list-metric-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
.list-metric-value {
  font-size: 32px; font-weight: 700; letter-spacing: -0.028em;
  color: #000; font-variant-numeric: tabular-nums; line-height: 1;
}
.list-metric-unit { font-size: 13px; font-weight: 700; color: var(--muted); margin-left: 3px; }
.list-metric-sub { font-size: 11px; color: var(--muted); margin-top: 6px; font-weight: 600; }
.list-metric .delta { font-weight: 800; }
.list-metric .delta.up { color: #16803D; }
.list-metric .delta.down { color: #B91C1C; }
.list-metric-bar {
  margin-top: 10px;
  height: 4px; border-radius: 999px;
  background: rgba(106,141,233,0.10);
  overflow: hidden;
}
.list-metric-bar > div {
  height: 100%;
  background: linear-gradient(90deg, #6a8de9, #5AC8FA);
  border-radius: 999px;
}
.spark-mini { width: 90px; height: 28px; flex-shrink: 0; }

/* Toolbar — left-aligned by default */
.list-toolbar {
  display: flex; align-items: center; justify-content: flex-start;
  gap: 12px; margin-bottom: 14px;
  padding: 6px 4px;
  flex-wrap: wrap;
}
.list-toolbar > div:empty { display: none; }
.list-toolbar-right { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.list-tabs {
  display: inline-flex; align-items: center; gap: 3px;
  flex-wrap: wrap;
  background: #f1f5f9;             /* slate-100 */
  border-radius: var(--r-pill);
  padding: 4px;
}
.list-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px;
  border-radius: var(--r-pill);
  color: #64748b;                  /* slate-500 */
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.list-tab:hover { color: #0f172a; }
.list-tab.active { color: #fff; background: #0f172a; }
.list-tab-count {
  font-size: 11px;
  font-weight: 800;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}
.list-tab.active .list-tab-count { color: #ffffff; opacity: 0.85; }
.list-sort-select {
  appearance: none;
  -webkit-appearance: none;
  padding: 9px 32px 9px 14px;
  border: 1px solid #e2e8f0;
  border-radius: var(--r-sm);
  background: #ffffff
    url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")
    no-repeat right 12px center;
  font-size: 12px;
  color: #334155;
  font-weight: 700;
  line-height: 1.2;
  cursor: pointer;
}
.list-sort-select:focus { outline: none; border-color: #0f172a; box-shadow: 0 0 0 1px #0f172a; }
/* search input は select じゃないので chevron 不要 */
input.list-sort-select { background-image: none; padding-right: 14px; }

/* checkbox + label combo (filter row) */
.filter-checkbox {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px;
  border-radius: var(--r-sm);
  background: #ffffff;
  border: 1px solid #e2e8f0;
  font-size: 12px;
  font-weight: 700;
  color: #334155;
  cursor: pointer;
  user-select: none;
}
.filter-checkbox input[type=checkbox] { margin: 0; cursor: pointer; }
.filter-checkbox:hover { background: #f8fafc; color: #0f172a; }

/* Dept pill — 単色 + 白テキスト */
.dept-pill {
  display: inline-flex; align-items: center;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: 10.5px;
  font-weight: 800;
  margin-left: 8px;
  vertical-align: 1px;
  color: #fff;
  letter-spacing: 0.02em;
}
.dept-subsidy           { background: #C2410C; }
.dept-benefit           { background: #B45309; }
.dept-editorial         { background: #BE185D; }
.dept-permit            { background: #B91C1C; }
.dept-hypothesis        { background: #6D28D9; }
.dept-audit             { background: #3730A3; }
.dept-backlink          { background: #15803D; }
.dept-seo-metrics       { background: #0E7490; }
.dept-content-refine    { background: #92400E; }
.dept-keyword-research  { background: #1D4ED8; }
.dept-outreach          { background: #9D174D; }
.dept-chat              { background: #6B21A8; }

/* List-table specific */
.list-table-wrap { border-radius: var(--r-md); background: #ffffff; padding: 0 !important; box-shadow: var(--shadow-card); }

/* テーブルカード内スクロール — ページではなくテーブル本体が縦スクロールし、
   thead は常にカード上端に固定される */
.list-table-wrap,
.section.compact:has(.runs-table),
.section.compact:has(.events-table) {
  max-height: calc(100vh - 240px);
  overflow-y: auto;
  overflow-x: auto;
  padding: 0 !important;     /* th が card 上端に貼り付くよう内側 padding を撤去 */
}
/* テーブル自身に border-radius を持たせる (wrap の角丸を継承) */
.list-table thead th:first-child,
.runs-table thead th:first-child,
.events-table thead th:first-child { border-top-left-radius: var(--r-md); }
.list-table thead th:last-child,
.runs-table thead th:last-child,
.events-table thead th:last-child  { border-top-right-radius: var(--r-md); }
.list-table tbody tr:last-child td:first-child,
.runs-table tbody tr:last-child td:first-child,
.events-table tbody tr:last-child td:first-child { border-bottom-left-radius: var(--r-md); }
.list-table tbody tr:last-child td:last-child,
.runs-table tbody tr:last-child td:last-child,
.events-table tbody tr:last-child td:last-child  { border-bottom-right-radius: var(--r-md); }
.list-table thead th { background: var(--tile-bg); padding: 12px 16px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 800; }
.list-table tbody td { padding: 14px 16px; font-size: 13px; font-weight: 500; color: #000; box-shadow: inset 0 1px 0 rgba(0,0,0,0.04); }
.list-table tbody tr:hover td { background: var(--tile-bg); }
.list-agent-cell { display: flex; align-items: center; gap: 12px; }
.list-avatar { border-radius: var(--r-sm); background: var(--tile-bg); flex-shrink: 0; box-shadow: var(--shadow-card); }
.list-avatar-placeholder { width: 36px; height: 36px; display: inline-block; }
.list-agent-text { min-width: 0; }
.list-agent-name { font-size: 13.5px; display: flex; align-items: center; font-weight: 700; color: #000; }
.list-agent-slug { font-size: 11px; color: var(--muted); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; margin-top: 2px; font-weight: 600; }

/* Schedule dot (on/off for timer) */
.sched-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-left: 4px; }
.sched-dot-on { background: #22C55E; box-shadow: 0 0 0 2px rgba(34,197,94,0.25); }
.sched-dot-off { background: #D1D5DB; }

/* Status pill — 単色 + 白テキスト */
.status-pill {
  display: inline-flex; align-items: center;
  padding: 4px 12px;
  border-radius: var(--r-pill);
  font-size: 11.5px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.01em;
}
.status-pill.status-on   { background: #15803D; }
.status-pill.status-idle { background: #6B7280; }
.status-pill.status-off  { background: #B91C1C; }

/* Row action buttons */
.row-action {
  width: 34px; height: 34px;
  border-radius: var(--r-sm);
  border: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.row-action-play {
  background: #0f172a;
  color: #fff;
}
.row-action-play:hover { background: #1e293b; }
.row-action-play:active { transform: scale(0.95); }
.row-action-menu {
  background: var(--tile-bg);
  color: var(--muted);
}
.row-action-menu:hover { background: var(--tile-bg-strong); color: #000; }

@media (max-width: 1100px) {
  .list-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
}

// graceful shutdown
process.on("SIGTERM", () => {
  console.log("[pokemon-agents] SIGTERM, shutting down");
  server.stop();
  db.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[pokemon-agents] SIGINT, shutting down");
  server.stop();
  db.close();
  process.exit(0);
});
