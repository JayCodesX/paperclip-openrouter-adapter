/**
 * Tests for features added in the most recent execute-cli.ts revision:
 *   - cwd mismatch on session resume → fresh session + log warning
 *   - errorCode "no_result" on spawn exit without result event
 *   - session_lost structured warn in spawn stream → clearSession: true
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  _resetStateForTesting,
  _drainStructuredLogForTesting,
  executeAgentLoop,
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

beforeEach(() => {
  _resetStateForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// suppress unused import warning — kept for future spawn-path structured log tests
void _drainStructuredLogForTesting;

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
    // Run ends with cli_not_found (spawn binary missing)
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


// Vision fallback chain tests removed — vision routing moved to orager engine
// in refactor commit 99f8e3a.
