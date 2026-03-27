/**
 * Session browser API for the orager adapter.
 *
 * Exposes past orager agent sessions so Paperclip can list them, search them,
 * and resume a specific session via `forceResume`.
 *
 * When the daemon is running, sessions are fetched via the daemon's
 * /sessions endpoint (which may use an SQLite index for faster queries).
 * Otherwise, sessions are read directly from the filesystem.
 *
 * Usage from Paperclip:
 *   import { listOragerSessions, searchOragerSessions } from "./sessions.js";
 *   const { sessions, total } = await listOragerSessions({ daemonUrl, signingKey, agentId, limit, offset });
 */
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { mintDaemonJwt as mintJwt } from "./jwt-utils.js";
// mintJwt is imported from ./jwt-utils.js as mintDaemonJwt
// ── Filesystem fallback ───────────────────────────────────────────────────────
const SESSIONS_DIR = path.join(os.homedir(), ".orager", "sessions");
async function listSessionsFromFilesystem(limit, offset) {
    let entries;
    try {
        entries = await fs.readdir(SESSIONS_DIR);
    }
    catch {
        return { sessions: [], total: 0, limit, offset };
    }
    const sessionFiles = entries.filter((e) => e.endsWith(".json") && !e.endsWith(".run.lock"));
    const total = sessionFiles.length;
    // Fast-path: sort by file mtime descending (avoids reading all file contents)
    // then only parse the files we actually need for the requested page.
    const withMtimes = await Promise.all(sessionFiles.map(async (file) => {
        try {
            const stat = await fs.stat(path.join(SESSIONS_DIR, file));
            return { file, mtime: stat.mtimeMs };
        }
        catch {
            return { file, mtime: 0 };
        }
    }));
    withMtimes.sort((a, b) => b.mtime - a.mtime);
    // Only read files in the requested page window
    const pageFiles = withMtimes.slice(offset, offset + limit);
    const summaries = [];
    for (const { file } of pageFiles) {
        try {
            const raw = await fs.readFile(path.join(SESSIONS_DIR, file), "utf8");
            const data = JSON.parse(raw);
            if (!data.sessionId || data.trashed)
                continue;
            // Validate sessionId to prevent path traversal payloads stored in session files
            if (!/^[a-zA-Z0-9_-]+$/.test(data.sessionId))
                continue;
            summaries.push({
                sessionId: data.sessionId,
                model: data.model ?? "",
                createdAt: data.createdAt ?? "",
                updatedAt: data.updatedAt ?? "",
                turnCount: data.turnCount ?? 0,
                cwd: data.cwd ?? "",
                trashed: false,
            });
        }
        catch {
            // Skip malformed session files
        }
    }
    return { sessions: summaries, total, limit, offset };
}
async function searchSessionsFromFilesystem(query, limit) {
    let entries;
    try {
        entries = await fs.readdir(SESSIONS_DIR);
    }
    catch {
        return { sessions: [], total: 0, query };
    }
    const q = query.toLowerCase();
    const sessionFiles = entries.filter((e) => e.endsWith(".json") && !e.endsWith(".run.lock"));
    const matches = [];
    for (const file of sessionFiles) {
        try {
            const raw = await fs.readFile(path.join(SESSIONS_DIR, file), "utf8");
            const data = JSON.parse(raw);
            if (!data.sessionId || data.trashed)
                continue;
            if (!/^[a-zA-Z0-9_-]+$/.test(data.sessionId))
                continue;
            const s = {
                sessionId: data.sessionId,
                model: data.model ?? "",
                createdAt: data.createdAt ?? "",
                updatedAt: data.updatedAt ?? "",
                turnCount: data.turnCount ?? 0,
                cwd: data.cwd ?? "",
                trashed: false,
            };
            if (s.sessionId.toLowerCase().includes(q) ||
                s.cwd.toLowerCase().includes(q) ||
                s.model.toLowerCase().includes(q)) {
                matches.push(s);
            }
        }
        catch {
            // Skip malformed files
        }
    }
    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions: matches.slice(0, limit), total: matches.length, query };
}
// ── Daemon client ─────────────────────────────────────────────────────────────
async function fetchFromDaemon(daemonUrl, signingKey, agentId, endpoint) {
    try {
        const token = mintJwt(signingKey, agentId);
        const res = await fetch(`${daemonUrl}${endpoint}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok)
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * List all orager sessions, sorted by most-recently-updated first.
 *
 * Tries the daemon first (faster with SQLite backend) and falls back to
 * reading session JSON files directly from ~/.orager/sessions/.
 */
export async function listOragerSessions(opts = {}) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    if (opts.daemonUrl && opts.signingKey && opts.agentId) {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        const result = await fetchFromDaemon(opts.daemonUrl, opts.signingKey, opts.agentId, `/sessions?${params}`);
        if (result)
            return result;
    }
    return listSessionsFromFilesystem(limit, offset);
}
/**
 * Search orager sessions by text query.
 * With the SQLite backend and daemon running, uses FTS5 for full-text search.
 * Falls back to simple substring matching on sessionId, cwd, and model.
 */
export async function searchOragerSessions(query, opts = {}) {
    const limit = Math.min(opts.limit ?? 20, 100);
    if (opts.daemonUrl && opts.signingKey && opts.agentId) {
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        const result = await fetchFromDaemon(opts.daemonUrl, opts.signingKey, opts.agentId, `/sessions/search?${params}`);
        if (result)
            return result;
    }
    return searchSessionsFromFilesystem(query, limit);
}
/**
 * Get a single session summary by session ID.
 * Returns null if the session does not exist.
 */
export async function getOragerSession(sessionId, opts = {}) {
    if (opts.daemonUrl && opts.signingKey && opts.agentId) {
        const result = await fetchFromDaemon(opts.daemonUrl, opts.signingKey, opts.agentId, `/sessions/${encodeURIComponent(sessionId)}`);
        if (result)
            return result;
    }
    // Filesystem fallback
    try {
        // Validate sessionId to prevent path traversal (e.g. "../../etc/passwd")
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
            return null;
        const raw = await fs.readFile(path.join(SESSIONS_DIR, `${sessionId}.json`), "utf8");
        const data = JSON.parse(raw);
        if (!data.sessionId || data.trashed)
            return null;
        return {
            sessionId: data.sessionId,
            model: data.model ?? "",
            createdAt: data.createdAt ?? "",
            updatedAt: data.updatedAt ?? "",
            turnCount: data.turnCount ?? 0,
            cwd: data.cwd ?? "",
            trashed: false,
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=sessions.js.map