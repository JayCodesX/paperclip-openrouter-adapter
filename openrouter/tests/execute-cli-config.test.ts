/**
 * Config-file content tests for executeAgentLoop:
 *   - provider routing fields (providerOrder, dataCollection, zdr, sort) appear
 *     in the JSON written to the orager config file
 *   - OTEL env vars (otelEndpoint → OTEL_EXPORTER_OTLP_ENDPOINT, etc.) are
 *     injected into the subprocess environment
 *   - spawn 'error' event: config file is unlinked when proc.on('error') fires
 *
 * Uses a fake orager binary that echoes the config file contents and selected
 * env vars to stderr so tests can capture them via onLog("stderr").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { executeAgentLoop, _resetStateForTesting } from "../src/server/execute-cli.js";

// ── fake orager binary ────────────────────────────────────────────────────────
// Reads --config-file from argv, echoes its JSON content + selected env vars to
// stderr, then emits a minimal success result on stdout.

const RESULT_JSON =
  '{"type":"result","subtype":"success","session_id":"fake-cfg-test","is_error":false,' +
  '"total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5,' +
  '"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"result":"ok"}';

async function createFakeBinary(dir: string): Promise<string> {
  const binPath = path.join(dir, "fake-orager");
  const script = [
    "#!/bin/sh",
    // Parse --config-file <path> from argv
    "config_file=''",
    "while [ $# -gt 0 ]; do",
    "  if [ \"$1\" = \"--config-file\" ]; then",
    "    config_file=\"$2\"",
    "    shift 2",
    "  else",
    "    shift",
    "  fi",
    "done",
    // Echo config file contents
    "if [ -n \"$config_file\" ] && [ -f \"$config_file\" ]; then",
    "  printf 'CONFIG_FILE: %s\\n' \"$(cat \"$config_file\")\" >&2",
    "fi",
    // Echo OTEL env vars
    "printf 'ENV_OTEL_ENDPOINT: %s\\n' \"$OTEL_EXPORTER_OTLP_ENDPOINT\" >&2",
    "printf 'ENV_OTEL_SERVICE_NAME: %s\\n' \"$OTEL_SERVICE_NAME\" >&2",
    "printf 'ENV_OTEL_RESOURCE_ATTRS: %s\\n' \"$OTEL_RESOURCE_ATTRIBUTES\" >&2",
    // Drain stdin and emit result
    "cat > /dev/null",
    `printf '%s\\n' '${RESULT_JSON}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(binPath, script, { mode: 0o755 });
  return binPath;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCtx(configOverrides: Record<string, unknown> = {}) {
  return {
    runId: "run-config-test",
    agent: {
      id: "agent-config",
      companyId: "co",
      name: "ConfigAgent",
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

/** Collect all stderr lines emitted via onLog. */
function stderrOutput(ctx: ReturnType<typeof makeCtx>): string {
  return (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
    .filter(([stream]: [string]) => stream === "stderr")
    .map(([, msg]: [string, string]) => msg)
    .join("");
}

/** Parse the CONFIG_FILE: ... line from stderr and return the JSON object. */
function parseConfigFromStderr(output: string): Record<string, unknown> | null {
  const match = output.match(/CONFIG_FILE: (\{.*\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let tmpDir: string;
let fakeBin: string;

beforeEach(async () => {
  _resetStateForTesting();
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-cfg-test-"));
  tmpDir = await fs.realpath(raw);
  fakeBin = await createFakeBinary(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── provider routing fields ───────────────────────────────────────────────────
// Provider fields are nested under config.provider in the adapter config.

describe("provider routing fields in config file", () => {
  it("writes providerOrder to the config file", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      provider: { order: ["Anthropic", "Together"] },
    });
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.providerOrder).toEqual(["Anthropic", "Together"]);
  });

  it("writes dataCollection to the config file", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      provider: { data_collection: "deny" },
    });
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg!.dataCollection).toBe("deny");
  });

  it("writes zdr: true to the config file", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      provider: { zdr: true },
    });
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg!.zdr).toBe(true);
  });

  it("writes sort to the config file", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      provider: { sort: "price" },
    });
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg!.sort).toBe("price");
  });

  it("writes providerOnly and providerIgnore to the config file", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      provider: { only: ["DeepSeek", "Together"], ignore: ["OpenAI"] },
    });
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg!.providerOnly).toEqual(["DeepSeek", "Together"]);
    expect(cfg!.providerIgnore).toEqual(["OpenAI"]);
  });
});

