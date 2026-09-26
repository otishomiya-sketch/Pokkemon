#!/usr/bin/env bun
/**
 * seed-demo-data.ts — 配布用デモデータ投入
 *
 * 目的: fresh DB (schema.sql 適用 + seed-agents 済) に対し、ダッシュボードの全ビューが
 * 「中身のある状態」で見られるよう、現実味のあるダミーデータを入れる。
 *
 * 投入先 (= ダッシュボードが実際に読むテーブル):
 *   reflections / logs / hypotheses / improvements / agent_costs / agent_schedules
 *   / daily_reports / approvals
 *   ※ knowledge_index は docs/knowledge/*.md から自動再構築されるので投入不要
 *
 * 安全装置:
 *   - reflections に「デモでない行」が既にある (= 実運用 DB) 場合は中止する。
 *     上書きしたい時だけ `--force` を付ける。
 *   - デモ行は識別可能 (reflections/logs は session_id='demo-*'、他テーブルは
 *     このスクリプトが管理するデモ専用テーブルとして全消し→再投入)。
 *   - 何度実行しても重複しない (冪等)。
 *
 * 使い方:
 *   bun pokemon-agents/scripts/seed-demo-data.ts          # fresh DB に投入
 *   bun pokemon-agents/scripts/seed-demo-data.ts --force  # 実データ DB でも強制投入
 *   bun pokemon-agents/scripts/seed-demo-data.ts --clear  # デモ行を消すだけ
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DB_PATH = process.env.AGENTS_DB_PATH || resolve(REPO_ROOT, ".claude/db/agents.db");
const FORCE = process.argv.includes("--force");
const CLEAR_ONLY = process.argv.includes("--clear");

const db = new Database(DB_PATH);
db.run("PRAGMA foreign_keys=OFF");

// ── 時刻ヘルパ (localtime 'YYYY-MM-DD HH:MM:SS') ──────────────────────────────
function ts(daysAgo: number, hour = 3, min = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, min, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── エージェント slug → id ──────────────────────────────────────────────────
const agentIdBySlug = new Map<string, number>();
for (const r of db.query<{ slug: string; id: number }, []>("SELECT slug, id FROM agents").all()) {
  agentIdBySlug.set(r.slug, r.id);
}
function aid(slug: string): number | null {
  return agentIdBySlug.get(slug) ?? null;
}
const PRIO: Record<string, number> = { high: 1, medium: 3, low: 5 };

// ── 安全装置 ────────────────────────────────────────────────────────────────
const realReflections = db
  .query<{ c: number }, []>(
    "SELECT COUNT(*) c FROM reflections WHERE session_id IS NULL OR session_id NOT LIKE 'demo-%'",
  )
  .get()!.c;

if (!CLEAR_ONLY && realReflections > 0 && !FORCE) {
  console.error(
    `[demo] reflections に実データ ${realReflections} 行があります。実運用 DB と判断し中止。\n` +
      `       fresh DB でないのに投入したい場合は --force を付けてください。`,
  );
  process.exit(1);
}

// ── デモ行のクリア (冪等性) ──────────────────────────────────────────────────
function clearDemo() {
  db.run("DELETE FROM logs WHERE session_id LIKE 'demo-%'");
  db.run("DELETE FROM reflections WHERE session_id LIKE 'demo-%'");
  // 以下はデモ専用テーブル扱い。実運用 DB では --force 時のみここに来る
  if (realReflections === 0 || FORCE) {
    for (const t of ["hypotheses", "improvements", "agent_costs", "agent_schedules", "daily_reports", "approvals"]) {
      db.run(`DELETE FROM ${t}`);
    }
  }
}

clearDemo();
if (CLEAR_ONLY) {
  console.log("[demo] デモ行を削除しました (--clear)。");
  db.close();
  process.exit(0);
}

let nR = 0,
  nL = 0,
  nH = 0,
  nI = 0,
  nC = 0,
  nS = 0,
  nD = 0,
  nA = 0;

db.transaction(() => {
  // ════════════════════════════════════════════════════════════════════════
  // 1. agent_schedules — どのエージェントがいつ動くか
  // ════════════════════════════════════════════════════════════════════════
  const schedules: Array<[string, string, number | null, string | null, number]> = [
    // [slug, trigger_type, interval_sec, cron_expr, enabled]
    ["megagengar-orchestrator", "timer", null, "0 2 * * *", 1],
    ["mew-supervisor", "timer", null, "0 5 * * *", 1],
    ["arceus-knowledge-editor", "timer", null, "0 3 * * 1", 1],
    ["abra-seo-report", "timer", null, "15 0,6,12,18 * * *", 1],
    ["butterfree-subsidy-sync", "timer", 21600, null, 1],
    ["pidgeot-editorial", "timer", null, "22 8,14,22 * * *", 1],
    ["vulpix-note-publisher", "timer", null, "0 10,16 * * *", 0],
    ["kadabra-rank-monitor", "timer", null, "0 8 * * 1", 1],
  ];
  for (const [slug, tt, iv, cron, en] of schedules) {
    const id = aid(slug);
    if (id == null) continue;
    db.run(
      `INSERT INTO agent_schedules (agent_id, trigger_type, interval_sec, cron_expr, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tt, iv, cron, en, ts(-1, 2), ts(20), ts(1)],
    );
    nS++;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. reflections — 実行ログ + 4層振り返り (オーケストレーター木を含む)
  // ════════════════════════════════════════════════════════════════════════
  type Refl = {
    slug: string;
    day: number;
    hour: number;
    status?: string;
    score?: number;
    parent?: number | null;
    result: string;
    what: string;
    qc: string;
    self: string;
    content: string;
    err?: string;
  };
  function insertRefl(r: Refl, session: string): number {
    const id = aid(r.slug);
    const startedAt = ts(r.day, r.hour);
    const dur = 60000 + Math.floor((r.score ?? 80) * 900);
    const row = db
      .query<{ id: number }, any[]>(
        `INSERT INTO reflections
           (agent_id, agent_slug, trigger, parent_run_id, status, started_at, ended_at, duration_ms,
            tokens_in, tokens_out, cost_usd, session_id, work_dir, quality_score,
            result_full, what_done, quality_check, self_improvement, content_improvement,
            error_message, reflected_at, created_at, updated_at)
         VALUES (?, ?, 'launchd', ?, ?, ?, ?, ?, ?, ?, ?, ?, '/demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        id,
        r.slug,
        r.parent ?? null,
        r.status ?? "completed",
        startedAt,
        startedAt,
        dur,
        12000 + r.day * 500,
        3000 + r.day * 200,
        0.08 + r.day * 0.01,
        session,
        r.score ?? 85,
        r.result,
        r.what,
        r.qc,
        r.self,
        r.content,
        r.err ?? null,
        startedAt,
        startedAt,
        startedAt,
      ) as { id: number };
    nR++;
    return row.id;
  }

  // --- Axis A: メガゲンガー (親) → ゴース/ゴースト/ゲンガー (子) の1サイクル ---
  const mega = insertRefl(
    {
      slug: "megagengar-orchestrator",
      day: 1,
      hour: 2,
      score: 88,
      result:
        "🌀 メガゲンガー完了\n- ゴース(検証): 3 validated / 1 falsified\n- ゴースト(仮説): 9 生成\n- ゲンガー(選抜): 5 experiment化、guidance 3 発行\n合計 47 分",
      what: "- Stage1 ゴース起動\n- Stage2 ゴースト起動\n- Stage3 ゲンガー起動\n- 完了通知送信",
      qc: "- ✅ 順序厳守 (検証→仮説→選抜)\n- ✅ 全て Task 委譲\n- ✅ 各段で Discord 通知",
      self: "- Stage2 が 18 分超過。haunter の timeout を 2400s に調整したい",
      content: "- pipeline 進捗を Discord にリアルタイム配信したい",
    },
    "demo-session-axisA",
  );
  insertRefl(
    {
      slug: "gastly-validator",
      day: 1,
      hour: 2,
      score: 90,
      parent: mega,
      result: "🔍 検証: 9件中 validated 3 / falsified 1 / inconclusive 2 / pending 3",
      what: "- executing 中 experiment 9 件の follow-up を実測\n- GSC で before/after 比較\n- 3 件を playbook 昇華、1 件を anti_pattern 昇華",
      qc: "- ✅ 実測値のみ (憶測なし)\n- ✅ follow_up 全項目確認\n- ✅ playbook は confidence 0.85 開始",
      self: "- verdict 閾値を metric 別に可変化したい (CTR ±3%、順位 ±2)",
      content: "- validated/falsified レシオの推移グラフを追加",
    },
    "demo-session-axisA",
  );
  insertRefl(
    {
      slug: "haunter-hypothesizer",
      day: 1,
      hour: 2,
      score: 85,
      parent: mega,
      result: "🧪 仮説 9 生成 (Opus3/Gemini3/Grok3)。playbook 18件参照",
      what: "- playbook/anti_pattern を参照\n- 3 LLM で並列生成\n- predicted_outcome 必須フィールドを全充填",
      qc: "- ✅ playbook を生成前に参照\n- ✅ 3 LLM 使用\n- ❌ Grok 1件タイムアウト (2/3 成功)",
      self: "- Grok API のリトライ (最大3回・指数バックオフ) を追加",
      content: "- 仮説に category 自動タグ付け",
    },
    "demo-session-axisA",
  );
  insertRefl(
    {
      slug: "gengar-selector",
      day: 1,
      hour: 2,
      score: 87,
      parent: mega,
      result: "🏆 Elo選抜: 上位5件を experiment化、guidance 3件発行",
      what: "- SERP 確認\n- 3 LLM Elo トーナメント\n- 上位を experiment 化、guidance 発行",
      qc: "- ✅ 3 LLM の Elo 取得\n- ✅ 選抜前に SERP 確認\n- ✅ 同時 executing 10枠以内",
      self: "- 意見割れ時の LLM 重み付けを調整 (Sonnet 1.0 / Grok 0.7)",
      content: "- トーナメントの乖離度ヒートマップを通知に追加",
    },
    "demo-session-axisA",
  );

  // --- Axis B: ミュウ (親) → ミューツー (子) ---
  const mew = insertRefl(
    {
      slug: "mew-supervisor",
      day: 1,
      hour: 5,
      score: 86,
      result:
        "✨ ミュウ完了\n- 観測: 12件 (critical1/high3/medium5/low3)\n- 起草: 10件 (auto4/human5/forbidden1)\n- 人間ゲート待ち: 5件",
      what: "- 過去7日の reflections を分析し 12 件検知\n- control_hypothesis を 10 件起草\n- auto_apply 4 件をミューツーへ委譲",
      qc: "- ✅ control-boundary.md を起動時 Read\n- ✅ 実ファイルは触らない\n- ✅ FORBIDDEN を anti_pattern 化",
      self: "- 検知閾値を severity 別に明文化したい",
      content: "- Discord 通知に diff 抜粋を含めて人間判断を容易に",
    },
    "demo-session-axisB",
  );
  insertRefl(
    {
      slug: "mewtwo-executor",
      day: 1,
      hour: 5,
      score: 92,
      parent: mew,
      result: "🧬 適用 4件 (success3/revert1)。playbook 1 昇華、anti_pattern 1",
      what: "- auto_apply 4件を git branch で適用\n- 効果測定: 1件 validated→playbook、1件 falsified→auto-revert",
      qc: "- ✅ auto_apply のみ適用\n- ✅ 新規 branch で実施\n- ✅ 自己改変なし\n- ✅ 無限ループ防止 (3回上限)",
      self: "- revert 判定の測定期間を +6h→+12h に延長",
      content: "- before/after の metric 比較グラフを Discord に埋め込み",
    },
    "demo-session-axisB",
  );

  // --- 実行部隊 (記事 Writer 等) の日次ログ、過去5日に散らす ---
  const workers: Array<[string, string, string]> = [
    ["pidgeot-editorial", "📝 エディトリアル 3本生成", "タグ×都道府県の記事を3本生成・公開"],
    ["butterfree-subsidy-sync", "🔄 jGrants 同期 +12件、AI生成 8件", "差分同期12件、未記事化8件を執筆"],
    ["abra-seo-report", "📊 朝のSEOレポート送信", "GSC/GA 集計、インデックス率を Discord 通知"],
    ["vulpix-note-publisher", "📔 note 記事 1本入稿", "ライフイベント起点の給付金記事を入稿"],
    ["magnezone-benefit-orchestrator", "💴 給付金パイプライン 1市", "コイル→レアコイルで横浜市24件を処理"],
  ];
  let day = 2;
  for (const [slug, result, what] of workers) {
    insertRefl(
      {
        slug,
        day,
        hour: 9 + (day % 6),
        score: 80 + (day % 15),
        result,
        what: `- ${what}`,
        qc: "- ✅ ドメイン知識を起動時にロード\n- ✅ guidance を確認",
        self: "- pre-flight check を追加",
        content: "- レポートに WoW 比較を追加",
      },
      `demo-session-w${day}`,
    );
    day++;
  }
  // 失敗 / 実行中の例も1件ずつ (ダッシュボードの status 表示確認用)
  insertRefl(
    {
      slug: "vulpix-note-publisher",
      day: 0,
      hour: 10,
      status: "failed",
      score: 30,
      result: "❌ note セッション失効で投稿失敗",
      what: "- ログイン試行 → reCAPTCHA 壁で中断",
      qc: "- ❌ 投稿未完了",
      self: "- セッション失効を事前検知して人間に通知",
      content: "-",
      err: "note login session expired (reCAPTCHA)",
    },
    "demo-session-fail",
  );
  insertRefl(
    {
      slug: "kadabra-rank-monitor",
      day: 0,
      hour: 8,
      status: "running",
      score: 0,
      result: "⏳ 順位取得中…",
      what: "- DataForSEO で SERP 取得中",
      qc: "-",
      self: "-",
      content: "-",
    },
    "demo-session-run",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 3. logs — hooks 由来のツール呼び出しイベント
  // ════════════════════════════════════════════════════════════════════════
  const tools = ["Read", "Bash", "Grep", "Edit", "WebFetch", "Write", "Task"];
  function insertLog(session: string, agent: string, day: number, idx: number) {
    const tool = tools[idx % tools.length];
    const evt = idx % 3 === 0 ? "PreToolUse" : "PostToolUse";
    db.run(
      `INSERT INTO logs (ts, session_id, cwd, agent, hook_event, tool_name, tool_input, success, duration_ms, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hook')`,
      [
        ts(day, 2, idx),
        session,
        "/demo",
        agent,
        evt,
        tool,
        JSON.stringify({ demo: true, n: idx }),
        evt === "PostToolUse" ? 1 : null,
        evt === "PostToolUse" ? 200 + idx * 30 : null,
      ],
    );
    nL++;
  }
  const logAgents: Array<[string, string]> = [
    ["demo-session-axisA", "megagengar-orchestrator"],
    ["demo-session-axisA", "gastly-validator"],
    ["demo-session-axisB", "mew-supervisor"],
    ["demo-session-w2", "pidgeot-editorial"],
    ["demo-session-w3", "butterfree-subsidy-sync"],
  ];
  for (const [session, agent] of logAgents) {
    for (let i = 0; i < 12; i++) insertLog(session, agent, 1, i);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. hypotheses — Axis A 施策仮説ボード (ダッシュボード /hypotheses)
  // ════════════════════════════════════════════════════════════════════════
  const hyps: Array<{
    title: string;
    proposal: string;
    rationale: string;
    impact: string;
    method: string;
    days: number;
    status: string;
    priority: string;
    executor: string;
    result?: string;
  }> = [
    {
      title: "タイトルに「年最新」を入れると CTR が上がる",
      proposal: "ガイドページのタイトルを『{制度名}【2026年最新】対象者・申請方法』形式に変更",
      rationale: "順位5-8位だが CTR が同順位平均の半分。鮮度シグナルが弱い",
      impact: "CTR 1.2% → 1.4% (+15%)",
      method: "T+1d impressions / T+7d ctr+position を GSC で再測",
      days: 7,
      status: "validated",
      priority: "high",
      executor: "pidgeot-editorial",
      result: "CTR 1.2%→1.45% (+20%)。playbook 化",
    },
    {
      title: "業種×地域の統合ページで取りこぼしクエリを拾う",
      proposal: "/industry × 都道府県 の組み合わせページを新規生成",
      rationale: "ロングテールのインプレッションはあるが着地ページ不在",
      impact: "対象クエリ群で週 +200 clicks",
      method: "T+3d indexed / T+7d position を GSC で確認",
      days: 7,
      status: "running",
      priority: "high",
      executor: "pidgeot-editorial",
    },
    {
      title: "FAQ 構造化データで rich result を狙う",
      proposal: "補助金詳細に FAQPage schema を追加",
      rationale: "競合は rich result 表示、自社は未対応",
      impact: "rich result 率 +12%",
      method: "T+3d rich_result / T+7d ctr",
      days: 7,
      status: "running",
      priority: "medium",
      executor: "butterfree-subsidy-sync",
    },
    {
      title: "H2 見出しを「手続き方法」寄りに再構成",
      proposal: "検索意図に合わせて H2 を申請手順中心に",
      rationale: "滞在時間は長いが直帰率が高い",
      impact: "position 12 → 8",
      method: "T+5d position / T+7d ctr",
      days: 7,
      status: "falsified",
      priority: "low",
      executor: "caterpie-subsidy-writer",
      result: "delta -8% (予測と逆方向)。anti_pattern 化",
    },
    {
      title: "内部リンクを本文中の自然な位置に分散",
      proposal: "文末集約リンクを本文中アンカーに分散配置",
      rationale: "関連ページへの遷移が弱い",
      impact: "関連ページ pos 平均 -1.5",
      method: "T+5d position",
      days: 5,
      status: "pending_review",
      priority: "medium",
      executor: "pidgeot-editorial",
    },
    {
      title: "給付金の診断ツールで CTR 改善",
      proposal: "ライフイベント別の給付金診断ツールを設置",
      rationale: "インプレッションあるが CTR 壊滅的",
      impact: "対象群 CTR +0.5pt",
      method: "T+7d ctr / sessions",
      days: 7,
      status: "pending_review",
      priority: "high",
      executor: "magnezone-benefit-orchestrator",
    },
  ];
  for (const h of hyps) {
    const started = ["running", "validated", "falsified"].includes(h.status) ? ts(8, 2) : null;
    const ended = ["validated", "falsified"].includes(h.status) ? ts(1, 2) : null;
    db.run(
      `INSERT INTO hypotheses
         (title, proposal, rationale, expected_impact, verification_method, verification_period_days,
          verification_result, status, priority, executor_agent, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        h.title, h.proposal, h.rationale, h.impact, h.method, h.days,
        h.result ?? null, h.status, PRIO[h.priority], h.executor, started, ended, ts(9, 2), ts(1, 2),
      ],
    );
    nH++;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5. improvements — Axis B 制御改善ボード (ダッシュボード /improvements)
  // ════════════════════════════════════════════════════════════════════════
  const imps: Array<{
    title: string;
    proposal: string;
    rationale: string;
    impact: string;
    status: string;
    priority: string;
    target: string;
    guardrail?: string;
    result?: string;
  }> = [
    {
      title: "haunter の timeout を 3600→2400s に短縮",
      proposal: "scripts/run-agent.sh の haunter timeout 値を調整",
      rationale: "Stage2 が 18 分で目標 15 分を超過していた",
      impact: "pipeline 全体の所要時間 -10%",
      status: "validated",
      priority: "medium",
      target: "haunter-hypothesizer",
      result: "適用後 error_rate 変化なし・所要時間 -12%。playbook 化",
    },
    {
      title: "magnemite のリトライ上限をルール化",
      proposal: "agent.md に API タイムアウト時 3 回リトライを明記",
      rationale: "過去7日でエラー率 50% 超を検知",
      impact: "error_rate 67% → <10%",
      status: "running",
      priority: "high",
      target: "magnemite-benefit-writer",
    },
    {
      title: "pidgeotto の差し戻し基準を明確化",
      proposal: "agent.md のレビュー基準ロジックを変更",
      rationale: "差し戻し率 42% で再作業コストが高い",
      impact: "差し戻し率 < 25%",
      status: "pending_review",
      priority: "medium",
      target: "pidgeotto-editorial-reviewer",
      guardrail: "agent.md のロジック変更のため human_gate (人間承認待ち)",
    },
    {
      title: "通知文言のタイポ修正",
      proposal: "abra の Discord 通知テンプレの誤字を修正",
      rationale: "軽微な表記ゆれ",
      impact: "可読性向上",
      status: "validated",
      priority: "low",
      target: "abra-seo-report",
      result: "適用済み (auto_apply)",
    },
    {
      title: "src/ への変更提案 (却下)",
      proposal: "アプリ本体のコンポーネントを変更",
      rationale: "観測から自動起案されたが境界外",
      impact: "-",
      status: "falsified",
      priority: "low",
      target: "delibird-chat",
      guardrail: "FORBIDDEN パス (src/) のため即 reject → anti_pattern 化",
    },
  ];
  for (const im of imps) {
    const started = ["running", "validated", "falsified"].includes(im.status) ? ts(6, 5) : null;
    const ended = ["validated", "falsified"].includes(im.status) ? ts(1, 5) : null;
    db.run(
      `INSERT INTO improvements
         (title, proposal, rationale, expected_impact, verification_result, status, priority,
          target_agent, executor_agent, guardrail_reason, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mewtwo-executor', ?, ?, ?, ?, ?)`,
      [
        im.title, im.proposal, im.rationale, im.impact, im.result ?? null, im.status, PRIO[im.priority],
        im.target, im.guardrail ?? null, started, ended, ts(7, 5), ts(1, 5),
      ],
    );
    nI++;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 6. agent_costs — 過去7日のエージェント別コスト
  // ════════════════════════════════════════════════════════════════════════
  const costAgents = [
    "megagengar-orchestrator", "haunter-hypothesizer", "gastly-validator", "gengar-selector",
    "mew-supervisor", "mewtwo-executor", "pidgeot-editorial", "butterfree-subsidy-sync",
    "abra-seo-report", "vulpix-note-publisher", "magnezone-benefit-orchestrator",
  ];
  for (let d = 6; d >= 0; d--) {
    for (const slug of costAgents) {
      if (aid(slug) == null) continue;
      // opus 系は高め、sonnet 系は低め (slug でざっくり)
      const base = /megagengar|haunter|mew|arceus/.test(slug) ? 0.45 : 0.12;
      const cost = +(base * (0.7 + (d % 3) * 0.2)).toFixed(4);
      db.run(
        `INSERT INTO agent_costs (agent, cost_usd, input_tokens, output_tokens, duration_ms, num_turns, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [slug, cost, 15000 + d * 800, 4000 + d * 300, 90000 + d * 5000, 6 + (d % 4), ts(d, 4)],
      );
      nC++;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 7. daily_reports — 日次サマリ (ダッシュボード /reports)
  // ════════════════════════════════════════════════════════════════════════
  for (let d = 5; d >= 1; d--) {
    db.run(
      `INSERT INTO daily_reports (date, summary_md, prompt_count, event_count, reflection_count, cost_usd, agents_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dateStr(d),
        `## ${dateStr(d)} の活動サマリ\n\n- Axis A: 仮説 9 生成 / 5 実験化 / 3 validated\n- Axis B: 制御改善 ${2 + (d % 3)} 件\n- 記事生成: ${5 + d} 本\n- 主要トピック: タイトル最適化・構造化データ・内部リンク`,
        20 + d * 3,
        180 + d * 25,
        6 + d,
        +(2.1 + d * 0.4).toFixed(2),
        JSON.stringify(["megagengar-orchestrator", "pidgeot-editorial", "abra-seo-report", "mew-supervisor"]),
        ts(d, 23),
      ],
    );
    nD++;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 8. approvals — 人間ゲート待ち (Axis B の human_gate)
  // ════════════════════════════════════════════════════════════════════════
  const approvals: Array<[string, string, string, string, string]> = [
    [
      "control_apply",
      "pidgeotto の差し戻し基準ロジック変更",
      "差し戻し率 42% を下げるため、レビュー基準を緩和する agent.md 変更。ロジック変更のため人間承認が必要。",
      "--- a/.claude/agents/pidgeotto-editorial-reviewer/agent.md\n+++ b/.claude/agents/pidgeotto-editorial-reviewer/agent.md\n@@\n- 27項目すべてを満たすこと\n+ 重大度 high の項目を満たすこと (low は警告のみ)",
      "pending",
    ],
    [
      "control_apply",
      "porygon に週次スケジュールを新規追加",
      "キーワード調査を週1で自動化する新 schedule。新規 plist 追加のため human_gate。",
      "+ 新規: com.claude.hojokin.porygon-keyword-research (毎週火 4:00)",
      "pending",
    ],
  ];
  for (const [etype, title, body, diff, status] of approvals) {
    db.run(
      `INSERT INTO approvals (entity_type, entity_id, title, body, diff_text, requested_by_agent_id, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [etype, 0, title, body, diff, aid("mew-supervisor"), status, ts(-3, 5), ts(1, 5), ts(1, 5)],
    );
    nA++;
  }
})();

console.log(
  `[demo] 投入完了:\n` +
    `  reflections    ${nR}\n  logs           ${nL}\n  hypotheses     ${nH}\n` +
    `  improvements   ${nI}\n  agent_costs    ${nC}\n  agent_schedules ${nS}\n` +
    `  daily_reports  ${nD}\n  approvals      ${nA}`,
);
console.log(`[demo] DB: ${DB_PATH}`);
console.log(`[demo] ダッシュボード: bun pokemon-agents/web/server.ts → http://localhost:5733/`);
db.close();
