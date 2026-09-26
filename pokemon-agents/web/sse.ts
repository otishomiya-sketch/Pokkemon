/**
 * SSE (Server-Sent Events) broadcaster
 *
 * 旧 pokemon-dashboard と同じ思想:
 *   - /api/events に EventSource 接続を貼ってもらう
 *   - サーバ側で 3 秒ごとに DB tasks/approvals/agent_runs の "状態 hash" を計算
 *   - 変化あれば全 subscriber に "tick" イベントを push
 *   - クライアント側は受信したら関連 fragment を fetch して DOM swap
 *
 * シンプルさ重視: 個別イベント (task.started 等) は送らず、「変化あった」signal だけ。
 * クライアントは fragment を再取得すれば良い。
 */

import type { Database } from "bun:sqlite";

type SendFn = (data: string) => void;
const subscribers = new Set<SendFn>();
let lastHash = "";
let pollerStarted = false;

function computeHash(db: Database): string {
  // 変化を検知したい table の最新状態を hash 化
  const r1 = db
    .query<
      { c: number; max_id: number | null; running: number; queued: number; failed: number },
      []
    >(
      `SELECT COUNT(*) as c, MAX(id) as max_id,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
              SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) as queued,
              SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) as failed
       FROM reflections`,
    )
    .get() as { c: number; max_id: number | null; running: number; queued: number; failed: number } | null;
  const r2 = db
    .query<{ c: number; max_id: number | null }, []>(
      `SELECT COUNT(*) as c, MAX(id) as max_id FROM approvals WHERE status='pending'`,
    )
    .get() as { c: number; max_id: number | null } | null;
  // 既存 agents.db の events も監視対象に (Claude Code hooks が書く)
  const r3 = db
    .query<{ c: number; max_id: number | null }, []>(
      `SELECT COUNT(*) as c, MAX(id) as max_id FROM logs`,
    )
    .get() as { c: number; max_id: number | null } | null;
  return [
    r1?.c ?? 0,
    r1?.max_id ?? 0,
    r1?.running ?? 0,
    r1?.queued ?? 0,
    r1?.failed ?? 0,
    r2?.c ?? 0,
    r2?.max_id ?? 0,
    r3?.c ?? 0,
    r3?.max_id ?? 0,
  ].join(":");
}

function startPoller(db: Database) {
  if (pollerStarted) return;
  pollerStarted = true;
  lastHash = computeHash(db);
  setInterval(() => {
    if (subscribers.size === 0) return;
    const h = computeHash(db);
    if (h !== lastHash) {
      lastHash = h;
      const payload = `data: ${JSON.stringify({ at: new Date().toISOString(), hash: h })}\n\n`;
      for (const send of subscribers) {
        try {
          send(payload);
        } catch {
          subscribers.delete(send);
        }
      }
    }
  }, 3000);
}

export function sseHandler(db: Database): Response {
  startPoller(db);

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let subscriberFn: SendFn | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send: SendFn = (data) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // closed
        }
      };
      subscriberFn = send;
      subscribers.add(send);
      // initial event so client knows it's connected
      send(`data: ${JSON.stringify({ at: new Date().toISOString(), hash: lastHash, hello: true })}\n\n`);
      // keep-alive ping every 25s (旧 dashboard は 30s だった)
      heartbeatTimer = setInterval(() => send(`: ping\n\n`), 25000);
    },
    cancel() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (subscriberFn) subscribers.delete(subscriberFn);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
