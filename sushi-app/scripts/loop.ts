#!/usr/bin/env bun
/**
 * 学習ループ用コマンド。エージェントは SQL を直接書かず、必ずこれを通して sushi.db を読み書きする。
 * 書き込みの入力は JSON。`--json '<JSON>'` で直接渡す（JSON の中に ' を使わない）か、JSON ファイルのパスを渡す。
 *
 *   bun sushi-app/scripts/loop.ts context                         全体の状況（JSON）
 *   bun sushi-app/scripts/loop.ts research-targets [件数=12]       価格帯ごとに何件集めるかの目安（ヨルノズク）
 *   bun sushi-app/scripts/loop.ts trends [日数=30]                 最近のトレンド一覧
 *   bun sushi-app/scripts/loop.ts add-trends --json '<JSON>'      トレンド追加（ヨルノズク）
 *   bun sushi-app/scripts/loop.ts baseline <nigiri|dish> [日数=14] 評価率の基準値
 *   bun sushi-app/scripts/loop.ts due                             測定日が来た実験の一覧（ゴース）
 *   bun sushi-app/scripts/loop.ts measure <実験id>                 実験の評価率と判定の目安（ゴース）
 *   bun sushi-app/scripts/loop.ts record-followup --json '<JSON>' 測定結果・判定の記録（ゴース）
 *   bun sushi-app/scripts/loop.ts add-hypotheses --json '<JSON>'  仮説追加（ゴースト）
 *   bun sushi-app/scripts/loop.ts proposed                        選抜待ちの仮説（ゲンガー）
 *   bun sushi-app/scripts/loop.ts start-experiments --json '<JSON>' 選抜結果の反映（ゲンガー）
 *   bun sushi-app/scripts/loop.ts add-notes --json '<JSON>'       素材の知識を追加・更新（アルセウス）
 *   bun sushi-app/scripts/loop.ts finish-reflection <run_id> --json '<JSON>'  振り返りの記録（全員）
 *
 * 管理用（人が使う）:
 *   bun sushi-app/scripts/loop.ts add-shop --json '{"name":"店名"}'   店舗を追加（店舗コードは自動で作る）
 *   bun sushi-app/scripts/loop.ts list-shops                          店舗一覧
 *   bun sushi-app/scripts/loop.ts set-shop-profile --json '{"code":"…","concept":"…","features":[…],"price_per_guest":12000}'
 *   bun sushi-app/scripts/loop.ts migrate-to-remote                   手元の学習データをクラウドへ移す（1 回だけ）
 *
 * 環境変数 SUSHI_REMOTE_URL と SUSHI_LOOP_TOKEN があれば、クラウドの DB に対して実行する（finish-reflection は常に手元）。
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../src/db";
import { JSON_COMMANDS, LoopError, runLoop } from "../src/loop-core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const AGENTS_DB = process.env.AGENTS_DB_PATH ?? resolve(REPO_ROOT, ".claude/db/agents.db");
const REMOTE_URL = process.env.SUSHI_REMOTE_URL?.replace(/\/+$/, "");
const LOOP_TOKEN = process.env.SUSHI_LOOP_TOKEN;

function out(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}
function die(message: string): never {
  console.error(`[loop] ${message}`);
  process.exit(1);
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** `--json '<JSON>'` で直接渡すか、JSON ファイルのパスを渡す */
function readJson(first: string | undefined, second: string | undefined): unknown {
  let text: string;
  if (first === "--json") {
    if (!second) die("--json の後に JSON を書いてください");
    text = second;
  } else {
    if (!first) die("--json '<JSON>' か JSON ファイルのパスを指定してください");
    if (!existsSync(first)) die(`ファイルがありません: ${first}`);
    text = readFileSync(first, "utf8");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    die(`JSON として読めません: ${(e as Error).message}`);
  }
}

async function callRemote(cmd: string, args: string[], input: unknown) {
  if (!LOOP_TOKEN) die("SUSHI_REMOTE_URL を使うには SUSHI_LOOP_TOKEN も必要です");
  const res = await fetch(`${REMOTE_URL}/api/loop`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LOOP_TOKEN}` },
    body: JSON.stringify({ cmd, args, input }),
  }).catch((e) => die(`クラウドに接続できません: ${(e as Error).message}`));
  const body = (await res.json().catch(() => ({}))) as { data?: unknown; failed?: boolean; error?: string };
  if (!res.ok) die(body.error ?? `クラウドがエラーを返しました（${res.status}）`);
  return { data: body.data, failed: body.failed };
}

function finishReflection(runId: number, f: any) {
  if (!runId) die("run_id を指定してください");
  if (!existsSync(AGENTS_DB)) die(`agents.db がありません: ${AGENTS_DB}（bash pokemon-agents/scripts/init.sh で作成）`);
  const agents = new Database(AGENTS_DB);
  const changes = agents
    .query(
      `UPDATE reflections SET status='completed', ended_at=datetime('now','localtime'),
         duration_ms=(strftime('%s','now','localtime') - strftime('%s', started_at)) * 1000,
         what_done=?, quality_check=?, quality_score=?, result_full=?, self_improvement=?, content_improvement=?,
         updated_at=datetime('now','localtime')
       WHERE id=?`,
    )
    .run(
      str(f.what_done, 4000), str(f.quality_check, 4000), Math.min(100, Math.max(0, Number(f.quality_score) || 0)),
      str(f.result_full, 20000), str(f.self_improvement, 4000), str(f.content_improvement, 4000), runId,
    ).changes;
  return { ok: changes === 1, run_id: runId };
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "finish-reflection") {
  out(finishReflection(Number(rest[0]), readJson(rest[1], rest[2])));
  process.exit(0);
}

if (cmd === "migrate-to-remote") {
  if (!REMOTE_URL) die("SUSHI_REMOTE_URL が設定されていません");
  const snapshot = runLoop(openDb(), "export-snapshot", []).data;
  out((await callRemote("import-snapshot", [], snapshot)).data);
  process.exit(0);
}

const takesJson = JSON_COMMANDS.has(cmd ?? "");
const input = takesJson ? readJson(rest[0], rest[1]) : undefined;
const args = takesJson ? [] : rest;

try {
  const result = REMOTE_URL ? await callRemote(cmd ?? "", args, input) : runLoop(openDb(), cmd, args, input);
  out(result.data);
  if (result.failed) process.exit(1);
} catch (e) {
  if (e instanceof LoopError) die(e.message);
  throw e;
}
