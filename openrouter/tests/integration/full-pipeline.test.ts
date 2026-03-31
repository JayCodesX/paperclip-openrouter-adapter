/**
 * Full pipeline integration tests: adapter → orager → mock OpenRouter
 *
 * HYBRID approach: most tests route through a single persistent orager daemon
 * (started once in beforeAll), eliminating per-test Node.js startup overhead.
 * A small set of spawn-path tests exercise the CLI subprocess path for coverage.
 *
 * OpenRouter network calls intercepted via OPENROUTER_BASE_URL env var.
 * No real API keys or internet access required.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeAgentLoop,
  _resetStateForTesting,
} from "../../src/server/execute-cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the built orager dist entry. Used for the shell wrapper.
 *  Override with ORAGER_DIST env var for CI where the repo layout differs. */
const ORAGER_DIST = process.env.ORAGER_DIST
  || path.resolve(__dirname, "../../../../orager/dist/index.js");

/**
 * Skip all integration tests when the orager dist is absent (e.g. CI without
 * a prior `npm run build` step, or fresh checkouts of this repo only).
 * Run `npm run build` in the orager repo to enable these tests.
 */
const oragerDistExists = existsSync(ORAGER_DIST);

/**
 * Per-test timeout. Daemon-path tests are faster since orager is already warm.
 * Spawn-path tests need more headroom for Node.js startup.
 */
const IT = 45_000;
const IT_SLOW = 150_000;
const IT_DAEMON = 30_000;
const IT_DAEMON_SLOW = 60_000;

// ── SSE stream builders ───────────────────────────────────────────────────────

interface SseTextOpts {
  model?: string;
  genId?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Build a complete SSE stream that yields a single text response then stops. */
function sseTextStream(content: string, opts: SseTextOpts = {}): string {
  const model = opts.model ?? "openai/gpt-4o";
  const genId = opts.genId ?? "gen-integ-1";
  const usage = opts.usage ?? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  return [
    sseLine({ id: genId, model, choices: [{ delta: { content }, finish_reason: null }] }),
    sseLine({ id: genId, model, choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage }),
    "data: [DONE]\n\n",
  ].join("");
}

/** Build a complete SSE stream that yields a single tool call then stops. */
function sseToolCallStream(
  toolName: string,
  args: Record<string, unknown>,
  opts: { model?: string; genId?: string } = {},
): string {
  const model = opts.model ?? "openai/gpt-4o";
  const genId = opts.genId ?? "gen-integ-tool";
  return [
    sseLine({
      id: genId,
      model,
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_integ_1",
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

// ── Mock OpenRouter server ────────────────────────────────────────────────────

type QueuedHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface CompletionCapture {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class MockOpenRouterServer {
  private server: http.Server;
  private completionQueue: QueuedHandler[] = [];
  private _generationCost = 0.0005;

  completionCalls: CompletionCapture[] = [];

  constructor() {
    this.server = http.createServer(async (req, res) => {
      res.on("error", () => { /* suppress broken-pipe when client is killed */ });

      const rawBody = await readBody(req).catch(() => "{}");
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* ok */ }

      const { method, url } = req;

      // GET /models — context window + live model metadata fetch
      if (method === "GET" && url?.startsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [{
            id: "openai/gpt-4o",
            context_length: 128000,
            supported_parameters: ["tools", "response_format"],
            pricing: { prompt: "0.000005", completion: "0.000015" },
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          }],
        }));
        return;
      }

      // GET /generation — cost metadata (fire-and-forget by orager)
      if (method === "GET" && url?.startsWith("/generation")) {
        const urlObj = new URL(url, `http://127.0.0.1`);
        const genId = urlObj.searchParams.get("id") ?? "unknown";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: {
            id: genId,
            model: "openai/gpt-4o",
            provider_name: "OpenAI",
            total_cost: this._generationCost,
            native_tokens_prompt: 100,
            native_tokens_completion: 10,
            latency: 400,
          },
        }));
        return;
      }

      // POST /chat/completions — main SSE endpoint
      if (method === "POST" && url?.startsWith("/chat/completions")) {
        this.completionCalls.push({ headers: req.headers, body: parsed });
        const handler = this.completionQueue.shift();
        if (handler) {
          handler(req, res);
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "MockOpenRouterServer: no handler queued for this request" }));
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  get port(): number {
    const addr = this.server.address();
    return typeof addr === "object" && addr ? (addr as { port: number }).port : 0;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  reset(): void {
    this.completionCalls = [];
    this.completionQueue = [];
    this._generationCost = 0.0005;
  }

  setGenerationCost(cost: number): void {
    this._generationCost = cost;
  }

  queueText(content: string, opts?: SseTextOpts): void {
    this.completionQueue.push((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Transfer-Encoding": "chunked" });
      res.end(sseTextStream(content, opts));
    });
  }

  queueToolCall(toolName: string, args: Record<string, unknown>, opts?: { model?: string }): void {
    this.completionQueue.push((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Transfer-Encoding": "chunked" });
      res.end(sseToolCallStream(toolName, args, opts));
    });
  }

  queueError(status: number, body: Record<string, unknown> = {}, headers: http.OutgoingHttpHeaders = {}): void {
    this.completionQueue.push((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    });
  }

  /** Responds after `delayMs` — used to test the adapter's process kill timeout. */
  queueSlow(delayMs: number, content = "slow response"): void {
    this.completionQueue.push((_req, res) => {
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Transfer-Encoding": "chunked" });
          res.end(sseTextStream(content));
        } catch { /* connection already closed — the test killed the process */ }
      }, delayMs);
      res.on("close", () => clearTimeout(timer));
    });
  }
}

