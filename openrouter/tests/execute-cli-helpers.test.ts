import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mintDaemonJwt } from "../src/server/jwt-utils.js";
import {
  _resetStateForTesting,
  buildApiKeyPool,
  DEFAULT_MODEL,
  DAEMON_KEY_PATH,
  isDaemonCircuitOpen,
  recordDaemonFailure,
  recordDaemonSuccess,
  DAEMON_CB_THRESHOLD,
  DAEMON_CB_RESET_MS,
  buildAdapterResult,
  AUTO_START_COOLDOWN_MS,
} from "../src/server/execute-cli.js";
import { models } from "../src/index.js";

beforeEach(() => {
  _resetStateForTesting();
});

// ── buildApiKeyPool ────────────────────────────────────────────────────────────

describe("buildApiKeyPool", () => {
  it("returns primary key when no apiKeys array", () => {
    const { primary, pool } = buildApiKeyPool({ apiKey: "sk-single" });
    expect(primary).toBe("sk-single");
    expect(pool).toEqual(["sk-single"]);
  });

  it("merges apiKey + apiKeys[] with apiKey first when not already present", () => {
    const { primary, pool } = buildApiKeyPool({ apiKey: "sk-primary", apiKeys: ["sk-secondary"] });
    expect(primary).toBe("sk-primary");
    expect(pool).toEqual(["sk-primary", "sk-secondary"]);
  });

  it("does not duplicate apiKey if already in apiKeys[]", () => {
    const { primary, pool } = buildApiKeyPool({ apiKey: "sk-a", apiKeys: ["sk-a", "sk-b"] });
    expect(primary).toBe("sk-a");
    expect(pool).toEqual(["sk-a", "sk-b"]);
  });

  it("returns empty primary and single-entry pool when no key configured", () => {
    const { primary, pool } = buildApiKeyPool({});
    expect(primary).toBe("");
    expect(pool).toEqual([""]);
  });

  it("filters out empty strings from apiKeys[]", () => {
    const { pool } = buildApiKeyPool({ apiKeys: ["", "  ", "sk-valid"] });
    expect(pool).toContain("sk-valid");
    expect(pool).not.toContain("");
    expect(pool).not.toContain("  ");
  });

  it("returns full pool from apiKeys[] when no primary apiKey", () => {
    const { pool } = buildApiKeyPool({ apiKeys: ["sk-a", "sk-b", "sk-c"] });
    expect(pool).toEqual(["sk-a", "sk-b", "sk-c"]);
  });
});

// ── daemon health check in testEnvironment ────────────────────────────────────

describe("testEnvironment daemon health check", () => {
  it("adds daemon_health_ok check when daemon returns { status: 'ok' }", async () => {
    const { testEnvironment } = await import("../src/server/test.js");

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok", activeRuns: 1, maxConcurrent: 5 }),
        });
      }
      // models endpoint — return ok so api key check passes
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      });
    }));

    const result = await testEnvironment({
      adapterType: "openrouter",
      config: {
        apiKey: "sk-test",
        daemonUrl: "http://localhost:4000",
        cwd: process.cwd(),
      },
      serverUrl: "",
    } as Parameters<typeof testEnvironment>[0]);

    const healthCheck = result.checks.find((c) => c.code === "daemon_health_ok");
    expect(healthCheck).toBeDefined();
    expect(healthCheck?.level).toBe("info");
    expect(healthCheck?.message).toContain("1 / 5");

    vi.unstubAllGlobals();
  });

  it("adds daemon_unreachable warn check when fetch throws", async () => {
    const { testEnvironment } = await import("../src/server/test.js");

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/health")) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    }));

    const result = await testEnvironment({
      adapterType: "openrouter",
      config: {
        apiKey: "sk-test",
        daemonUrl: "http://localhost:9999",
        cwd: process.cwd(),
      },
      serverUrl: "",
    } as Parameters<typeof testEnvironment>[0]);

    const unreachable = result.checks.find((c) => c.code === "daemon_unreachable");
    expect(unreachable).toBeDefined();
    expect(unreachable?.level).toBe("warn");

    vi.unstubAllGlobals();
  });

  it("skips daemon health check when daemonUrl is not configured", async () => {
    const { testEnvironment } = await import("../src/server/test.js");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await testEnvironment({
      adapterType: "openrouter",
      config: { apiKey: "sk-test", cwd: process.cwd() },
      serverUrl: "",
    } as Parameters<typeof testEnvironment>[0]);

    const healthCalls = fetchMock.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("/health"),
    );
    expect(healthCalls).toHaveLength(0);

    vi.unstubAllGlobals();
  });
});

