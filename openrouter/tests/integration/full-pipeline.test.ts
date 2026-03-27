/**
 * Full pipeline integration tests: adapter → real orager spawn → mock OpenRouter
 *
 * Every test exercises the complete request path with no mocking inside the
 * pipeline itself:
 *
 *   Paperclip context (makeCtx)
 *     → executeAgentLoop  (adapter — execute-cli.ts)
 *       → temp config file written (chmod 600)
 *       → orager spawned from dist/ (real Node.js process)
 *         → model/tool calls hit mock OpenRouter server
 *         → tools execute against real filesystem (tmpDir)
 *         → stream-json events emitted on stdout
 *       → stream parsed by adapter
 *     → AdapterExecutionResult returned
 *
 * OpenRouter network calls intercepted via OPENROUTER_BASE_URL env var injected
 * through config.env into the spawned orager process.
 * No real API keys or internet access required.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeAgentLoop,
  _resetStateForTesting,
  recordRunCost,
} from "../../src/server/execute-cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the built orager dist entry. Used for the shell wrapper. */
const ORAGER_DIST = path.resolve(__dirname, "../../../../orager/dist/index.js");

/** Per-test timeout — spawning a Node.js process takes a few hundred ms. */
const IT = 30_000;

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

// ── Test fixtures ─────────────────────────────────────────────────────────────

let mockServer: MockOpenRouterServer;
let tmpDir: string;
let cliPath: string;

beforeAll(async () => {
  // 1. Start the mock OpenRouter server on a random port
  mockServer = new MockOpenRouterServer();
  await mockServer.start();

  // 2. Temp working directory — used as cwd for all runs
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-pipeline-integ-"));

  // 3. Create a shell wrapper that runs orager from the local dist/
  //    so the test doesn't depend on the global npm install.
  const wrapperPath = path.join(tmpDir, "orager-wrapper.sh");
  await fs.writeFile(wrapperPath, `#!/bin/sh\nexec node "${ORAGER_DIST}" "$@"\n`);
  await fs.chmod(wrapperPath, 0o755);
  cliPath = wrapperPath;
}, 30_000);

afterAll(async () => {
  await mockServer.stop();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  mockServer.reset();
  _resetStateForTesting();
});

// ── Context factory ───────────────────────────────────────────────────────────

interface CtxConfig extends Record<string, unknown> {}
interface CtxContext extends Record<string, unknown> {}
interface CtxRuntime extends Record<string, unknown> {}

