/**
 * スケジュール編集 (launchd plist 書き込み)
 *
 * ダッシュボードから plist を生成・保存・有効化/無効化・削除する。
 * com.claude.hojokin.{agent-slug}.plist に限定、他プロジェクトは一切触らない。
 *
 * 2 モード対応:
 *   - "calendar": StartCalendarInterval (毎日決まった時刻に実行)
 *   - "interval": StartInterval (一定秒数ごとに実行)
 */

import { writeFileSync, readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const LAUNCHD_DIR = resolve(homedir(), "Library/LaunchAgents");
const LABEL_PREFIX = "com.claude.hojokin.";
const LOG_DIR = resolve(homedir(), ".claude/logs");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export interface TimeSpec {
  hour: number;   // 0-23
  minute: number; // 0-59
}

export type ScheduleMode = "calendar" | "interval";

export interface ScheduleSaveInput {
  agent_slug: string;
  mode?: ScheduleMode;        // 省略時は times の有無で自動判定 (旧 API 互換)
  times?: TimeSpec[];          // mode="calendar" のとき: 毎日実行する時刻
  interval_sec?: number;       // mode="interval" のとき: 実行間隔 (秒)
  enabled: boolean;
}

export interface ScheduleReadResult {
  mode: ScheduleMode;
  times: TimeSpec[];
  interval_sec: number;
  enabled: boolean;
  exists: boolean;
}

/**
 * plist を書き出し、有効なら launchctl load、無効なら .plist.disabled で保存。
 */
export function saveSchedule(input: ScheduleSaveInput): { path: string; action: "created" | "updated" | "deleted" } {
  if (!/^[a-z][a-z0-9-]+$/.test(input.agent_slug)) {
    throw new Error(`invalid agent_slug: ${input.agent_slug}`);
  }

  const label = LABEL_PREFIX + input.agent_slug;
  const enabledPath = resolve(LAUNCHD_DIR, `${label}.plist`);
  const disabledPath = `${enabledPath}.disabled`;

  // モード判定 (省略時は times の有無)
  const mode: ScheduleMode = input.mode || (input.interval_sec && input.interval_sec > 0 ? "interval" : "calendar");
  const times = input.times || [];
  const intervalSec = input.interval_sec || 0;

  // 設定なし = 削除
  const isEmpty = mode === "calendar" ? times.length === 0 : intervalSec <= 0;
  if (isEmpty) {
    let deleted = false;
    for (const p of [enabledPath, disabledPath]) {
      if (existsSync(p)) {
        unlinkSync(p);
        deleted = true;
      }
    }
    try {
      Bun.spawnSync(["launchctl", "unload", enabledPath], { stdout: "pipe", stderr: "pipe" });
    } catch {
      // noop
    }
    return { path: enabledPath, action: deleted ? "deleted" : "deleted" };
  }

  if (mode === "interval" && intervalSec < 60) {
    throw new Error(`interval_sec must be >= 60 (got ${intervalSec})`);
  }

  const plistXml = mode === "calendar"
    ? buildCalendarPlist(label, input.agent_slug, times)
    : buildIntervalPlist(label, input.agent_slug, intervalSec);
  const targetPath = input.enabled ? enabledPath : disabledPath;
  const existed = existsSync(enabledPath) || existsSync(disabledPath);

  for (const p of [enabledPath, disabledPath]) {
    if (p !== targetPath && existsSync(p)) unlinkSync(p);
  }

  writeFileSync(targetPath, plistXml, "utf-8");

  if (input.enabled) {
    // unload は失敗しても OK (まだ load されてない場合 / すでに boot out されてる場合)
    Bun.spawnSync(["launchctl", "unload", targetPath], { stdout: "pipe", stderr: "pipe" });
    // load は exit code を見て成否を判別 (silent fail 防止)
    const loadResult = Bun.spawnSync(
      ["launchctl", "load", targetPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderrText = loadResult.stderr ? new TextDecoder().decode(loadResult.stderr).trim() : "";
    const stdoutText = loadResult.stdout ? new TextDecoder().decode(loadResult.stdout).trim() : "";
    if (loadResult.exitCode !== 0) {
      const msg = `launchctl load failed (exit=${loadResult.exitCode}): ${stderrText || stdoutText || "(no output)"}`;
      console.error(`[schedule] ${msg} for ${targetPath}`);
      throw new Error(msg);
    }
    if (stderrText) console.warn(`[schedule] launchctl load stderr: ${stderrText}`);
  }

  return { path: targetPath, action: existed ? "updated" : "created" };
}

function buildCalendarPlist(label: string, agentSlug: string, times: TimeSpec[]): string {
  const intervalsXml = times
    .map(
      (t) =>
        `    <dict>\n      <key>Hour</key>\n      <integer>${t.hour}</integer>\n      <key>Minute</key>\n      <integer>${t.minute}</integer>\n    </dict>`,
    )
    .join("\n");

  return basePlist(label, agentSlug, `  <key>StartCalendarInterval</key>
  <array>
${intervalsXml}
  </array>`);
}

function buildIntervalPlist(label: string, agentSlug: string, intervalSec: number): string {
  return basePlist(label, agentSlug, `  <key>StartInterval</key>
  <integer>${intervalSec}</integer>`);
}

function basePlist(label: string, agentSlug: string, triggerXml: string): string {
  const logPath = `${LOG_DIR}/hojokin-${agentSlug}.log`;
  // run-agent.sh は <slug> <md-path> [model] を期待。
  // md-path 指定がなくても run-agent.sh の find fallback で解決はできるが、
  // 明示しておく方が安全 (DB と launchd の SSOT 一貫性のため)。
  const mdPath = resolveAgentMdPath(agentSlug);
  const cmd = `cd ${REPO_ROOT} && bash scripts/run-agent.sh ${agentSlug} ${mdPath} >> ${logPath} 2>&1`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${homedir()}/.local/bin</string>
  </dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>${escapeXml(cmd)}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
${triggerXml}
</dict>
</plist>
`;
}

/**
 * agent.md のリポジトリ相対パスを返す。
 * フラット定義 (.claude/agents/<slug>.md) を優先し、無ければフォルダ定義 (<slug>/agent.md)。
 * (2026-06-23: 旧来は <slug>/agent.md 決め打ちで、フラット化したエージェントの plist が
 *  実在しないパスを指して agent_md_missing になっていた)
 */
function resolveAgentMdPath(agentSlug: string): string {
  const flat = `.claude/agents/${agentSlug}.md`;
  const folder = `.claude/agents/${agentSlug}/agent.md`;
  return existsSync(resolve(REPO_ROOT, flat)) ? flat : folder;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * .plist ↔ .plist.disabled のトグルだけ行う (内容は変えない)
 */
export function toggleSchedule(agentSlug: string, enabled: boolean): { path: string } {
  const label = LABEL_PREFIX + agentSlug;
  const enabledPath = resolve(LAUNCHD_DIR, `${label}.plist`);
  const disabledPath = `${enabledPath}.disabled`;
  const from = enabled ? disabledPath : enabledPath;
  const to = enabled ? enabledPath : disabledPath;
  if (existsSync(from)) {
    renameSync(from, to);
  }
  if (enabled) {
    try {
      Bun.spawnSync(["launchctl", "load", to], { stdout: "pipe", stderr: "pipe" });
    } catch {}
  } else {
    try {
      Bun.spawnSync(["launchctl", "unload", enabledPath], { stdout: "pipe", stderr: "pipe" });
    } catch {}
  }
  return { path: to };
}

/**
 * 既存 plist から実行設定を読み取る (編集時の初期値用)
 */
export function readScheduleTimes(agentSlug: string): ScheduleReadResult {
  const label = LABEL_PREFIX + agentSlug;
  const enabledPath = resolve(LAUNCHD_DIR, `${label}.plist`);
  const disabledPath = `${enabledPath}.disabled`;
  let path: string | null = null;
  let enabled = true;
  if (existsSync(enabledPath)) {
    path = enabledPath;
  } else if (existsSync(disabledPath)) {
    path = disabledPath;
    enabled = false;
  }
  if (!path) {
    return { mode: "calendar", times: [], interval_sec: 0, enabled: true, exists: false };
  }
  const raw = readFileSync(path, "utf-8");

  // StartInterval (秒間隔) の検出 — 優先
  const intervalMatch = raw.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  if (intervalMatch) {
    return {
      mode: "interval",
      times: [],
      interval_sec: Number(intervalMatch[1]),
      enabled,
      exists: true,
    };
  }

  // StartCalendarInterval (時刻指定)
  const times: TimeSpec[] = [];
  const dictRegex = /<dict>[\s\S]*?<\/dict>/g;
  const startCalMatch = raw.match(
    /<key>StartCalendarInterval<\/key>\s*(<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>)/,
  );
  if (startCalMatch) {
    const block = startCalMatch[1];
    const dicts = block.startsWith("<dict>") ? [block] : (block.match(dictRegex) || []);
    for (const d of dicts) {
      const h = d.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
      const m = d.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
      if (h || m) {
        times.push({ hour: h ? Number(h[1]) : 0, minute: m ? Number(m[1]) : 0 });
      }
    }
  }
  return { mode: "calendar", times, interval_sec: 0, enabled, exists: true };
}
