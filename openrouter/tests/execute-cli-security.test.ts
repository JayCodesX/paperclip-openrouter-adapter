/**
 * Security-path tests for executeAgentLoop:
 *   - non-loopback daemonUrl is ignored (SSRF guard), falls through to spawn
 *   - symlink traversal via instructionsFilePath is blocked (safeInstructionsFilePath = "")
 *   - instructionsFilePath outside cwd is blocked
 *   - malformed daemonUrl (not a valid URL) is silently ignored
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
    runId: "run-security-test",
    agent: {
      id: "agent-security",
      companyId: "co",
      name: "SecurityAgent",
      adapterType: "openrouter",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      apiKey: "sk-test-key",
      model: "openai/gpt-4o-mini",
      maxTurns: 1,
      cliPath: "/nonexistent/orager-binary-xyz",
      ...configOverrides,
    },
    context: { wakeReason: "manual", ...contextOverrides },
    onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => _resetStateForTesting());
afterEach(() => vi.restoreAllMocks());

// ── non-loopback daemonUrl SSRF guard ─────────────────────────────────────────

describe("daemonUrl SSRF guard", () => {
  it("ignores a non-loopback daemonUrl and logs a warning", async () => {
    const ctx = makeCtx({ daemonUrl: "http://evil.example.com:4000" });
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    expect(stderrLines).toMatch(/ignoring non-loopback daemonUrl/i);
  });

  it("falls through to spawn (cli_not_found) after rejecting non-loopback daemonUrl", async () => {
    const ctx = makeCtx({ daemonUrl: "http://10.0.0.1:4000" });
    const result = await executeAgentLoop(ctx);

    // Daemon was skipped (SSRF guard), so we get spawn's cli_not_found
    expect(result.errorCode).toBe("cli_not_found");
  });

  it("accepts a loopback daemonUrl (127.0.0.1) without warning", async () => {
    // Daemon is not actually running, so it will time out / fall through to spawn.
    // The important thing is no SSRF warning is logged.
    const ctx = makeCtx({ daemonUrl: "http://127.0.0.1:19999" });
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    expect(stderrLines).not.toMatch(/ignoring non-loopback daemonUrl/i);
  });

  it("accepts a localhost daemonUrl without warning", async () => {
    const ctx = makeCtx({ daemonUrl: "http://localhost:19999" });
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    expect(stderrLines).not.toMatch(/ignoring non-loopback daemonUrl/i);
  });

  it("silently ignores a malformed (non-URL) daemonUrl", async () => {
    const ctx = makeCtx({ daemonUrl: "not-a-url" });
    const result = await executeAgentLoop(ctx);

    // Falls through to spawn
    expect(result.errorCode).toBe("cli_not_found");
    // No crash — result is well-formed
    expect(result.exitCode).toBe(1);
  });
});

// ── instructionsFilePath symlink / traversal guard ───────────────────────────

describe("instructionsFilePath traversal guard", () => {
  it("blocks an instructionsFilePath that is outside cwd", async () => {
    // Point to a file that definitely exists but is outside any reasonable cwd.
    const ctx = makeCtx({
      instructionsFilePath: "/etc/hosts",
      cwd: os.tmpdir(),
    });
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]: [string]) => stream === "stderr")
      .map(([, msg]: [string, string]) => msg)
      .join("");

    expect(stderrLines).toMatch(/instructionsFilePath.*outside cwd/i);
  });

  it("blocks a symlink that resolves outside cwd", async () => {
    // Create a temp dir to act as cwd, put a symlink in it pointing to /etc/hosts.
    // Use realpath to resolve macOS /tmp → /private/tmp so the cwd prefix is canonical.
    const tmpDirRaw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-test-"));
    const tmpDir = await fs.realpath(tmpDirRaw);
    const symlinkPath = path.join(tmpDir, "instructions.md");
    try {
      await fs.symlink("/etc/hosts", symlinkPath);

      const ctx = makeCtx({
        instructionsFilePath: "instructions.md",
        cwd: tmpDir,
      });
      await executeAgentLoop(ctx);

      const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
        .filter(([stream]: [string]) => stream === "stderr")
        .map(([, msg]: [string, string]) => msg)
        .join("");

      // Either "outside cwd" or a resolution error — both mean the file was blocked
      expect(stderrLines).toMatch(/instructionsFilePath/i);
    } finally {
      await fs.unlink(symlinkPath).catch(() => {});
      await fs.rmdir(tmpDir).catch(() => {});
    }
  });

  it("allows a valid instructionsFilePath within cwd", async () => {
    // Create a real file inside a temp cwd.
    // Use realpath to resolve macOS /tmp → /private/tmp so the prefix check passes.
    const tmpDirRaw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-test-"));
    const tmpDir = await fs.realpath(tmpDirRaw);
    const instructionsPath = path.join(tmpDir, "system.md");
    try {
      await fs.writeFile(instructionsPath, "You are a helpful assistant.\n");

      const ctx = makeCtx({
        instructionsFilePath: "system.md",
        cwd: tmpDir,
      });
      const result = await executeAgentLoop(ctx);

      // No traversal warning
      const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
        .filter(([stream]: [string]) => stream === "stderr")
        .map(([, msg]: [string, string]) => msg)
        .join("");

      expect(stderrLines).not.toMatch(/instructionsFilePath.*outside cwd/i);
      // Run still fails at spawn (binary not found), not at security check
      expect(result.errorCode).toBe("cli_not_found");
    } finally {
      await fs.unlink(instructionsPath).catch(() => {});
      await fs.rmdir(tmpDir).catch(() => {});
    }
  });

  it("gracefully handles a non-existent instructionsFilePath", async () => {
    const ctx = makeCtx({
      instructionsFilePath: "does-not-exist.md",
      cwd: os.tmpdir(),
    });
    // Should not throw — just warn and continue
    const result = await executeAgentLoop(ctx);

    // The run still makes it to the spawn step
    expect(result.errorCode).toBe("cli_not_found");
  });
});

// ── extraArgs blocklist ───────────────────────────────────────────────────────

beforeEach(() => { _resetStateForTesting(); });

describe("extraArgs blocklist", () => {
  // We test this by calling executeAgentLoop with dangerous extraArgs and
  // verifying it returns a config_error before spawning anything.

  function makeCtx(extraArgs: string[]): Parameters<typeof executeAgentLoop>[0] {
    return {
      runId: "test-blocklist",
      agent: { id: "agent-1", name: "Test", companyId: "co-1" },
      runtime: { sessionId: null, sessionParams: {} },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        extraArgs,
      },
      context: {},
      onLog: async () => {},
    };
  }

  it("rejects --dangerously-skip-permissions in extraArgs", async () => {
    const result = await executeAgentLoop(makeCtx(["--dangerously-skip-permissions"]));
    expect(result.errorCode).toBe("config_error");
    expect(result.errorMessage).toContain("--dangerously-skip-permissions");
    expect(result.exitCode).toBe(1);
  });

  it("rejects --serve in extraArgs", async () => {
    const result = await executeAgentLoop(makeCtx(["--serve"]));
    expect(result.errorCode).toBe("config_error");
  });

  it("rejects --config-file in extraArgs", async () => {
    const result = await executeAgentLoop(makeCtx(["--config-file", "/tmp/malicious.json"]));
    expect(result.errorCode).toBe("config_error");
  });

  it("allows safe flags through", async () => {
    // --verbose is safe and should not be blocked (run will fail at spawn, not blocklist)
    const ctx = makeCtx(["--verbose"]);
    const result = await executeAgentLoop(ctx);
    // Should fail for a different reason (missing binary), not config_error from blocklist
    expect(result.errorCode).not.toBe("config_error");
  });
});

describe("extraArgs blocklist — equals-sign form", () => {
  // The blocklist now catches both "--flag" (bare) and "--flag=value" (equals-sign) variants.

  function makeEqCtx(extraArgs: string[]): Parameters<typeof executeAgentLoop>[0] {
    return {
      runId: "test-eq-blocklist",
      agent: { id: "agent-1", name: "Test", companyId: "co-1" },
      runtime: { sessionId: null, sessionParams: {} },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        extraArgs,
      },
      context: {},
      onLog: async () => {},
    };
  }

  it("rejects --config-file=/tmp/evil (equals-sign variant)", async () => {
    const result = await executeAgentLoop(makeEqCtx(["--config-file=/tmp/evil"]));
    expect(result.errorCode).toBe("config_error");
    expect(result.errorMessage).toContain("--config-file");
  });

  it("rejects --dangerously-skip-permissions=true (equals-sign variant)", async () => {
    const result = await executeAgentLoop(makeEqCtx(["--dangerously-skip-permissions=true"]));
    expect(result.errorCode).toBe("config_error");
    expect(result.errorMessage).toContain("--dangerously-skip-permissions");
  });

  it("rejects --serve=1 (equals-sign variant)", async () => {
    const result = await executeAgentLoop(makeEqCtx(["--serve=1"]));
    expect(result.errorCode).toBe("config_error");
  });

  it("allows --verbose (safe flag, no equals-sign match)", async () => {
    const result = await executeAgentLoop(makeEqCtx(["--verbose"]));
    // Falls through to spawn (binary not found) — not a config_error
    expect(result.errorCode).not.toBe("config_error");
  });
});

describe("webhookUrl loopback SSRF guard", () => {
  // webhookUrl pointing at loopback addresses should be silently ignored (SSRF guard).
  // The run continues but the config object sent to orager omits webhookUrl.
  // We verify the warning is logged; the run itself falls through to spawn (cli_not_found).

  function makeWebhookCtx(webhookUrl: string): Parameters<typeof executeAgentLoop>[0] {
    return {
      runId: "test-webhook-ssrf",
      agent: { id: "agent-webhook", name: "Test", companyId: "co-1" },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        webhookUrl,
        cliPath: "/nonexistent/orager-binary-xyz",
      },
      context: { wakeReason: "manual" },
      onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
      onMeta: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("ignores webhookUrl pointing at 127.0.0.1 and logs a warning", async () => {
    const ctx = makeWebhookCtx("http://127.0.0.1:9000/hook");
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([s]: [string]) => s === "stderr")
      .map(([, m]: [string, string]) => m)
      .join("");

    expect(stderrLines).toMatch(/webhookUrl.*loopback|loopback.*SSRF/i);
  });

  it("ignores webhookUrl pointing at IPv6-mapped loopback (::ffff:127.0.0.1)", async () => {
    const ctx = makeWebhookCtx("http://[::ffff:127.0.0.1]:9000/hook");
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([s]: [string]) => s === "stderr")
      .map(([, m]: [string, string]) => m)
      .join("");

    expect(stderrLines).toMatch(/webhookUrl.*loopback|loopback.*SSRF/i);
  });

  it("ignores webhookUrl pointing at localhost", async () => {
    const ctx = makeWebhookCtx("http://localhost:3000/hook");
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([s]: [string]) => s === "stderr")
      .map(([, m]: [string, string]) => m)
      .join("");

    expect(stderrLines).toMatch(/webhookUrl.*loopback|loopback.*SSRF/i);
  });

  it("allows a legitimate external webhookUrl without warning", async () => {
    const ctx = makeWebhookCtx("https://hooks.example.com/my-webhook");
    await executeAgentLoop(ctx);

    const stderrLines = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([s]: [string]) => s === "stderr")
      .map(([, m]: [string, string]) => m)
      .join("");

    expect(stderrLines).not.toMatch(/webhookUrl.*loopback/i);
  });
});
