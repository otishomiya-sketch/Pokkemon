/**
 * Heartbeat Scheduler Loop
 *
 * server.ts (web 統合) または scheduler.ts (standalone) から呼ばれる。
 * 5 秒 tick で agent_schedules を scan、due な row を tasks に enqueue → run-task.sh dispatch。
 */

import type { Database } from "bun:sqlite";
import { spawn } from "bun";
import { resolve } from "path";

const TICK_MS = 5000;

interface DueSchedule {
  id: number;
  agent_id: number;
  interval_sec: number | null;
  cron_expr: string | null;
  payload_template: string;
}

function nowSql(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function computeNext(intervalSec: number | null, _cronExpr: string | null): string {
  if (intervalSec && intervalSec > 0) {
    const d = new Date(Date.now() + intervalSec * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return nowSql();
}

export function startScheduler(opts: { db: Database; repoRoot: string }) {
  const { db, repoRoot } = opts;
  const RUN_TASK_SH = resolve(repoRoot, "pokemon-agents/scripts/run-task.sh");

  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });

  function dispatchTask(taskId: number) {
    const proc = spawn({
      cmd: ["bash", RUN_TASK_SH, String(taskId)],
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
    proc.exited.catch((e: unknown) => {
      console.error(`[scheduler] task ${taskId} dispatch error:`, e);
    });
  }

  function tick(): void {
    const now = nowSql();

    // Timer due
    const due = db
      .query<DueSchedule, [string]>(
        `SELECT id, agent_id, interval_sec, cron_expr, payload_template
         FROM agent_schedules
         WHERE enabled=1 AND trigger_type='timer' AND next_run_at <= ?
         LIMIT 32`,
      )
      .all(now);

    for (const sched of due) {
      // agent_slug も同時に埋める (片肺レコード防止 - 2026-04-26)
      const result = db
        .query<{ id: number }, [number, number, number, string, string]>(
          `INSERT INTO reflections (agent_id, agent_slug, schedule_id, trigger, status, payload, created_at)
           VALUES (?, (SELECT slug FROM agents WHERE id = ?), ?, 'timer', 'queued', ?, ?)
           RETURNING id`,
        )
        .get(sched.agent_id, sched.agent_id, sched.id, sched.payload_template, now);

      if (!result) continue;

      const next = computeNext(sched.interval_sec, sched.cron_expr);
      db.run(
        `UPDATE agent_schedules SET last_fired_at=?, next_run_at=?, updated_at=? WHERE id=?`,
        [now, next, now, sched.id],
      );

      console.log(
        `[scheduler] timer fired schedule=${sched.id} agent=${sched.agent_id} task=${result.id}`,
      );
      dispatchTask(result.id);
    }

    // Automation due (parent completion で next_run_at が now に setted)
    const dueAutomation = db
      .query<DueSchedule, [string]>(
        `SELECT id, agent_id, interval_sec, cron_expr, payload_template
         FROM agent_schedules
         WHERE enabled=1 AND trigger_type='automation' AND next_run_at IS NOT NULL AND next_run_at <= ?
         LIMIT 32`,
      )
      .all(now);

    for (const sched of dueAutomation) {
      const result = db
        .query<{ id: number }, [number, number, number, string, string]>(
          `INSERT INTO reflections (agent_id, agent_slug, schedule_id, trigger, status, payload, created_at)
           VALUES (?, (SELECT slug FROM agents WHERE id = ?), ?, 'automation', 'queued', ?, ?)
           RETURNING id`,
        )
        .get(sched.agent_id, sched.agent_id, sched.id, sched.payload_template, now);

      if (!result) continue;

      db.run(
        `UPDATE agent_schedules SET last_fired_at=?, next_run_at=NULL, updated_at=? WHERE id=?`,
        [now, now, sched.id],
      );

      console.log(
        `[scheduler] automation fired schedule=${sched.id} agent=${sched.agent_id} task=${result.id}`,
      );
      dispatchTask(result.id);
    }

    // Checkout expired 回収
    const expired = db.run(
      `UPDATE reflections SET status='timeout', error_message='checkout_expired', ended_at=?
       WHERE status='running' AND checkout_expires_at < ?`,
      [now, now],
    );
    if (expired.changes > 0) {
      console.error(`[scheduler] timed out ${expired.changes} expired task(s)`);
    }
  }

  console.log(`[scheduler] starting loop, tick every ${TICK_MS}ms`);

  (async () => {
    while (!stopping) {
      try {
        tick();
      } catch (e) {
        console.error("[scheduler] tick error:", e);
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
    console.log("[scheduler] loop stopped");
  })();
}