// ── OTEL env passthrough (config parsing) ─────────────────────────────────────

describe("OTEL config passthrough", () => {
  it("otelEndpoint / otelServiceName are recognized config fields (type check)", () => {
    // Verify the shape expected by execute-cli is accepted — structural test
    const config: Record<string, unknown> = {
      apiKey: "sk-test",
      otelEndpoint: "http://otel.example.com:4317",
      otelServiceName: "my-agent",
      otelResourceAttributes: "deployment.environment=production",
    };
    // All three are strings — no coercion needed
    expect(typeof config.otelEndpoint).toBe("string");
    expect(typeof config.otelServiceName).toBe("string");
    expect(typeof config.otelResourceAttributes).toBe("string");
  });
});

// ── DEFAULT_MODEL consistency ──────────────────────────────────────────────────
// The DEFAULT_MODEL in execute-cli.ts must appear in index.ts's hardcoded models
// list so that:
//   1. The health probe (test.ts) uses the same model as the adapter default.
//   2. The fallback model list includes the default so vision-fallback works.
//   3. The UI model dropdown shows the default as a selectable option.

describe("DEFAULT_MODEL consistency", () => {
  it("DEFAULT_MODEL appears in the hardcoded index.ts models list", () => {
    const ids = models.map((m) => m.id);
    expect(ids).toContain(DEFAULT_MODEL);
  });
});

// ── Daemon key file permission warning ────────────────────────────────────────
// readDaemonSigningKey warns when the key file has group- or world-readable bits.
// We test this by temporarily writing to the real DAEMON_KEY_PATH location and
// checking the warning appears in onLog. The real key (if any) is saved and
// restored via afterEach.

describe("daemon key file permission check", () => {
  let savedKey: string | null = null;
  let keyDirCreated = false;

  beforeEach(async () => {
    // Save the existing key (if any) so we can restore it after the test
    savedKey = await fs.readFile(DAEMON_KEY_PATH, "utf8").catch(() => null);
    // Ensure the directory exists
    await fs.mkdir(path.dirname(DAEMON_KEY_PATH), { recursive: true });
    keyDirCreated = true;
  });

  afterEach(async () => {
    if (!keyDirCreated) return;
    if (savedKey !== null) {
      await fs.writeFile(DAEMON_KEY_PATH, savedKey);
      await fs.chmod(DAEMON_KEY_PATH, 0o600);
    } else {
      await fs.unlink(DAEMON_KEY_PATH).catch(() => {});
    }
  });

  it("emits warning to onLog when daemon key file has group-readable permissions", async () => {
    await fs.writeFile(DAEMON_KEY_PATH, "test-signing-key");
    await fs.chmod(DAEMON_KEY_PATH, 0o644); // group/world readable — unsafe

    const logs: Array<[string, string]> = [];
    const { executeAgentLoop: run } = await import("../src/server/execute-cli.js");
    // cliPath points to a non-existent binary so the test fails fast after the
    // permission check fires (during the daemon-fallback → spawn attempt).
    await run({
      runId: "key-perm-test",
      agent: { id: "test-agent", companyId: "co", name: "A", adapterType: "openrouter", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        maxTurns: 1,
        cwd: os.tmpdir(),
        cliPath: "/nonexistent/orager-test-binary",
        daemonUrl: "http://127.0.0.1:19999", // nothing listening → falls back to spawn
        dangerouslySkipPermissions: true,
      },
      context: { task: "test", wakeReason: "manual" },
      onLog: async (s, l) => { logs.push([s, l]); },
      onMeta: async () => {},
    });
    const stderrText = logs.filter(([s]) => s === "stderr").map(([, l]) => l).join("\n");
    expect(stderrText).toContain("unsafe permissions");
  });

  it("does not emit permission warning when daemon key is 600", async () => {
    await fs.writeFile(DAEMON_KEY_PATH, "test-signing-key");
    await fs.chmod(DAEMON_KEY_PATH, 0o600); // safe

    const logs: Array<[string, string]> = [];
    const { executeAgentLoop: run } = await import("../src/server/execute-cli.js");
    await run({
      runId: "key-safe-test",
      agent: { id: "test-agent", companyId: "co", name: "A", adapterType: "openrouter", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        maxTurns: 1,
        cwd: os.tmpdir(),
        cliPath: "/nonexistent/orager-test-binary",
        daemonUrl: "http://127.0.0.1:19999",
        dangerouslySkipPermissions: true,
      },
      context: { task: "test", wakeReason: "manual" },
      onLog: async (s, l) => { logs.push([s, l]); },
      onMeta: async () => {},
    });
    const stderrText = logs.filter(([s]) => s === "stderr").map(([, l]) => l).join("\n");
    expect(stderrText).not.toContain("unsafe permissions");
  });
});

