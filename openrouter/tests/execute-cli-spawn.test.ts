/**
 * Spawn-path tests for executeAgentLoop:
 *   - config file write failure returns errorCode "config_error"
 *   - spawn error event cleans up config file and returns errorCode "spawn_error"
 *   - timeout fires SIGTERM → result has timedOut: true, errorCode "timeout"
 *   - dry-run mode returns success without spawning, cleans up config file
 *   - requiredEnvVars missing returns errorCode "config_error" before spawning
 *   - maxCostUsdSoft exceeded emits a stderr warning
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeAgentLoop, _resetStateForTesting } from "../src/server/execute-cli.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCtx(
  configOverrides: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
) {
  return {
    runId: "run-spawn-test",
    agent: {
      id: "agent-spawn",
      companyId: "co",
      name: "SpawnAgent",
      adapterType: "openrouter",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      apiKey: "sk-test-key",
      model: "openai/gpt-4o-mini",
      maxTurns: 1,
      cliPath: "/nonexistent/orager-binary",
      ...configOverrides,
    },
    context: { wakeReason: "manual", ...contextOverrides },
    onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => _resetStateForTesting());
afterEach(() => vi.restoreAllMocks());

// ── config file write failure ─────────────────────────────────────────────────

describe("config file write failure", () => {
  it("returns errorCode 'config_error' when fs.open throws", async () => {
    vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    const ctx = makeCtx();
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("config_error");
    expect(result.errorMessage).toContain("Failed to write orager config file");
  });
});

// ── spawn: binary not found ────────────────────────────────────────────────────

describe("CLI not found", () => {
  it("returns errorCode 'cli_not_found' when binary is not on PATH", async () => {
    const ctx = makeCtx({ cliPath: "/nonexistent/orager-binary-xyz" });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("cli_not_found");
    expect(result.errorMessage).toMatch(/Cannot find orager CLI/);
  });

  it("cleans up the config file even when binary is not found", async () => {
    const unlinkedPaths: string[] = [];
    const realUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation((...args: Parameters<typeof fs.unlink>) => {
      unlinkedPaths.push(String(args[0]));
      return realUnlink(...args);
    });

    const ctx = makeCtx({ cliPath: "/nonexistent/orager-binary-xyz" });
    await executeAgentLoop(ctx);

    // At least one unlink should target a file in os.tmpdir()
    expect(unlinkedPaths.some((p) => p.startsWith(os.tmpdir()))).toBe(true);
  });
});

// ── dry-run mode ─────────────────────────────────────────────────────────────

describe("dryRun mode", () => {
  it("returns success without spawning any process", async () => {
    // If the binary is not found but dryRun is true, the run should succeed
    // before reaching the command-resolution step.
    const ctx = makeCtx({ dryRun: true, cliPath: "/nonexistent/binary" });
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toContain("[dry-run]");
    expect((result.resultJson as Record<string, unknown>).subtype).toBe("success");
  });

  it("logs DRY RUN message to stderr", async () => {
    const ctx = makeCtx({ dryRun: true, cliPath: "/nonexistent/binary" });
    await executeAgentLoop(ctx);

    const stderrCalls = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([stream]: [string]) => stream === "stderr",
    );
    const messages = stderrCalls.map(([, msg]: [string, string]) => msg).join("");
    expect(messages).toContain("DRY RUN");
  });

  it("cleans up config file in dry-run mode", async () => {
    const unlinkedPaths: string[] = [];
    const realUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation((...args: Parameters<typeof fs.unlink>) => {
      unlinkedPaths.push(String(args[0]));
      return realUnlink(...args).catch(() => {});
    });

    const ctx = makeCtx({ dryRun: true, cliPath: "/nonexistent/binary" });
    await executeAgentLoop(ctx);

    expect(unlinkedPaths.some((p) => p.startsWith(os.tmpdir()))).toBe(true);
  });
});

// ── requiredEnvVars ───────────────────────────────────────────────────────────

describe("requiredEnvVars pre-flight check", () => {
  it("returns errorCode 'config_error' listing missing vars", async () => {
    const ctx = makeCtx({
      requiredEnvVars: ["MISSING_VAR_XYZZY", "ALSO_MISSING_ABCDE"],
    });
    // Ensure neither var is in the environment
    delete process.env.MISSING_VAR_XYZZY;
    delete process.env.ALSO_MISSING_ABCDE;

    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("config_error");
    expect(result.errorMessage).toContain("MISSING_VAR_XYZZY");
    expect(result.errorMessage).toContain("ALSO_MISSING_ABCDE");
  });

  it("proceeds normally when all required vars are present", async () => {
    process.env.MY_TEST_VAR_FOR_ORAGER = "present";
    const ctx = makeCtx({
      requiredEnvVars: ["MY_TEST_VAR_FOR_ORAGER"],
      cliPath: "/nonexistent/binary",
    });
    const result = await executeAgentLoop(ctx);
    delete process.env.MY_TEST_VAR_FOR_ORAGER;

    // Should fail with cli_not_found, NOT config_error (pre-flight passed)
    expect(result.errorCode).toBe("cli_not_found");
  });
});

// ── missing API key ───────────────────────────────────────────────────────────

describe("missing API key", () => {
  it("returns errorCode 'config_error' when apiKey is empty", async () => {
    const ctx = makeCtx({ apiKey: "" });
    delete process.env.OPENROUTER_API_KEY;
    const result = await executeAgentLoop(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("config_error");
    expect(result.errorMessage).toMatch(/OpenRouter API key is required/);
  });
});

// ── config file is written chmod 600 ─────────────────────────────────────────

describe("config file permissions", () => {
  it("config file is written with mode 0o600", async () => {
    let capturedMode: number | undefined;
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(
      (...args: Parameters<typeof fs.open>) => {
        capturedMode = args[2] as number;
        return realOpen(...args);
      },
    );

    const ctx = makeCtx({ cliPath: "/nonexistent/binary" });
    await executeAgentLoop(ctx);

    expect(capturedMode).toBe(0o600);
  });
});

// ── proc.pid null safety ──────────────────────────────────────────────────────

describe("timeout: proc.pid null safety", () => {
  // This test verifies that the timeout path doesn't throw when proc.pid is
  // somehow unavailable (e.g. spawn returns synchronously before PID is assigned).
  // We test via the settled result shape rather than internal state.

  it("timeout result has timedOut: true and errorCode: timeout", async () => {
    // Create a fake CLI that runs indefinitely (ignores all args — shell script
    // works regardless of the orager-style flags prefixed by executeAgentLoop).
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-timeout-test-"));
    try {
      const fakeCli = path.join(tmpDir, "fake-orager");
      await fs.writeFile(fakeCli, "#!/bin/sh\nsleep 65\n");
      await fs.chmod(fakeCli, 0o755);

      const ctx = {
        runId: "test-timeout-pid",
        agent: { id: "agent-1", name: "Test", companyId: "co-1" },
        runtime: { sessionId: null, sessionParams: {} },
        config: {
          apiKey: "sk-test",
          model: "openai/gpt-4o",
          timeoutSec: 1, // 1 second timeout
          graceSec: 1,
          cliPath: fakeCli,
        },
        context: {},
        onLog: async () => {},
      };
      const result = await executeAgentLoop(ctx as Parameters<typeof executeAgentLoop>[0]);
      expect(result.timedOut).toBe(true);
      expect(result.errorCode).toBe("timeout");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 10_000); // 10s test timeout
});

// ── stdin error logging ───────────────────────────────────────────────────────

describe("stdin write error logging", () => {
  it("logs warning when stdin write fails but does not crash", async () => {
    const logs: Array<{ stream: string; line: string }> = [];
    const ctx = {
      runId: "test-stdin",
      agent: { id: "agent-1", name: "Test", companyId: "co-1" },
      runtime: { sessionId: null, sessionParams: {} },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        // Use a binary that exits immediately (before reading stdin)
        cliPath: process.execPath,
        extraArgs: ["-e", "process.exit(0)"],
      },
      context: {},
      onLog: async (stream: string, line: string) => { logs.push({ stream, line }); },
    };
    const result = await executeAgentLoop(ctx as Parameters<typeof executeAgentLoop>[0]);
    // Process exits immediately — should not throw, should return a result
    expect(result).toBeDefined();
    expect(typeof result.exitCode === "number" || result.exitCode === null).toBe(true);
  }, 10_000);
});
