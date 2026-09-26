/**
 * Paperclip-inspired layout: 左 sidebar + main content area
 * - 240px sidebar (sections: Overview / Work / Pokemon / Company)
 * - main は max-w-7xl 相当の余裕、padding 24px
 * - design tokens (CSS vars: --bg, --fg, --muted, --border, --accent)
 */

import { icon } from "./icons";

interface NavItem {
  href: string;
  label: string;
  iconName: string;
  badge?: number | string;
  active?: boolean;
  children?: NavItem[];
}

interface NavSection {
  label?: string;
  items: NavItem[];
}

function buildNav(currentPath: string, badges: { approvals: number; running: number }): NavSection[] {
  const pathOnly = currentPath.split("?")[0];
  const search = currentPath.includes("?") ? currentPath.slice(currentPath.indexOf("?") + 1) : "";
  const params = new URLSearchParams(search);
  const a = (href: string) => pathOnly === href;
  // フラット 1 階層構造 (URL = DB table name)
  return [
    {
      items: [
        { href: "/agents",       label: "エージェント",            iconName: "agents",    active: pathOnly === "/agents",       badge: badges.running > 0 ? badges.running : undefined },
        { href: "/schedules",    label: "スケジュール",            iconName: "clock",     active: pathOnly === "/schedules" },
        { href: "/costs",        label: "コスト",                  iconName: "costs",     active: pathOnly === "/costs" },
        { href: "/reflections",  label: "リフレクションログ",      iconName: "list",      active: pathOnly === "/reflections" },
        { href: "/logs",         label: "行動ログ",                iconName: "activity",  active: pathOnly === "/logs" },
        { href: "/hypotheses",   label: "仮説検証",                iconName: "zap",       active: pathOnly === "/hypotheses" },
        { href: "/improvements", label: "自律改善",                iconName: "knowledge", active: pathOnly === "/improvements", badge: badges.approvals > 0 ? badges.approvals : undefined },
        { href: "/knowledge",    label: "ドメイン知識",            iconName: "knowledge", active: pathOnly === "/knowledge" },
        { href: "/reports",      label: "日報",                    iconName: "knowledge", active: pathOnly === "/reports" },
      ],
    },
  ];
}

export interface LayoutOpts {
  title: string;
  body: string;
  flash?: { type: "ok" | "err"; msg: string };
  currentPath: string;
  badges?: {
    approvals: number;
    running: number;
    totalAgents?: number;
    activeAgents?: number;
    healthPct?: number;
    healthMood?: string;
    events24h?: number;
    errors7d?: number;
  };
}

export function renderLayout(opts: LayoutOpts): string {
  const badges = opts.badges || { approvals: 0, running: 0 };
  const nav = buildNav(opts.currentPath, badges);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(opts.title)} — Pokemon Agents</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=LINE+Seed+JP:wght@400;700&display=swap">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            brand: '#6a8de9',
          },
          fontFamily: {
            sans: ['Poppins','"LINE Seed JP"','-apple-system','BlinkMacSystemFont','"Hiragino Sans"','"Yu Gothic"','sans-serif'],
            mono: ['ui-monospace','"SF Mono"','Menlo','Consolas','monospace'],
          },
        },
      },
    };
  </script>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <a href="/" class="sidebar-header" style="text-decoration:none;color:inherit;display:block;">
        <div class="brand">
          <span class="brand-mark">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15"/>
              <path d="M2 12h8a2 2 0 014 0h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <circle cx="12" cy="12" r="2.5" fill="#fff" stroke="currentColor" stroke-width="1.8"/>
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8" fill="none"/>
            </svg>
          </span>
          <span class="brand-name">Pokemon Agents</span>
        </div>
        <div class="brand-sub">hojokin-agent / local</div>
      </a>
      <nav class="sidebar-nav">
        ${nav
          .map(
            (section) => `
          ${section.label ? `<div class="nav-section-label">${escapeHtml(section.label)}</div>` : ""}
          <div class="nav-section">
            ${section.items
              .map(
                (item) => `<a href="${item.href}" class="nav-item ${item.active ? "active" : ""}" data-nav="${item.iconName}">
                  <span class="nav-icon-chip">${icon(item.iconName, "size-4")}</span>
                  <span class="nav-label">${escapeHtml(item.label)}</span>
                  ${item.badge ? `<span class="nav-badge">${escapeHtml(String(item.badge))}</span>` : ""}
                </a>${
                  item.children && item.children.length > 0
                    ? `<div class="nav-children">${item.children
                        .map(
                          (c) => `<a href="${c.href}" class="nav-child ${c.active ? "active" : ""}">
                          <span class="nav-icon-chip nav-icon-chip-sm">${icon(c.iconName, "size-4")}</span>
                          <span class="nav-label">${escapeHtml(c.label)}</span>
                        </a>`,
                        )
                        .join("")}</div>`
                    : ""
                }`,
              )
              .join("")}
          </div>
        `,
          )
          .join("")}
      </nav>
    </aside>
    <main class="main" id="main">
      ${opts.flash ? `<div class="flash ${opts.flash.type}">${escapeHtml(opts.flash.msg)}</div>` : ""}
      <div id="live-content">${opts.body}</div>
    </main>
  </div>
  <script>${liveScript(opts.currentPath)}</script>
