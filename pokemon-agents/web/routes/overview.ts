import type { Database } from "bun:sqlite";
import { escapeHtml, timeAgo } from "../components/layout";
import { q1 } from "../lib/db-helpers";

/**
 * Top page = バーチャルオフィス (島マップ版)
 *
 * - 見出しの下に島マップエリア
 * - エージェントが島の各エリアに配置される (部署で集まってる)
 * - 各キャラの上に最新の reflection の吹き出しが常時表示
 * - SSE 経由で新着が来たら該当キャラの吹き出しが差し替わる
 */

interface MemberRow {
  slug: string;
  pokemon_jp: string;
  avatar_url: string | null;
  role_label: string | null;
  department: string;
  department_label: string | null;
  refl_id: number | null;
  refl_status: string | null;
  refl_what_done: string | null;
  refl_result_summary: string | null;
  refl_error_message: string | null;
  refl_created_at: string | null;
}

export interface Post {
  id: number;
  agent_slug: string;
  pokemon_jp: string | null;
  avatar_url: string | null;
  role_label: string | null;
  status: string;
  what_done: string | null;
  result_summary: string | null;
  error_message: string | null;
  created_at: string;
}

const COMPLETE_INTROS = [
  "やってきたよー！",
  "おっす、終わった！",
  "報告します！",
  "見て見てー！",
  "おしごと完了！",
  "できたよ！",
];
const FAIL_INTROS = ["やばい、失敗しちゃった…", "ごめん、コケた。"];
const RUNNING_INTROS = ["今がんばってる！", "作業中…"];

function pickIntro(status: string, id: number): string {
  const arr = status === "running"
    ? RUNNING_INTROS
    : status === "failed" || status === "timeout" || status === "error"
      ? FAIL_INTROS
      : COMPLETE_INTROS;
  return arr[id % arr.length];
}

function statusKey(status: string | null): string {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "timeout" || status === "error") return "failed";
  if (status === "running") return "running";
  return "queued";
}

function shortenContent(text: string): string {
  const cleaned = text.replace(/\r/g, "").trim();
  const firstLine = cleaned.split("\n").find((l) => l.trim().length > 0) || cleaned;
  const stripped = firstLine.replace(/^[-・*•▶●]\s*/, "").trim();
  return stripped.length > 50 ? stripped.slice(0, 50) + "…" : stripped;
}

/**
 * 各エージェントの島内ポジション (left%, top%) — 画像に合わせて部署ごとに配置
 * 部署近接 + 個性的な場所 (火山・雪山・森・海・街・砂漠) に分配
 */
const POSITIONS: Record<string, { left: number; top: number }> = {
  // 仮説ライン — 火山 (左下)、不気味な雰囲気
  "haunter-hypothesizer":     { left: 12, top: 56 },
  "gengar-selector":          { left: 18, top: 64 },
  "gastly-validator":         { left: 8,  top: 68 },
  "megagengar-orchestrator":  { left: 16, top: 76 },

  // 補助金 — 右上の街 (production)
  "butterfree-subsidy-sync":  { left: 80, top: 14 },
  "caterpie-subsidy-writer":  { left: 86, top: 20 },
  "metapod-subsidy-reviewer": { left: 76, top: 22 },
  "scizor-guide-writer":      { left: 84, top: 28 },

  // 給付金 — 中央右の湖+遺跡
  "magnemite-benefit-writer":          { left: 60, top: 36 },
  "magneton-kyufukin":                 { left: 67, top: 38 },
  "magnezone-benefit-orchestrator":    { left: 64, top: 44 },

  // 記事編集 — 左上の森
  "pidgey-editorial-writer":           { left: 28, top: 18 },
  "pidgeotto-editorial-reviewer":      { left: 36, top: 22 },
  "pidgeot-editorial":                 { left: 32, top: 14 },

  // SEO計測 — 雪山山頂
  "abra-seo-report":     { left: 50, top: 10 },
  "kadabra-rank-monitor":{ left: 56, top: 16 },

  // 監査 — 高い山の上 (神殿っぽいエリア)
  "mew-supervisor":    { left: 44, top: 30 },
  "mewtwo-executor":   { left: 50, top: 32 },

  // 被リンク — 海岸 (beach)
  "vulpix-note-publisher":      { left: 30, top: 78 },
  "shuckle-hatena-publisher":   { left: 22, top: 84 },

  // アライアンス — 北西の小島
  "starmie-expert-outreach":    { left: 6,  top: 30 },

  // キーワード調査 — 中央の砂漠
  "porygon-keyword-research":   { left: 44, top: 70 },

  // ドメイン知識 — 中央の古代遺跡
  "arceus-knowledge-editor":    { left: 52, top: 50 },

  // 対話 — 街の入口
  "delibird-chat":              { left: 70, top: 70 },

  // 許認可 — 右下の島
  "pinsir-permit-writer":       { left: 86, top: 64 },
};

