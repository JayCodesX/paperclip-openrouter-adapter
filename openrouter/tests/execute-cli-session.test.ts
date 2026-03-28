/**
 * Session-handling tests for executeAgentLoop:
 *   - cwd is stored in sessionParams on a successful spawn result
 *   - workspaceId / repoUrl / repoRef are propagated into sessionParams
 *   - bootstrap prompt is only prepended on the first run (no previousSessionId)
 *   - cwd mismatch clears the session and logs a warning
 *   - forceResume: true bypasses the cwd-mismatch guard
 *
 * These tests use a mock orager binary (shell script) that emits a minimal
 * stream-json result event so executeAgentLoop reaches the result-assembly stage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeAgentLoop, _resetStateForTesting } from "../src/server/execute-cli.js";

// ── fake orager binary ────────────────────────────────────────────────────────
// Reads stdin, echoes it to stderr (so tests can inspect the prompt),
// then emits a minimal NDJSON result event and exits 0.

const FAKE_SESSION_ID = "fake-session-abc123";

async function createFakeBinary(dir: string): Promise<string> {
  const binPath = path.join(dir, "fake-orager");
  const script = [
    "#!/bin/sh",
    // Read all stdin and echo it to stderr so tests can capture the prompt
    "stdin=$(cat)",
    'echo "STDIN_RECEIVED: $stdin" >&2',
    // Emit a minimal result NDJSON on stdout
    `printf '%s\\n' '{"type":"result","subtype":"success","session_id":"${FAKE_SESSION_ID}","is_error":false,"total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"result":"done"}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(binPath, script, { mode: 0o755 });
  return binPath;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCtx(
  configOverrides: Record<string, unknown> = {},
  runtimeOverrides: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
) {
  return {
    runId: "run-session-test",
    agent: {
      id: "agent-session",
      companyId: "co",
      name: "SessionAgent",
      adapterType: "openrouter",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      ...runtimeOverrides,
    },
    config: {
      apiKey: "sk-test-key",
      model: "openai/gpt-4o-mini",
      maxTurns: 1,
      ...configOverrides,
    },
    context: { wakeReason: "manual", ...contextOverrides },
    onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

let tmpDir: string;
let fakeBin: string;

beforeEach(async () => {
  _resetStateForTesting();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-session-test-"));
  fakeBin = await createFakeBinary(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── cwd stored in sessionParams ───────────────────────────────────────────────

describe("cwd in sessionParams", () => {
  it("stores the current cwd in sessionParams after a successful run", async () => {
    const cwd = tmpDir;
    const ctx = makeCtx({ cliPath: fakeBin, cwd });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toBeTruthy();
    expect((result.sessionParams as Record<string, unknown>).cwd).toBe(cwd);
  });

  it("stores the oragerSessionId returned by orager", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    const result = await executeAgentLoop(ctx);

    expect((result.sessionParams as Record<string, unknown>).oragerSessionId).toBe(FAKE_SESSION_ID);
  });
});

// ── workspaceId / repoUrl / repoRef propagation ───────────────────────────────

describe("workspace metadata in sessionParams", () => {
  it("propagates workspaceId into sessionParams", async () => {
    const ctx = makeCtx(
      { cliPath: fakeBin, cwd: tmpDir },
      {},
      {
        wakeReason: "manual",
        paperclipWorkspace: { workspaceId: "ws-abc", repoUrl: null, repoRef: null },
      },
    );
    const result = await executeAgentLoop(ctx);

    expect((result.sessionParams as Record<string, unknown>).workspaceId).toBe("ws-abc");
  });

  it("propagates repoUrl and repoRef into sessionParams", async () => {
    const ctx = makeCtx(
      { cliPath: fakeBin, cwd: tmpDir },
      {},
      {
        wakeReason: "manual",
        paperclipWorkspace: {
          workspaceId: "ws-xyz",
          repoUrl: "https://github.com/example/repo",
          repoRef: "refs/heads/main",
        },
      },
    );
    const result = await executeAgentLoop(ctx);

    const sp = result.sessionParams as Record<string, unknown>;
    expect(sp.repoUrl).toBe("https://github.com/example/repo");
    expect(sp.repoRef).toBe("refs/heads/main");
  });
});

// ── bootstrap prompt only on first run ───────────────────────────────────────
// The prompt is sent via stdin to orager. The fake binary echoes stdin to stderr
// so tests can capture the rendered prompt via the onLog("stderr") callback.

describe("bootstrap prompt injection", () => {
  it("injects bootstrap on the first run (no stored sessionId)", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      bootstrapPromptTemplate: "BOOTSTRAP_MARKER: you are agent {{agent.name}}",
    });
    await executeAgentLoop(ctx);

    const stderrOutput = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    // The fake binary echoes stdin; the rendered bootstrap should be present
    expect(stderrOutput).toContain("BOOTSTRAP_MARKER");
  });

  it("does NOT inject bootstrap on a resume run (stored sessionId present)", async () => {
    const ctx = makeCtx(
      {
        cliPath: fakeBin,
        cwd: tmpDir,
        bootstrapPromptTemplate: "BOOTSTRAP_MARKER: you are agent {{agent.name}}",
      },
      // Provide an existing session so previousSessionId is non-empty
      {
        sessionParams: {
          oragerSessionId: "existing-session-001",
          cwd: tmpDir,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    await executeAgentLoop(ctx);

    const stderrOutput = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    expect(stderrOutput).not.toContain("BOOTSTRAP_MARKER");
  });
});

// ── cwd mismatch clears session ───────────────────────────────────────────────

describe("cwd mismatch guard", () => {
  it("starts a fresh session when cwd changed and logs a warning", async () => {
    const otherCwd = path.join(tmpDir, "other");
    await fs.mkdir(otherCwd);

    const ctx = makeCtx(
      { cliPath: fakeBin, cwd: tmpDir },
      // Session was created in a different directory
      {
        sessionParams: {
          oragerSessionId: "old-session-xyz",
          cwd: otherCwd,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    expect(stderrLines).toMatch(/starting fresh/i);
    expect(stderrLines).toMatch(/old-session-xyz/);
  });

  it("does NOT clear the session when cwd matches", async () => {
    const ctx = makeCtx(
      { cliPath: fakeBin, cwd: tmpDir },
      {
        sessionParams: {
          oragerSessionId: "good-session-123",
          cwd: tmpDir,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    const result = await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    expect(stderrLines).not.toMatch(/starting fresh/i);
    // Session was resumed — orager returns its own session id
    expect(result.exitCode).toBe(0);
  });
});

// ── forceResume bypasses cwd mismatch ─────────────────────────────────────────

describe("forceResume", () => {
  it("bypasses the cwd-mismatch guard when forceResume: true", async () => {
    const otherCwd = path.join(tmpDir, "other2");
    await fs.mkdir(otherCwd);

    const ctx = makeCtx(
      { cliPath: fakeBin, cwd: tmpDir, forceResume: true },
      {
        sessionParams: {
          oragerSessionId: "cross-cwd-session",
          cwd: otherCwd,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    // No "starting fresh" warning — forceResume allowed cross-cwd resumption
    expect(stderrLines).not.toMatch(/starting fresh/i);
  });
});