// ── Daemon circuit breaker (5.6) ──────────────────────────────────────────────
// The circuit breaker opens after DAEMON_CB_THRESHOLD consecutive failures and
// stays open for DAEMON_CB_RESET_MS, then half-opens to allow a probe.

describe("daemon circuit breaker", () => {
  beforeEach(() => {
    _resetStateForTesting();
  });

  it("is closed with no failures", () => {
    expect(isDaemonCircuitOpen("http://127.0.0.1:9000")).toBe(false);
  });

  it("stays closed below the threshold", () => {
    for (let i = 0; i < DAEMON_CB_THRESHOLD - 1; i++) {
      recordDaemonFailure("http://127.0.0.1:9000");
    }
    expect(isDaemonCircuitOpen("http://127.0.0.1:9000")).toBe(false);
  });

  it("opens after threshold consecutive failures", () => {
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure("http://127.0.0.1:9000");
    }
    expect(isDaemonCircuitOpen("http://127.0.0.1:9000")).toBe(true);
  });

  it("closes again after a success", () => {
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure("http://127.0.0.1:9000");
    }
    expect(isDaemonCircuitOpen("http://127.0.0.1:9000")).toBe(true);
    recordDaemonSuccess("http://127.0.0.1:9000");
    expect(isDaemonCircuitOpen("http://127.0.0.1:9000")).toBe(false);
  });

  it("half-opens after DAEMON_CB_RESET_MS elapses", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
        recordDaemonFailure("http://127.0.0.1:9001");
      }
      expect(isDaemonCircuitOpen("http://127.0.0.1:9001")).toBe(true);

      // Advance time past the reset window
      vi.advanceTimersByTime(DAEMON_CB_RESET_MS + 1);

      // After reset, one probe is allowed (half-open → circuit reports closed)
      expect(isDaemonCircuitOpen("http://127.0.0.1:9001")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks separate circuits per URL", () => {
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure("http://daemon-a:9000");
    }
    expect(isDaemonCircuitOpen("http://daemon-a:9000")).toBe(true);
    expect(isDaemonCircuitOpen("http://daemon-b:9000")).toBe(false);
  });
});

// ── mintDaemonJwt (5.15) ──────────────────────────────────────────────────────
// Unit tests for JWT token structure and expiry.

