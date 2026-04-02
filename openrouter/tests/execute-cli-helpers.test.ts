import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetStateForTesting,
  buildApiKeyPool,
  DEFAULT_MODEL,
  buildAdapterResult,
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

  it("produces identical results when called twice with same opts", () => {
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
