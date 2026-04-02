/**
 * Session browser API for the orager adapter.
 *
 * Exposes past orager agent sessions so Paperclip can list them, search them,
 * and resume a specific session via `forceResume`.
 *
 * Sessions are read directly from the filesystem (~/.orager/sessions/).
 *
 * Usage from Paperclip:
 *   import { listOragerSessions, searchOragerSessions } from "./sessions.js";
 *   const { sessions, total } = await listOragerSessions({ limit, offset });
 */

import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  cwd: string;
  trashed: boolean;
}

export interface ListSessionsResult {
  sessions: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface SearchSessionsResult {
  sessions: SessionSummary[];
  total: number;
  query: string;
}

export interface SessionBrowserOptions {
  /** Maximum number of sessions to return (default 50, max 200). */
  limit?: number;
  /** Offset for pagination (default 0). */
  offset?: number;
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

// Re-evaluated on each use so that ORAGER_SESSIONS_DIR set after module import
// (e.g. in tests or CI) is respected — mirrors orager's getSessionsDir().
function getSessionsDir(): string {
  return process.env["ORAGER_SESSIONS_DIR"] ?? path.join(os.homedir(), ".orager", "sessions");
}

async function listSessionsFromFilesystem(limit: number, offset: number): Promise<ListSessionsResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(getSessionsDir());
  } catch (err) {
    // L-10: Log non-ENOENT errors so operators can diagnose session listing failures.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(`[openrouter adapter] sessions: readdir failed: ${code ?? err}\n`);
    }
    return { sessions: [], total: 0, limit, offset };
  }

  const sessionFiles = entries.filter((e) => e.endsWith(".json") && !e.endsWith(".run.lock"));
  const total = sessionFiles.length;

  // Fast-path: sort by file mtime descending (avoids reading all file contents)
  // then only parse the files we actually need for the requested page.
  const withMtimes = await Promise.all(
    sessionFiles.map(async (file) => {
      try {
        const stat = await fs.stat(path.join(getSessionsDir(), file));
        return { file, mtime: stat.mtimeMs };
      } catch {
        return { file, mtime: 0 };
      }
    }),
  );
  withMtimes.sort((a, b) => b.mtime - a.mtime);

  // Only read files in the requested page window
  const pageFiles = withMtimes.slice(offset, offset + limit);
  const summaries: SessionSummary[] = [];

  for (const { file } of pageFiles) {
    try {
      const raw = await fs.readFile(path.join(getSessionsDir(), file), "utf8");
      const data = JSON.parse(raw) as {
        sessionId?: string;
        model?: string;
        createdAt?: string;
        updatedAt?: string;
        turnCount?: number;
        cwd?: string;
        trashed?: boolean;
      };
      if (!data.sessionId || data.trashed) continue;
      // Validate sessionId to prevent path traversal payloads stored in session files
      if (!/^[a-zA-Z0-9_-]+$/.test(data.sessionId)) continue;
      summaries.push({
        sessionId: data.sessionId,
        model: data.model ?? "",
        createdAt: data.createdAt ?? "",
        updatedAt: data.updatedAt ?? "",
        turnCount: data.turnCount ?? 0,
        cwd: data.cwd ?? "",
        trashed: false,
      });
    } catch {
      // Skip malformed session files
    }
  }

  return { sessions: summaries, total, limit, offset };
}

async function searchSessionsFromFilesystem(query: string, limit: number): Promise<SearchSessionsResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(getSessionsDir());
  } catch (err) {
    // L-10: Log non-ENOENT errors so operators can diagnose session search failures.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(`[openrouter adapter] sessions: readdir failed: ${code ?? err}\n`);
    }
    return { sessions: [], total: 0, query };
  }

  const q = query.toLowerCase();
  const sessionFiles = entries.filter((e) => e.endsWith(".json") && !e.endsWith(".run.lock"));
  const matches: SessionSummary[] = [];

  for (const file of sessionFiles) {
    try {
      const raw = await fs.readFile(path.join(getSessionsDir(), file), "utf8");
      const data = JSON.parse(raw) as {
        sessionId?: string;
        model?: string;
        createdAt?: string;
        updatedAt?: string;
        turnCount?: number;
        cwd?: string;
        trashed?: boolean;
      };
      if (!data.sessionId || data.trashed) continue;
      if (!/^[a-zA-Z0-9_-]+$/.test(data.sessionId)) continue;
      const s: SessionSummary = {
        sessionId: data.sessionId,
        model: data.model ?? "",
        createdAt: data.createdAt ?? "",
        updatedAt: data.updatedAt ?? "",
        turnCount: data.turnCount ?? 0,
        cwd: data.cwd ?? "",
        trashed: false,
      };
      if (
        s.sessionId.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.model.toLowerCase().includes(q)
      ) {
        matches.push(s);
      }
    } catch {
      // Skip malformed files
    }
  }

  matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { sessions: matches.slice(0, limit), total: matches.length, query };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List all orager sessions, sorted by most-recently-updated first.
 *
 * Reads session JSON files directly from ~/.orager/sessions/.
 */
export async function listOragerSessions(opts: SessionBrowserOptions = {}): Promise<ListSessionsResult> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  return listSessionsFromFilesystem(limit, offset);
}

/**
 * Search orager sessions by text query.
 * Uses simple substring matching on sessionId, cwd, and model.
 */
export async function searchOragerSessions(
  query: string,
  opts: SessionBrowserOptions = {},
): Promise<SearchSessionsResult> {
  const limit = Math.min(opts.limit ?? 20, 100);
  return searchSessionsFromFilesystem(query, limit);
}

/**
 * Get a single session summary by session ID.
 * Returns null if the session does not exist.
 */
export async function getOragerSession(
  sessionId: string,
): Promise<SessionSummary | null> {
  try {
    // Validate sessionId to prevent path traversal (e.g. "../../etc/passwd")
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    const raw = await fs.readFile(path.join(getSessionsDir(), `${sessionId}.json`), "utf8");
    const data = JSON.parse(raw) as {
      sessionId?: string;
      model?: string;
      createdAt?: string;
      updatedAt?: string;
      turnCount?: number;
      cwd?: string;
      trashed?: boolean;
    };
    if (!data.sessionId || data.trashed) return null;
    return {
      sessionId: data.sessionId,
      model: data.model ?? "",
      createdAt: data.createdAt ?? "",
      updatedAt: data.updatedAt ?? "",
      turnCount: data.turnCount ?? 0,
      cwd: data.cwd ?? "",
      trashed: false,
    };
  } catch {
    return null;
  }
}