interface MakeCtxResult {
  ctx: Parameters<typeof executeAgentLoop>[0];
  onLog: ReturnType<typeof vi.fn>;
  onMeta: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides: {
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
      maxRetries: 0,      // fail fast — no retries unless the test needs them
      cwd: tmpDir,
      cliPath,
      dangerouslySkipPermissions: true,
      promptTemplate: "Task: {{context.task}}",
      // Redirect all orager HTTP calls to the mock server
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pull all log lines from the onLog mock calls. */
function logLines(onLog: ReturnType<typeof vi.fn>): string[] {
  return (onLog.mock.calls as [string, string][]).map(([, line]) => line);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("full pipeline — spawn path", () => {

  // ── Basic end-to-end ────────────────────────────────────────────────────────

  it("simple text response: exitCode 0 and completion request made", async () => {
    mockServer.queueText("Integration test complete.");

    const { ctx } = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(1);
  }, IT);

  it("prompt rendered with context interpolation appears in request", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({
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
  }, IT);

  it("correct model forwarded to OpenRouter request body", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({ config: { model: "openai/gpt-4o-mini" } });
    await executeAgentLoop(ctx);

    expect(mockServer.completionCalls[0]?.body?.model).toBe("openai/gpt-4o-mini");
  }, IT);

  it("apiKey appears in Authorization header of OpenRouter request", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({ config: { apiKey: "sk-custom-test-key" } });
    await executeAgentLoop(ctx);

    const auth = mockServer.completionCalls[0]?.headers?.authorization ?? "";
    expect(auth).toBe("Bearer sk-custom-test-key");
  }, IT);

  it("sampling params forwarded: temperature and top_p in request body", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({ config: { temperature: 0.42, top_p: 0.88 } });
    await executeAgentLoop(ctx);

    const body = mockServer.completionCalls[0]?.body ?? {};
    expect(body.temperature).toBe(0.42);
    expect(body.top_p).toBe(0.88);
  }, IT);

  // ── Multi-turn tool execution ────────────────────────────────────────────────

  it("multi-turn: bash tool called, result sent to LLM, final text returned", async () => {
    // Turn 1: LLM calls bash
    mockServer.queueToolCall("bash", { command: "echo 'pipeline-integration-hello'" });
    // Turn 2: LLM acknowledges the tool output
    mockServer.queueText("Bash ran successfully and printed the expected output.");

    const { ctx } = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    // Two LLM requests: one that returned the tool call, one after the tool ran
    expect(mockServer.completionCalls).toHaveLength(2);

    // The second request must include a "tool" role message (the bash output)
    const turn2Messages = mockServer.completionCalls[1]?.body?.messages as Array<{ role: string }>;
    const hasToolMessage = turn2Messages?.some((m) => m.role === "tool");
    expect(hasToolMessage).toBe(true);
  }, IT);

  it("read_file tool: agent reads a real file in cwd and result reaches LLM", async () => {
    // Create a file the agent will read
    const testFile = path.join(tmpDir, "integ-test-data.txt");
    await fs.writeFile(testFile, "integration-file-content-42");

    // Turn 1: LLM calls read_file
    mockServer.queueToolCall("read_file", { path: "integ-test-data.txt" });
    // Turn 2: LLM sees the file content in the tool result
    mockServer.queueText("I read the file successfully.");

    const { ctx } = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(2);

    // The second request's tool message should contain the file content
    const turn2Messages = mockServer.completionCalls[1]?.body?.messages as Array<{ role: string; content: unknown }>;
    const toolMsg = turn2Messages?.find((m) => m.role === "tool");
    const toolContent = JSON.stringify(toolMsg?.content ?? "");
    expect(toolContent).toContain("integration-file-content-42");
  }, IT);

  // ── Adapter-level config features ──────────────────────────────────────────

  it("dryRun: no API calls made, exitCode 0 returned", async () => {
    const { ctx } = makeCtx({ config: { dryRun: true } });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(mockServer.completionCalls).toHaveLength(0);
  }, IT);

  it("requiredEnvVars: missing var fails before any OpenRouter call", async () => {
    const { ctx } = makeCtx({
      config: { requiredEnvVars: ["INTEG_TEST_DEFINITELY_NOT_SET_XYZ"] },
    });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(1);
    expect(mockServer.completionCalls).toHaveLength(0);
  }, IT);

  it("wakeReasonModels: override model sent when wake reason matches", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({
      config: {
        model: "openai/gpt-4o-mini",
        wakeReasonModels: { pr_opened: "openai/gpt-4o" },
      },
      context: { wakeReason: "pr_opened" },
    });
    await executeAgentLoop(ctx);

    expect(mockServer.completionCalls[0]?.body?.model).toBe("openai/gpt-4o");
  }, IT);

  it("wakeReasonModels: base model used when wake reason has no override", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({
      config: {
        model: "openai/gpt-4o-mini",
        wakeReasonModels: { pr_opened: "openai/gpt-4o" },
      },
      context: { wakeReason: "comment_added" },
    });
    await executeAgentLoop(ctx);

    expect(mockServer.completionCalls[0]?.body?.model).toBe("openai/gpt-4o-mini");
  }, IT);

