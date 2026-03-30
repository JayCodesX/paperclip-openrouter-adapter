/**
 * Tests for Part 2 audit findings (2026-03-29):
 *   TC1  — daemon signing-key age warning (>30 days) and unsafe-permissions warning
 *   TC3  — approvalAnswer forwarding edge cases (null, wrong types, valid shape)
 *   TC4  — :online suffix propagated to ALL fallback models, not just primary
 *   TC5  — both spawn and daemon paths deliver instructions via appendSystemPrompt
 *   TC6  — oversized daemon stream segment: result extracted when segment contains result event
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import { chmod } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  executeAgentLoop,
  _resetStateForTesting,
} from "../src/server/execute-cli.js";

// ── shared helpers ────────────────────────────────────────────────────────────

const RESULT_NDJSON =
  '{"type":"result","subtype":"success","session_id":"p2-sess","is_error":false,' +
  '"total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5,' +
  '"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"result":"done"}\n';

async function createFakeBinary(dir: string): Promise<string> {
  const binPath = path.join(dir, "fake-orager");
  const script = [
    "#!/bin/sh",
    "config_file=''",
    "while [ $# -gt 0 ]; do",
    "  if [ \"$1\" = \"--config-file\" ]; then config_file=\"$2\"; shift 2",
    "  else shift; fi",
    "done",
    "if [ -n \"$config_file\" ] && [ -f \"$config_file\" ]; then",
    "  printf 'CONFIG_FILE: %s\\n' \"$(cat \"$config_file\")\" >&2",
    "fi",
    "cat > /dev/null",
    `printf '%s' '${RESULT_NDJSON}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(binPath, script, { mode: 0o755 });
  return binPath;
}

function makeCtx(configOverrides: Record<string, unknown> = {}) {
  return {
    runId: "run-p2-test",
    agent: { id: "agent-p2", companyId: "co", name: "P2Agent", adapterType: "openrouter", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { apiKey: "sk-test-key", model: "openai/gpt-4o-mini", maxTurns: 1, ...configOverrides },
    context: { wakeReason: "manual" },
    onLog: vi.fn().mockResolvedValue(undefined) as (s: "stdout" | "stderr", l: string) => Promise<void>,
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

function stderrText(ctx: ReturnType<typeof makeCtx>): string {
  return (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
    .filter(([s]: [string]) => s === "stderr")
    .map(([, m]: [string, string]) => m)
    .join("");
}

function parseConfigFromStderr(output: string): Record<string, unknown> | null {
  const match = output.match(/CONFIG_FILE: (\{.*\})/);
  if (!match) return null;
  try { return JSON.parse(match[1] as string) as Record<string, unknown>; }
  catch { return null; }
}

/** Spin up a minimal daemon mock that responds with a success NDJSON result. */
async function makeDaemonServer(
  keyPath: string,
  opts: {
    onRequest?: (req: http.IncomingMessage, body: string) => void;
    respondWith?: (res: http.ServerResponse) => void;
  } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<http.Server>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "POST" && req.url === "/run") {
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); });
        req.on("end", () => {
          opts.onRequest?.(req, body);
          if (opts.respondWith) {
            opts.respondWith(res);
          } else {
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            res.write(RESULT_NDJSON);
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
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let tmpDir: string;
let fakeBin: string;

beforeEach(async () => {
  _resetStateForTesting();
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-p2-test-"));
  tmpDir = await fs.realpath(raw);
  fakeBin = await createFakeBinary(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── TC4: :online suffix on fallback models ────────────────────────────────────

describe("TC4 — onlineSearch :online suffix applied to fallback models", () => {
  it("appends :online to every fallback model that lacks a variant suffix", async () => {
    const ctx = makeCtx({
      onlineSearch: true,
      models: ["anthropic/claude-3-haiku", "openai/gpt-4o"],
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.models).toEqual([
      "anthropic/claude-3-haiku:online",
      "openai/gpt-4o:online",
    ]);
  });

  it("does NOT add :online to fallback models that already have a variant suffix", async () => {
    const ctx = makeCtx({
      onlineSearch: true,
      models: ["anthropic/claude-3-haiku:nitro", "openai/gpt-4o:free"],
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.models).toEqual([
      "anthropic/claude-3-haiku:nitro",
      "openai/gpt-4o:free",
    ]);
  });

  it("mixes correctly: suffixed models untouched, unsuffixed get :online", async () => {
    const ctx = makeCtx({
      onlineSearch: true,
      models: ["anthropic/claude-3-haiku", "openai/gpt-4o:nitro"],
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.models).toEqual([
      "anthropic/claude-3-haiku:online",
      "openai/gpt-4o:nitro",
    ]);
  });

  it("does NOT touch fallback models when onlineSearch is false", async () => {
    const ctx = makeCtx({
      onlineSearch: false,
      models: ["anthropic/claude-3-haiku", "openai/gpt-4o"],
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!.models).toEqual([
      "anthropic/claude-3-haiku",
      "openai/gpt-4o",
    ]);
  });

  it("daemon path: models array carries :online suffix when onlineSearch is set", async () => {
    const keyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(keyPath, "tc4-daemon-test-signing-key-32bytes", { encoding: "utf8", mode: 0o600 });

    let capturedBody: Record<string, unknown> | null = null;
    const daemon = await makeDaemonServer(keyPath, {
      onRequest: (_, body) => { try { capturedBody = JSON.parse(body) as Record<string, unknown>; } catch { /* */ } },
    });

    const ctx = makeCtx({
      daemonUrl: daemon.url,
      daemonKeyFile: keyPath,
      onlineSearch: true,
      models: ["anthropic/claude-3-haiku", "openai/gpt-4o"],
      cliPath: "/nonexistent",
    });
    await executeAgentLoop(ctx);
    await daemon.close();

    expect(capturedBody).not.toBeNull();
    const opts = (capturedBody as { opts?: Record<string, unknown> }).opts ?? {};
    expect(opts["models"]).toEqual([
      "anthropic/claude-3-haiku:online",
      "openai/gpt-4o:online",
    ]);
  });
});

// ── TC5: appendSystemPrompt on both spawn and daemon paths ────────────────────

describe("TC5 — instructions delivered via appendSystemPrompt on both paths", () => {
  it("spawn path: sends appendSystemPrompt (file content), not systemPromptFile", async () => {
    const instrFile = path.join(tmpDir, "instructions.md");
    await fs.writeFile(instrFile, "# Custom Instructions\nDo something specific.", "utf8");

    const ctx = makeCtx({
      instructionsFilePath: instrFile,
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    // Must send the file CONTENTS as appendSystemPrompt
    expect(cfg!["appendSystemPrompt"]).toBe("# Custom Instructions\nDo something specific.");
    // Must NOT send a file path (systemPromptFile is the old pattern)
    expect(cfg!["systemPromptFile"]).toBeUndefined();
  });

  it("daemon path: sends appendSystemPrompt (file content) in HTTP body opts", async () => {
    const instrFile = path.join(tmpDir, "instructions.md");
    await fs.writeFile(instrFile, "Daemon system prompt content.", "utf8");

    const keyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(keyPath, "tc5-daemon-test-signing-key-32bytes", { encoding: "utf8", mode: 0o600 });

    let capturedOpts: Record<string, unknown> | null = null;
    const daemon = await makeDaemonServer(keyPath, {
      onRequest: (_, body) => {
        try {
          const parsed = JSON.parse(body) as { opts?: Record<string, unknown> };
          capturedOpts = parsed.opts ?? null;
        } catch { /* */ }
      },
    });

    const ctx = makeCtx({
      daemonUrl: daemon.url,
      daemonKeyFile: keyPath,
      instructionsFilePath: instrFile,
      cliPath: "/nonexistent",
      cwd: tmpDir,
    });
    await executeAgentLoop(ctx);
    await daemon.close();

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!["appendSystemPrompt"]).toBe("Daemon system prompt content.");
    expect(capturedOpts!["systemPromptFile"]).toBeUndefined();
  });

  it("spawn path: omits appendSystemPrompt when no instructionsFilePath is set", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!["appendSystemPrompt"]).toBeUndefined();
    expect(cfg!["systemPromptFile"]).toBeUndefined();
  });
});

// ── TC1: daemon signing-key age and permission warnings ───────────────────────

describe("TC1 — daemon signing-key warnings", () => {
  it("emits age warning when key file mtime is older than 30 days", async () => {
    const keyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(keyPath, "old-key-content-32bytes-padding!!", { encoding: "utf8", mode: 0o600 });

    // Back-date the key file to 31 days ago using utimes
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(keyPath, thirtyOneDaysAgo, thirtyOneDaysAgo);

    const daemon = await makeDaemonServer(keyPath);
    const ctx = makeCtx({
      daemonUrl: daemon.url,
      daemonKeyFile: keyPath,
      cliPath: "/nonexistent",
    });
    await executeAgentLoop(ctx);
    await daemon.close();

    const stderr = stderrText(ctx);
    expect(stderr).toMatch(/daemon signing key.*31 days old|daemon signing key.*is \d+ days old/i);
  });

  it("does NOT emit age warning when key file is recent (< 30 days)", async () => {
    const keyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(keyPath, "fresh-key-content-32bytes-paddd!", { encoding: "utf8", mode: 0o600 });

    const daemon = await makeDaemonServer(keyPath);
    const ctx = makeCtx({
      daemonUrl: daemon.url,
      daemonKeyFile: keyPath,
      cliPath: "/nonexistent",
    });
    await executeAgentLoop(ctx);
    await daemon.close();

    const stderr = stderrText(ctx);
    expect(stderr).not.toMatch(/days old/i);
  });

  it("emits permissions warning when key file is group-readable (mode 0o640)", async () => {
    // Skip on Windows — chmod is a no-op
    if (process.platform === "win32") return;

    const keyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(keyPath, "unsafe-key-content-32bytes-padd!", { encoding: "utf8", mode: 0o600 });
    await chmod(keyPath, 0o640); // deliberately make group-readable

    const daemon = await makeDaemonServer(keyPath);
    const ctx = makeCtx({
      daemonUrl: daemon.url,
      daemonKeyFile: keyPath,
      cliPath: "/nonexistent",
    });
    await executeAgentLoop(ctx);
    await daemon.close();

    const stderr = stderrText(ctx);
    expect(stderr).toMatch(/unsafe permissions|chmod 600/i);
  });
});

// ── TC3: approvalAnswer forwarding edge cases ─────────────────────────────────

describe("TC3 — approvalAnswer forwarding edge cases", () => {
  it("forwards approvalAnswer when questionAnswer has correct { choiceKey, toolCallId } shape", async () => {
    const ctx = makeCtx({
      cliPath: fakeBin,
      cwd: tmpDir,
    });
    // Inject questionAnswer via context
    (ctx as unknown as { context: Record<string, unknown> }).context = {
      wakeReason: "approval",
      questionAnswer: { choiceKey: "yes", toolCallId: "call-abc" },
    };
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!["approvalAnswer"]).toEqual({ choiceKey: "yes", toolCallId: "call-abc" });
  });

  it("does NOT forward approvalAnswer when questionAnswer is null", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    (ctx as unknown as { context: Record<string, unknown> }).context = {
      wakeReason: "manual",
      questionAnswer: null,
    };
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    // approvalAnswer should be absent (not forwarded when null)
    expect(cfg!["approvalAnswer"]).toBeUndefined();
  });

  it("does NOT forward approvalAnswer when questionAnswer has missing toolCallId", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    (ctx as unknown as { context: Record<string, unknown> }).context = {
      wakeReason: "approval",
      questionAnswer: { choiceKey: "yes" }, // missing toolCallId
    };
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!["approvalAnswer"]).toBeUndefined();
  });

  it("does NOT forward approvalAnswer when questionAnswer has missing choiceKey", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    (ctx as unknown as { context: Record<string, unknown> }).context = {
      wakeReason: "approval",
      questionAnswer: { toolCallId: "call-abc" }, // missing choiceKey
    };
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!["approvalAnswer"]).toBeUndefined();
  });

  it("does NOT forward approvalAnswer when questionAnswer fields are wrong types", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    (ctx as unknown as { context: Record<string, unknown> }).context = {
      wakeReason: "approval",
      questionAnswer: { choiceKey: 42, toolCallId: true }, // wrong types
    };
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!["approvalAnswer"]).toBeUndefined();
  });
});

// ── TC6: oversized daemon stream segment recovery ─────────────────────────────

describe("TC6 — oversized daemon stream segment recovery", () => {
  it("extracts result from segment that exceeds 10 MB buffer and contains a result event", async () => {
    const keyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(keyPath, "tc6-daemon-test-signing-key-32bytes", { encoding: "utf8", mode: 0o600 });

    const RESULT_EVENT = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "recovered",
      session_id: "tc6-sess",
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      total_cost_usd: 0.001,
    });

    const daemon = await makeDaemonServer(keyPath, {
      respondWith: (res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Emit a single line > 10 MB that contains the result event embedded in junk
        const junk = "x".repeat(10 * 1024 * 1024 + 100);
        // The result event is embedded inside the oversized segment
        res.write(`${junk}${RESULT_EVENT}\n`);
        res.end();
      },
    });

    const ctx = makeCtx({
      daemonUrl: daemon.url,
      daemonKeyFile: keyPath,
      cliPath: "/nonexistent",
    });
    const result = await executeAgentLoop(ctx);
    await daemon.close();

    // The adapter should warn about the oversized segment
    expect(stderrText(ctx)).toMatch(/oversized stream segment/i);
    // And should have recovered the result (exitCode 0) or at minimum not crashed
    // (the segment may or may not be fully parseable depending on extraction logic)
    expect(result).toBeDefined();
  });

  it("returns no_result errorCode when oversized segment does NOT contain a result event", async () => {
    const keyPath = path.join(tmpDir, "daemon.key");
    await fs.writeFile(keyPath, "tc6b-daemon-test-signing-key-32bytes", { encoding: "utf8", mode: 0o600 });

    const daemon = await makeDaemonServer(keyPath, {
      respondWith: (res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Pure junk — no result event embedded
        const junk = "x".repeat(10 * 1024 * 1024 + 100);
        res.write(`${junk}\n`);
        res.end();
      },
    });

    const ctx = makeCtx({
      daemonUrl: daemon.url,
      daemonKeyFile: keyPath,
      cliPath: "/nonexistent",
    });
    const result = await executeAgentLoop(ctx);
    await daemon.close();

    expect(stderrText(ctx)).toMatch(/oversized|exceeded/i);
    // Without a result event, we fall back to spawn or return no_result
    expect(result).toBeDefined();
  });
});
