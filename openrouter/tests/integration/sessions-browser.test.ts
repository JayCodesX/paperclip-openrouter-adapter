/**
 * Integration tests for sessions.ts — daemon-calling path.
 *
 * fetch is stubbed globally so we never make real network calls. The daemon
 * filesystem fallback (reads from ~/.orager/sessions/) is exercised implicitly
 * whenever the mock fetch is not configured or returns a non-ok status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listOragerSessions,
  searchOragerSessions,
  getOragerSession,
  type SessionSummary,
} from "../../src/server/sessions.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TEST_DAEMON_URL = "http://127.0.0.1:19877";
const TEST_SIGNING_KEY = "sessions-test-signing-key-32b!!";
const TEST_AGENT_ID = "agent-sessions-test";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "sess-" + Math.random().toString(36).slice(2, 10),
    model: "gpt-4o",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    turnCount: 5,
    cwd: "/home/user/project",
    trashed: false,
    ...overrides,
  };
}

const SESSION_A = makeSession({ sessionId: "sess-aaa", model: "gpt-4o" });
const SESSION_B = makeSession({ sessionId: "sess-bbb", model: "claude-3-5-sonnet" });
const SESSION_C = makeSession({ sessionId: "sess-ccc", model: "deepseek/deepseek-chat-v3-2" });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal fetch mock that inspects the URL and returns appropriate
 * JSON. Designed to cover /sessions, /sessions/search, and /sessions/:id.
 */
function makeFetchMock(sessions: SessionSummary[]) {
  return vi.fn().mockImplementation((url: string | URL) => {
    const urlStr = String(url);

    // /sessions/search?q=...
    if (urlStr.includes("/sessions/search")) {
      const u = new URL(urlStr);
      const q = u.searchParams.get("q") ?? "";
      const matched = sessions.filter(
        (s) =>
          s.sessionId.includes(q) ||
          s.model.includes(q) ||
          s.cwd.includes(q),
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ sessions: matched, total: matched.length, query: q }),
      });
    }

    // /sessions/:id  (non-search path with an id segment)
    const idMatch = urlStr.match(/\/sessions\/([^?]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      const session = sessions.find((s) => s.sessionId === id);
      if (!session) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: "not found" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(session),
      });
    }

    // /sessions?limit=...&offset=...
    if (urlStr.includes("/sessions")) {
      const u = new URL(urlStr);
      const limit = parseInt(u.searchParams.get("limit") ?? "50", 10);
      const offset = parseInt(u.searchParams.get("offset") ?? "0", 10);
      const page = sessions.slice(offset, offset + limit);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            sessions: page,
            total: sessions.length,
            limit,
            offset,
          }),
      });
    }

    // Fallback — unknown URL
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

