/**
 * Integration tests for the executeAgentLoop daemon fast-path.
 *
 * Spins up a real HTTP server that acts as the orager daemon. Writes a
 * temporary signing key to ~/.orager/daemon.key and restores (or removes)
 * the original key in afterAll.
 *
 * Each test calls executeAgentLoop and inspects what the test server received
 * plus what the function returned.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeAgentLoop } from "../../src/server/execute-cli.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_SIGNING_KEY = "integration-test-key-32-bytes!!!";
const KEY_PATH = path.join(os.homedir(), ".orager", "daemon.key");
const DAEMON_KEY_DIR = path.join(os.homedir(), ".orager");

// ── Server state ──────────────────────────────────────────────────────────────

let server: http.Server;
let daemonBaseUrl: string;
let tmpDir: string;

/**
 * Captures the last /run request received by the test server so tests can
 * inspect the payload.
 */
let lastRunRequest: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> } | null =
  null;

/**
 * When set, the server uses this handler for the NEXT /run POST only, then
 * resets it to null. Useful for 503-retry and 401 tests.
 */
let nextRunHandler:
  | ((
      req: http.IncomingMessage,
      res: http.ServerResponse,
      body: Record<string, unknown>,
    ) => void)
  | null = null;

/** How many times /run has been called since the last reset. */
let runCallCount = 0;

// ── Standard NDJSON success stream ────────────────────────────────────────────

function writeSuccessStream(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Transfer-Encoding": "chunked",
  });
  res.write(
    JSON.stringify({
      type: "system",
      subtype: "init",
      model: "gpt-4o",
      session_id: "sess-integ",
    }) + "\n",
  );
  res.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Done",
      session_id: "sess-integ",
      finish_reason: "stop",
      total_cost_usd: 0.005,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
      },
    }) + "\n",
  );
  res.end();
}

// ── Helper: read body from IncomingMessage ─────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Test server ───────────────────────────────────────────────────────────────

function createTestServer(): http.Server {
  return http.createServer(async (req, res) => {
    const { method, url } = req;

    // GET /health
    if (method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeRuns: 0, maxConcurrent: 3 }));
      return;
    }

    // POST /run
    if (method === "POST" && url === "/run") {
      runCallCount++;

      let parsedBody: Record<string, unknown> = {};
      try {
        const raw = await readBody(req);
        parsedBody = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // ignore parse errors for error-path tests
      }

      // Capture for inspection
      lastRunRequest = { headers: req.headers, body: parsedBody };

      // Per-test handler override
      if (nextRunHandler) {
        const handler = nextRunHandler;
        nextRunHandler = null;
        handler(req, res, parsedBody);
        return;
      }

      // Default: success
      writeSuccessStream(res);
      return;
    }

    // Unhandled
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

// ── Original key backup ───────────────────────────────────────────────────────

let originalKeyContent: string | null = null;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create a temporary working directory for cwd
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adapter-integ-"));

  // 2. Start the test HTTP server on a random port
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  daemonBaseUrl = `http://127.0.0.1:${addr.port}`;

  // 3. Back up the existing daemon key (if any), then write the test key
  try {
    originalKeyContent = await fs.readFile(KEY_PATH, "utf8");
  } catch {
    originalKeyContent = null; // file doesn't exist — that's fine
  }
  await fs.mkdir(DAEMON_KEY_DIR, { recursive: true });
  await fs.writeFile(KEY_PATH, TEST_SIGNING_KEY, { mode: 0o600 });
});

afterAll(async () => {
  // Close the server
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );

  // Restore the original key (or delete the test key if there was none before)
  if (originalKeyContent !== null) {
    await fs.writeFile(KEY_PATH, originalKeyContent, { mode: 0o600 });
  } else {
    await fs.unlink(KEY_PATH).catch(() => {});
  }

  // Remove the temp dir
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  lastRunRequest = null;
  nextRunHandler = null;
  runCallCount = 0;
});

