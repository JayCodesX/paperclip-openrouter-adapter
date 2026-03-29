/**
 * Tests for features added in the most recent execute-cli.ts revision:
 *   - onMeta fires on daemon path (before daemon/spawn branch)
 *   - filesChanged propagated from daemon result
 *   - session_lost structured warn in daemon stream → clearSession: true
 *   - cwd mismatch on session resume → fresh session + log warning
 *   - Daemon key age warning fires at most once per process
 *   - errorCode "no_result" on spawn exit without result event
 *   - cwd stored in daemon sessionParams
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  _resetStateForTesting,
  _drainStructuredLogForTesting,
  executeAgentLoop,
  DAEMON_KEY_PATH,
  DAEMON_KEY_MAX_AGE_MS,
} from "../src/server/execute-cli.js";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Minimal agent/runtime/context stubs reused across tests. */
function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run",
    agent: {
      id: "test-agent",
      companyId: "co",
      name: "Test",
      adapterType: "openrouter",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    context: { task: "test", wakeReason: "manual" },
    ...overrides,
  };
}

const TEST_SIGNING_KEY = "test-key-for-new-feature-tests-32b";

/** Build a ReadableStream whose body is the provided NDJSON lines joined by \n. */
function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(body));
      ctrl.close();
    },
  });
}

/**
 * Stubs fs.readFile and fs.stat so that the signing key path returns
 * a valid key without touching the real filesystem. All other reads are
 * forwarded to the real implementation.
 */
function stubSigningKey(key: string, mtime = Date.now()) {
  const realReadFile = fs.readFile.bind(fs);
  const realStat = fs.stat.bind(fs);

  vi.spyOn(fs, "readFile").mockImplementation(
    (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === DAEMON_KEY_PATH) {
        return Promise.resolve(key) as ReturnType<typeof fs.readFile>;
      }
      return (realReadFile as typeof fs.readFile)(...args);
    },
  );

  vi.spyOn(fs, "stat").mockImplementation((...args: Parameters<typeof fs.stat>) => {
    if (String(args[0]) === DAEMON_KEY_PATH) {
      // mode 0o100600 = regular file, 600 permissions
      return Promise.resolve({ mode: 0o100600, mtimeMs: mtime } as Awaited<ReturnType<typeof fs.stat>>);
    }
    return (realStat as typeof fs.stat)(...args);
  });
}

/** Mock fetch so /health returns ok and /run returns the supplied NDJSON events. */
function mockDaemon(runEvents: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok" }),
        });
      }
      // /run — return streaming NDJSON
      return Promise.resolve({
        ok: true,
        status: 200,
        body: ndjsonStream(runEvents),
        headers: new Headers(),
      });
    }),
  );
}

const SUCCESS_EVENTS = [
  { type: "system", session_id: "sess-1", model: "openai/gpt-4o" },
  {
    type: "result",
    subtype: "success",
    result: "Done",
    session_id: "sess-1",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    total_cost_usd: 0.001,
    turnCount: 2,
  },
];

beforeEach(() => {
  _resetStateForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── onMeta fires on daemon path ──────────────────────────────────────────────

describe("onMeta — daemon path", () => {
  it("calls onMeta before the daemon request completes", async () => {
    stubSigningKey(TEST_SIGNING_KEY);
    mockDaemon(SUCCESS_EVENTS);

    const onMetaCalls: unknown[] = [];
    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
      },
      onLog: async () => {},
      onMeta: async (meta) => { onMetaCalls.push(meta); },
    } as Parameters<typeof executeAgentLoop>[0]);

    expect(onMetaCalls).toHaveLength(1);
    expect((onMetaCalls[0] as { adapterType: string }).adapterType).toBe("openrouter-cli");
    expect(result.exitCode).toBe(0);
  });
});

// ── filesChanged propagated from daemon path ─────────────────────────────────

