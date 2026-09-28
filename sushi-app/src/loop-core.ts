/**
 * 学習ループのコマンド本体。scripts/loop.ts（Mac のエージェントから）と
 * server.ts の /api/loop（クラウドの DB に対して）の両方から呼ばれる。
 * 入力は検証してから書き込み、エージェントに SQL を直接書かせない。
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import { BAND_IDS, PRICE_BANDS, bandFor } from "./shop-profile";

const DEFAULT_SCHEDULE = [{ at: "T+3d" }, { at: "T+7d", final: true }];
const MAX_HYPOTHESES_PER_RUN = 6;
const REAL_TRENDS_TO_RETIRE_SAMPLES = 20;

/** JSON の入力を受け取るコマンド */
export const JSON_COMMANDS = new Set([
  "add-trends", "record-followup", "add-hypotheses", "start-experiments", "add-notes", "add-shop", "import-snapshot",
  "set-shop-profile",
]);

export class LoopError extends Error {}

export interface LoopResult {
  data: unknown;
  /** true のときは CLI を終了コード 1 で終える（一部だけ失敗した場合など） */
  failed?: boolean;
}

function die(message: string): never {
  throw new LoopError(message);
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : []);
const isCategory = (v: unknown, withBoth = true) => v === "nigiri" || v === "dish" || (withBoth && v === "both");

/** 推測されにくい店舗コード（紛らわしい文字 0/O/1/I/L を除く） */
export function newShopCode(length = 10): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return [...randomBytes(length)].map((b) => alphabet[b % alphabet.length]).join("");
}

const count0 = (db: Database, sql: string) => db.query<{ c: number }, []>(sql).get()!.c;