export function fetchReflectionsSince(db: Database, sinceId: number, limit: number): Post[] {
  return db
    .query<Post, []>(
      `SELECT r.id, r.agent_slug, a.pokemon_jp, a.avatar_url, a.role_label,
              r.status, r.what_done, r.result_summary, r.error_message, r.created_at
       FROM reflections r
       LEFT JOIN agents a ON a.slug = r.agent_slug OR a.pokemon_slug = r.agent_slug
       WHERE r.id > ${sinceId}
         AND (r.what_done IS NOT NULL OR r.result_summary IS NOT NULL OR r.error_message IS NOT NULL)
       ORDER BY r.id DESC LIMIT ${limit}`,
    )
    .all();
}

export function renderReflectionPost(p: Post): string {
  const intro = pickIntro(p.status, p.id);
  const rawText = p.what_done || p.result_summary || p.error_message || "";
  const text = shortenContent(rawText);
  const sk = statusKey(p.status);
  return JSON.stringify({
    id: p.id,
    slug: p.agent_slug,
    intro,
    text,
    status: sk,
    time_ago: timeAgo(p.created_at),
  });
}

export function renderOverview(db: Database): string {
  const members = db
    .query<MemberRow, []>(
      `SELECT a.slug, a.pokemon_jp, a.avatar_url, a.role_label,
              a.department, a.department_label,
              r.id as refl_id, r.status as refl_status,
              r.what_done as refl_what_done,
              r.result_summary as refl_result_summary,
              r.error_message as refl_error_message,
              r.created_at as refl_created_at
       FROM agents a
       LEFT JOIN (
         SELECT r1.* FROM reflections r1
         INNER JOIN (
           SELECT agent_slug, MAX(id) as mid
           FROM reflections
           WHERE what_done IS NOT NULL OR result_summary IS NOT NULL OR error_message IS NOT NULL
           GROUP BY agent_slug
         ) r2 ON r1.id = r2.mid
       ) r ON r.agent_slug = a.slug OR r.agent_slug = a.pokemon_slug
       ORDER BY a.slug`,
    )
    .all();

  const lastId = q1(db, `SELECT COALESCE(MAX(id),0) FROM reflections`);

  return `
<div class="page-header">
  <div>
    <div class="page-kicker">Live Office</div>
    <h1>みんなのオフィス</h1>
  </div>
  <div class="watching-pill" id="watching-indicator">
    <span class="watching-dot"></span>
    <span id="watching-text">見守り中</span>
  </div>
</div>

<div class="office-map" data-last-id="${lastId}">
  <div class="office-map-inner" id="office-map-inner">
    <img class="office-map-bg" src="/bg/dashboard-bg.png" alt="">
    <div class="office-map-overlay"></div>
    ${members.map(renderCharacter).join("")}
  </div>
  <div class="office-map-hint">ドラッグでマップを動かせるよ</div>
</div>

${OFFICE_STYLES}

<script>
(() => {
  const map = document.querySelector('.office-map');
  if (!map) return;
  const liveText = document.getElementById('watching-text');
  let lastId = Number(map.dataset.lastId || 0);

  function flash() {
    if (!liveText) return;
    liveText.textContent = '更新';
    setTimeout(() => { liveText.textContent = '見守り中'; }, 1400);
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function updateChar(payload) {
    const ch = document.querySelector('.office-character[data-slug="' + payload.slug + '"]');
    if (!ch) return;
    const bubble = ch.querySelector('.character-bubble');
    if (!bubble) return;
    bubble.classList.remove('completed', 'failed', 'running', 'queued', 'empty');
    bubble.classList.add(payload.status || 'queued');
    bubble.innerHTML =
      '<div class="bubble-intro">「' + escHtml(payload.intro) + '」</div>' +
      '<div class="bubble-text">' + escHtml(payload.text) + '</div>' +
      '<div class="bubble-time">' + escHtml(payload.time_ago) + '</div>';
    ch.classList.add('just-updated');
    setTimeout(() => ch.classList.remove('just-updated'), 2000);
  }

  async function fetchNew() {
    try {
      const r = await fetch('/api/reflections-since?since=' + lastId);
      if (!r.ok) return;
      const data = await r.json();
      const rows = data.rows || [];
      if (rows.length === 0) return;
      const reversed = [...rows].reverse();
      for (const row of reversed) {
        try { updateChar(JSON.parse(row.html)); } catch (_) {}
      }
      lastId = Math.max(lastId, ...rows.map(r => r.id));
      map.dataset.lastId = String(lastId);
      flash();
    } catch (e) {}
  }

  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try { const m = JSON.parse(ev.data); if (m.hello) return; fetchNew(); } catch (_) {}
  };
  es.onerror = () => { if (liveText) liveText.textContent = '再接続中…'; };
  es.onopen = () => { if (liveText) liveText.textContent = '見守り中'; };
  setInterval(fetchNew, 15000);

  // ===== Drag-to-pan =====
  const inner = document.getElementById('office-map-inner');
  if (!inner) return;
  const ASPECT = 1600 / 1067;   // 島画像のアスペクト比
  let tx = 0, ty = 0;
  let startX = 0, startY = 0;
  let startTx = 0, startTy = 0;
  let dragging = false;

  // 画像 inner サイズを viewport に合わせて scale (常に viewport を覆う)
  function fitInner() {
    const mapW = map.offsetWidth;
    const mapH = map.offsetHeight;
    const baseW = 1600;
    const baseH = 1067;
    let w = baseW, h = baseH;
    // viewport の方が大きい場合は inner を拡大
    if (mapW > w) { w = mapW; h = w / ASPECT; }
    if (mapH > h) { h = mapH; w = h * ASPECT; }
    // 一辺が拡大されたらもう一辺も連動 (cover 風)
    if (w < mapW) { w = mapW; h = w / ASPECT; }
    if (h < mapH) { h = mapH; w = h * ASPECT; }
    inner.style.width  = w + 'px';
    inner.style.height = h + 'px';
  }

  function getBounds() {
    const innerW = inner.offsetWidth;
    const innerH = inner.offsetHeight;
    const mapW = map.offsetWidth;
    const mapH = map.offsetHeight;
    return {
      minX: Math.min(0, mapW - innerW),
      minY: Math.min(0, mapH - innerH),
      maxX: 0,
      maxY: 0,
    };
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function applyTransform() {
    inner.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
  }
  function center() {
    fitInner();
    const b = getBounds();
    tx = clamp((map.offsetWidth - inner.offsetWidth) / 2, b.minX, b.maxX);
    ty = clamp((map.offsetHeight - inner.offsetHeight) / 2, b.minY, b.maxY);
    applyTransform();
  }

  function onDown(e) {
    dragging = true;
    map.classList.add('dragging');
    const p = e.touches ? e.touches[0] : e;
    startX = p.clientX; startY = p.clientY;
    startTx = tx; startTy = ty;
    if (e.cancelable) e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    const b = getBounds();
    tx = clamp(startTx + p.clientX - startX, b.minX, b.maxX);
    ty = clamp(startTy + p.clientY - startY, b.minY, b.maxY);
    applyTransform();
    if (e.cancelable) e.preventDefault();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    map.classList.remove('dragging');
  }

  // 初期位置: 中央寄せ (画像読み込み後)
  if (inner.querySelector('img')?.complete) center();
  else inner.querySelector('img')?.addEventListener('load', center);
  window.addEventListener('resize', () => {
    fitInner();
    const b = getBounds();
    tx = clamp(tx, b.minX, b.maxX);
    ty = clamp(ty, b.minY, b.maxY);
    applyTransform();
  });

  map.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  map.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
})();
</script>
`;
}

