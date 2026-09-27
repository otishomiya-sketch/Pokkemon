#!/usr/bin/env bun
/**
 * 学習ループ用コマンド。エージェントは SQL を直接書かず、必ずこれを通して sushi.db を読み書きする。
 * 書き込みの入力は JSON。`--json '<JSON>'` で直接渡す（JSON の中に ' を使わない）か、JSON ファイルのパスを渡す。
 *
 *   bun sushi-app/scripts/loop.ts context                         全体の状況（JSON）
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
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../src/db";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const AGENTS_DB = process.env.AGENTS_DB_PATH ?? resolve(REPO_ROOT, ".claude/db/agents.db");
const DEFAULT_SCHEDULE = [{ at: "T+3d" }, { at: "T+7d", final: true }];
const MAX_HYPOTHESES_PER_RUN = 6;
const REAL_TRENDS_TO_RETIRE_SAMPLES = 20;

const db = openDb();
const [cmd, ...args] = process.argv.slice(2);

function out(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}
function die(message: string): never {
  console.error(`[loop] ${message}`);
  process.exit(1);
}
/** `--json '<JSON>'` で直接渡すか、JSON ファイルのパスを渡す */
function readJson(...input: (string | undefined)[]): any {
  const [first, second] = input;
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
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : []);
const isCategory = (v: unknown, withBoth = true) => v === "nigiri" || v === "dish" || (withBoth && v === "both");

/** 評価の集計。experimentId を渡すとその実験が効いていた提案だけを数える */
function rates(opts: { category?: string; since?: string; experimentId?: number }) {
  const where = ["p.mode = 'live'"];
  const params: (string | number)[] = [];
  if (opts.category && opts.category !== "both") {
    where.push("p.category = ?");
    params.push(opts.category);
  }
  if (opts.since) {
    where.push("p.created_at >= ?");
    params.push(opts.since);
  }
  if (opts.experimentId !== undefined) {
    where.push("EXISTS (SELECT 1 FROM json_each(p.experiment_ids) WHERE json_each.value = ?)");
    params.push(opts.experimentId);
  }
  const row = db
    .query<{ samples: number; adopted: number; positive: number; proposals: number }, (string | number)[]>(
      `SELECT COUNT(f.id) AS samples,
              COALESCE(SUM(f.rating = 'adopted'), 0) AS adopted,
              COALESCE(SUM(f.rating IN ('adopted','tried')), 0) AS positive,
              COUNT(DISTINCT p.id) AS proposals
         FROM proposals p LEFT JOIN feedback f ON f.proposal_id = p.id
        WHERE ${where.join(" AND ")}`,
    )
    .get(...params)!;
  const ratio = (n: number) => (row.samples > 0 ? Math.round((n / row.samples) * 1000) / 1000 : null);
  return { proposals: row.proposals, samples: row.samples, positive_rate: ratio(row.positive), adoption_rate: ratio(row.adopted) };
}

function daysAgo(days: number): string {
  return db.query<{ d: string }, [string]>("SELECT datetime('now','localtime', ?) AS d").get(`-${days} days`)!.d;
}

function offsetDays(at: string): number {
  const m = /^T\+(\d+)d$/.exec(at);
  if (!m) die(`follow_up_schedule の at は "T+3d" の形で書いてください: ${at}`);
  return Number(m[1]);
}

function comments(experimentId: number, limit = 15) {
  return db
    .query<{ rating: string; comment: string }, [number, number]>(
      `SELECT f.rating, f.comment FROM feedback f JOIN proposals p ON p.id = f.proposal_id
        WHERE EXISTS (SELECT 1 FROM json_each(p.experiment_ids) WHERE json_each.value = ?)
          AND f.comment IS NOT NULL AND f.comment <> ''
        ORDER BY f.created_at DESC LIMIT ?`,
    )
    .all(experimentId, limit);
}