export function runLoop(db: Database, cmd: string | undefined, args: string[], input?: any): LoopResult {
  const daysAgo = (days: number): string =>
    db.query<{ d: string }, [string]>("SELECT datetime('now','localtime', ?) AS d").get(`-${days} days`)!.d;

  const offsetDays = (at: string): number => {
    const m = /^T\+(\d+)d$/.exec(at);
    if (!m) die(`follow_up_schedule の at は "T+3d" の形で書いてください: ${at}`);
    return Number(m[1]);
  };

  /** 評価の集計。experimentId を渡すとその実験が効いていた提案だけを数える */
  const rates = (opts: { category?: string; since?: string; experimentId?: number }) => {
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
  };

  const comments = (experimentId: number, limit = 15) =>
    db
      .query<{ rating: string; comment: string }, [number, number]>(
        `SELECT f.rating, f.comment FROM feedback f JOIN proposals p ON p.id = f.proposal_id
          WHERE EXISTS (SELECT 1 FROM json_each(p.experiment_ids) WHERE json_each.value = ?)
            AND f.comment IS NOT NULL AND f.comment <> ''
          ORDER BY f.created_at DESC LIMIT ?`,
      )
      .all(experimentId, limit);

  if (JSON_COMMANDS.has(cmd ?? "") && input === undefined) die("--json '<JSON>' か JSON ファイルのパスを指定してください");

  switch (cmd) {
    case "context": {
      const count = (sql: string) => db.query<{ c: number }, []>(sql).get()!.c;
      return {
        data: {
          now: daysAgo(0),
          shops: count("SELECT COUNT(*) AS c FROM shops"),
          shops_by_band: db
            .query("SELECT COALESCE(price_band, 'unregistered') AS price_band, COUNT(*) AS c FROM shops GROUP BY 1 ORDER BY 2 DESC")
            .all(),
          trends: db
            .query("SELECT source_type, COUNT(*) AS c FROM trends WHERE status='active' GROUP BY source_type")
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
        },
      };
    }

    case "trends": {
      const days = Number(args[0] ?? 30);
      return {
        data: db
          .query(
            `SELECT id, category, title, summary, ingredients, techniques, season, price_band, source_type, observed_at
               FROM trends WHERE status='active' AND observed_at >= date('now','localtime', ?)
              ORDER BY observed_at DESC, id DESC`,
          )
          .all(`-${days} days`),
      };
    }

    case "research-targets": {
      // 登録店舗の価格帯・コンセプト・特徴をまとめ、今回のリサーチで価格帯ごとに何件集めるかの目安を返す（店名は出さない）
      const total = Number(args[0] ?? 12);
      const shops = db
        .query<{ price_band: string | null; price_per_guest: number | null; concept: string | null; features: string }, []>(
          "SELECT price_band, price_per_guest, concept, features FROM shops WHERE price_band IS NOT NULL",
        )
        .all();
      const recent = db
        .query<{ band: string; c: number }, []>(
          `SELECT COALESCE(price_band, 'all') AS band, COUNT(*) AS c FROM trends
            WHERE status = 'active' AND source_type <> 'sample' AND observed_at >= date('now','localtime','-30 days') GROUP BY 1`,
        )
        .all();
      const recentBy = Object.fromEntries(recent.map((r) => [r.band, r.c]));
      // 価格帯を問わない一般的な流行に 2 割、残りを店舗数に比例して配分（店舗が無ければ全部を一般に）
      const general = shops.length ? Math.max(2, Math.round(total * 0.2)) : total;
      const targets = PRICE_BANDS.map((b) => {
        const inBand = shops.filter((x) => x.price_band === b.id);
        const features = inBand.flatMap((x) => JSON.parse(x.features) as string[]);
        const topFeatures = [...new Set(features)]
          .map((f) => [f, features.filter((y) => y === f).length] as const)
          .sort((a, z) => z[1] - a[1])
          .slice(0, 8)
          .map(([f]) => f);
        return {
          price_band: b.id,
          label: b.label,
          examples: b.examples,
          shops: inBand.length,
          price_per_guest_range: inBand.length
            ? [Math.min(...inBand.map((x) => x.price_per_guest ?? 0)), Math.max(...inBand.map((x) => x.price_per_guest ?? 0))]
            : null,
          concepts: inBand.map((x) => x.concept).filter(Boolean).slice(0, 8),
          features: topFeatures,
          trends_last_30_days: recentBy[b.id] ?? 0,
          target_count: shops.length ? Math.round(((total - general) * inBand.length) / shops.length) : 0,
        };
      });
      return {
        data: {
          total,
          general: { price_band: "all", target_count: general, trends_last_30_days: recentBy.all ?? 0 },
          bands: targets,
          unregistered_shops: count0(db, "SELECT COUNT(*) AS c FROM shops WHERE price_band IS NULL"),
        },
      };
    }

    case "add-trends": {
      const items = input;
      if (!Array.isArray(items)) die("配列 [...] で渡してください");
      const insert = db.query(
        `INSERT INTO trends (category, title, summary, ingredients, techniques, season, region, price_band, source_type, source_url, collected_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'noctowl-researcher')`,
      );
      // 1 つの記事から複数の傾向を取れるよう、重複は見出しで判定する
      const exists = db.query<{ id: number }, [string]>("SELECT id FROM trends WHERE title = ? LIMIT 1");
      const result = { added: 0, skipped: [] as string[] };
      for (const t of items) {
        const title = str(t.title, 60);
        const summary = str(t.summary, 300);
        const url = str(t.source_url, 500);
        const band = t.price_band === undefined || t.price_band === null || t.price_band === "all" ? null : t.price_band;
        const why =
          !isCategory(t.category) ? "category が不正" :
          band !== null && !BAND_IDS.includes(band) ? `price_band は ${BAND_IDS.join(" / ")} / all のどれか` :
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
          str(t.season, 20) || null, str(t.region, 40) || null, band, t.source_type, url,
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
      return { data: { ...result, active_real_trends: real, retired_samples: retiredSamples, retired_old: retiredOld } };
    }

    case "baseline": {
      const category = args[0];
      if (!isCategory(category, false)) die("nigiri か dish を指定してください");
      const days = Number(args[1] ?? 14);
      const r = rates({ category, since: daysAgo(days) });
      return {
        data: {
          category, days, ...r, enough_samples: r.samples >= 10,
          note: r.samples >= 10 ? "" : "評価が10件未満。仮説の baseline は 0.5 を暫定値として使い、evidence に「暫定」と書くこと",
        },
      };
    }

    case "due": {
      const rows = db
        .query<{ id: number; title: string; started_at: string; follow_up_schedule: string; follow_up_results: string }, []>(
          "SELECT id, title, started_at, follow_up_schedule, follow_up_results FROM menu_hypotheses WHERE status='executing'",
        )
        .all();
      const now = db.query<{ d: string }, []>("SELECT datetime('now','localtime') AS d").get()!.d;
      const nowMs = Date.parse(now.replace(" ", "T") + "Z");
      const due = [];
      for (const r of rows) {
        const done = new Set((JSON.parse(r.follow_up_results) as { at: string }[]).map((x) => x.at));
        for (const point of JSON.parse(r.follow_up_schedule) as { at: string; final?: boolean }[]) {
          const dueAt = Date.parse(r.started_at.replace(" ", "T") + "Z") + offsetDays(point.at) * 86400_000;
          if (!done.has(point.at) && dueAt <= nowMs) due.push({ id: r.id, title: r.title, at: point.at, final: Boolean(point.final) });
        }
      }
      return { data: due };
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
      return {
        data: {
          ...h, ...r, value, suggestion,
          rule: "評価数が min_samples 未満なら samples_short（最終判定日なら inconclusive）。value≥target→validated、value≤baseline→falsified、その間→inconclusive",
          comments: comments(id),
        },
      };
    }

    case "record-followup": {
      const f = input;
      const h = db
        .query<{ id: number; status: string; category: string; statement: string; metric: string; baseline: number; target: number; follow_up_results: string; trend_ids: string }, [number]>(
          "SELECT id, status, category, statement, metric, baseline, target, follow_up_results, trend_ids FROM menu_hypotheses WHERE id = ?",
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

      db.transaction(() => {
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
      })();
      return { data: { ok: true, id: h.id, status: verdict === "continue" ? "executing" : verdict } };
    }

    case "add-hypotheses": {
      const items = input;
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
        try {
          schedule.forEach((p: { at: string }) => offsetDays(p.at));
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
      return { data: { added: ids, errors }, failed: ids.length === 0 && errors.length > 0 };
    }

    case "proposed":
      return {
        data: db
          .query(
            "SELECT id, category, title, statement, evidence, action, metric, baseline, target, trend_ids FROM menu_hypotheses WHERE kind='hypothesis' AND status='proposed' ORDER BY id",
          )
          .all(),
      };

    case "start-experiments": {
      const f = input;
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
      return { data: { started, retired, errors } };
    }

    case "add-notes": {
      const items = input;
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
      return { data: { added, updated } };
    }

    // ---- 管理用（エージェントは使わない） ----

    case "add-shop": {
      const name = str(input?.name, 60);
      if (!name) die("店名（name）を指定してください");
      const code = str(input?.code, 20).toUpperCase() || newShopCode();
      if (code.length < 8) die("店舗コードは 8 文字以上にしてください（推測されないように）");
      const price = Number(input?.price_per_guest);
      const hasPrice = Number.isFinite(price) && price > 0;
      db.query("INSERT INTO shops (code, name, concept, features, price_per_guest, price_band) VALUES (?, ?, ?, ?, ?, ?)").run(
        code, name, str(input?.concept, 200) || null, JSON.stringify(strList(input?.features)),
        hasPrice ? Math.round(price) : null, hasPrice ? bandFor(price) : null,
      );
      return { data: { code, name, price_band: hasPrice ? bandFor(price) : null } };
    }

    case "set-shop-profile": {
      const code = str(input?.code, 20);
      const price = Number(input?.price_per_guest);
      if (!code) die("code を指定してください");
      if (!Number.isFinite(price) || price <= 0) die("price_per_guest（客単価・円）を指定してください");
      const changes = db
        .query("UPDATE shops SET concept = ?, features = ?, price_per_guest = ?, price_band = ? WHERE code = ? COLLATE NOCASE")
        .run(str(input?.concept, 200) || null, JSON.stringify(strList(input?.features)), Math.round(price), bandFor(price), code).changes;
      if (!changes) die(`店舗 ${code} がありません`);
      return { data: { code, price_band: bandFor(price) } };
    }

    case "recent-proposals": {
      // 直近の提案（管理用・読み取りのみ）。提案の偏りを調べるために使う
      const limit = Math.min(100, Number(args[0] ?? 30));
      const rows = db
        .query<{ id: number; shop: string; category: string; ingredients: string; notes: string; result: string; trend_ids: string; experiment_ids: string; mode: string; created_at: string }, [number]>(
          `SELECT p.id, s.name AS shop, p.category, p.ingredients, p.notes, p.result, p.trend_ids, p.experiment_ids, p.mode, p.created_at
             FROM proposals p JOIN shops s ON s.id = p.shop_id ORDER BY p.id DESC LIMIT ?`,
        )
        .all(limit);
      return {
        data: rows.map((r) => ({
          id: r.id, shop: r.shop, category: r.category, mode: r.mode, created_at: r.created_at,
          ingredients: JSON.parse(r.ingredients), notes: r.notes,
          dishes: (JSON.parse(r.result).proposals ?? []).map((d: { name: string; concept: string }) => ({ name: d.name, concept: d.concept })),
          trend_ids: JSON.parse(r.trend_ids), experiment_ids: JSON.parse(r.experiment_ids),
        })),
      };
    }

    case "shop-stats":
      // 店舗ごとの利用状況（管理用）
      return {
        data: db
          .query(
            `SELECT s.code, s.name, s.price_band,
                    (SELECT COUNT(*) FROM proposals p WHERE p.shop_id = s.id) AS proposals,
                    (SELECT COUNT(*) FROM proposals p WHERE p.shop_id = s.id AND p.created_at >= datetime('now','localtime','-7 days')) AS proposals_7d,
                    (SELECT COUNT(*) FROM feedback f JOIN proposals p ON p.id = f.proposal_id WHERE p.shop_id = s.id) AS ratings,
                    (SELECT COUNT(*) FROM dish_images i JOIN proposals p ON p.id = i.proposal_id WHERE p.shop_id = s.id) AS images,
                    (SELECT MAX(p.created_at) FROM proposals p WHERE p.shop_id = s.id) AS last_used
               FROM shops s ORDER BY s.id`,
          )
          .all(),
      };

    case "list-shops":
      return { data: db.query("SELECT id, code, name, concept, features, price_per_guest, price_band, created_at FROM shops ORDER BY id").all() };

    case "export-snapshot":
      return {
        data: {
          trends: db.query("SELECT * FROM trends WHERE source_type <> 'sample' ORDER BY id").all(),
          menu_hypotheses: db.query("SELECT * FROM menu_hypotheses ORDER BY id").all(),
          knowledge_notes: db.query("SELECT * FROM knowledge_notes ORDER BY id").all(),
        },
      };

    case "import-snapshot": {
      // 手元の DB の学習データをクラウドの空の DB に移す（1 回だけ使う想定）
      const existing = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM menu_hypotheses").get()!.c;
      if (existing > 0) die("移行先に仮説データがすでにあります。二重に取り込まないよう止めました");
      const copy = (table: string, rows: unknown) => {
        if (!Array.isArray(rows) || rows.length === 0) return 0;
        const cols = Object.keys(rows[0] as object).filter((c) => /^[a-z_]+$/.test(c));
        const stmt = db.query(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
        let n = 0;
        for (const r of rows as Record<string, any>[]) n += stmt.run(...cols.map((c) => r[c] ?? null)).changes;
        return n;
      };
      const result = db.transaction(() => ({
        trends: copy("trends", input.trends),
        menu_hypotheses: copy("menu_hypotheses", input.menu_hypotheses),
        knowledge_notes: copy("knowledge_notes", input.knowledge_notes),
      }))();
      return { data: result };
    }

    default:
      die(`不明なコマンドです: ${cmd ?? "(なし)"}。scripts/loop.ts の先頭の使い方を見てください`);
  }
}
