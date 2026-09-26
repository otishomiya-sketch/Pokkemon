/**
 * launchd plist → agent_schedules 自動同期
 *
 * plist ファイル (~/Library/LaunchAgents/com.claude.hojokin.*.plist) を SSOT として、
 * サーバ起動時にスキャンして agent_schedules テーブルを rebuild する。
 *
 * 対応フィールド:
 *   - ファイル名 → agent slug (com.claude.hojokin.{slug}.plist)
 *   - StartCalendarInterval → cron_expr (毎日 HH:MM, 複数可)
 *   - StartInterval → interval_sec
 *   - `.disabled` サフィックス → enabled=0
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const LAUNCHD_DIR = resolve(homedir(), "Library/LaunchAgents");
const PLIST_PREFIX = "com.claude.hojokin.";

interface PlistSchedule {
  slug: string;
  enabled: boolean;
  trigger_type: "timer";
  cron_expr: string | null;
  interval_sec: number | null;
  plist_path: string;
}

export function syncLaunchdToDb(db: Database): { scanned: number; synced: number; skipped: number } {
  let entries: string[];
  try {
    entries = readdirSync(LAUNCHD_DIR);
  } catch {
    console.warn("[launchd-sync] LaunchAgents directory not found:", LAUNCHD_DIR);
    return { scanned: 0, synced: 0, skipped: 0 };
  }

  const plistFiles = entries.filter(
    (f) => f.startsWith(PLIST_PREFIX) && (f.endsWith(".plist") || f.endsWith(".plist.disabled")),
  );

  // agent slug → id マップ
  const agents = db
    .query<{ id: number; slug: string }, []>(`SELECT id, slug FROM agents`)
    .all();
  const slugToId = new Map(agents.map((a) => [a.slug, a.id]));

  // 既存の launchd 由来スケジュールを一旦削除 (plist SSOT で rebuild)
  db.run(`DELETE FROM agent_schedules WHERE payload_template LIKE '%launchd%'`);

  let synced = 0;
  let skipped = 0;
  const upsert = db.prepare(`
    INSERT INTO agent_schedules (agent_id, trigger_type, interval_sec, cron_expr, enabled, payload_template, created_at, updated_at)
    VALUES (?, 'timer', ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
  `);

  for (const file of plistFiles) {
    const parsed = parsePlist(resolve(LAUNCHD_DIR, file));
    if (!parsed) {
      skipped++;
      continue;
    }
    const agentId = slugToId.get(parsed.slug);
    if (!agentId) {
      console.log(`[launchd-sync] skip (agent not found): ${parsed.slug}`);
      skipped++;
      continue;
    }
    upsert.run(
      agentId,
      parsed.interval_sec,
      parsed.cron_expr,
      parsed.enabled ? 1 : 0,
      JSON.stringify({ source: "launchd", plist: file }),
    );
    synced++;
  }

  console.log(`[launchd-sync] scanned ${plistFiles.length}, synced ${synced}, skipped ${skipped}`);
  return { scanned: plistFiles.length, synced, skipped };
}

function parsePlist(fullPath: string): PlistSchedule | null {
  const fileName = fullPath.split("/").pop()!;
  const enabled = !fileName.endsWith(".disabled");

  // ファイル名から slug 抽出: com.claude.hojokin.{slug}.plist[.disabled]
  const slugMatch = fileName.match(/^com\.claude\.hojokin\.(.+?)\.plist(\.disabled)?$/);
  if (!slugMatch) return null;
  const slug = slugMatch[1];

  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }

  // StartInterval (秒) を抽出
  const intervalMatch = raw.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  const interval_sec = intervalMatch ? Number(intervalMatch[1]) : null;

  // StartCalendarInterval を抽出 (毎日 HH:MM 複数対応)
  let cron_expr: string | null = null;
  const calBlockMatch = raw.match(
    /<key>StartCalendarInterval<\/key>\s*(<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>)/,
  );
  if (calBlockMatch) {
    const block = calBlockMatch[1];
    // 各 dict から Hour, Minute を抽出
    const dicts = block.match(/<dict>[\s\S]*?<\/dict>/g) || [];
    const singleDict = block.startsWith("<dict>") ? [block] : dicts;
    const intervals = singleDict.map((d) => {
      const h = d.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
      const m = d.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
      return { h: h ? Number(h[1]) : null, m: m ? Number(m[1]) : null };
    });
    // crontab 形式に: minute hour * * *
    const hours = [...new Set(intervals.map((i) => i.h).filter((x) => x != null))].sort((a, b) => (a! - b!));
    const minutes = [...new Set(intervals.map((i) => i.m).filter((x) => x != null))].sort((a, b) => (a! - b!));
    if (hours.length > 0 || minutes.length > 0) {
      const mStr = minutes.length === 1 ? String(minutes[0]) : minutes.join(",") || "0";
      const hStr = hours.length > 0 ? hours.join(",") : "*";
      cron_expr = `${mStr} ${hStr} * * *`;
    }
  }

  return {
    slug,
    enabled,
    trigger_type: "timer",
    cron_expr,
    interval_sec,
    plist_path: fullPath,
  };
}
