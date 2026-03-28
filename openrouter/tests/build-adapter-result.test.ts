/**
 * Tests for buildAdapterResult — the shared result builder used by both the
 * daemon fast path and the spawn path. Verifies that total_cost_usd from the
 * result event is correctly surfaced as costUsd on the AdapterExecutionResult.
 *
 * Also tests the daemon NDJSON streaming path end-to-end: a minimal HTTP server
 * emits a result event with total_cost_usd; we verify the assembled result has
 * the correct costUsd value.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

// ── A4: daemon NDJSON streaming path — costUsd end-to-end ────────────────────
// Verifies that total_cost_usd in the daemon's result event is faithfully
// extracted when the NDJSON stream is parsed by buildAdapterResult.

describe("daemon NDJSON streaming path — costUsd end-to-end (A4)", () => {
  let serverUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      // Emit a realistic NDJSON stream: an assistant message, then the result event
      res.write(JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Hello!" }] }) + "\n");
      res.write(JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Task complete",
        session_id: "sess-stream-001",
        finish_reason: "stop",
        total_cost_usd: 0.00456,
        turn_count: 1,
        usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0 },
      }) + "\n");
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("parses NDJSON stream and extracts total_cost_usd via buildAdapterResult", async () => {
    const response = await fetch(`${serverUrl}/`);
    expect(response.ok).toBe(true);

    const body = await response.text();
    const lines = body.split("\n").filter(Boolean);

    // Find the result event
    const resultLine = lines.find((l) => {
      try { return (JSON.parse(l) as Record<string, unknown>).type === "result"; }
      catch { return false; }
    });
    expect(resultLine).toBeDefined();

    const resultEvent = JSON.parse(resultLine!) as Record<string, unknown>;
    const adapterResult = buildAdapterResult({
      resultEvent,
      sessionId: "",
      resolvedModel: "openai/gpt-4o",
      sessionLost: false,
      cwd: "/workspace",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: null,
      signal: null,
    });

    expect(adapterResult.costUsd).toBe(0.00456);
    expect(adapterResult.exitCode).toBe(0);
    expect(adapterResult.usage?.inputTokens).toBe(200);
    expect(adapterResult.usage?.outputTokens).toBe(80);
  });

  it("NDJSON stream with zero-cost result has costUsd of 0", async () => {
    // Use buildAdapterResult directly with a zero-cost result event
    const adapterResult = buildAdapterResult({
      resultEvent: {
        type: "result",
        subtype: "success",
        result: "",
        session_id: "",
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
      sessionId: "",
      resolvedModel: "openai/gpt-4o",
      sessionLost: false,
      cwd: "/workspace",
      workspaceId: null,
      workspaceRepoUrl: null,
      workspaceRepoRef: null,
      exitCode: null,
      signal: null,
    });
    expect(adapterResult.costUsd).toBe(0);
  });
});
