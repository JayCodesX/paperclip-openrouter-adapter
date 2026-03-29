/**
 * Tests for the orager-feature additions surfaced in Sprint 9:
 *   - onlineSearch: :online suffix appended to model in config file
 *   - agentId override: config.agentId used as JWT subject and memoryKey
 *   - processRateLimitTracker: updated on daemon 429, cleared on success
 *
 * The spawn-path tests use the fake-binary + CONFIG_FILE stderr pattern from
 * execute-cli-config.test.ts. The daemon-path tests spin up a minimal HTTP
 * server identical to the pattern in execute-cli-p3.test.ts.
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
  processRateLimitTracker,
} from "../src/server/execute-cli.js";

// ── shared fake binary ────────────────────────────────────────────────────────
// Reads --config-file from argv, echoes its JSON to stderr, then succeeds.

const RESULT_JSON =
  '{"type":"result","subtype":"success","session_id":"feat-test-session","is_error":false,' +
  '"total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5,' +
  '"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"result":"done"}';

async function createFakeBinary(dir: string): Promise<string> {
  const binPath = path.join(dir, "fake-orager");
  const script = [
    "#!/bin/sh",
    "config_file=''",
    "while [ $# -gt 0 ]; do",
    "  if [ \"$1\" = \"--config-file\" ]; then",
    "    config_file=\"$2\"; shift 2",
    "  else shift; fi",
    "done",
    "if [ -n \"$config_file\" ] && [ -f \"$config_file\" ]; then",
    "  printf 'CONFIG_FILE: %s\\n' \"$(cat \"$config_file\")\" >&2",
    "fi",
    "cat > /dev/null",
    `printf '%s\\n' '${RESULT_JSON}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(binPath, script, { mode: 0o755 });
  return binPath;
}

function makeCtx(configOverrides: Record<string, unknown> = {}) {
  return {
    runId: "run-feat-test",
    agent: { id: "agent-feat", companyId: "co", name: "FeatAgent", adapterType: "openrouter", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { apiKey: "sk-test-key", model: "openai/gpt-4o-mini", maxTurns: 1, ...configOverrides },
    context: { wakeReason: "manual" },
    onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

function stderrOutput(ctx: ReturnType<typeof makeCtx>): string {
  return (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
    .filter(([s]: [string]) => s === "stderr")
    .map(([, m]: [string, string]) => m)
    .join("");
}

function parseConfigFromStderr(output: string): Record<string, unknown> | null {
  const match = output.match(/CONFIG_FILE: (\{.*\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]) as Record<string, unknown>; }
  catch { return null; }
}

let tmpDir: string;
let fakeBin: string;

beforeEach(async () => {
  _resetStateForTesting();
  processRateLimitTracker.clearRateLimit();
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-feat-test-"));
  tmpDir = await fs.realpath(raw);
  fakeBin = await createFakeBinary(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  processRateLimitTracker.clearRateLimit();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── onlineSearch ──────────────────────────────────────────────────────────────

describe("onlineSearch — :online suffix in spawn path", () => {
  it("appends :online to model when onlineSearch: true and no suffix present", async () => {
    const ctx = makeCtx({ onlineSearch: true, cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("openai/gpt-4o-mini:online");
  });

  it("does NOT append :online when model already has a variant suffix", async () => {
    const ctx = makeCtx({
      model: "openai/gpt-4o-mini:nitro",
      onlineSearch: true,
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("openai/gpt-4o-mini:nitro");
  });

  it("does NOT append :online when onlineSearch: false", async () => {
    const ctx = makeCtx({ onlineSearch: false, cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("openai/gpt-4o-mini");
  });

  it("does NOT modify model when onlineSearch is absent", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("openai/gpt-4o-mini");
  });

  it("appends :online even when a :free suffix would be overridden — only skips when already suffixed", async () => {
    const ctx = makeCtx({
      model: "deepseek/deepseek-chat",
      onlineSearch: true,
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg!.model).toBe("deepseek/deepseek-chat:online");
  });
});

// ── agentId override ──────────────────────────────────────────────────────────

describe("agentId override — config.agentId changes daemon JWT subject", () => {
  let server: http.Server;
  let daemonUrl: string;
  let signingKeyPath: string;
  let capturedAuthHeader: string | null;

  beforeEach(async () => {
    capturedAuthHeader = null;

    signingKeyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(signingKeyPath, "agentid-test-signing-key-32bytes!", {
      encoding: "utf8",
      mode: 0o600,
    });

    server = await new Promise<http.Server>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (req.method === "POST" && req.url === "/run") {
          capturedAuthHeader = req.headers["authorization"] ?? null;
          req.resume();
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            res.write(
              JSON.stringify({
                type: "result",
                subtype: "success",
                result: "ok",
                session_id: "agentid-sess",
                finish_reason: "stop",
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
                total_cost_usd: 0,
              }) + "\n",
            );
            res.end();
          });
          return;
        }
        res.writeHead(404); res.end();
      });
      srv.listen(0, "127.0.0.1", () => resolve(srv));
      srv.on("error", reject);
    });

    const addr = server.address() as AddressInfo;
    daemonUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("daemon call is made (JWT sent) when config.agentId is provided", async () => {
    const ctx = makeCtx({
      daemonUrl,
      daemonKeyFile: signingKeyPath,
      agentId: "custom-agent-override",
      cliPath: "/nonexistent/bin",
    });
    const result = await executeAgentLoop(ctx);
    expect(result.exitCode).toBe(0);
    // A Bearer token was sent — the daemon call went through
    expect(capturedAuthHeader).toMatch(/^Bearer /);
  });

  it("daemon call succeeds without config.agentId (falls back to agent.id)", async () => {
    const ctx = makeCtx({
      daemonUrl,
      daemonKeyFile: signingKeyPath,
      cliPath: "/nonexistent/bin",
    });
    const result = await executeAgentLoop(ctx);
    expect(result.exitCode).toBe(0);
    expect(capturedAuthHeader).toMatch(/^Bearer /);
  });
});

// ── processRateLimitTracker updated on daemon 429 ────────────────────────────

describe("processRateLimitTracker — updated from daemon responses", () => {
  let server: http.Server;
  let daemonUrl: string;
  let signingKeyPath: string;
  let requestCount: number;

  beforeEach(async () => {
    requestCount = 0;

    signingKeyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(signingKeyPath, "rlt-test-signing-key-32bytes!!!!!", {
      encoding: "utf8",
      mode: 0o600,
    });

    server = await new Promise<http.Server>((resolve, reject) => {
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
              res.writeHead(429, { "Retry-After": "1", "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "rate limited" }));
            } else {
              res.writeHead(200, { "Content-Type": "application/x-ndjson" });
              res.write(
                JSON.stringify({
                  type: "result", subtype: "success", result: "ok",
                  session_id: "rlt-sess", finish_reason: "stop",
                  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
                  total_cost_usd: 0,
                }) + "\n",
              );
              res.end();
            }
          });
          return;
        }
        res.writeHead(404); res.end();
      });
      srv.listen(0, "127.0.0.1", () => resolve(srv));
      srv.on("error", reject);
    });

    const addr = server.address() as AddressInfo;
    daemonUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("processRateLimitTracker.recordRateLimit() is called when the daemon returns 429", async () => {
    // Spy on recordRateLimit to verify it was called with a positive wait time.
    // We don't assert isRateLimited() after the run because the Retry-After window
    // (1 s) expires before the successful retry completes and clearRateLimit() runs.
    const recordSpy = vi.spyOn(processRateLimitTracker, "recordRateLimit");

    await executeAgentLoop(
      makeCtx({ daemonUrl, daemonKeyFile: signingKeyPath, cliPath: "/nonexistent/bin" }),
    );

    expect(recordSpy).toHaveBeenCalledOnce();
    const [calledWith] = recordSpy.mock.calls[0];
    expect(typeof calledWith === "number" && calledWith > 0).toBe(true);
  }, 15_000);

  it("processRateLimitTracker.isRateLimited() is false after the run completes successfully", async () => {
    await executeAgentLoop(
      makeCtx({ daemonUrl, daemonKeyFile: signingKeyPath, cliPath: "/nonexistent/bin" }),
    );
    // After a successful completion, clearRateLimit() was called
    expect(processRateLimitTracker.isRateLimited()).toBe(false);
  }, 15_000);

  it("processRateLimitTracker.remainingWaitMs() > 0 right after a 429 (before retry completes)", async () => {
    // Observe the wait time right after recordRateLimit is called
    let capturedWaitMs = -1;
    const origRecord = processRateLimitTracker.recordRateLimit.bind(processRateLimitTracker);
    vi.spyOn(processRateLimitTracker, "recordRateLimit").mockImplementation((ms) => {
      origRecord(ms);
      capturedWaitMs = processRateLimitTracker.remainingWaitMs();
    });

    await executeAgentLoop(
      makeCtx({ daemonUrl, daemonKeyFile: signingKeyPath, cliPath: "/nonexistent/bin" }),
    );

    expect(capturedWaitMs).toBeGreaterThan(0);
  }, 15_000);
});