function renderCharacter(m: MemberRow): string {
  const pos = POSITIONS[m.slug] || { left: 50, top: 50 };
  const sk = statusKey(m.refl_status);
  const hasActivity = m.refl_id != null;
  const intro = hasActivity && m.refl_status ? pickIntro(m.refl_status, m.refl_id!) : "";
  const rawText = m.refl_what_done || m.refl_result_summary || m.refl_error_message || "";
  const text = rawText ? shortenContent(rawText) : "";
  const timeStr = m.refl_created_at ? timeAgo(m.refl_created_at) : "";

  return `<div class="office-character" data-slug="${escapeHtml(m.slug)}"
    style="left:${pos.left}%; top:${pos.top}%;">
    <div class="character-bubble ${hasActivity ? sk : "empty"}">
      ${
        hasActivity
          ? `<div class="bubble-intro">「${escapeHtml(intro)}」</div>
             <div class="bubble-text">${escapeHtml(text)}</div>
             <div class="bubble-time">${escapeHtml(timeStr)}</div>`
          : `<div class="bubble-empty">アイドル中</div>`
      }
    </div>
    <div class="character-figure">
      ${
        m.avatar_url
          ? `<img class="character-avatar" src="${escapeHtml(m.avatar_url)}" alt="${escapeHtml(m.pokemon_jp)}">`
          : `<span class="character-avatar placeholder"></span>`
      }
      <div class="character-name">${escapeHtml(m.pokemon_jp)}</div>
    </div>
  </div>`;
}