describe("filesChanged — daemon path", () => {
  it("includes filesChanged in resultJson when daemon emits it", async () => {
    stubSigningKey(TEST_SIGNING_KEY);
    const eventsWithFiles = [
      { type: "system", session_id: "sess-2", model: "openai/gpt-4o" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "sess-2",
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 },
        total_cost_usd: 0.0005,
        turnCount: 1,
        filesChanged: ["src/foo.ts", "src/bar.ts"],
      },
    ];
    mockDaemon(eventsWithFiles);

    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
        trackFileChanges: true,
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    expect(result.exitCode).toBe(0);
    const rj = result.resultJson as Record<string, unknown>;
    expect(rj.filesChanged).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("resultJson.filesChanged is undefined when daemon omits it", async () => {
    stubSigningKey(TEST_SIGNING_KEY);
    mockDaemon(SUCCESS_EVENTS);

    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    const rj = result.resultJson as Record<string, unknown>;
    expect(rj.filesChanged).toBeUndefined();
  });
});

// ── session_lost structured warn → clearSession ──────────────────────────────

describe("session loss detection — daemon path", () => {
  it("sets clearSession=true when daemon emits structured warn subtype session_lost", async () => {
    stubSigningKey(TEST_SIGNING_KEY);
    const eventsWithStructuredSessionLost = [
      { type: "warn", subtype: "session_lost", message: "session old-sess not found, starting fresh", session_id: "old-sess" },
      { type: "system", session_id: "sess-new", model: "openai/gpt-4o" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "sess-new",
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 },
        total_cost_usd: 0.0005,
      },
    ];
    mockDaemon(eventsWithStructuredSessionLost);

    const result = await executeAgentLoop({
      ...baseArgs({
        runtime: {
          sessionId: "old-session-id",
          sessionParams: {
            oragerSessionId: "old-sess",
            cwd: os.tmpdir(),
            updatedAt: new Date().toISOString(),
          },
          sessionDisplayId: "old-sess",
          taskKey: null,
        },
      }),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    expect(result.clearSession).toBe(true);
  });
});

// ── runId threaded through daemon structured logs ─────────────────────────────

describe("runId in daemon structured logs", () => {
  it("structured logs emitted inside executeViaDaemon carry the caller's runId", async () => {
    stubSigningKey(TEST_SIGNING_KEY);
    // Emit a session_lost warn so the session_not_found structuredLog fires
    // inside executeViaDaemon — this is the event that previously logged runId: "".
    const events = [
      { type: "warn", subtype: "session_lost", message: "session stale not found, starting fresh", session_id: "stale" },
      { type: "system", session_id: "sess-new", model: "openai/gpt-4o" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "sess-new",
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 },
        total_cost_usd: 0.0005,
      },
    ];
    mockDaemon(events);

    await executeAgentLoop({
      ...baseArgs({ runId: "my-specific-run-id" }),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    const logs = _drainStructuredLogForTesting();
    const sessionNotFoundLog = logs.find((e) => e.event === "session_not_found");
    expect(sessionNotFoundLog).toBeDefined();
    expect(sessionNotFoundLog?.runId).toBe("my-specific-run-id");
  });
});

// ── cwd mismatch → log warning and use fresh session ────────────────────────

describe("cwd mismatch on session resume", () => {
  it("logs a warning and clears session when cwd changes", async () => {
    const stderrLines: string[] = [];

    const result = await executeAgentLoop({
      ...baseArgs({
        runtime: {
          sessionId: "old-session-id",
          sessionParams: {
            oragerSessionId: "old-sess",
            cwd: "/some/other/dir",
            updatedAt: new Date().toISOString(),
          },
          sessionDisplayId: "old-sess",
          taskKey: null,
        },
      }),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        cwd: os.tmpdir(),
        cliPath: "/nonexistent/orager",
        dangerouslySkipPermissions: true,
      },
      onLog: async (stream, line) => {
        if (stream === "stderr") stderrLines.push(line);
      },
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    const allStderr = stderrLines.join("\n");
    expect(allStderr).toContain("/some/other/dir");
    // Run ends with cli_not_found (daemon unreachable + spawn binary missing)
    expect(result.errorCode).toBe("cli_not_found");
  });

  it("does not warn when forceResume=true even if cwd differs", async () => {
    const stderrLines: string[] = [];

    await executeAgentLoop({
      ...baseArgs({
        runtime: {
          sessionId: "old-session-id",
          sessionParams: {
            oragerSessionId: "old-sess",
            cwd: "/some/other/dir",
            updatedAt: new Date().toISOString(),
          },
          sessionDisplayId: "old-sess",
          taskKey: null,
        },
      }),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        cwd: os.tmpdir(),
        cliPath: "/nonexistent/orager",
        dangerouslySkipPermissions: true,
        forceResume: true,
      },
      onLog: async (stream, line) => {
        if (stream === "stderr") stderrLines.push(line);
      },
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    const allStderr = stderrLines.join("\n");
    expect(allStderr).not.toContain("starting fresh");
  });
});

// ── Daemon key age warning fires at most once ────────────────────────────────

describe("daemon key age warning", () => {
  it("emits age warning at most once per process reset", async () => {
    _resetStateForTesting();
    const oldMtime = Date.now() - DAEMON_KEY_MAX_AGE_MS - 1000;
    stubSigningKey(TEST_SIGNING_KEY, oldMtime);
    mockDaemon(SUCCESS_EVENTS);

    const warnMessages: string[] = [];
    const collectLog = async (_s: "stdout" | "stderr", line: string) => {
      if (line.includes("days old")) warnMessages.push(line);
    };

    await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
      },
      onLog: collectLog,
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    // Reset fetch mock but keep fs spies for second run
    vi.unstubAllGlobals();
    mockDaemon(SUCCESS_EVENTS);

    await executeAgentLoop({
      ...baseArgs({ runId: "run-2" }),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
      },
      onLog: collectLog,
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    // The warning should have fired exactly once across both runs
    expect(warnMessages).toHaveLength(1);
    expect(warnMessages[0]).toContain("days old");
  });
});

// ── errorCode "no_result" on spawn exit without result event ────────────────

describe("errorCode no_result — spawn path", () => {
  it("returns errorCode=no_result when orager exits with no result event", async () => {
    // Write a tiny shell script that exits cleanly but emits no events
    const scriptPath = path.join(os.tmpdir(), "fake-orager-no-result.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(scriptPath, 0o755);

    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        cwd: os.tmpdir(),
        cliPath: scriptPath,
        dangerouslySkipPermissions: true,
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    await fs.unlink(scriptPath).catch(() => {});
    expect(result.errorCode).toBe("no_result");
  });
});

// ── session loss detection — spawn path ─────────────────────────────────────

describe("session loss detection — spawn path", () => {
  it("sets clearSession=true when spawn stdout emits structured warn subtype session_lost", async () => {
    const events = [
      JSON.stringify({ type: "warn", subtype: "session_lost", message: "session old-sess not found, starting fresh", session_id: "old-sess" }),
      JSON.stringify({ type: "system", session_id: "sess-new", model: "openai/gpt-4o" }),
      JSON.stringify({ type: "result", subtype: "success", result: "Done", session_id: "sess-new", usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 }, total_cost_usd: 0.0005 }),
    ].join("\n");

    const scriptPath = path.join(os.tmpdir(), "fake-orager-session-lost.sh");
    await fs.writeFile(scriptPath, `#!/bin/sh\nprintf '${events.replace(/'/g, "'\\''")}\n'\nexit 0\n`);
    await fs.chmod(scriptPath, 0o755);

    const result = await executeAgentLoop({
      ...baseArgs({
        runtime: {
          sessionId: "old-session-id",
          sessionParams: {
            oragerSessionId: "old-sess",
            cwd: os.tmpdir(),
            updatedAt: new Date().toISOString(),
          },
          sessionDisplayId: "old-sess",
          taskKey: null,
        },
      }),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        cwd: os.tmpdir(),
        cliPath: scriptPath,
        dangerouslySkipPermissions: true,
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    await fs.unlink(scriptPath).catch(() => {});
    expect(result.clearSession).toBe(true);
  });
});

// ── cwd stored in daemon sessionParams ───────────────────────────────────────

describe("cwd in daemon sessionParams", () => {
  it("stores cwd in sessionParams returned from daemon path", async () => {
    stubSigningKey(TEST_SIGNING_KEY);
    mockDaemon(SUCCESS_EVENTS);

    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        daemonUrl: "http://127.0.0.1:4000",
        cwd: os.tmpdir(),
        dangerouslySkipPermissions: true,
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    expect(result.sessionParams).toBeTruthy();
    expect((result.sessionParams as Record<string, unknown>).cwd).toBe(os.tmpdir());
  });
});

// ── Vision fallback chain ─────────────────────────────────────────────────────
// checkVisionSupport() calls fetch(`${OPENROUTER_BASE_URL}/models`) to look up
// each model's input_modalities. The tests stub fetch globally to control what
// each model-id lookup returns, then run executeAgentLoop with an image
// attachment so the vision code path is exercised. _drainStructuredLogForTesting
// captures the resulting structured log events.

/** Build a minimal OpenRouter /models response containing the given entries. */
function modelsResponse(
  entries: Array<{ id: string; vision: boolean }>,
): object {
  return {
    data: entries.map(({ id, vision }) => ({
      id,
      architecture: { input_modalities: vision ? ["text", "image"] : ["text"] },
    })),
  };
}

/**
 * Stub fetch so that:
 *   - calls to a URL containing "/models" return `modelsRes`
 *   - calls to a URL ending with "/health" return ok
 *   - all other calls (daemon /run) return `runEvents` as NDJSON
 */
function mockDaemonWithVision(runEvents: unknown[], modelsRes: object) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const s = String(url);
      if (s.includes("/models")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(modelsRes),
        });
      }
      if (s.endsWith("/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok" }),
        });
      }
      // daemon /run — stream NDJSON
      const enc = new TextEncoder();
      const body = runEvents.map((l) => JSON.stringify(l)).join("\n") + "\n";
      return Promise.resolve({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(enc.encode(body));
            ctrl.close();
          },
        }),
        headers: new Headers(),
      });
    }),
  );
}