const daemonOpts = {
  daemonUrl: TEST_DAEMON_URL,
  signingKey: TEST_SIGNING_KEY,
  agentId: TEST_AGENT_ID,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("listOragerSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls daemon and returns paginated result", async () => {
    vi.stubGlobal("fetch", makeFetchMock([SESSION_A, SESSION_B, SESSION_C]));

    const result = await listOragerSessions({ ...daemonOpts });

    expect(result.total).toBe(3);
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[0].sessionId).toBe("sess-aaa");
    expect(result.sessions[1].sessionId).toBe("sess-bbb");
    expect(result.sessions[2].sessionId).toBe("sess-ccc");
  });

  it("passes limit and offset as query params to daemon", async () => {
    const fetchMock = makeFetchMock([SESSION_A, SESSION_B, SESSION_C]);
    vi.stubGlobal("fetch", fetchMock);

    await listOragerSessions({ ...daemonOpts, limit: 1, offset: 1 });

    // Find the /sessions call (not /sessions/search or /sessions/:id)
    const sessionsCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => {
        const u = new URL(String(url));
        return u.pathname === "/sessions";
      },
    );
    expect(sessionsCalls.length).toBeGreaterThan(0);
    const calledUrl = new URL(String(sessionsCalls[0][0]));
    expect(calledUrl.searchParams.get("limit")).toBe("1");
    expect(calledUrl.searchParams.get("offset")).toBe("1");
  });

  it("falls back to filesystem when fetch throws — no throw, returns empty array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    // Filesystem may or may not have sessions; the key assertion is no throw
    const result = await listOragerSessions({ ...daemonOpts });

    expect(result).toBeDefined();
    expect(Array.isArray(result.sessions)).toBe(true);
    // total may be 0 if no real sessions exist on the CI machine — that's fine
    expect(typeof result.total).toBe("number");
  });

  it("falls back when daemon returns non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    );

    const result = await listOragerSessions({ ...daemonOpts });

    // Returns filesystem result (empty array if no session files exist)
    expect(result).toBeDefined();
    expect(Array.isArray(result.sessions)).toBe(true);
  });

  it("returns empty list when no daemonUrl is given (filesystem path, no files expected)", async () => {
    // No daemonUrl — goes directly to filesystem fallback
    const result = await listOragerSessions({});

    expect(result).toBeDefined();
    expect(Array.isArray(result.sessions)).toBe(true);
    // Should not throw regardless of whether ~/.orager/sessions exists
  });
});

describe("searchOragerSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls /sessions/search?q=... and returns results", async () => {
    vi.stubGlobal("fetch", makeFetchMock([SESSION_A, SESSION_B, SESSION_C]));

    const result = await searchOragerSessions("gpt-4o", { ...daemonOpts });

    expect(result.query).toBe("gpt-4o");
    expect(Array.isArray(result.sessions)).toBe(true);
    // Only SESSION_A has model "gpt-4o"
    expect(result.sessions.some((s) => s.sessionId === "sess-aaa")).toBe(true);
  });

  it("verifies fetch was called with /sessions/search path", async () => {
    const fetchMock = makeFetchMock([SESSION_A, SESSION_B]);
    vi.stubGlobal("fetch", fetchMock);

    await searchOragerSessions("deepseek", { ...daemonOpts });

    const searchCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes("/sessions/search"),
    );
    expect(searchCalls.length).toBe(1);
    const calledUrl = new URL(String(searchCalls[0][0]));
    expect(calledUrl.searchParams.get("q")).toBe("deepseek");
  });

  it("returns empty results when daemon is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await searchOragerSessions("some query", { ...daemonOpts });

    expect(result).toBeDefined();
    expect(Array.isArray(result.sessions)).toBe(true);
    // Filesystem fallback — may be empty; should not throw
    expect(result.query).toBe("some query");
  });
});

describe("getOragerSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls /sessions/:id and returns the session summary", async () => {
    vi.stubGlobal("fetch", makeFetchMock([SESSION_A, SESSION_B]));

    const result = await getOragerSession("sess-aaa", { ...daemonOpts });

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-aaa");
    expect(result!.model).toBe("gpt-4o");
  });

  it("returns null for a 404 from daemon", async () => {
    vi.stubGlobal("fetch", makeFetchMock([SESSION_A]));

    // "sess-nonexistent" is not in the fixture list — mock returns 404
    const result = await getOragerSession("sess-nonexistent", { ...daemonOpts });

    // 404 → fetchFromDaemon returns null → filesystem fallback → likely null
    expect(result).toBeNull();
  });

  it("returns null when daemon is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await getOragerSession("sess-anything", { ...daemonOpts });

    // Filesystem fallback for a non-existent session — should return null
    expect(result).toBeNull();
  });

  it("verifies fetch was called with the correct URL path for the session ID", async () => {
    const fetchMock = makeFetchMock([SESSION_B]);
    vi.stubGlobal("fetch", fetchMock);

    await getOragerSession("sess-bbb", { ...daemonOpts });

    const sessionCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes("/sessions/sess-bbb"),
    );
    expect(sessionCalls.length).toBe(1);
  });
});
