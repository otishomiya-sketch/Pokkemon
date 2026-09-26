/**
 * Actor classification — DB-native (agents テーブルが唯一の真実)
 *
 * Event ごとに「誰が起こしたか」を判別:
 *   - subagent : Claude Code 内で Task tool により spawn されたサブエージェント
 *   - scheduled: launchd / platform scheduler が agent.md を直接 claude -p した
 *   - claude   : 対話セッションの Claude Code (= 人間との会話中)
 *   - user     : UserPromptSubmit そのもの
 *
 * ポケモン情報 (日本語名 / avatar) は agents テーブルから runtime で引く。
 * TS 側に辞書を書かない — CLAUDE.md の「ダッシュボードは DB-native 必須」ルール参照。
 */

import type { Database } from "bun:sqlite";

export interface AgentMeta {
  slug: string;          // 'caterpie-subsidy-writer'
  pokemon_slug: string;  // 'caterpie'
  pokemon_jp: string;    // 'キャタピー'
  avatar_url: string | null;
}

/**
 * agents テーブルから slug → AgentMeta のマップを構築。
 * pokemon_slug と full slug の両方で検索できるように二重登録する。
 */
export function buildAgentLookup(db: Database): Map<string, AgentMeta> {
  const rows = db
    .query<AgentMeta, []>(
      `SELECT slug, pokemon_slug, pokemon_jp, avatar_url FROM agents`,
    )
    .all();
  const map = new Map<string, AgentMeta>();
  for (const r of rows) {
    map.set(r.slug, r);
    // pokemon_slug 単独でも引けるように (既存キーを優先)
    if (!map.has(r.pokemon_slug)) map.set(r.pokemon_slug, r);
  }
  return map;
}

export interface Actor {
  kind: "user" | "claude" | "scheduled" | "subagent" | "unknown";
  name: string;
  icon: string;         // icons.ts の name (絵文字禁止)
  avatar?: string;      // Supabase Storage の png URL (agents テーブルから)
  slug?: string;
}

/**
 * イベントから "誰が" を推定。
 * agentLookup が渡されない場合は名前不明 (slug そのまま表示) となる。
 */
export function classifyActor(
  event: {
    hook_event?: string | null;
    prompt?: string | null;
    agent?: string | null;
    transcript_path?: string | null;
    source?: string | null;
  },
  agentLookup?: Map<string, AgentMeta>,
): Actor {
  // UserPromptSubmit 自体 = 人間
  // ただし scheduled セッションの UserPromptSubmit は claude -p の起動 prompt なので人間扱いしない
  if (event.hook_event === "UserPromptSubmit" && event.source !== "scheduled") {
    return { kind: "user", name: "Tom (人間)", icon: "user" };
  }

  // サブエージェント (Task/Agent tool で spawn): transcript path が /subagents/agent-*
  if (event.transcript_path && event.transcript_path.includes("/subagents/agent-")) {
    if (event.agent) {
      const meta = lookupAgent(event.agent, agentLookup);
      if (meta) {
        return {
          kind: "subagent",
          name: meta.pokemon_jp,
          icon: "",
          avatar: meta.avatar_url ?? undefined,
          slug: meta.pokemon_slug,
        };
      }
      return { kind: "subagent", name: event.agent, icon: "theater", slug: normalizeKey(event.agent) };
    }
    return { kind: "subagent", name: "サブエージェント", icon: "theater" };
  }

  // scheduled 起動 (launchd → run-agent.sh → claude -p): session attribution が scheduled
  if (event.source === "scheduled") {
    if (event.agent) {
      const meta = lookupAgent(event.agent, agentLookup);
      if (meta) {
        return {
          kind: "scheduled",
          name: meta.pokemon_jp,
          icon: "",
          avatar: meta.avatar_url ?? undefined,
          slug: meta.pokemon_slug,
        };
      }
      return { kind: "scheduled", name: event.agent, icon: "bot", slug: normalizeKey(event.agent) };
    }
    return { kind: "scheduled", name: "scheduled", icon: "bot" };
  }

  // 既存の prompt 由来判定 (過去データ互換)
  if (event.prompt && event.prompt.includes(".claude/agents/")) {
    const m = event.prompt.match(/\.claude\/agents\/(?:_[a-z-]+\/)?([a-z][a-z0-9-]+)\/agent\.md/);
    if (m) {
      const meta = lookupAgent(m[1], agentLookup);
      if (meta) {
        return {
          kind: "scheduled",
          name: meta.pokemon_jp,
          icon: "",
          avatar: meta.avatar_url ?? undefined,
          slug: meta.pokemon_slug,
        };
      }
      return { kind: "scheduled", name: m[1], icon: "bot", slug: normalizeKey(m[1]) };
    }
  }

  // agent カラムに pokemon 名が入ってる場合 (Task tool 経由の subagent)
  if (event.agent) {
    const meta = lookupAgent(event.agent, agentLookup);
    if (meta) {
      return {
        kind: "subagent",
        name: meta.pokemon_jp,
        icon: "",
        avatar: meta.avatar_url ?? undefined,
        slug: meta.pokemon_slug,
      };
    }
    if (["general-purpose", "Explore", "Plan"].includes(event.agent)) {
      return { kind: "subagent", name: event.agent, icon: "theater", slug: event.agent };
    }
    return { kind: "subagent", name: event.agent, icon: "theater", slug: normalizeKey(event.agent) };
  }

  // それ以外 = 対話中の Claude Code (私と人間の会話)
  return { kind: "claude", name: "Claude Code", icon: "terminal" };
}