</body>
</html>`;
}

/**
 * Live update client script.
 * - /api/events に EventSource で接続
 * - dashboard / heartbeat ページ では event 受信時に該当 fragment を fetch & swap
 * - sidebar の badge も更新
 * - 接続 indicator (live-dot / live-text) を更新
 */
function liveScript(currentPath: string): string {
  // 注: "/" (overview) は overview.ts 自身が SSE で部分更新するので live swap は OFF
  const isLive = currentPath === "/heartbeat";
  return `
(() => {
  const dot = document.getElementById('live-dot');
  const txt = document.getElementById('live-text');
  const isLive = ${JSON.stringify(isLive)};
  const fragmentUrl = ${JSON.stringify(currentPath === "/" ? "/api/fragments/dashboard" : "/api/fragments/heartbeat")};
  let es = null;
  let reconnectTimer = null;
  let lastSwap = 0;

  function setStatus(state) {
    if (!dot || !txt) return;
    dot.className = 'dot ' + (state === 'on' ? 'dot-on' : 'dot-off');
    txt.textContent = state === 'on' ? 'live' : (state === 'reconnect' ? 'reconnect…' : 'offline');
  }

  function refreshBadges() {
    fetch('/api/fragments/badges').then(r => r.json()).then(b => {
      // sidebar nav badges を更新
      document.querySelectorAll('.nav-item').forEach(a => {
        const href = a.getAttribute('href');
        const badge = a.querySelector('.nav-badge');
        let count = 0;
        if (href === '/approvals' || href === '/inbox') count = b.approvals;
        else if (href === '/') count = b.running;
        if (count > 0) {
          if (badge) badge.textContent = count;
          else {
            const el = document.createElement('span');
            el.className = 'nav-badge';
            el.textContent = count;
            a.appendChild(el);
          }
        } else if (badge) {
          badge.remove();
        }
      });
    }).catch(() => {});
  }

  function refreshFragment() {
    if (!isLive) return refreshBadges();
    // throttle: 連続変化があっても 800ms 以内は無視
    const now = Date.now();
    if (now - lastSwap < 800) return;
    lastSwap = now;
    fetch(fragmentUrl).then(r => r.text()).then(html => {
      const el = document.getElementById('live-content');
      if (el) el.innerHTML = html;
    }).catch(() => {});
    refreshBadges();
  }

  function connect() {
    setStatus('reconnect');
    es = new EventSource('/api/events');
    es.onopen = () => setStatus('on');
    es.onerror = () => {
      setStatus('off');
      try { es.close(); } catch (_) {}
      // backoff 3s
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.hello) return; // 接続初期 ping
        refreshFragment();
      } catch (_) {}
    };
  }

  connect();
  // tab が visible に戻った時 force refresh
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFragment();
  });
})();
`;
}

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ステータスの日本語表示
const STATUS_JP: Record<string, string> = {
  // 仮説ライフサイクル (新)
  pending_review: "承認待ち",
  validated: "勝ち",
  falsified: "負け",
  abandoned: "取り下げ",
  // task/run 系 (新 schema)
  queued: "待機",
  running: "実行中",
  completed: "完了",
  failed: "失敗",
  timeout: "タイムアウト",
  budget_halted: "予算超過",
  skipped: "スキップ",
  cancelled: "キャンセル",
  // legacy agent_runs status
  success: "完了",
  error: "失敗",
  partial_fix: "部分修正",
  partial_pass: "部分合格",
  sendback: "差し戻し",
  bootstrap: "初期化",
  fixed: "修正済み",
  failure: "失敗",
  // approval/issue/hypothesis 系
  pending: "承認待ち",
  approved: "承認済み",
  applied: "適用済み",
  rejected: "却下",
  expired: "期限切れ",
  proposed: "提案中",
  selected: "選抜済み",
  awaiting_approval: "承認待ち",
  executing: "実行中",
  measuring: "計測中",
  inconclusive: "判定不能",
  aborted: "中止",
  reverted: "差し戻し",
  // issue
  todo: "未着手",
  in_progress: "進行中",
  in_review: "レビュー中",
  blocked: "ブロック",
  done: "完了",
  // generic
  active: "稼働中",
  disabled: "停止",
  draft: "下書き",
  deprecated: "廃止",
  resolved: "解決済み",
  dismissed: "却下",
  warning: "警告",
  halted: "停止",
};

const DEPT_JP: Record<string, string> = {
  subsidy: "補助金",
  benefit: "給付金",
  editorial: "記事編集",
  permit: "許認可",
  hypothesis: "仮説ライン",
  audit: "監査",
  backlink: "被リンク",
  "seo-metrics": "SEO計測",
  "content-refine": "コンテンツ改善",
  "keyword-research": "キーワード調査",
  outreach: "アライアンス",
  chat: "対話",
};

const ROLE_JP: Record<string, string> = {
  writer: "執筆",
  reviewer: "レビュー",
  publisher: "配信",
  orchestrator: "統括",
  validator: "検証",
  hypothesizer: "仮説生成",
  selector: "選抜",
  supervisor: "観測",
  executor: "改修実行",
  researcher: "調査",
  optimizer: "最適化",
  outreach: "開拓",
  auditor: "監査",
  solo: "単独",
};

export function jpStatus(s: string): string {
  return STATUS_JP[s] || s;
}
export function jpDept(s: string): string {
  return DEPT_JP[s] || s;
}
export function jpRole(s: string): string {
  return ROLE_JP[s] || s;
}

// status → 正規の CSS class 名 (legacy も全部このマップに乗せる)
const STATUS_CLASS: Record<string, string> = {
  // 仮説ライフサイクル (新)
  pending_review: "pending",
  abandoned: "skipped",
  // 完了系 (緑)
  success: "completed", completed: "completed", validated: "completed",
  approved: "completed", applied: "completed", fixed: "completed",
  done: "completed", resolved: "completed", active: "completed",
  selected: "completed",
  // 失敗系 (赤)
  error: "failed", failed: "failed", failure: "failed",
  timeout: "failed", falsified: "failed", reverted: "failed",
  // 警告系 (橙)
  partial_fix: "warning", partial_pass: "warning", sendback: "warning",
  warning: "warning", budget_halted: "budget_halted", halted: "budget_halted",
  // 却下/拒否 (濃赤)
  rejected: "rejected",
  // 保留系 (黄)
  pending: "pending", proposed: "pending", awaiting_approval: "pending",
  in_review: "pending",
  // 実行中 (青)
  running: "running", executing: "running", measuring: "running",
  in_progress: "in_progress",
  // 待機 (灰)
  queued: "queued", todo: "queued", draft: "queued",
  // スキップ/キャンセル (薄灰)
  cancelled: "skipped", skipped: "skipped", dismissed: "skipped",
  expired: "skipped", inconclusive: "skipped", aborted: "skipped",
  disabled: "skipped", deprecated: "skipped",
  // その他
  blocked: "blocked", bootstrap: "pending",
};

export function statusBadge(status: string): string {
  const cls = STATUS_CLASS[status] || "queued";
  return `<span class="badge ${cls}">${escapeHtml(jpStatus(status))}</span>`;
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function fmtCost(usd: number | null): string {
  if (usd == null) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function fmtInterval(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso.replace(" ", "T"));
  const diff = Date.now() - date.getTime();
  if (diff < 0) {
    const fwd = Math.abs(diff);
    if (fwd < 60_000) return `in ${Math.round(fwd / 1000)}s`;
    if (fwd < 3_600_000) return `in ${Math.round(fwd / 60_000)}m`;
    return `in ${Math.round(fwd / 3_600_000)}h`;
  }
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
