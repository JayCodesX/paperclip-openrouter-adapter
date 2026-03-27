/**
 * Unit tests for testEnvironment (src/server/test.ts).
 *
 * fetch is stubbed so no real network calls are made. The orager probe
 * (which spawns a real process) is tested separately from the API checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testEnvironment } from "../src/server/test.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(config: Record<string, unknown> = {}): Parameters<typeof testEnvironment>[0] {
  return {
    adapterType: "openrouter",
    config: {
      apiKey: "sk-test-key",
      model: "openai/gpt-4o",
      cliPath: "/dev/null",  // not executable — won't reach the probe
      cwd: "/tmp",
      ...config,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("testEnvironment — API key checks", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns error check when apiKey is missing", async () => {
    const result = await testEnvironment(makeCtx({ apiKey: "" }));
    const keyCheck = result.checks.find((c) => c.code === "openrouter_api_key_missing");
    expect(keyCheck).toBeDefined();
    expect(keyCheck?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  it("returns error check on 401 Unauthorized", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    const result = await testEnvironment(makeCtx());
    const keyCheck = result.checks.find((c) => c.code === "openrouter_api_key_invalid");
    expect(keyCheck).toBeDefined();
    expect(keyCheck?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  it("returns info check on successful /models response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as Response);
    const result = await testEnvironment(makeCtx());
    const connCheck = result.checks.find((c) => c.code === "openrouter_connectivity_ok");
    expect(connCheck).toBeDefined();
    expect(connCheck?.level).toBe("info");
  });

  it("returns error check when /models fetch throws (network failure)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await testEnvironment(makeCtx());
    const connCheck = result.checks.find((c) => c.code === "openrouter_connectivity_failed");
    expect(connCheck).toBeDefined();
    expect(connCheck?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  it("returns warn check on non-401, non-200 /models response", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const result = await testEnvironment(makeCtx());
    const connCheck = result.checks.find((c) => c.code === "openrouter_connectivity_warn");
    expect(connCheck).toBeDefined();
    expect(connCheck?.level).toBe("warn");
  });

  it("warns when timeoutSec is configured very low", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) } as Response);
    const result = await testEnvironment(makeCtx({ timeoutSec: 5 }));
    const timeoutCheck = result.checks.find((c) => c.code === "openrouter_timeout_very_low");
    expect(timeoutCheck).toBeDefined();
    expect(timeoutCheck?.level).toBe("warn");
  });

  it("includes adapterType in result", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) } as Response);
    const result = await testEnvironment(makeCtx());
    expect(result.adapterType).toBe("openrouter");
  });

  it("includes testedAt ISO timestamp", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) } as Response);
    const result = await testEnvironment(makeCtx());
    expect(() => new Date(result.testedAt)).not.toThrow();
    expect(new Date(result.testedAt).getFullYear()).toBeGreaterThan(2000);
  });
});

describe("testEnvironment — daemon health check", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("reports daemon_health_ok when daemon responds with status=ok", async () => {
    // First call: /models (for API check); second: /health (for daemon check)
    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", activeRuns: 0, maxConcurrent: 5 }),
      } as Response);

    const result = await testEnvironment(makeCtx({ daemonUrl: "http://127.0.0.1:19999" }));
    const daemonCheck = result.checks.find((c) => c.code === "daemon_health_ok");
    expect(daemonCheck).toBeDefined();
    expect(daemonCheck?.level).toBe("info");
  });

  it("reports daemon_unreachable when daemon fetch throws", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) } as Response)
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await testEnvironment(makeCtx({ daemonUrl: "http://127.0.0.1:19999" }));
    const daemonCheck = result.checks.find((c) => c.code === "daemon_unreachable");
    expect(daemonCheck).toBeDefined();
    expect(daemonCheck?.level).toBe("warn");
  });
});
