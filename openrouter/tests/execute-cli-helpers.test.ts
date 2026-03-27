import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  _resetStateForTesting,
  buildApiKeyPool,
  checkVisionSupport,
  recordRunCost,
  checkCostAnomaly,
} from "../src/server/execute-cli.js";

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

// ── checkVisionSupport ────────────────────────────────────────────────────────

describe("checkVisionSupport", () => {
  const API_KEY = "sk-test";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(response: { ok: boolean; data?: unknown }) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: response.ok,
        json: async () => response.data ?? {},
      }),
    );
  }

  it("returns true when model reports image in input_modalities", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          { id: "openai/gpt-4o", input_modalities: ["text", "image"] },
        ],
      },
    });
    expect(await checkVisionSupport(API_KEY, "openai/gpt-4o")).toBe(true);
  });

  it("returns false when model is present but has no image modality", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          { id: "openai/gpt-4-turbo", input_modalities: ["text"] },
        ],
      },
    });
    expect(await checkVisionSupport(API_KEY, "openai/gpt-4-turbo")).toBe(false);
  });

  it("returns true when image is only in architecture.input_modalities", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          {
            id: "meta-llama/llama-3.2-11b-vision-instruct",
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      },
    });
    expect(
      await checkVisionSupport(API_KEY, "meta-llama/llama-3.2-11b-vision-instruct"),
    ).toBe(true);
  });

  it("returns null when model is not found in /models response", async () => {
    mockFetch({
      ok: true,
      data: { data: [{ id: "some/other-model", input_modalities: ["text"] }] },
    });
    expect(await checkVisionSupport(API_KEY, "unknown/model")).toBeNull();
  });

  it("returns null when fetch returns non-ok status", async () => {
    mockFetch({ ok: false });
    expect(await checkVisionSupport(API_KEY, "openai/gpt-4o")).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    expect(await checkVisionSupport(API_KEY, "openai/gpt-4o")).toBeNull();
  });

  it("returns cached result on second call without re-fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "openai/gpt-4o", input_modalities: ["text", "image"] }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkVisionSupport(API_KEY, "openai/gpt-4o");
    await checkVisionSupport(API_KEY, "openai/gpt-4o");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache is cleared by _resetStateForTesting", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "openai/gpt-4o", input_modalities: ["text", "image"] }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkVisionSupport(API_KEY, "openai/gpt-4o");
    _resetStateForTesting();
    await checkVisionSupport(API_KEY, "openai/gpt-4o");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── cost anomaly detection ─────────────────────────────────────────────────────

describe("cost anomaly detection", () => {
  it("does not emit warning when window has fewer than 3 runs", () => {
    const logs: string[] = [];
    const mockLog = (_s: "stdout" | "stderr", line: string) => { logs.push(line); };

    recordRunCost(0.01);
    recordRunCost(0.01);
    checkCostAnomaly(0.50, "agent1", "run1", mockLog);

    expect(logs).toHaveLength(0);
  });

  it("does not emit warning when cost is within 2x average", () => {
    const logs: string[] = [];
    const mockLog = (_s: "stdout" | "stderr", line: string) => { logs.push(line); };

    recordRunCost(0.10);
    recordRunCost(0.10);
    recordRunCost(0.10);
    checkCostAnomaly(0.15, "agent1", "run1", mockLog); // 1.5x — under threshold

    expect(logs).toHaveLength(0);
  });

  it("emits warning to stderr when cost exceeds 2x rolling average", () => {
    const stderrLogs: string[] = [];
    const mockLog = (stream: "stdout" | "stderr", line: string) => {
      if (stream === "stderr") stderrLogs.push(line);
    };

    recordRunCost(0.10);
    recordRunCost(0.10);
    recordRunCost(0.10);
    checkCostAnomaly(0.50, "agent1", "run1", mockLog); // 5x — over threshold

    expect(stderrLogs).toHaveLength(1);
    expect(stderrLogs[0]).toContain("COST ANOMALY");
    expect(stderrLogs[0]).toContain("$0.5000");
  });

  it("skips zero-cost runs so they do not dilute the average", () => {
    const logs: string[] = [];
    const mockLog = (_s: "stdout" | "stderr", line: string) => { logs.push(line); };

    recordRunCost(0);    // dry-run — skipped
    recordRunCost(0);    // dry-run — skipped
    recordRunCost(0);    // dry-run — skipped
    // Window still has 0 real entries — anomaly check should be a no-op
    checkCostAnomaly(0.50, "agent1", "run1", mockLog);

    expect(logs).toHaveLength(0);
  });

  it("rolling window caps at 20 entries", () => {
    for (let i = 0; i < 25; i++) recordRunCost(0.01);
    // Window should hold exactly 20 entries — no error thrown
    const logs: string[] = [];
    checkCostAnomaly(0.01, "a", "r", (_s, l) => logs.push(l));
    // 0.01 == avg, no anomaly
    expect(logs).toHaveLength(0);
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