/**
 * agent 文字列 ('caterpie', 'caterpie-subsidy-writer' 等) から AgentMeta を引く。
 * full slug → pokemon_slug の順で試す。
 */
function lookupAgent(agent: string, lookup?: Map<string, AgentMeta>): AgentMeta | null {
  if (!lookup) return null;
  const direct = lookup.get(agent);
  if (direct) return direct;
  const head = normalizeKey(agent);
  return lookup.get(head) ?? null;
}

function normalizeKey(agent: string): string {
  // 'caterpie-subsidy-writer' → 'caterpie'
  return agent.split("-")[0].toLowerCase();
}

/**
 * Tool input/prompt から人間が読みやすい要約を生成
 */
export function summarize(ev: {
  hook_event?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  prompt?: string | null;
}): string {
  if (!ev.tool_input) {
    if (ev.hook_event === "Stop") return "(session stop)";
    if (ev.hook_event === "SessionStart") return "(session start)";
    if (ev.hook_event === "UserPromptSubmit") return (ev.prompt || "").slice(0, 120);
    return "";
  }
  let input: Record<string, unknown> | null = null;
  try {
    input = JSON.parse(ev.tool_input);
  } catch {
    return ev.tool_input.slice(0, 120);
  }
  if (!input || typeof input !== "object") return "";

  if (ev.tool_name === "Read" || ev.tool_name === "Write" || ev.tool_name === "Edit")
    return String(input.file_path || "");
  if (ev.tool_name === "Bash") return String(input.command || "").slice(0, 160);
  if (ev.tool_name === "WebFetch" || ev.tool_name === "WebSearch")
    return String(input.url || input.query || "");
  if (ev.tool_name === "Grep" || ev.tool_name === "Glob")
    return String(input.pattern || "");
  if (ev.tool_name === "Task" || ev.tool_name === "Agent")
    return String(input.description || input.prompt || "").slice(0, 140);
  return JSON.stringify(input).slice(0, 100);
}

export function actorBadgeClass(kind: string): string {
  return (
    {
      user: "user",
      claude: "claude",
      scheduled: "scheduled",
      subagent: "subagent",
      unknown: "unknown",
    }[kind] || "unknown"
  );
}