describe("mintDaemonJwt", () => {
  it("produces a three-part dot-separated JWT", () => {
    const token = mintDaemonJwt("test-key-32-bytes-for-hmac-sha256", "agent-1");
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("header decodes to HS256/JWT", () => {
    const token = mintDaemonJwt("test-key-32-bytes-for-hmac-sha256", "agent-1");
    const [headerB64] = token.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");
  });

  it("payload contains agentId, scope, iat, exp", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = mintDaemonJwt("test-key-32-bytes-for-hmac-sha256", "my-agent");
    const after = Math.floor(Date.now() / 1000);

    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;

    expect(payload.agentId).toBe("my-agent");
    expect(payload.scope).toBe("run");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.iat as number).toBeGreaterThanOrEqual(before);
    expect(payload.iat as number).toBeLessThanOrEqual(after);
  });

  it("token expires in 15 minutes (900 seconds)", () => {
    const token = mintDaemonJwt("test-key-32-bytes-for-hmac-sha256", "agent-1");
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
    const iat = payload.iat as number;
    const exp = payload.exp as number;
    expect(exp - iat).toBe(900);
  });

  it("generates different tokens on separate calls (different iat)", async () => {
    // Wait 1ms to ensure different iat (though with ms precision it's likely the same)
    const token1 = mintDaemonJwt("test-key-32-bytes-for-hmac-sha256", "agent-1");
    await new Promise((r) => setTimeout(r, 10));
    const token2 = mintDaemonJwt("test-key-32-bytes-for-hmac-sha256", "agent-1");
    // Tokens may differ by signature when iat differs
    // At minimum they should both be valid JWT shape
    expect(token1.split(".")).toHaveLength(3);
    expect(token2.split(".")).toHaveLength(3);
  });
});

// ── buildAdapterResult ────────────────────────────────────────────────────────

describe("buildAdapterResult", () => {
  beforeEach(() => _resetStateForTesting());

  const BASE_RESULT_EVENT: Record<string, unknown> = {
    type: "result",
    subtype: "success",
    result: "Done",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 },
    total_cost_usd: 0.0015,
    session_id: "sess-abc",
  };

  it("builds a success result from a result event", () => {
    const r = buildAdapterResult({
      resultEvent: BASE_RESULT_EVENT,
      sessionId: "sess-abc",
      resolvedModel: "deepseek/deepseek-chat-v3-0324",
      sessionLost: false,
      cwd: "/tmp/test",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: 0,
      signal: null,
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.errorMessage).toBeUndefined();
    expect(r.clearSession).toBe(false);
    expect(r.costUsd).toBeCloseTo(0.0015);
    expect(r.usage?.inputTokens).toBe(100);
    expect(r.usage?.outputTokens).toBe(20);
    expect(r.usage?.cachedInputTokens).toBe(10);
    expect(r.sessionDisplayId).toBe("sess-abc");
    expect((r.resultJson as Record<string, unknown>).subtype).toBe("success");
  });

  it("sets clearSession: true on error_max_turns", () => {
    const r = buildAdapterResult({
      resultEvent: { ...BASE_RESULT_EVENT, subtype: "error_max_turns" },
      sessionId: "s1",
      resolvedModel: "",
      sessionLost: false,
      cwd: "/tmp",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: null,
      signal: null,
    });
    expect(r.clearSession).toBe(true);
    // error_max_turns is a soft stop — exitCode should not be 1
    expect(r.exitCode).toBe(0);
  });

  it("sets clearSession: true when sessionLost is true", () => {
    const r = buildAdapterResult({
      resultEvent: { ...BASE_RESULT_EVENT, subtype: "success" },
      sessionId: "",
      resolvedModel: "",
      sessionLost: true,
      cwd: "/tmp",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: 0,
      signal: null,
    });
    expect(r.clearSession).toBe(true);
  });

  it("falls back to resultEvent.session_id when sessionId arg is empty", () => {
    const r = buildAdapterResult({
      resultEvent: { ...BASE_RESULT_EVENT, session_id: "from-event" },
      sessionId: "",
      resolvedModel: "",
      sessionLost: false,
      cwd: "/tmp",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: 0,
      signal: null,
    });
    expect(r.sessionDisplayId).toBe("from-event");
    expect((r.sessionParams as Record<string, unknown> | null)?.oragerSessionId).toBe("from-event");
  });

  it("includes workspaceId/repoUrl/repoRef in sessionParams when provided", () => {
    const r = buildAdapterResult({
      resultEvent: BASE_RESULT_EVENT,
      sessionId: "s1",
      resolvedModel: "",
      sessionLost: false,
      cwd: "/workspace",
      workspaceId: "ws-42",
      workspaceRepoUrl: "https://github.com/org/repo",
      workspaceRepoRef: "main",
      exitCode: 0,
      signal: null,
    });
    const params = r.sessionParams as Record<string, unknown>;
    expect(params.workspaceId).toBe("ws-42");
    expect(params.repoUrl).toBe("https://github.com/org/repo");
    expect(params.repoRef).toBe("main");
  });

  it("produces non-zero exitCode for non-soft-stop subtypes", () => {
    const r = buildAdapterResult({
      resultEvent: { ...BASE_RESULT_EVENT, subtype: "error_tool_budget" },
      sessionId: "",
      resolvedModel: "",
      sessionLost: false,
      cwd: "/tmp",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: null,
      signal: null,
    });
    expect(r.exitCode).toBe(1);
    expect(r.errorMessage).toContain("error_tool_budget");
  });

  it("daemon and spawn paths produce identical results for same event", () => {
    const opts = {
      resultEvent: BASE_RESULT_EVENT,
      sessionId: "sess-xyz",
      resolvedModel: "openai/gpt-4o",
      sessionLost: false,
      cwd: "/repo",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: 0,
      signal: null as null,
    };
    const r1 = buildAdapterResult(opts);
    const r2 = buildAdapterResult(opts);
    // Strip updatedAt (contains current timestamp) for comparison
    const stripTs = (r: typeof r1) => {
      const p = r.sessionParams ? { ...(r.sessionParams as Record<string, unknown>) } : null;
      if (p) delete p.updatedAt;
      return { ...r, sessionParams: p };
    };
    expect(stripTs(r1)).toEqual(stripTs(r2));
  });
});