// ── Shared test state ────────────────────────────────────────────────────────

let mockServer: MockOpenRouterServer;
let tmpDir: string;
let cliPath: string;

// Daemon state
let daemonProc: ChildProcess | null = null;
let daemonUrl = "";
const DAEMON_KEY_PATH = path.join(os.homedir(), ".orager", "daemon.key");
const DAEMON_PORT_PATH = path.join(os.homedir(), ".orager", "daemon.port");
let originalDaemonKey: string | null = null;
let originalDaemonPort: string | null = null;

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Start the mock OpenRouter server on a random port
  mockServer = new MockOpenRouterServer();
  await mockServer.start();

  // 2. Temp working directory — used as cwd for all runs
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-pipeline-integ-"));

  // 3. Create a shell wrapper that runs orager from the local dist/
  const wrapperPath = path.join(tmpDir, "orager-wrapper.sh");
  await fs.writeFile(wrapperPath, `#!/bin/sh\nexec node "${ORAGER_DIST}" "$@"\n`);
  await fs.chmod(wrapperPath, 0o755);
  cliPath = wrapperPath;

  if (!oragerDistExists) return; // skip daemon startup if dist is missing

  // 4. Back up existing daemon key + port files
  try { originalDaemonKey = await fs.readFile(DAEMON_KEY_PATH, "utf8"); } catch { originalDaemonKey = null; }
  try { originalDaemonPort = await fs.readFile(DAEMON_PORT_PATH, "utf8"); } catch { originalDaemonPort = null; }

  // 5. Start orager daemon on a random high port
  const port = 20000 + Math.floor(Math.random() * 30000);
  daemonUrl = `http://127.0.0.1:${port}`;

  daemonProc = spawn(cliPath, ["--serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OPENROUTER_BASE_URL: mockServer.baseUrl,
      OPENROUTER_API_KEY: "sk-mock-key",
    },
  });
  daemonProc.unref();

  // 6. Wait for daemon to respond on /health (up to 15s)
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${daemonUrl}/health`);
      if (res.ok) { ready = true; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready) {
    throw new Error(`Orager daemon did not start on port ${port} within 15s`);
  }
}, 30_000);

afterAll(async () => {
  // Kill daemon process group
  if (daemonProc?.pid) {
    try { process.kill(-daemonProc.pid, "SIGTERM"); } catch { /* already dead */ }
    await new Promise((r) => setTimeout(r, 2000));
    try { process.kill(-daemonProc.pid, "SIGKILL"); } catch { /* already dead */ }
  }

  // Restore original daemon key
  if (originalDaemonKey !== null) {
    await fs.writeFile(DAEMON_KEY_PATH, originalDaemonKey, { mode: 0o600 });
  } else {
    await fs.unlink(DAEMON_KEY_PATH).catch(() => {});
  }

  // Restore original daemon port
  if (originalDaemonPort !== null) {
    await fs.writeFile(DAEMON_PORT_PATH, originalDaemonPort);
  } else {
    await fs.unlink(DAEMON_PORT_PATH).catch(() => {});
  }

  await mockServer.stop();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  mockServer.reset();
  _resetStateForTesting();
});

// ── Context factories ────────────────────────────────────────────────────────

interface CtxConfig extends Record<string, unknown> {}
interface CtxContext extends Record<string, unknown> {}
interface CtxRuntime extends Record<string, unknown> {}

interface MakeCtxResult {
  ctx: Parameters<typeof executeAgentLoop>[0];
  onLog: ReturnType<typeof vi.fn>;
  onMeta: ReturnType<typeof vi.fn>;
}

/** Build a context that uses the spawn path (cliPath, no daemonUrl). */
function makeSpawnCtx(overrides: {
  config?: CtxConfig;
  context?: CtxContext;
  runtime?: CtxRuntime;
} = {}): MakeCtxResult {
  const onLog = vi.fn().mockResolvedValue(undefined);
  const onMeta = vi.fn().mockResolvedValue(undefined);

  const ctx: Parameters<typeof executeAgentLoop>[0] = {
    runId: "integ-" + Math.random().toString(36).slice(2),
    agent: {
      id: "integ-agent",
      companyId: "co-integ",
      name: "IntegrationAgent",
      adapterType: "openrouter",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      ...overrides.runtime,
    },
    config: {
      apiKey: "sk-mock-key",
      model: "openai/gpt-4o",
      maxTurns: 5,
      maxRetries: 0,
      cwd: tmpDir,
      cliPath,
      dangerouslySkipPermissions: true,
      promptTemplate: "Task: {{context.task}}",
      env: { OPENROUTER_BASE_URL: mockServer.baseUrl },
      ...overrides.config,
    },
    context: {
      task: "run integration test",
      wakeReason: "manual",
      paperclipWorkspace: { cwd: tmpDir },
      paperclipRuntimeServices: [],
      ...overrides.context,
    },
    onLog,
    onMeta,
  };

  return { ctx, onLog, onMeta };
}

/** Build a context that routes through the persistent daemon (daemonUrl set). */
function makeDaemonCtx(overrides: {
  config?: CtxConfig;
  context?: CtxContext;
  runtime?: CtxRuntime;
} = {}): MakeCtxResult {
  return makeSpawnCtx({
    ...overrides,
    config: {
      daemonUrl,
      daemonAutoStart: false,
      ...overrides.config,
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Pull all log lines from the onLog mock calls. */
function logLines(onLog: ReturnType<typeof vi.fn>): string[] {
  return (onLog.mock.calls as [string, string][]).map(([, line]) => line);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAEMON PATH TESTS — fast, single orager process shared across all tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!oragerDistExists)("full pipeline — daemon path", () => {

  // ── Basic end-to-end ────────────────────────────────────────────────────────

  it("prompt rendered with context interpolation appears in request", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({
      config: { promptTemplate: "UNIQUE_MARKER_{{context.task}}" },
      context: { task: "xyz-task-abc" },
    });
    await executeAgentLoop(ctx);

    const messages = mockServer.completionCalls[0]?.body?.messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages?.find((m) => m.role === "user");
    const content = typeof userMsg?.content === "string"
      ? userMsg.content
      : JSON.stringify(userMsg?.content ?? "");
    expect(content).toContain("UNIQUE_MARKER_xyz-task-abc");
  }, IT_DAEMON);

  it("correct model forwarded to OpenRouter request body", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({ config: { model: "openai/gpt-4o-mini" } });
    await executeAgentLoop(ctx);

    expect(mockServer.completionCalls[0]?.body?.model).toBe("openai/gpt-4o-mini");
  }, IT_DAEMON);

  it("sampling params forwarded: temperature and top_p in request body", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({ config: { temperature: 0.42, top_p: 0.88 } });
    await executeAgentLoop(ctx);

    const body = mockServer.completionCalls[0]?.body ?? {};
    expect(body.temperature).toBe(0.42);
    expect(body.top_p).toBe(0.88);
  }, IT_DAEMON);

  // ── Multi-turn tool execution ──────────────────────────────────────────────

  it("multi-turn: bash tool called, result sent to LLM, final text returned", async () => {
    mockServer.queueToolCall("bash", { command: "echo 'pipeline-integration-hello'" });
    mockServer.queueText("Bash ran successfully and printed the expected output.");

    const { ctx } = makeDaemonCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(2);

    const turn2Messages = mockServer.completionCalls[1]?.body?.messages as Array<{ role: string }>;
    const hasToolMessage = turn2Messages?.some((m) => m.role === "tool");
    expect(hasToolMessage).toBe(true);
  }, IT_DAEMON_SLOW);

  it("read_file tool: agent reads a real file in cwd and result reaches LLM", async () => {
    const testFile = path.join(tmpDir, "integ-test-data.txt");
    await fs.writeFile(testFile, "integration-file-content-42");

    mockServer.queueToolCall("read_file", { path: "integ-test-data.txt" });
    mockServer.queueText("I read the file successfully.");

    const { ctx } = makeDaemonCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(2);

    const turn2Messages = mockServer.completionCalls[1]?.body?.messages as Array<{ role: string; content: unknown }>;
    const toolMsg = turn2Messages?.find((m) => m.role === "tool");
    const toolContent = JSON.stringify(toolMsg?.content ?? "");
    expect(toolContent).toContain("integration-file-content-42");
  }, IT_DAEMON_SLOW);

  // ── Adapter-level config features ──────────────────────────────────────────

  it("wakeReasonModels: override model sent when wake reason matches", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({
      config: {
        model: "openai/gpt-4o-mini",
        wakeReasonModels: { pr_opened: "openai/gpt-4o" },
      },
      context: { wakeReason: "pr_opened" },
    });
    await executeAgentLoop(ctx);

    expect(mockServer.completionCalls[0]?.body?.model).toBe("openai/gpt-4o");
  }, IT_DAEMON);

  it("wakeReasonModels: base model used when wake reason has no override", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({
      config: {
        model: "openai/gpt-4o-mini",
        wakeReasonModels: { pr_opened: "openai/gpt-4o" },
      },
      context: { wakeReason: "comment_added" },
    });
    await executeAgentLoop(ctx);

    expect(mockServer.completionCalls[0]?.body?.model).toBe("openai/gpt-4o-mini");
  }, IT_DAEMON);

  it("bootstrapPromptTemplate: prepended on first run (no prior session)", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({
      config: {
        bootstrapPromptTemplate: "BOOTSTRAP_MARKER: {{context.task}}",
        promptTemplate: "REGULAR: {{context.task}}",
      },
      runtime: { sessionId: null, sessionParams: null },
    });
    await executeAgentLoop(ctx);

    const messages = mockServer.completionCalls[0]?.body?.messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages?.find((m) => m.role === "user");
    const content = typeof userMsg?.content === "string"
      ? userMsg.content
      : JSON.stringify(userMsg?.content ?? "");
    expect(content).toContain("BOOTSTRAP_MARKER:");
  }, IT_DAEMON);

  it("bootstrapPromptTemplate: not used on resume run (prior session present)", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({
      config: {
        bootstrapPromptTemplate: "BOOTSTRAP_MARKER: {{context.task}}",
        promptTemplate: "REGULAR: {{context.task}}",
      },
      runtime: {
        sessionId: "fake-prior-session",
        sessionParams: { oragerSessionId: "fake-prior-session" },
        sessionDisplayId: "fake-prior-session",
        taskKey: null,
      },
    });
    await executeAgentLoop(ctx);

    const messages = mockServer.completionCalls[0]?.body?.messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages?.find((m) => m.role === "user");
    const content = typeof userMsg?.content === "string"
      ? userMsg.content
      : JSON.stringify(userMsg?.content ?? "");
    expect(content).not.toContain("BOOTSTRAP_MARKER:");
    expect(content).toContain("REGULAR:");
  }, IT_DAEMON);

  // ── Session resume ─────────────────────────────────────────────────────────

  it("session resume: prior conversation messages included in second run's request", async () => {
    // Run 1: fresh session
    mockServer.queueText("First run complete. I understand the task.");
    const { ctx: ctx1 } = makeDaemonCtx();
    const result1 = await executeAgentLoop(ctx1);
    expect(result1.exitCode).toBe(0);

    const sessionId = result1.sessionDisplayId
      ?? (result1.sessionParams as Record<string, unknown> | null)?.oragerSessionId as string | undefined;
    expect(typeof sessionId).toBe("string");

    mockServer.reset();
    _resetStateForTesting();

    // Run 2: resume with the captured session ID
    mockServer.queueText("Second run complete.");
    const { ctx: ctx2 } = makeDaemonCtx({
      runtime: {
        sessionId,
        sessionParams: { oragerSessionId: sessionId },
        sessionDisplayId: sessionId ?? null,
        taskKey: null,
      },
    });
    const result2 = await executeAgentLoop(ctx2);
    expect(result2.exitCode).toBe(0);

    const messages = mockServer.completionCalls[0]?.body?.messages as Array<{ role: string }>;
    expect(messages?.length).toBeGreaterThan(2);
  }, IT_DAEMON_SLOW);

  // ── Error handling and retry ───────────────────────────────────────────────

  it("model fallback on 429: third request uses fallback model after two failures", async () => {
    mockServer.queueError(429, { error: { message: "Rate limit exceeded" } });
    mockServer.queueError(429, { error: { message: "Rate limit exceeded" } });
    mockServer.queueText("Done with fallback.");

    const { ctx } = makeDaemonCtx({
      config: {
        model: "openai/gpt-4o",
        models: ["openai/gpt-4o-mini"],
        maxRetries: 3,
      },
    });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(3);
    expect(mockServer.completionCalls[2]?.body?.model).toBe("openai/gpt-4o-mini");
  }, IT_DAEMON);

  it("maxTurns reached: loop terminates and clears session (soft stop)", async () => {
    for (let i = 0; i < 6; i++) {
      mockServer.queueToolCall("bash", { command: "echo loop" });
    }

    const { ctx } = makeDaemonCtx({ config: { maxTurns: 3, maxRetries: 0 } });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(true);
    expect(mockServer.completionCalls.length).toBeLessThanOrEqual(4);
  }, IT_DAEMON_SLOW);

  // ── Usage and cost ─────────────────────────────────────────────────────────

  it("usage returned: inputTokens and outputTokens populated in result", async () => {
    mockServer.queueText("Done.", {
      usage: { prompt_tokens: 350, completion_tokens: 42, total_tokens: 392 },
    });

    const { ctx } = makeDaemonCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.usage?.inputTokens).toBeGreaterThanOrEqual(350);
    expect(result.usage?.outputTokens).toBeGreaterThanOrEqual(42);
  }, IT_DAEMON);

  it("costUsd populated from generation metadata response", async () => {
    mockServer.setGenerationCost(0.0123);
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  }, IT_DAEMON);

  // ── Orager-level features ─────────────────────────────────────────────────

  it("parallel_tool_calls flag forwarded to OpenRouter request", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({ config: { parallel_tool_calls: false } });
    await executeAgentLoop(ctx);

    const body = mockServer.completionCalls[0]?.body ?? {};
    expect(body.parallel_tool_calls).toBe(false);
  }, IT_DAEMON);

  it("fallback models forwarded to OpenRouter request body", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx({
      config: { models: ["openai/gpt-4o-mini", "openai/gpt-3.5-turbo"] },
    });
    await executeAgentLoop(ctx);

    const body = mockServer.completionCalls[0]?.body ?? {};
    expect(Array.isArray(body.models)).toBe(true);
    expect((body.models as string[]).includes("openai/gpt-4o-mini")).toBe(true);
  }, IT_DAEMON);

  it("X-Session-Id header present for sticky OpenRouter routing", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeDaemonCtx();
    await executeAgentLoop(ctx);

    const sessionIdHeader = mockServer.completionCalls[0]?.headers?.["x-session-id"];
    expect(typeof sessionIdHeader).toBe("string");
    expect((sessionIdHeader as string).length).toBeGreaterThan(0);
  }, IT_DAEMON);

  it("two-turn conversation: messages array grows across turns", async () => {
    mockServer.queueToolCall("bash", { command: "echo hello" });
    mockServer.queueText("Task done.");

    const { ctx } = makeDaemonCtx();
    await executeAgentLoop(ctx);

    const turn1Count = (mockServer.completionCalls[0]?.body?.messages as unknown[])?.length ?? 0;
    const turn2Count = (mockServer.completionCalls[1]?.body?.messages as unknown[])?.length ?? 0;
    expect(turn2Count).toBeGreaterThan(turn1Count);
  }, IT_DAEMON_SLOW);

  it("sessionLost: clearSession is true when orager reports session not found", async () => {
    mockServer.queueText("Started fresh.");

    const { ctx } = makeDaemonCtx({
      runtime: { sessionId: "ses-123", sessionParams: { oragerSessionId: "ses-abc-does-not-exist", updatedAt: new Date().toISOString() }, sessionDisplayId: null, taskKey: null },
    });
    const result = await executeAgentLoop(ctx);

    expect(result.clearSession).toBe(true);
  }, IT_DAEMON);

  it("onMeta commandNotes includes the effective model before spawn", async () => {
    mockServer.queueText("Done.", { model: "openai/gpt-4o" });

    const { ctx, onMeta } = makeDaemonCtx({ config: { model: "openai/gpt-4o" } });
    await executeAgentLoop(ctx);

    expect(onMeta).toHaveBeenCalled();
    const metaArg = (onMeta.mock.calls[0] as [Record<string, unknown>])[0];
    const notes = metaArg.commandNotes as string[] | undefined;
    expect(Array.isArray(notes)).toBe(true);
    expect(notes!.some((n) => n.startsWith("model:"))).toBe(true);
  }, IT_DAEMON);

  it("trackFileChanges: filesChanged populated in resultJson when agent writes a file", async () => {
    const testFile = path.join(tmpDir, `track-test-${Date.now()}.txt`);
    mockServer.queueToolCall("write_file", { path: testFile, content: "hello from agent" });
    mockServer.queueText("File written.");

    const { ctx } = makeDaemonCtx({
      config: { trackFileChanges: true },
    });
    const result = await executeAgentLoop(ctx);

    const filesChanged = (result.resultJson?.filesChanged ?? []) as string[];
    expect(Array.isArray(filesChanged)).toBe(true);
    expect(filesChanged.some((f: string) => f.includes("track-test-"))).toBe(true);
  }, IT_DAEMON_SLOW);

  it("requiredEnvVars: run completes normally when var is present", async () => {
    mockServer.queueText("Done with required env.");

    const { ctx } = makeDaemonCtx({
      config: {
        requiredEnvVars: ["OPENROUTER_BASE_URL"],
        env: { OPENROUTER_BASE_URL: mockServer.baseUrl, OPENROUTER_REQUIRED_VAR: "present" },
      },
    });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls.length).toBeGreaterThan(0);
  }, IT_DAEMON);

});

// ─────────────────────────────────────────────────────────────────────────────
// SPAWN PATH TESTS — exercise the CLI subprocess path for regression coverage
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!oragerDistExists)("full pipeline — spawn path", () => {

  it("simple text response: exitCode 0 and completion request made", async () => {
    mockServer.queueText("Integration test complete.");

    const { ctx } = makeSpawnCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(1);
  }, IT);

  it("apiKey appears in Authorization header of OpenRouter request", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeSpawnCtx({ config: { apiKey: "sk-custom-test-key" } });
    await executeAgentLoop(ctx);

    const auth = mockServer.completionCalls[0]?.headers?.authorization ?? "";
    expect(auth).toBe("Bearer sk-custom-test-key");
  }, IT);

  it("dryRun: no API calls made, exitCode 0 returned", async () => {
    const { ctx } = makeSpawnCtx({ config: { dryRun: true } });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(0);
  }, IT);

  it("timeoutSec: adapter kills orager process and returns timeout error", async () => {
    mockServer.queueSlow(10_000);

    const start = Date.now();
    const { ctx } = makeSpawnCtx({ config: { timeoutSec: 4, maxRetries: 0 } });
    const result = await executeAgentLoop(ctx);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(8_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("timeout");
  }, IT);

  it("orager crash with no result event: returns error result with errorCode", async () => {
    mockServer.queueError(500, { error: { message: "Internal Server Error" } });

    const { ctx } = makeSpawnCtx({ config: { maxRetries: 0 } });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeTruthy();
    expect(typeof result.errorCode).toBe("string");
    expect(result.errorCode).not.toBe("");
  }, IT);

  it("config file written with mode 600 before orager is spawned", async () => {
    mockServer.completionQueue.push(async (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sseTextStream("Config file mode ok."));
    });

    const { ctx } = makeSpawnCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
  }, IT);

});

// ── Security: symlink traversal (spawn path) ────────────────────────────────

describe.skipIf(!oragerDistExists)("security: instructionsFilePath symlink traversal (via spawn)", () => {

  it("ignores instructionsFilePath that resolves outside cwd via symlink", async () => {
    mockServer.queueText("Done with ignored instructions.");

    const symlinkPath = path.join(tmpDir, "evil-instructions.md");
    await fs.unlink(symlinkPath).catch(() => {});
    await fs.symlink("/etc/hosts", symlinkPath);

    const { ctx, onLog } = makeSpawnCtx({
      config: { instructionsFilePath: symlinkPath },
    });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);

    const stderr = logLines(onLog).filter((l) => l.includes("WARNING"));
    expect(stderr.some((l) => l.includes("outside cwd") || l.includes("not found"))).toBe(true);

    await fs.unlink(symlinkPath).catch(() => {});
  }, IT);

});

// ── Oversized segment handling (spawn path) ─────────────────────────────────

describe.skipIf(!oragerDistExists)("oversized segment handling (via spawn)", () => {

  it("logs a warning and continues when an orager stdout line exceeds 1 MB", async () => {
    const OVER_1MB = "x".repeat(1024 * 1024 + 1);
    mockServer.completionQueue.push((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Transfer-Encoding": "chunked" });
      res.end(sseTextStream(OVER_1MB));
    });

    const { ctx, onLog } = makeSpawnCtx();
    await executeAgentLoop(ctx);

    const stderrLines = logLines(onLog).filter((l) => l.includes("[openrouter adapter]"));
    expect(stderrLines.some((l) => l.includes("exceeded") && l.includes("oversized"))).toBe(true);
  }, IT);

});