const OFFICE_STYLES = `<style>
.watching-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 14px;
  background: #fff;
  border-radius: 999px;
  box-shadow: var(--shadow-card);
  font-size: 12px;
  font-weight: 700;
  color: #475569;
}
.watching-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 0 4px rgba(16,185,129,0.18);
  animation: watching-pulse 1.8s ease-in-out infinite;
}
@keyframes watching-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(16,185,129,0.18); }
  50% { box-shadow: 0 0 0 8px rgba(16,185,129,0); }
}

/* このページだけ .main + 内側 #live-content をフレックス化して map に残り高さを渡す */
.main:has(.office-map) {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 40px);
  padding-bottom: 0;
  overflow: hidden;
}
.main:has(.office-map) > #live-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.main:has(.office-map) .page-header { flex-shrink: 0; }

/* マップエリア — サイドバー下端まで延ばして、内部ドラッグでパン */
.office-map {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
  border-radius: var(--r-md);
  overflow: hidden;
  box-shadow: var(--shadow-card);
  background: #cfeaff;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  margin-bottom: 0;
}
.office-map.dragging { cursor: grabbing; }

/* 内側のスクロール可能 inner — 大きめサイズで、translate で動かす */
.office-map-inner {
  position: absolute;
  top: 0; left: 0;
  width: 1600px;
  height: 1067px;
  will-change: transform;
  transform-origin: 0 0;
}
.office-map-bg {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.office-map-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(244,247,254,0) 0%, rgba(244,247,254,0.10) 100%);
  pointer-events: none;
}

/* 操作ヒント (右下) */
.office-map-hint {
  position: absolute;
  right: 12px; bottom: 12px;
  background: rgba(15,23,42,0.78);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  padding: 5px 12px;
  border-radius: 999px;
  pointer-events: none;
  z-index: 100;
  letter-spacing: 0.02em;
  opacity: 0.7;
  transition: opacity 0.3s ease;
}
.office-map.dragging .office-map-hint { opacity: 0; }

/* キャラクター = avatar + 名前 + 吹き出し */
.office-character {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  z-index: 5;
  transition: z-index 0s;
}
.office-character:hover { z-index: 20; }
.office-character.just-updated .character-figure {
  animation: char-bounce 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes char-bounce {
  0%   { transform: translateY(0); }
  40%  { transform: translateY(-10px); }
  70%  { transform: translateY(2px); }
  100% { transform: translateY(0); }
}

.character-figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  filter: drop-shadow(0 4px 8px rgba(15,23,42,0.25));
  transition: transform 0.25s cubic-bezier(0.34, 1.6, 0.64, 1);
  cursor: pointer;
}
.office-character:hover .character-figure { transform: scale(1.1); }

.character-avatar {
  width: 52px; height: 52px;
  border-radius: 14px;
  background: rgba(255,255,255,0.9);
  object-fit: cover;
  display: block;
  box-shadow: 0 0 0 3px rgba(255,255,255,0.85);
}
.character-avatar.placeholder { display: block; }
.character-name {
  margin-top: 4px;
  padding: 1px 8px;
  background: rgba(15,23,42,0.78);
  color: #fff;
  font-size: 10.5px;
  font-weight: 800;
  border-radius: 999px;
  white-space: nowrap;
  letter-spacing: 0.01em;
}

/* 吹き出しは avatar の上 */
.character-bubble {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: 200px;
  padding: 8px 12px 10px;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 4px 12px rgba(15,23,42,0.18);
  font-size: 11px;
  line-height: 1.5;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.4s ease, transform 0.4s ease;
  transform: translateX(-50%) translateY(4px);
}
/* 活動済み → 吹き出し常時表示。empty → hover のみ */
.office-character .character-bubble.completed,
.office-character .character-bubble.failed,
.office-character .character-bubble.running {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.office-character:hover .character-bubble {
  opacity: 1 !important;
  transform: translateX(-50%) translateY(0) !important;
  z-index: 30;
}

.character-bubble::after {
  content: "";
  position: absolute;
  top: 100%; left: 50%; margin-left: -6px;
  border-top: 7px solid #ffffff;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
}
.character-bubble.completed { background: #f0fdf4; box-shadow: 0 4px 12px rgba(16,185,129,0.25); }
.character-bubble.completed::after { border-top-color: #f0fdf4; }
.character-bubble.failed { background: #fef2f2; box-shadow: 0 4px 12px rgba(239,68,68,0.25); }
.character-bubble.failed::after { border-top-color: #fef2f2; }
.character-bubble.running { background: #eff6ff; box-shadow: 0 4px 12px rgba(59,130,246,0.25); }
.character-bubble.running::after { border-top-color: #eff6ff; }

.bubble-intro {
  font-size: 11.5px;
  font-weight: 800;
  color: #0f172a;
  margin-bottom: 2px;
  letter-spacing: -0.005em;
}
.character-bubble.failed .bubble-intro { color: #b91c1c; }
.bubble-text {
  font-size: 10.5px;
  color: #334155;
  font-weight: 500;
  line-height: 1.4;
}
.bubble-time {
  font-size: 9.5px;
  color: #94a3b8;
  font-weight: 700;
  margin-top: 4px;
  text-align: right;
}
.bubble-empty {
  font-size: 10.5px;
  color: #94a3b8;
  font-weight: 600;
  font-style: italic;
}
</style>`;