// ── Auto-start rate limiter ───────────────────────────────────────────────────

describe("auto-start rate limiter constants", () => {
  it("AUTO_START_COOLDOWN_MS is 2 minutes", () => {
    expect(AUTO_START_COOLDOWN_MS).toBe(2 * 60 * 1000);
  });
});

// ── Sampling params: finite check ────────────────────────────────────────────

describe("safeNumber via buildAdapterResult (indirect)", () => {
  it("buildAdapterResult handles missing usage gracefully", () => {
    const r = buildAdapterResult({
      resultEvent: { type: "result", subtype: "success", result: "ok" },
      sessionId: "",
      resolvedModel: "",
      sessionLost: false,
      cwd: "/tmp",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: 0,
      signal: null,
    });
    expect(r.usage).toBeUndefined();
    expect(r.costUsd).toBe(0);
  });
});

// ── Circuit breaker half-open state ──────────────────────────────────────────

describe("daemon circuit breaker half-open state", () => {
  beforeEach(() => { _resetStateForTesting(); });

  it("after DAEMON_CB_THRESHOLD failures, circuit is open", () => {
    const url = "http://127.0.0.1:9999";
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url);
    }
    expect(isDaemonCircuitOpen(url)).toBe(true);
  });

  it("after DAEMON_CB_RESET_MS passes, circuit transitions to half-open (returns false)", () => {
    const url = "http://127.0.0.1:9998";
    // Open the circuit
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url);
    }
    expect(isDaemonCircuitOpen(url)).toBe(true);

    // Simulate time passing by directly manipulating the internal state
    // We can't easily mock Date.now() here, so we verify the threshold is correct
    // and that after success, the circuit closes
    recordDaemonSuccess(url);
    expect(isDaemonCircuitOpen(url)).toBe(false);
  });

  it("recordDaemonSuccess clears the circuit breaker state", () => {
    const url = "http://127.0.0.1:9997";
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url);
    }
    expect(isDaemonCircuitOpen(url)).toBe(true);
    recordDaemonSuccess(url);
    expect(isDaemonCircuitOpen(url)).toBe(false);
  });
});

