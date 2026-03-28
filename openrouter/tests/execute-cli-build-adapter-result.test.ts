/**
 * Unit tests for buildAdapterResult and buildApiKeyPool.
 *
 * buildAdapterResult maps every result subtype to the correct
 * {softStop, clearSession, exitCode, errorCode} combination.
 *
 * buildApiKeyPool merges the primary key + extra pool, deduplicates,
 * and falls back to the OPENROUTER_API_KEY env var.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildAdapterResult,
  buildApiKeyPool,
  _resetStateForTesting,
} from "../src/server/execute-cli.js";

// ── buildAdapterResult helpers ────────────────────────────────────────────────

function makeOpts(subtype: string, extra: Record<string, unknown> = {}) {
  return {
    resultEvent: {
      subtype,
      result: "done",
      session_id: "sess-1",
      total_cost_usd: 0.001,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      ...extra,
    },
    sessionId: "sess-1",
    resolvedModel: "openai/gpt-4o",
    sessionLost: false,
    cwd: "/tmp/test",
    workspaceId: null,
    workspaceRepoUrl: null,
    workspaceRepoRef: null,
    exitCode: null,
    signal: null,
  };
}

// ── buildAdapterResult tests ──────────────────────────────────────────────────

describe("buildAdapterResult — subtype mappings", () => {
  it("success → exitCode:0, softStop:true, no errorCode, no clearSession", () => {
    const r = buildAdapterResult(makeOpts("success"));
    expect(r.exitCode).toBe(0);
    expect(r.errorCode).toBeUndefined();
    expect(r.errorMessage).toBeUndefined();
    expect(r.clearSession).toBeFalsy();
  });

  it("error_max_turns → exitCode:1, clearSession:true, errorCode set", () => {
    const r = buildAdapterResult(makeOpts("error_max_turns"));
    expect(r.exitCode).toBe(0); // softStop=true (max_turns is a soft stop)
    expect(r.clearSession).toBe(true);
    expect(r.errorCode).toBeUndefined(); // softStop means no errorCode
  });

  it("error_loop_abort → exitCode:1, clearSession:false, errorCode set", () => {
    const r = buildAdapterResult(makeOpts("error_loop_abort"));
    expect(r.exitCode).toBe(1);
    expect(r.clearSession).toBeFalsy();
    expect(r.errorCode).toBe("error_loop_abort");
  });

  it("error → exitCode:1, errorCode:'error'", () => {
    const r = buildAdapterResult(makeOpts("error"));
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe("error");
    expect(r.clearSession).toBeFalsy();
  });

  it("error_circuit_open → exitCode:1, errorCode set", () => {
    const r = buildAdapterResult(makeOpts("error_circuit_open"));
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe("error_circuit_open");
  });

  it("error_max_cost → exitCode:1, errorCode set", () => {
    const r = buildAdapterResult(makeOpts("error_max_cost"));
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe("error_max_cost");
  });

  it("interrupted → exitCode:1, errorCode set", () => {
    const r = buildAdapterResult(makeOpts("interrupted"));
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe("interrupted");
  });

  it("error_cancelled → exitCode:1, errorCode set", () => {
    const r = buildAdapterResult(makeOpts("error_cancelled"));
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe("error_cancelled");
  });

  it("error_tool_budget → exitCode:1, errorCode set", () => {
    const r = buildAdapterResult(makeOpts("error_tool_budget"));
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe("error_tool_budget");
  });

  it("unknown subtype → exitCode:1, errorCode equals the subtype string", () => {
    const r = buildAdapterResult(makeOpts("some_future_unknown_subtype"));
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe("some_future_unknown_subtype");
    expect(r.clearSession).toBeFalsy();
  });
});

describe("buildAdapterResult — session and usage fields", () => {
  it("sessionLost=true forces clearSession regardless of subtype", () => {
    const r = buildAdapterResult({ ...makeOpts("success"), sessionLost: true });
    expect(r.clearSession).toBe(true);
  });

  it("usage fields are mapped correctly from result event", () => {
    const r = buildAdapterResult(makeOpts("success"));
    expect(r.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
    });
  });

  it("sessionParams contains oragerSessionId when session ID is present", () => {
    const r = buildAdapterResult(makeOpts("success"));
    expect((r.sessionParams as Record<string, unknown>)?.oragerSessionId).toBe("sess-1");
  });

  it("sessionParams is null when both sessionId arg and result session_id are empty", () => {
    const opts = { ...makeOpts("success"), sessionId: "" };
    (opts.resultEvent as Record<string, unknown>).session_id = "";
    const r = buildAdapterResult(opts);
    expect(r.sessionParams).toBeNull();
  });

  it("resolvedModel is forwarded to result.model", () => {
    const r = buildAdapterResult(makeOpts("success"));
    expect(r.model).toBe("openai/gpt-4o");
  });

  it("filesChanged forwarded from resultEvent when present", () => {
    const r = buildAdapterResult(makeOpts("success", { filesChanged: ["a.ts", "b.ts"] }));
    expect(r.resultJson?.filesChanged).toEqual(["a.ts", "b.ts"]);
  });

  it("exitCode arg overrides computed value when explicitly set", () => {
    const opts = { ...makeOpts("success"), exitCode: 42 };
    const r = buildAdapterResult(opts);
    expect(r.exitCode).toBe(42);
  });
});

// ── buildApiKeyPool tests ─────────────────────────────────────────────────────

describe("buildApiKeyPool", () => {
  beforeEach(() => {
    _resetStateForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("primary key only — pool contains just the primary", () => {
    const { primary, pool } = buildApiKeyPool({ apiKey: "sk-primary" });
    expect(primary).toBe("sk-primary");
    expect(pool).toEqual(["sk-primary"]);
  });

  it("extra apiKeys are appended to pool", () => {
    const { primary, pool } = buildApiKeyPool({
      apiKey: "sk-primary",
      apiKeys: ["sk-extra-1", "sk-extra-2"],
    });
    expect(primary).toBe("sk-primary");
    expect(pool).toEqual(["sk-primary", "sk-extra-1", "sk-extra-2"]);
  });

  it("primary is deduplicated if it also appears in apiKeys", () => {
    const { pool } = buildApiKeyPool({
      apiKey: "sk-dupe",
      apiKeys: ["sk-dupe", "sk-other"],
    });
    const count = pool.filter((k) => k === "sk-dupe").length;
    expect(count).toBe(1);
  });

  it("falls back to OPENROUTER_API_KEY env var when apiKey is empty", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-from-env");
    const { primary } = buildApiKeyPool({ apiKey: "" });
    expect(primary).toBe("sk-from-env");
  });

  it("non-string entries in apiKeys are filtered out", () => {
    const { pool } = buildApiKeyPool({
      apiKey: "sk-primary",
      apiKeys: ["sk-valid", 42, null, ""],
    });
    expect(pool).not.toContain(42);
    expect(pool).not.toContain(null);
    expect(pool).not.toContain("");
  });

  it("extra keys only (no primary) — pool uses extra keys", () => {
    const { pool } = buildApiKeyPool({ apiKeys: ["sk-a", "sk-b"] });
    expect(pool).toContain("sk-a");
    expect(pool).toContain("sk-b");
  });
});