switch (cmd) {
  case "context": {
    const count = (sql: string) => db.query<{ c: number }, []>(sql).get()!.c;
    out({
      now: daysAgo(0),
      shops: count("SELECT COUNT(*) AS c FROM shops"),
      trends: db
        .query<{ source_type: string; c: number }, []>(
          "SELECT source_type, COUNT(*) AS c FROM trends WHERE status='active' GROUP BY source_type",
        )
        .all(),
      last_7_days: { nigiri: rates({ category: "nigiri", since: daysAgo(7) }), dish: rates({ category: "dish", since: daysAgo(7) }) },
      last_30_days: { nigiri: rates({ category: "nigiri", since: daysAgo(30) }), dish: rates({ category: "dish", since: daysAgo(30) }) },
      executing: db
        .query("SELECT id, category, title, action, metric, baseline, target, started_at FROM menu_hypotheses WHERE status='executing'")
        .all(),
      proposed: db
        .query("SELECT id, category, title FROM menu_hypotheses WHERE kind='hypothesis' AND status='proposed'")
        .all(),
      patterns: db
        .query(
          "SELECT id, kind, category, title, action FROM menu_hypotheses WHERE kind IN ('playbook','anti_pattern') AND status='active' ORDER BY updated_at DESC LIMIT 30",
        )
        .all(),
      recently_closed: db
        .query(
          "SELECT id, category, title, status, follow_up_results FROM menu_hypotheses WHERE kind='experiment' AND status IN ('validated','falsified','inconclusive') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 20",
        )
        .all(daysAgo(30)),
      knowledge_notes: count("SELECT COUNT(*) AS c FROM knowledge_notes"),
    });
    break;
  }

  case "trends": {
    const days = Number(args[0] ?? 30);
    out(
      db
        .query(
          `SELECT id, category, title, summary, ingredients, techniques, season, source_type, observed_at
             FROM trends WHERE status='active' AND observed_at >= date('now','localtime', ?)
            ORDER BY observed_at DESC, id DESC`,
        )
        .all(`-${days} days`),
    );
    break;
  }

  case "add-trends": {
    const items = readJson(args[0], args[1]);
    if (!Array.isArray(items)) die("配列 [...] で渡してください");
    const insert = db.query(
      `INSERT INTO trends (category, title, summary, ingredients, techniques, season, region, source_type, source_url, collected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'noctowl-researcher')`,
    );
    // 1 つの記事から複数の傾向を取れるよう、重複は見出しで判定する
    const exists = db.query<{ id: number }, [string]>("SELECT id FROM trends WHERE title = ? LIMIT 1");
    const result = { added: 0, skipped: [] as string[] };
    for (const t of items) {
      const title = str(t.title, 60);
      const summary = str(t.summary, 300);
      const url = str(t.source_url, 500);
      const why =
        !isCategory(t.category) ? "category が不正" :
        !title || !summary ? "title / summary が空" :
        t.source_type !== "sns" && t.source_type !== "web" ? "source_type は sns か web" :
        !/^https?:\/\//.test(url) ? "source_url が URL ではない" :
        exists.get(title) ? "登録済み（同じ見出し）" : "";
      if (why) {
        result.skipped.push(`${title || "(無題)"}: ${why}`);
        continue;
      }
      insert.run(
        t.category, title, summary, JSON.stringify(strList(t.ingredients)), JSON.stringify(strList(t.techniques)),
        str(t.season, 20) || null, str(t.region, 40) || null, t.source_type, url,
      );
      result.added++;
    }
    const real = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM trends WHERE status='active' AND source_type <> 'sample'").get()!.c;
    const retiredSamples = real >= REAL_TRENDS_TO_RETIRE_SAMPLES
      ? db.query("UPDATE trends SET status='retired' WHERE source_type='sample' AND status='active'").run().changes
      : 0;
    const retiredOld = db
      .query("UPDATE trends SET status='retired' WHERE status='active' AND source_type <> 'sample' AND observed_at < date('now','localtime','-180 days')")
      .run().changes;
    out({ ...result, active_real_trends: real, retired_samples: retiredSamples, retired_old: retiredOld });
    break;
  }

  case "baseline": {
    const category = args[0];
    if (!isCategory(category, false)) die("nigiri か dish を指定してください");
    const days = Number(args[1] ?? 14);
    const r = rates({ category, since: daysAgo(days) });
    out({ category, days, ...r, enough_samples: r.samples >= 10, note: r.samples >= 10 ? "" : "評価が10件未満。仮説の baseline は 0.5 を暫定値として使い、evidence に「暫定」と書くこと" });
    break;
  }

  case "due": {
    const rows = db
      .query<{ id: number; title: string; started_at: string; follow_up_schedule: string; follow_up_results: string }, []>(
        "SELECT id, title, started_at, follow_up_schedule, follow_up_results FROM menu_hypotheses WHERE status='executing'",
      )
      .all();
    const now = Date.now();
    const due = [];
    for (const r of rows) {
      const done = new Set((JSON.parse(r.follow_up_results) as { at: string }[]).map((x) => x.at));
      for (const point of JSON.parse(r.follow_up_schedule) as { at: string; final?: boolean }[]) {
        const dueAt = new Date(r.started_at.replace(" ", "T")).getTime() + offsetDays(point.at) * 86400_000;
        if (!done.has(point.at) && dueAt <= now) due.push({ id: r.id, title: r.title, at: point.at, final: Boolean(point.final) });
      }
    }
    out(due);
    break;
  }

  case "measure": {
    const id = Number(args[0]);
    const h = db
      .query<{ id: number; title: string; status: string; metric: string; baseline: number; target: number; min_samples: number; started_at: string; category: string }, [number]>(
        "SELECT id, title, status, metric, baseline, target, min_samples, started_at, category FROM menu_hypotheses WHERE id = ?",
      )
      .get(id);
    if (!h) die(`実験 ${id} がありません`);
    const r = rates({ experimentId: id, since: h.started_at });
    const value = h.metric === "adoption_rate" ? r.adoption_rate : r.positive_rate;
    const suggestion =
      r.samples < h.min_samples ? "samples_short" :
      value! >= h.target ? "validated" :
      value! <= h.baseline ? "falsified" : "inconclusive";
    out({
      ...h, ...r, value,
      suggestion,
      rule: "評価数が min_samples 未満なら samples_short（最終判定日なら inconclusive）。value≥target→validated、value≤baseline→falsified、その間→inconclusive",
      comments: comments(id),
    });
    break;
  }

  case "record-followup": {
    const f = readJson(args[0], args[1]);
    const h = db
      .query<{ id: number; kind: string; status: string; category: string; statement: string; evidence: string; metric: string; baseline: number; target: number; follow_up_results: string; trend_ids: string }, [number]>(
        "SELECT id, kind, status, category, statement, evidence, metric, baseline, target, follow_up_results, trend_ids FROM menu_hypotheses WHERE id = ?",
      )
      .get(Number(f.id));
    if (!h || h.status !== "executing") die(`実行中の実験 ${f.id} がありません`);
    const verdict = f.verdict ?? "continue";
    if (!["continue", "validated", "falsified", "inconclusive"].includes(verdict)) die("verdict が不正です");
    const results = JSON.parse(h.follow_up_results);
    results.push({ at: str(f.at, 10), value: f.value ?? null, samples: Number(f.samples) || 0, note: str(f.note, 500), recorded_at: daysAgo(0) });
    const promotes = verdict === "validated" || verdict === "falsified";
    const title = str(f.pattern?.title, 80);
    const action = str(f.pattern?.action, 500);
    if (promotes && (!title || !action)) die("validated / falsified のときは pattern.title と pattern.action を書いてください");

    const tx = db.transaction(() => {
      db.query("UPDATE menu_hypotheses SET follow_up_results = ?, status = ?, updated_at = datetime('now','localtime') WHERE id = ?")
        .run(JSON.stringify(results), verdict === "continue" ? "executing" : verdict, h.id);
      if (promotes) {
        db.query(
          `INSERT INTO menu_hypotheses (kind, status, category, title, statement, evidence, action, metric, baseline, target,
             follow_up_schedule, follow_up_results, trend_ids, parent_id, created_by)
           VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 'gastly-validator')`,
        ).run(
          verdict === "validated" ? "playbook" : "anti_pattern", h.category, title, h.statement,
          `実験 #${h.id} の結果: ${str(f.note, 400)}`, action, h.metric, h.baseline, h.target,
          JSON.stringify(results), h.trend_ids, h.id,
        );
      }
    });
    tx();
    out({ ok: true, id: h.id, status: verdict === "continue" ? "executing" : verdict });
    break;
  }

  case "add-hypotheses": {
    const items = readJson(args[0], args[1]);
    if (!Array.isArray(items)) die("配列 [...] で渡してください");
    if (items.length > MAX_HYPOTHESES_PER_RUN) die(`1回に出せる仮説は ${MAX_HYPOTHESES_PER_RUN} 件までです`);
    const insert = db.query(
      `INSERT INTO menu_hypotheses (kind, status, category, title, statement, evidence, action, metric, baseline, target,
         min_samples, follow_up_schedule, trend_ids, created_by)
       VALUES ('hypothesis', 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'haunter-hypothesizer') RETURNING id`,
    );
    const ids: number[] = [];
    const errors: string[] = [];
    for (const h of items) {
      if (!isCategory(h.category)) { errors.push(`${h.title}: category が不正`); continue; }
      if (h.metric !== "positive_rate" && h.metric !== "adoption_rate") { errors.push(`${h.title}: metric が不正`); continue; }
      const schedule = Array.isArray(h.follow_up_schedule) ? h.follow_up_schedule : DEFAULT_SCHEDULE;
      schedule.forEach((p: { at: string }) => offsetDays(p.at));
      try {
        const row = insert.get(
          h.category, str(h.title, 80), str(h.statement, 500), str(h.evidence, 800), str(h.action, 500), h.metric,
          Number(h.baseline), Number(h.target), Number(h.min_samples) || 10, JSON.stringify(schedule),
          JSON.stringify(Array.isArray(h.trend_ids) ? h.trend_ids.map(Number) : []),
        ) as { id: number };
        ids.push(row.id);
      } catch (e) {
        errors.push(`${h.title}: ${(e as Error).message}`);
      }
    }
    out({ added: ids, errors });
    if (ids.length === 0 && errors.length > 0) process.exit(1);
    break;
  }

  case "proposed": {
    out(
      db
        .query(
          "SELECT id, category, title, statement, evidence, action, metric, baseline, target, trend_ids FROM menu_hypotheses WHERE kind='hypothesis' AND status='proposed' ORDER BY id",
        )
        .all(),
    );
    break;
  }

  case "start-experiments": {
    const f = readJson(args[0], args[1]);
    const started: number[] = [];
    const errors: string[] = [];
    for (const s of Array.isArray(f.selected) ? f.selected : []) {
      try {
        const changes = db
          .query(
            `UPDATE menu_hypotheses SET kind='experiment', status='executing', score=?, started_at=datetime('now','localtime'),
               updated_at=datetime('now','localtime') WHERE id=? AND kind='hypothesis' AND status='proposed'`,
          )
          .run(Number(s.score) || null, Number(s.id)).changes;
        changes ? started.push(Number(s.id)) : errors.push(`${s.id}: 選抜待ちの仮説ではありません`);
      } catch (e) {
        errors.push(`${s.id}: ${(e as Error).message}`);
      }
    }
    let retired = 0;
    for (const r of Array.isArray(f.rejected) ? f.rejected : []) {
      retired += db
        .query(
          `UPDATE menu_hypotheses SET status='retired', score=?, evidence = evidence || ?, updated_at=datetime('now','localtime')
            WHERE id=? AND kind='hypothesis' AND status='proposed'`,
        )
        .run(Number(r.score) || null, `\n[不採用理由] ${str(r.reason, 300)}`, Number(r.id)).changes;
    }
    out({ started, retired, errors });
    break;
  }

  case "add-notes": {
    const items = readJson(args[0], args[1]);
    if (!Array.isArray(items)) die("配列 [...] で渡してください");
    const find = db.query<{ id: number }, [string, string]>("SELECT id FROM knowledge_notes WHERE topic = ? AND subject = ?");
    let added = 0, updated = 0;
    for (const n of items) {
      const topic = str(n.topic, 20), subject = str(n.subject, 40), body = str(n.body, 1200);
      const confidence = Math.min(1, Math.max(0, Number(n.confidence) || 0.5));
      if (!topic || !subject || !body) continue;
      const hit = find.get(topic, subject);
      if (hit) {
        db.query("UPDATE knowledge_notes SET body=?, confidence=?, updated_at=datetime('now','localtime') WHERE id=?").run(body, confidence, hit.id);
        updated++;
      } else {
        db.query("INSERT INTO knowledge_notes (topic, subject, body, confidence) VALUES (?, ?, ?, ?)").run(topic, subject, body, confidence);
        added++;
      }
    }
    out({ added, updated });
    break;
  }

  case "finish-reflection": {
    const runId = Number(args[0]);
    const f = readJson(args[1], args[2]);
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
    out({ ok: changes === 1, run_id: runId });
    break;
  }

  default:
    die(`不明なコマンドです: ${cmd ?? "(なし)"}。ファイル先頭の使い方を見てください`);
}
