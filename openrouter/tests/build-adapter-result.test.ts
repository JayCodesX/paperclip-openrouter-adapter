/**
 * Tests for buildAdapterResult — the shared result builder used by the spawn
 * path. Verifies that total_cost_usd from the result event is correctly
 * surfaced as costUsd on the AdapterExecutionResult.
 */

import { describe, it, expect } from "vitest";
import { buildAdapterResult } from "../src/index.js";

// ── A4: buildAdapterResult costUsd unit tests ─────────────────────────────────

describe("buildAdapterResult — costUsd extraction (A4)", () => {
  const baseOpts = {
    sessionId: "sess-123",
    resolvedModel: "openai/gpt-4o",
    sessionLost: false,
    cwd: "/workspace",
    workspaceId: null,
    workspaceRepoUrl: null,
    workspaceRepoRef: null,
    exitCode: null,
    signal: null,
  };

  it("extracts total_cost_usd from result event as costUsd", () => {
    const result = buildAdapterResult({
      ...baseOpts,
      resultEvent: {
        subtype: "success",
        result: "done",
        session_id: "sess-123",
        total_cost_usd: 0.00123,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
      },
    });
    expect(result.costUsd).toBe(0.00123);
  });

  it("returns costUsd of 0 when total_cost_usd is missing from result event", () => {
    const result = buildAdapterResult({
      ...baseOpts,
      resultEvent: {
        subtype: "success",
        result: "done",
        session_id: "sess-123",
        // no total_cost_usd field
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
      },
    });
    expect(result.costUsd).toBe(0);
  });

  it("correctly maps a multi-dollar cost", () => {
    const result = buildAdapterResult({
      ...baseOpts,
      resultEvent: {
        subtype: "success",
        result: "done",
        session_id: "sess-123",
        total_cost_usd: 2.5,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
      },
    });
    expect(result.costUsd).toBe(2.5);
  });

  it("returns exitCode 0 for success subtype", () => {
    const result = buildAdapterResult({
      ...baseOpts,
      resultEvent: { subtype: "success", result: "", session_id: "", total_cost_usd: 0, usage: null },
    });
    expect(result.exitCode).toBe(0);
  });

  it("returns exitCode 1 for error subtype", () => {
    const result = buildAdapterResult({
      ...baseOpts,
      resultEvent: { subtype: "error", result: "something broke", session_id: "", total_cost_usd: 0, usage: null },
    });
    expect(result.exitCode).toBe(1);
  });

  it("clearSession is true for error_max_turns (session should be cleared)", () => {
    const result = buildAdapterResult({
      ...baseOpts,
      resultEvent: { subtype: "error_max_turns", result: "max turns reached", session_id: "sess-999", total_cost_usd: 0.05, usage: null },
    });
    expect(result.clearSession).toBe(true);
    expect(result.costUsd).toBe(0.05);
  });

  it("computes correct cacheHitRatio from usage", () => {
    const result = buildAdapterResult({
      ...baseOpts,
      resultEvent: {
        subtype: "success",
        result: "",
        session_id: "",
        total_cost_usd: 0,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 400 },
      },
    });
    // 400 / 1000 = 0.4 — stored in resultJson, rounded to 2 decimal places
    expect((result.resultJson as Record<string, unknown>)?.cacheHitRatio).toBeCloseTo(0.4, 2);
  });
});

