import type { Database } from "bun:sqlite";
import { renderEvents } from "./events";
import { renderReflections } from "./reflections";

type View = "events" | "reflections";

export function renderLogs(db: Database, params: URLSearchParams): string {
  const raw = params.get("view") || "reflections";
  const view: View = raw === "events" ? "events" : "reflections";

  const title = view === "events" ? "行動ログ" : "リフレクション";
  const kicker = view === "events" ? "Activity Log" : "Reflections";
  const pageTitle = `<div class="page-header">
    <div>
      <div class="page-kicker">${kicker}</div>
      <h1>${title}</h1>
    </div>
  </div>`;

  let body = "";
  if (view === "events") body = stripPageHeader(renderEvents(db, params));
  else body = renderReflections(db, params);

  return pageTitle + body;
}

function stripPageHeader(html: string): string {
  const startIdx = html.indexOf('<div class="page-header">');
  if (startIdx === -1) return html;
  let depth = 0;
  let i = startIdx;
  while (i < html.length) {
    if (html.startsWith("<div", i)) {
      depth++;
      i += 4;
    } else if (html.startsWith("</div>", i)) {
      depth--;
      i += 6;
      if (depth === 0) return html.slice(0, startIdx) + html.slice(i);
    } else {
      i++;
    }
  }
  return html;
}