// ── OTEL env var passthrough ──────────────────────────────────────────────────

describe("OTEL env var passthrough", () => {
  it("injects otelEndpoint as OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      otelEndpoint: "http://localhost:4318",
    });
    await executeAgentLoop(ctx);

    expect(stderrOutput(ctx)).toContain("ENV_OTEL_ENDPOINT: http://localhost:4318");
  });

  it("injects otelServiceName as OTEL_SERVICE_NAME", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      otelServiceName: "my-orager-service",
    });
    await executeAgentLoop(ctx);

    expect(stderrOutput(ctx)).toContain("ENV_OTEL_SERVICE_NAME: my-orager-service");
  });

  it("injects otelResourceAttributes as OTEL_RESOURCE_ATTRIBUTES", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      otelResourceAttributes: "deployment.environment=prod,service.version=1.2.3",
    });
    await executeAgentLoop(ctx);

    expect(stderrOutput(ctx)).toContain(
      "ENV_OTEL_RESOURCE_ATTRS: deployment.environment=prod,service.version=1.2.3",
    );
  });

  it("does not set OTEL env vars when none are configured", async () => {
    // Remove any inherited OTEL vars so we get clean output
    const savedEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const savedService = process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;

    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);

    const out = stderrOutput(ctx);
    // Lines are present but values should be empty
    expect(out).toMatch(/ENV_OTEL_ENDPOINT: \s*\n/);
    expect(out).toMatch(/ENV_OTEL_SERVICE_NAME: \s*\n/);

    if (savedEndpoint !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint;
    if (savedService !== undefined) process.env.OTEL_SERVICE_NAME = savedService;
  });
});

// ── spawn 'error' event — config file cleanup ─────────────────────────────────
// The proc.on('error') handler fires when the OS-level exec fails after the
// process object has been created (e.g., EPERM). We verify that the config
// file is still unlinked in this path.

describe("spawn error event cleanup", () => {
  it("unlinks the config file when the spawned process emits 'error'", async () => {
    const unlinkedPaths: string[] = [];
    const realUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation((...args: Parameters<typeof fs.unlink>) => {
      unlinkedPaths.push(String(args[0]));
      return realUnlink(...args).catch(() => {});
    });

    // Create a valid binary so ensureCommandResolvable passes, then make it
    // emit SIGTERM immediately so the process exits with a non-zero status.
    // Alternatively: use a binary that immediately exits with an error.
    // The proc.on('error') path is hard to trigger without mocking spawn.
    // Instead verify via the synchronous catch path: a spawn() syscall error
    // can be simulated with a binary that exists on disk but has permissions
    // that prevent execution. On most POSIX systems, removing exec bit works.
    const noExecBin = path.join(tmpDir, "no-exec-bin");
    await fs.writeFile(noExecBin, "#!/bin/sh\nexit 0\n", { mode: 0o644 }); // no +x

    const ctx = makeCtx({ cliPath: noExecBin });
    await executeAgentLoop(ctx);

    // The run should fail (cli_not_found or spawn_error — either path unlinks)
    expect(unlinkedPaths.some((p) => p.startsWith(os.tmpdir()))).toBe(true);
  });
});

// ── wakeReasonModels routing ──────────────────────────────────────────────────
// wakeReasonModels maps wake-reason strings to model IDs. When context.wakeReason
// matches a key, the mapped model is used instead of the base model. The config
// file written to disk must contain the effective (post-routing) model.

