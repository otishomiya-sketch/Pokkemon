/**
 * POST /api/approve  /  POST /api/reject
 * approve は entity_type に応じて apply 実行 (budget_increase / agent_revision / manual)
 * reject は status='rejected' にするだけ
 */

import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const REVIEWER = "human:tom";

export async function renderApprovalActions(
  db: Database,
  pathname: string,
  formData: FormData,
): Promise<Response> {
  const idStr = formData.get("id");
  if (typeof idStr !== "string") {
    return badRequest("missing id");
  }
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) {
    return badRequest("invalid id");
  }

  let result: { ok: boolean; error?: string };
  if (pathname === "/api/approve") {
    result = approveAndApply(db, id);
  } else if (pathname === "/api/reject") {
    result = reject(db, id);
  } else {
    return new Response("Not Found", { status: 404 });
  }

  const action = pathname === "/api/approve" ? "approved" : "rejected";
  const flash = result.ok
    ? `ok:${id}:${action}`
    : `err:${id}:${result.error || "unknown"}`;
  const target = `/improvements?flash=${encodeURIComponent(flash)}`;
  return new Response(null, {
    status: 303,
    headers: { Location: target },
  });
}

function approveAndApply(db: Database, approvalId: number): { ok: boolean; error?: string } {
  const approval = db
    .query<
      {
        id: number;
        entity_type: string;
        entity_id: number;
        diff_text: string | null;
        body: string | null;
      },
      [number]
    >(`SELECT id, entity_type, entity_id, diff_text, body FROM approvals WHERE id=? AND status='pending'`)
    .get(approvalId);

  if (!approval) return { ok: false, error: "approval not found or already processed" };

  try {
    const REPO_ROOT = process.cwd();

    if (approval.entity_type === "budget_increase") {
      const parsed = JSON.parse(approval.body || "{}") as { period?: string; new_budget_cents?: number };
      if (!parsed.period || !parsed.new_budget_cents) {
        return { ok: false, error: "budget_increase body must contain period + new_budget_cents" };
      }
      db.run(
        `UPDATE agent_budgets SET budget_cents=?, status='active', halted_at=NULL, updated_at=datetime('now','localtime') WHERE agent_id=? AND period=?`,
        [parsed.new_budget_cents, approval.entity_id, parsed.period],
      );
    } else if (approval.entity_type === "agent_revision") {
      const agent = db
        .query<
          { id: number; slug: string; source_md_path: string; instructions: string; version: number },
          [number]
        >(`SELECT id, slug, source_md_path, instructions, version FROM agents WHERE id=?`)
        .get(approval.entity_id);
      if (!agent) return { ok: false, error: "target agent not found" };

      let newInstructions: string | null = null;
      try {
        const parsed = JSON.parse(approval.body || "{}") as { new_instructions?: string };
        if (parsed.new_instructions) newInstructions = parsed.new_instructions;
      } catch {
        if (approval.body) newInstructions = approval.body;
      }
      if (!newInstructions) return { ok: false, error: "agent_revision: body must contain new_instructions" };

      const newHash = createHash("sha256").update(newInstructions).digest("hex");
      const mdFullPath = join(REPO_ROOT, agent.source_md_path);
      const prevContent = readFileSync(mdFullPath, "utf-8");
      writeFileSync(mdFullPath, newInstructions);
      db.run(
        `UPDATE agents SET instructions=?, instructions_hash=?, version=version+1, updated_at=datetime('now','localtime') WHERE id=?`,
        [newInstructions, newHash, agent.id],
      );
      db.run(
        `INSERT INTO agent_revisions (agent_id, version, prev_instructions, new_instructions, diff, changed_by, reason, derived_from_approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          agent.id,
          agent.version + 1,
          prevContent,
          newInstructions,
          approval.diff_text,
          REVIEWER,
          `approval #${approval.id}`,
          approval.id,
        ],
      );
    } else if (approval.entity_type === "manual") {
      // 副作用なし
    } else if (approval.entity_type === "control_apply" || approval.entity_type === "pilot_promotion") {
      // approve 記録のみ、apply は別途
    } else {
      return { ok: false, error: `unknown entity_type: ${approval.entity_type}` };
    }

    db.run(
      `UPDATE approvals SET status='applied', reviewed_by=?, reviewed_at=datetime('now','localtime'),
         applied_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`,
      [REVIEWER, approvalId],
    );

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function reject(db: Database, approvalId: number): { ok: boolean; error?: string } {
  const result = db.run(
    `UPDATE approvals SET status='rejected', reviewed_by=?, reviewed_at=datetime('now','localtime'),
       rejection_reason='rejected by reviewer', updated_at=datetime('now','localtime')
     WHERE id=? AND status='pending'`,
    [REVIEWER, approvalId],
  );
  if (result.changes === 0) return { ok: false, error: "approval not found or already processed" };
  return { ok: true };
}

function badRequest(msg: string): Response {
  return new Response(msg, { status: 400 });
}

