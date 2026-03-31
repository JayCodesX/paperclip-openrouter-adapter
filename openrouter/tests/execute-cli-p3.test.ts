/**
 * P3 tests for executeAgentLoop:
 *   - daemon circuit breaker: after DAEMON_CB_THRESHOLD failures the adapter
 *     bypasses the daemon (logs a warning) and falls through to spawn
 *   - structured log run_complete: fields written to ORAGER_LOG_FILE include
 *     inputTokens, outputTokens, cachedInputTokens, turnCount, subtype, costUsd
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  executeAgentLoop,
  _resetStateForTesting,
  _drainStructuredLogForTesting,
  recordDaemonFailure,
  recordDaemonSuccess,
  isDaemonCircuitOpen,
  DAEMON_CB_THRESHOLD,
  DAEMON_CB_RESET_MS,
} from "../src/server/execute-cli.js";

// ── fake orager binary ────────────────────────────────────────────────────────

const RESULT_JSON =
  '{"type":"result","subtype":"success","session_id":"cb-test-session","is_error":false,' +
  '"total_cost_usd":0.002,"turn_count":3,' +
  '"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":5,"cache_read_input_tokens":20},' +
  '"result":"done"}';

async function createFakeBinary(dir: string): Promise<string> {
  const binPath = path.join(dir, "fake-orager");
  const script = [
    "#!/bin/sh",
    "cat > /dev/null",
    `printf '%s\\n' '${RESULT_JSON}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(binPath, script, { mode: 0o755 });
  return binPath;
}

function makeCtx(configOverrides: Record<string, unknown> = {}) {
  return {
    runId: "run-p3-test",
    agent: {
      id: "agent-p3",
      companyId: "co",
      name: "P3Agent",
      adapterType: "openrouter",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      apiKey: "sk-test-key",
      model: "openai/gpt-4o-mini",
      maxTurns: 1,
      ...configOverrides,
    },
    context: { wakeReason: "manual" },
    onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

let tmpDir: string;
let fakeBin: string;

beforeEach(async () => {
  _resetStateForTesting();
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-p3-test-"));
  tmpDir = await fs.realpath(raw);
  fakeBin = await createFakeBinary(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── daemon circuit breaker ────────────────────────────────────────────────────

describe("daemon circuit breaker fallback", () => {
  it("isDaemonCircuitOpen returns false initially", () => {
    expect(isDaemonCircuitOpen("http://127.0.0.1:3456")).toBe(false);
  });

  it("isDaemonCircuitOpen returns true after DAEMON_CB_THRESHOLD failures", () => {
    const url = "http://127.0.0.1:3456";
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url);
    }
    expect(isDaemonCircuitOpen(url)).toBe(true);
  });

  it("logs 'circuit breaker open' warning and falls through to spawn", async () => {
    const daemonUrl = "http://127.0.0.1:19998";
    // Trip the circuit breaker
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(daemonUrl);
    }

    const ctx = makeCtx({ daemonUrl, cliPath: fakeBin, cwd: tmpDir });
    const result = await executeAgentLoop(ctx);

    // Verify circuit-open warning was logged
    const stderr = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([s]: [string]) => s === "stderr")
      .map(([, m]: [string, string]) => m)
      .join("");
    expect(stderr).toMatch(/circuit breaker open/i);

    // Verify run succeeded via spawn (not daemon)
    expect(result.exitCode).toBe(0);
  });

  it("circuit breaker is per-URL — different URLs are independent", () => {
    const url1 = "http://127.0.0.1:3456";
    const url2 = "http://127.0.0.1:3457";
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url1);
    }
    expect(isDaemonCircuitOpen(url1)).toBe(true);
    expect(isDaemonCircuitOpen(url2)).toBe(false);
  });

  it("goes half-open after DAEMON_CB_RESET_MS and allows one probe", () => {
    const url = "http://127.0.0.1:3456";
    // Open the circuit
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url);
    }
    expect(isDaemonCircuitOpen(url)).toBe(true);

    // Advance time past the reset window by temporarily overriding Date.now
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(realNow() + DAEMON_CB_RESET_MS + 1);
    try {
      // Half-open: should allow one probe
      expect(isDaemonCircuitOpen(url)).toBe(false);
    } finally {
      vi.spyOn(Date, "now").mockRestore();
    }
  });

  it("re-opens after a failed half-open probe", () => {
    const url = "http://127.0.0.1:3456";
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url);
    }

    // Advance into half-open window
    const realNow = Date.now;
    const now = realNow() + DAEMON_CB_RESET_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(isDaemonCircuitOpen(url)).toBe(false); // half-open probe allowed

    // Probe fails
    recordDaemonFailure(url);

    // Circuit should be open again (openedAt reset to mock-now)
    expect(isDaemonCircuitOpen(url)).toBe(true);

    vi.spyOn(Date, "now").mockRestore();
  });

  it("fully resets after a successful half-open probe", () => {
    const url = "http://127.0.0.1:3456";
    for (let i = 0; i < DAEMON_CB_THRESHOLD; i++) {
      recordDaemonFailure(url);
    }

    // Half-open
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(realNow() + DAEMON_CB_RESET_MS + 1);
    expect(isDaemonCircuitOpen(url)).toBe(false);
    vi.spyOn(Date, "now").mockRestore();

    // Probe succeeds
    recordDaemonSuccess(url);

    // Circuit fully closed: fresh failures count from zero
    expect(isDaemonCircuitOpen(url)).toBe(false);
    for (let i = 0; i < DAEMON_CB_THRESHOLD - 1; i++) {
      recordDaemonFailure(url);
    }
    expect(isDaemonCircuitOpen(url)).toBe(false); // one below threshold
  });
});

// ── structured log run_complete fields ───────────────────────────────────────
// Uses _drainStructuredLogForTesting() which captures all structuredLog() calls
// into an in-memory buffer (regardless of ORAGER_LOG_FILE).

describe("structured log run_complete fields", () => {
  it("writes run_complete event with usage and subtype fields", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    const result = await executeAgentLoop(ctx);
    expect(result.exitCode).toBe(0);

    const entries = _drainStructuredLogForTesting();
    const runComplete = entries.find((e) => e.event === "run_complete");
    expect(runComplete).toBeTruthy();

    expect(runComplete!.level).toBe("info");
    expect(runComplete!.agentId).toBe("agent-p3");
    expect(runComplete!.runId).toBe("run-p3-test");
    expect(typeof runComplete!.durationMs).toBe("number");
    expect(runComplete!.subtype).toBe("success");

    // Usage fields from the fake binary result JSON
    expect(runComplete!.inputTokens).toBe(100);
    expect(runComplete!.outputTokens).toBe(50);
    expect(runComplete!.cachedInputTokens).toBe(20);
    expect(typeof runComplete!.costUsd).toBe("number");
  });

  it("also writes a run_start event before run_complete", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);

    const events = _drainStructuredLogForTesting().map((e) => e.event);
    expect(events).toContain("run_start");
    expect(events).toContain("run_complete");
    expect(events.indexOf("run_start")).toBeLessThan(events.indexOf("run_complete"));
  });

  it("writes cacheWriteInputTokens in run_complete when binary reports cache_creation_input_tokens", async () => {
    // RESULT_JSON (defined at the top of this file) includes cache_creation_input_tokens:5
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);

    const entries = _drainStructuredLogForTesting();
    const runComplete = entries.find((e) => e.event === "run_complete");
    expect(runComplete).toBeTruthy();
    // cache_creation_input_tokens: 5 in the fake binary output → cacheWriteInputTokens: 5
    expect(runComplete!.cacheWriteInputTokens).toBe(5);
  });
});

// ── T4: daemon stream parse error → structuredLog ─────────────────────────────
// Verifies that when the daemon returns a stream line that looks like JSON
// but is malformed, the adapter emits a structured log entry with
// event: "daemon_stream_parse_error" in addition to the stderr warning.

describe("daemon stream parse error → structuredLog", () => {
  let server: import("node:http").Server;
  let daemonUrl: string;
  let signingKeyPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    _resetStateForTesting();
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-t4-"));
    tmpDir = await fs.realpath(raw);

    // Write a test signing key file so the adapter can mint a JWT
    signingKeyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(signingKeyPath, "t4-test-signing-key-32bytes!!!!", { encoding: "utf8", mode: 0o600 });

    // Start a minimal mock daemon that returns one bad JSON line then a valid result
    server = await new Promise<import("node:http").Server>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (req.method === "POST" && req.url === "/run") {
          // Consume body
          req.resume();
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            // One malformed JSON line (starts with '{' so adapter should warn+log)
            res.write("{ this is malformed json }\n");
            // One valid result line
            res.write(
              JSON.stringify({
                type: "result",
                subtype: "success",
                result: "ok",
                session_id: "t4-sess",
                finish_reason: "stop",
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
                total_cost_usd: 0,
              }) + "\n",
            );
            res.end();
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });
      srv.listen(0, "127.0.0.1", () => resolve(srv));
      srv.on("error", reject);
    });
    const addr = server.address() as AddressInfo;
    daemonUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("emits daemon_stream_parse_error to structured log when stream contains malformed JSON", async () => {
    const ctx = {
      runId: "run-t4",
      agent: { id: "agent-t4", companyId: "co", name: "T4Agent", adapterType: "openrouter", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl,
        daemonKeyFile: signingKeyPath,
        cliPath: "/nonexistent/orager-binary-xyz",
      },
      context: { wakeReason: "manual" },
      onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
      onMeta: vi.fn().mockResolvedValue(undefined),
    };

    await executeAgentLoop(ctx);

    const entries = _drainStructuredLogForTesting();
    const parseErrors = entries.filter((e) => e.event === "daemon_stream_parse_error");
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(parseErrors[0].linePreview).toContain("malformed");
  });

  it("also logs a stderr warning for the malformed line", async () => {
    const ctx = {
      runId: "run-t4b",
      agent: { id: "agent-t4b", companyId: "co", name: "T4BAgent", adapterType: "openrouter", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl,
        daemonKeyFile: signingKeyPath,
        cliPath: "/nonexistent/orager-binary-xyz",
      },
      context: { wakeReason: "manual" },
      onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
      onMeta: vi.fn().mockResolvedValue(undefined),
    };

    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([s]: [string]) => s === "stderr")
      .map(([, m]: [string, string]) => m)
      .join("");

    expect(stderrLines).toMatch(/failed to parse JSON event/i);
  });
});

// ── T5: 429 Retry-After back-off ──────────────────────────────────────────────
// Verifies that when the daemon returns 429, the adapter waits the specified
// Retry-After duration, retries once with a fresh JWT, and succeeds on the
// second attempt.

describe("daemon 429 Retry-After back-off", () => {
  let server: import("node:http").Server;
  let daemonUrl: string;
  let signingKeyPath: string;
  let tmpDir: string;
  let requestCount: number;

  beforeEach(async () => {
    _resetStateForTesting();
    requestCount = 0;

    const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-t5-"));
    tmpDir = await fs.realpath(raw);

    signingKeyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(signingKeyPath, "t5-test-signing-key-32bytes!!!!", { encoding: "utf8", mode: 0o600 });

    server = await new Promise<import("node:http").Server>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (req.method === "POST" && req.url === "/run") {
          requestCount++;
          req.resume();
          req.on("end", () => {
            if (requestCount === 1) {
              // First request: 429 with a short Retry-After
              res.writeHead(429, { "Retry-After": "1", "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "rate limited" }));
            } else {
              // Second request: success
              res.writeHead(200, { "Content-Type": "application/x-ndjson" });
              res.write(
                JSON.stringify({
                  type: "result",
                  subtype: "success",
                  result: "ok",
                  session_id: "t5-sess",
                  finish_reason: "stop",
                  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
                  total_cost_usd: 0,
                }) + "\n",
              );
              res.end();
            }
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });
      srv.listen(0, "127.0.0.1", () => resolve(srv));
      srv.on("error", reject);
    });
    const addr = server.address() as AddressInfo;
    daemonUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("retries after 429 and succeeds on second attempt", async () => {
    const ctx = {
      runId: "run-t5",
      agent: { id: "agent-t5", companyId: "co", name: "T5Agent", adapterType: "openrouter", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl,
        daemonKeyFile: signingKeyPath,
        cliPath: "/nonexistent/orager-binary-xyz",
      },
      context: { wakeReason: "manual" },
      onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
      onMeta: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeAgentLoop(ctx);

    // Should have made exactly 2 POST /run requests (first got 429, second succeeded)
    expect(requestCount).toBe(2);
    // Result should be successful (from the second request)
    expect(result.exitCode).toBe(0);
  }, 15_000); // generous timeout for the 1s retry-after wait

  it("logs a rate-limited warning on 429", async () => {
    const ctx = {
      runId: "run-t5b",
      agent: { id: "agent-t5b", companyId: "co", name: "T5BAgent", adapterType: "openrouter", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl,
        daemonKeyFile: signingKeyPath,
        cliPath: "/nonexistent/orager-binary-xyz",
      },
      context: { wakeReason: "manual" },
      onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
      onMeta: vi.fn().mockResolvedValue(undefined),
    };

    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([s]: [string]) => s === "stderr")
      .map(([, m]: [string, string]) => m)
      .join("");

    expect(stderrLines).toMatch(/rate.limit/i);
  }, 15_000);
});