// ── Context factory ───────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}): Parameters<typeof executeAgentLoop>[0] {
  return {
    runId: "test-run-" + Math.random().toString(36).slice(2),
    agent: {
      id: "agent-test",
      companyId: "co-test",
      name: "IntegTest",
      adapterType: "openrouter",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      apiKey: "sk-test-key",
      daemonUrl: daemonBaseUrl,
      model: "gpt-4o",
      maxTurns: 5,
      cwd: tmpDir,
      promptTemplate: "Test task: {{context.task}}",
      ...overrides,
    },
    context: {
      task: "say hello",
      wakeReason: "test",
      paperclipWorkspace: { cwd: tmpDir },
      paperclipRuntimeServices: [],
    },
    onLog: vi.fn().mockResolvedValue(undefined),
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("adapter daemon flow — happy path", () => {
  it("sends a valid POST /run with JWT auth header", async () => {
    const ctx = makeCtx();
    await executeAgentLoop(ctx);

    expect(lastRunRequest).not.toBeNull();
    const auth = lastRunRequest!.headers.authorization ?? "";
    expect(auth).toMatch(/^Bearer /);
    // JWT has three dot-separated base64url segments
    const token = auth.slice("Bearer ".length);
    expect(token.split(".")).toHaveLength(3);
    // Body should have prompt and opts
    expect(typeof lastRunRequest!.body.prompt).toBe("string");
    expect(lastRunRequest!.body.opts).toBeDefined();
  });

  it("returns sessionId from the init event", async () => {
    const result = await executeAgentLoop(makeCtx());

    expect(result.sessionParams).toBeDefined();
    // sessionDisplayId or sessionParams.oragerSessionId should be "sess-integ"
    expect(
      result.sessionDisplayId === "sess-integ" ||
        (result.sessionParams as Record<string, unknown> | null)?.oragerSessionId === "sess-integ",
    ).toBe(true);
  });

  it("returns costUsd from the result event", async () => {
    const result = await executeAgentLoop(makeCtx());

    expect(result.costUsd).toBeCloseTo(0.005, 4);
  });

  it("returns exitCode 0 on success", async () => {
    const result = await executeAgentLoop(makeCtx());

    expect(result.exitCode).toBe(0);
  });

  it("returns usage from result event", async () => {
    const result = await executeAgentLoop(makeCtx());

    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(100);
    expect(result.usage!.outputTokens).toBe(50);
  });

  it("forwards opts.model to daemon body", async () => {
    await executeAgentLoop(makeCtx({ model: "gpt-4o" }));

    expect(lastRunRequest).not.toBeNull();
    const opts = lastRunRequest!.body.opts as Record<string, unknown>;
    expect(opts.model).toBe("gpt-4o");
  });

  it("forwards dangerouslySkipPermissions to daemon opts", async () => {
    await executeAgentLoop(makeCtx({ dangerouslySkipPermissions: true }));

    expect(lastRunRequest).not.toBeNull();
    const opts = lastRunRequest!.body.opts as Record<string, unknown>;
    expect(opts.dangerouslySkipPermissions).toBe(true);
  });
});

describe("adapter daemon flow — error paths", () => {
  it("daemon 401 → returns error result with errorCode auth_error", async () => {
    nextRunHandler = (_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
    };

    const result = await executeAgentLoop(makeCtx());

    // 401 is a hard error (not a fallback) — adapter returns an error result
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("auth_error");
  });

  it("daemon 503 first, success on retry", async () => {
    // First call → 503 with Retry-After: 0 (so the test doesn't wait)
    // Second call → success stream
    let callsSeen = 0;
    nextRunHandler = (_req, res, _body) => {
      callsSeen++;
      if (callsSeen === 1) {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": "0",
        });
        res.end(JSON.stringify({ error: "at capacity" }));
        // Re-arm the handler so the second call also goes through nextRunHandler
        nextRunHandler = (_req2, res2) => {
          writeSuccessStream(res2);
        };
        return;
      }
      writeSuccessStream(res);
    };

    const result = await executeAgentLoop(makeCtx());

    // After the retry the run should succeed
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBeCloseTo(0.005, 4);
  });

  it("daemon unavailable (connection refused) → result is defined with error info", async () => {
    // Point daemonUrl at a port where nothing is listening.
    // Also set cliPath to a nonexistent binary so the spawn fallback fails fast.
    const unusedPort = 19999; // Very unlikely to be in use
    const ctx = makeCtx({
      daemonUrl: `http://127.0.0.1:${unusedPort}`,
      cliPath: "/nonexistent/orager",
    });

    const result = await executeAgentLoop(ctx);

    // Result must be defined regardless of failure mode
    expect(result).toBeDefined();
    // The spawn fallback will fail because /nonexistent/orager does not exist
    expect(result.exitCode).not.toBeNull();
  });
});
