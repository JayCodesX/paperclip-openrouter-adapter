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
    /** Base URL of the running orager daemon (e.g. http://127.0.0.1:PORT). */
    daemonUrl?: string;
    /** Daemon JWT signing key (from ~/.orager/daemon.key). */
    signingKey?: string;
    /** Agent ID for JWT claims. */
    agentId?: string;
    /** Maximum number of sessions to return (default 50, max 200). */
    limit?: number;
    /** Offset for pagination (default 0). */
    offset?: number;
}
/**
 * List all orager sessions, sorted by most-recently-updated first.
 *
 * Tries the daemon first (faster with SQLite backend) and falls back to
 * reading session JSON files directly from ~/.orager/sessions/.
 */
export declare function listOragerSessions(opts?: SessionBrowserOptions): Promise<ListSessionsResult>;
/**
 * Search orager sessions by text query.
 * With the SQLite backend and daemon running, uses FTS5 for full-text search.
 * Falls back to simple substring matching on sessionId, cwd, and model.
 */
export declare function searchOragerSessions(query: string, opts?: SessionBrowserOptions): Promise<SearchSessionsResult>;
/**
 * Get a single session summary by session ID.
 * Returns null if the session does not exist.
 */
export declare function getOragerSession(sessionId: string, opts?: Pick<SessionBrowserOptions, "daemonUrl" | "signingKey" | "agentId">): Promise<SessionSummary | null>;
//# sourceMappingURL=sessions.d.ts.map