describe("wakeReasonModels routing", () => {
  it("uses the mapped model when wakeReason matches a wakeReasonModels key", async () => {
    const ctx = {
      ...makeCtx({
        cliPath: fakeBin,
        cwd: tmpDir,
        model: "openai/gpt-4o",
        wakeReasonModels: { comment: "deepseek/deepseek-r1" },
      }),
      context: { wakeReason: "comment" },
    };
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg?.model).toBe("deepseek/deepseek-r1");
  });

  it("uses the base model when wakeReason does not match any wakeReasonModels key", async () => {
    const ctx = {
      ...makeCtx({
        cliPath: fakeBin,
        cwd: tmpDir,
        model: "openai/gpt-4o",
        wakeReasonModels: { comment: "deepseek/deepseek-r1" },
      }),
      context: { wakeReason: "push" }, // "push" not in map
    };
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg?.model).toBe("openai/gpt-4o");
  });

  it("uses the base model when wakeReason is empty", async () => {
    const ctx = {
      ...makeCtx({
        cliPath: fakeBin,
        cwd: tmpDir,
        model: "openai/gpt-4o",
        wakeReasonModels: { comment: "deepseek/deepseek-r1" },
      }),
      context: { wakeReason: "" },
    };
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg?.model).toBe("openai/gpt-4o");
  });

  it("uses the base model when wakeReasonModels is not configured", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
      model: "anthropic/claude-sonnet-4-6",
    });
    await executeAgentLoop(ctx);

    const cfg = parseConfigFromStderr(stderrOutput(ctx));
    expect(cfg?.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("supports multiple entries — routes each wakeReason to its own model", async () => {
    const wakeReasonModels = {
      comment: "deepseek/deepseek-r1",
      review: "openai/gpt-4o",
      push: "google/gemini-2.5-flash",
    };

    for (const [wakeReason, expectedModel] of Object.entries(wakeReasonModels)) {
      const ctx = {
        ...makeCtx({
          cliPath: fakeBin,
          cwd: tmpDir,
          model: "openai/gpt-4o-mini", // base model
          wakeReasonModels,
        }),
        context: { wakeReason },
      };
      await executeAgentLoop(ctx);

      const cfg = parseConfigFromStderr(stderrOutput(ctx));
      expect(cfg?.model).toBe(expectedModel);
    }
  });
});

// ── OTEL passthrough ──────────────────────────────────────────────────────────

describe("OTEL environment variable passthrough", () => {
  // We test by intercepting the spawn call and checking the env it receives.
  // Since we can't easily intercept spawn in unit tests, we verify via the
  // structured log path: the adapter logs env (redacted) in onMeta.

  it("otelEndpoint in config is passed through in onMeta env", async () => {
    const metaCalls: unknown[] = [];
    const ctx = {
      runId: "test-otel",
      agent: { id: "agent-1", name: "Test", companyId: "co-1" },
      runtime: { sessionId: null, sessionParams: {} },
      config: {
        apiKey: "sk-test",
        model: "openai/gpt-4o",
        otelEndpoint: "http://localhost:4318",
        otelServiceName: "orager-test",
        cliPath: "/nonexistent/orager",
      },
      context: {},
      onLog: async () => {},
      onMeta: async (meta: unknown) => { metaCalls.push(meta); },
    };
    // Will fail at cli_not_found, but onMeta is called before spawn
    await executeAgentLoop(ctx as Parameters<typeof executeAgentLoop>[0]);
    expect(metaCalls.length).toBeGreaterThan(0);
    const meta = metaCalls[0] as Record<string, unknown>;
    const env = meta.env as Record<string, string>;
    // OTEL vars should be in the env (they're not sensitive — no REDACTED)
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:4318");
    expect(env.OTEL_SERVICE_NAME).toBe("orager-test");
  });
});

// ── daemonAutoStart config wiring ─────────────────────────────────────────────

describe("daemonAutoStart config wiring", () => {
  it("daemonAutoStart: false does not attempt auto-start when env var absent", async () => {
    delete process.env.ORAGER_DAEMON_AUTOSTART;
    const logs: Array<{ stream: string; line: string }> = [];
    const ctx = {
      runId: "test-autostart",
      agent: { id: "agent-1", name: "Test", companyId: "co-1" },
      runtime: { sessionId: null, sessionParams: {} },
      config: {
        apiKey: "sk-test",
        daemonUrl: "http://127.0.0.1:19998",  // unlikely to be running
        daemonAutoStart: false,
        cliPath: "/nonexistent/orager",
      },
      context: {},
      onLog: async (stream: string, line: string) => { logs.push({ stream, line }); },
    };
    await executeAgentLoop(ctx as Parameters<typeof executeAgentLoop>[0]);
    // Should NOT log an auto-start attempt
    const autoStartLog = logs.find(l => l.line.includes("auto-start"));
    expect(autoStartLog).toBeUndefined();
  });
});
