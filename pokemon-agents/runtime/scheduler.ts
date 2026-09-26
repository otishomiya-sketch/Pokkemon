#!/usr/bin/env bun
/**
 * Standalone scheduler entry (heartbeat だけ動かしたい時用)
 *
 * 通常は web/server.ts 経由で起動 (HTTP + scheduler 同居)。
 * scheduler 単独運転したい場合のみこちらを使う。
 *
 * 起動: bun pokemon-agents/runtime/scheduler.ts
 */

import { Database } from "bun:sqlite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { startScheduler } from "./scheduler-loop";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DB_PATH = resolve(REPO_ROOT, ".claude/db/agents.db");

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

console.log(`[scheduler-standalone] db=${DB_PATH}`);
startScheduler({ db, repoRoot: REPO_ROOT });