describe("vision fallback chain", () => {
  beforeEach(() => {
    _resetStateForTesting();
  });

  it("falls back to vision-capable model and logs vision_model_fallback event", async () => {
    // Primary model: text-only. First default fallback: vision-capable.
    mockDaemonWithVision(SUCCESS_EVENTS, modelsResponse([
      { id: "openai/gpt-4o-mini", vision: false },
      { id: "google/gemini-2.0-flash-001", vision: true },
    ]));
    stubSigningKey(TEST_SIGNING_KEY);

    const stderrLines: string[] = [];
    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl: "http://127.0.0.1:4000",
      },
      context: {
        task: "test",
        wakeReason: "manual",
        attachments: [{ url: "https://example.com/img.png", mimeType: "image/png" }],
      },
      onLog: async (stream, line) => { if (stream === "stderr") stderrLines.push(line); },
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    expect(result.exitCode).toBe(0);

    const entries = _drainStructuredLogForTesting();
    const fallbackEvent = entries.find((e) => e.event === "vision_model_fallback");
    expect(fallbackEvent).toBeTruthy();
    expect(fallbackEvent!.originalModel).toBe("openai/gpt-4o-mini");
    expect(fallbackEvent!.fallbackModel).toBe("google/gemini-2.0-flash-001");
    expect(stderrLines.join("")).toMatch(/does not support image inputs.*falling back/i);
  });

  it("warns via vision_not_supported when all fallback models also lack vision", async () => {
    // All models text-only — fallback chain exhausted.
    mockDaemonWithVision(SUCCESS_EVENTS, modelsResponse([
      { id: "openai/gpt-4o-mini", vision: false },
      { id: "google/gemini-2.0-flash-001", vision: false },
      { id: "openai/gpt-4o", vision: false },
      { id: "anthropic/claude-sonnet-4-5", vision: false },
    ]));
    stubSigningKey(TEST_SIGNING_KEY);

    const stderrLines: string[] = [];
    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl: "http://127.0.0.1:4000",
      },
      context: {
        task: "test",
        wakeReason: "manual",
        attachments: [{ url: "https://example.com/img.png", mimeType: "image/png" }],
      },
      onLog: async (stream, line) => { if (stream === "stderr") stderrLines.push(line); },
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    // Run still proceeds despite no working vision model
    expect(result.exitCode).toBe(0);

    const entries = _drainStructuredLogForTesting();
    const warnEvent = entries.find((e) => e.event === "vision_not_supported");
    expect(warnEvent).toBeTruthy();
    expect(warnEvent!.model).toBe("openai/gpt-4o-mini");
    // Should NOT have emitted a fallback event
    expect(entries.find((e) => e.event === "vision_model_fallback")).toBeUndefined();
    expect(stderrLines.join("")).toMatch(/no vision fallback was available/i);
  });

  it("emits vision_support_unknown (soft warning) when model not found in /models list", async () => {
    // /models response does not contain the requested model at all.
    mockDaemonWithVision(SUCCESS_EVENTS, modelsResponse([]));
    stubSigningKey(TEST_SIGNING_KEY);

    const stderrLines: string[] = [];
    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl: "http://127.0.0.1:4000",
      },
      context: {
        task: "test",
        wakeReason: "manual",
        attachments: [{ url: "https://example.com/img.png", mimeType: "image/png" }],
      },
      onLog: async (stream, line) => { if (stream === "stderr") stderrLines.push(line); },
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    // Run proceeds — null means "unknown", not "unsupported"
    expect(result.exitCode).toBe(0);

    const entries = _drainStructuredLogForTesting();
    const unknownEvent = entries.find((e) => e.event === "vision_support_unknown");
    expect(unknownEvent).toBeTruthy();
    expect(unknownEvent!.model).toBe("openai/gpt-4o-mini");
    // No fallback attempted for unknown support
    expect(entries.find((e) => e.event === "vision_model_fallback")).toBeUndefined();
    expect(stderrLines.join("")).toMatch(/could not verify vision support/i);
  });

  it("sets fallbackDisabled:true in vision_not_supported when visionFallbackModels is []", async () => {
    // User explicitly disables the fallback chain with an empty list.
    mockDaemonWithVision(SUCCESS_EVENTS, modelsResponse([
      { id: "openai/gpt-4o-mini", vision: false },
    ]));
    stubSigningKey(TEST_SIGNING_KEY);

    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl: "http://127.0.0.1:4000",
        visionFallbackModels: [], // explicitly disabled
      },
      context: {
        task: "test",
        wakeReason: "manual",
        attachments: [{ url: "https://example.com/img.png", mimeType: "image/png" }],
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    expect(result.exitCode).toBe(0);

    const entries = _drainStructuredLogForTesting();
    const warnEvent = entries.find((e) => e.event === "vision_not_supported");
    expect(warnEvent).toBeTruthy();
    expect(warnEvent!.fallbackDisabled).toBe(true);
    // No fallback attempted since the chain was explicitly disabled
    expect(entries.find((e) => e.event === "vision_model_fallback")).toBeUndefined();
  });

  it("fallbackDisabled:true when visionFallbackModels:[] in spawn path (no daemonUrl)", async () => {
    // This variant does NOT set daemonUrl so the run goes through spawn after
    // the shared vision-check code path, confirming the flag is set regardless
    // of execution backend.
    const RESULT =
      '{"type":"result","subtype":"success","session_id":"vs-spawn","is_error":false,' +
      '"total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":2,' +
      '"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"result":"ok"}';

    const tmpDirRaw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-vis-spawn-"));
    const tmpDir = await fs.realpath(tmpDirRaw);
    const fakeBin = path.join(tmpDir, "fake-orager");
    await fs.writeFile(
      fakeBin,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${RESULT}'\nexit 0\n`,
      { mode: 0o755 },
    );

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (String(url).includes("/models")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(modelsResponse([{ id: "openai/gpt-4o-mini", vision: false }])),
            });
          }
          return Promise.reject(new Error("unexpected fetch in spawn path test"));
        }),
      );

      const result = await executeAgentLoop({
        ...baseArgs(),
        config: {
          apiKey: "sk-test",
          model: "openai/gpt-4o-mini",
          cliPath: fakeBin,
          cwd: tmpDir,
          visionFallbackModels: [], // explicitly disable fallback
        },
        context: {
          task: "test",
          wakeReason: "manual",
          attachments: [{ url: "https://example.com/img.png", mimeType: "image/png" }],
        },
        onLog: async () => {},
        onMeta: async () => {},
      } as Parameters<typeof executeAgentLoop>[0]);

      expect(result.exitCode).toBe(0);

      const entries = _drainStructuredLogForTesting();
      const warnEvent = entries.find((e) => e.event === "vision_not_supported");
      expect(warnEvent).toBeTruthy();
      expect(warnEvent!.fallbackDisabled).toBe(true);
      expect(entries.find((e) => e.event === "vision_model_fallback")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("respects user-supplied visionFallbackModels override", async () => {
    // User provides a custom fallback list with only one model.
    const customFallback = "my-org/custom-vision-model";
    mockDaemonWithVision(SUCCESS_EVENTS, modelsResponse([
      { id: "openai/gpt-4o-mini", vision: false },
      { id: customFallback, vision: true },
    ]));
    stubSigningKey(TEST_SIGNING_KEY);

    const result = await executeAgentLoop({
      ...baseArgs(),
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o-mini",
        daemonUrl: "http://127.0.0.1:4000",
        visionFallbackModels: [customFallback],
      },
      context: {
        task: "test",
        wakeReason: "manual",
        attachments: [{ url: "https://example.com/img.png", mimeType: "image/png" }],
      },
      onLog: async () => {},
      onMeta: async () => {},
    } as Parameters<typeof executeAgentLoop>[0]);

    expect(result.exitCode).toBe(0);

    const entries = _drainStructuredLogForTesting();
    const fallbackEvent = entries.find((e) => e.event === "vision_model_fallback");
    expect(fallbackEvent).toBeTruthy();
    expect(fallbackEvent!.fallbackModel).toBe(customFallback);
  });
});