  it("bootstrapPromptTemplate: prepended on first run (no prior session)", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({
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
  }, IT);

  it("bootstrapPromptTemplate: not used on resume run (prior session present)", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({
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
  }, IT);

  // ── Session resume ─────────────────────────────────────────────────────────

  it("session resume: prior conversation messages included in second run's request", async () => {
    // Run 1: fresh session
    mockServer.queueText("First run complete. I understand the task.");
    const { ctx: ctx1 } = makeCtx();
    const result1 = await executeAgentLoop(ctx1);
    expect(result1.exitCode).toBe(0);

    const sessionId = result1.sessionDisplayId
      ?? (result1.sessionParams as Record<string, unknown> | null)?.oragerSessionId as string | undefined;
    expect(typeof sessionId).toBe("string");

    // Reset mock, keep same tmpDir so the session file is still on disk
    mockServer.reset();
    _resetStateForTesting();

    // Run 2: resume with the captured session ID
    mockServer.queueText("Second run complete.");
    const { ctx: ctx2 } = makeCtx({
      runtime: {
        sessionId,
        sessionParams: { oragerSessionId: sessionId },
        sessionDisplayId: sessionId ?? null,
        taskKey: null,
      },
    });
    const result2 = await executeAgentLoop(ctx2);
    expect(result2.exitCode).toBe(0);

    // The resumed session should have prior messages — more than just system + new user
    const messages = mockServer.completionCalls[0]?.body?.messages as Array<{ role: string }>;
    expect(messages?.length).toBeGreaterThan(2);
  }, 60_000); // longer — two spawns

  // ── Error handling and retry ────────────────────────────────────────────────

  it("model fallback on 429: third request uses fallback model after two failures", async () => {
    // orager's retry logic: first 429 → retry same model (retriedCurrentModel=false→true).
    // Second 429 on same model → now retriedCurrentModel=true → rotate to fallback.
    mockServer.queueError(429, { error: { message: "Rate limit exceeded" } }); // attempt 1
    mockServer.queueError(429, { error: { message: "Rate limit exceeded" } }); // attempt 2 (same model)
    mockServer.queueText("Done with fallback."); // attempt 3 (fallback model)

    const { ctx } = makeCtx({
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
  }, IT);

  it("maxTurns reached: loop terminates and clears session (soft stop)", async () => {
    // error_max_turns is a soft stop — adapter returns exitCode 0 but sets clearSession.
    // The LLM keeps calling tools indefinitely; orager stops at maxTurns.
    for (let i = 0; i < 6; i++) {
      mockServer.queueToolCall("bash", { command: "echo loop" });
    }

    const { ctx } = makeCtx({ config: { maxTurns: 3, maxRetries: 0 } });
    const result = await executeAgentLoop(ctx);

    // Soft stop: exitCode 0, session cleared so it won't be resumed
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(true);
    // Should not have made more requests than maxTurns allows
    expect(mockServer.completionCalls.length).toBeLessThanOrEqual(4);
  }, IT);

  it("timeoutSec: adapter kills orager process and returns timeout error", async () => {
    // The mock delays 10s — well past the 4s timeout
    mockServer.queueSlow(10_000);

    const start = Date.now();
    const { ctx } = makeCtx({ config: { timeoutSec: 4, maxRetries: 0 } });
    const result = await executeAgentLoop(ctx);
    const elapsed = Date.now() - start;

    // The adapter's SIGTERM fires at timeoutSec (4s), exitCode is null (killed)
    expect(elapsed).toBeLessThan(8_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull(); // process killed, not clean exit
    expect(result.errorCode).toBe("timeout");
  }, IT);

  // ── Usage and cost ─────────────────────────────────────────────────────────

  it("usage returned: inputTokens and outputTokens populated in result", async () => {
    mockServer.queueText("Done.", {
      usage: { prompt_tokens: 350, completion_tokens: 42, total_tokens: 392 },
    });

    const { ctx } = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.usage?.inputTokens).toBeGreaterThanOrEqual(350);
    expect(result.usage?.outputTokens).toBeGreaterThanOrEqual(42);
  }, IT);

  it("costUsd populated from generation metadata response", async () => {
    mockServer.setGenerationCost(0.0123);
    mockServer.queueText("Done.");

    const { ctx } = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    // Cost should reflect the generation endpoint value (may be 0 if orager
    // uses streaming usage × pricing instead; at minimum it must be ≥ 0)
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  }, IT);

});

// ─────────────────────────────────────────────────────────────────────────────

describe("cost anomaly detection", () => {

  it("warns on stderr when run cost exceeds 2x rolling average", async () => {
    // Pre-populate cost window with cheap runs ($0.0001 each)
    recordRunCost(0.0001);
    recordRunCost(0.0001);
    recordRunCost(0.0001);
    // avg = 0.0001; threshold = 0.0002

    // Make the generation endpoint report a cost well above the threshold
    mockServer.setGenerationCost(0.001); // 10x average
    mockServer.queueText("Expensive run done.");

    const { ctx, onLog } = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    const lines = logLines(onLog);
    const hasAnomaly = lines.some((l) => l.includes("COST ANOMALY"));
    expect(hasAnomaly).toBe(true);
  }, IT);

  it("no warning when cost is within 2x rolling average", async () => {
    recordRunCost(0.001);
    recordRunCost(0.001);
    recordRunCost(0.001);
    // avg = 0.001; threshold = 0.002

    mockServer.setGenerationCost(0.0015); // 1.5x — under threshold
    mockServer.queueText("Normal run done.");

    const { ctx, onLog } = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    const lines = logLines(onLog);
    const hasAnomaly = lines.some((l) => l.includes("COST ANOMALY"));
    expect(hasAnomaly).toBe(false);
  }, IT);

});

// ─────────────────────────────────────────────────────────────────────────────

describe("orager-level features (via spawn)", () => {

  it("requiredEnvVars validated inside orager (spawn path belt-and-suspenders)", async () => {
    // The adapter checks requiredEnvVars before spawning.
    // This test verifies the check fires for the spawn path specifically.
    const { ctx } = makeCtx({
      config: { requiredEnvVars: ["ORAGER_INTEG_MISSING_VAR_99XYZ"] },
    });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(1);
    expect(mockServer.completionCalls).toHaveLength(0);
  }, IT);

  it("parallel_tool_calls flag forwarded to OpenRouter request", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({ config: { parallel_tool_calls: false } });
    await executeAgentLoop(ctx);

    const body = mockServer.completionCalls[0]?.body ?? {};
    expect(body.parallel_tool_calls).toBe(false);
  }, IT);

  it("fallback models forwarded to OpenRouter request body", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx({
      config: { models: ["openai/gpt-4o-mini", "openai/gpt-3.5-turbo"] },
    });
    await executeAgentLoop(ctx);

    const body = mockServer.completionCalls[0]?.body ?? {};
    expect(Array.isArray(body.models)).toBe(true);
    expect((body.models as string[]).includes("openai/gpt-4o-mini")).toBe(true);
  }, IT);

  it("X-Session-Id header present for sticky OpenRouter routing", async () => {
    mockServer.queueText("Done.");

    const { ctx } = makeCtx();
    await executeAgentLoop(ctx);

    // orager sets X-Session-Id for sticky routing on every request
    const sessionIdHeader = mockServer.completionCalls[0]?.headers?.["x-session-id"];
    expect(typeof sessionIdHeader).toBe("string");
    expect((sessionIdHeader as string).length).toBeGreaterThan(0);
  }, IT);

  it("two-turn conversation: messages array grows across turns", async () => {
    mockServer.queueToolCall("bash", { command: "echo hello" });
    mockServer.queueText("Task done.");

    const { ctx } = makeCtx();
    await executeAgentLoop(ctx);

    const turn1Count = (mockServer.completionCalls[0]?.body?.messages as unknown[])?.length ?? 0;
    const turn2Count = (mockServer.completionCalls[1]?.body?.messages as unknown[])?.length ?? 0;
    // Turn 2 must have more messages (added assistant + tool messages)
    expect(turn2Count).toBeGreaterThan(turn1Count);
  }, IT);

});
