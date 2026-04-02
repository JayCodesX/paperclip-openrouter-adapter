/**
 * Tests for Part 2 audit findings (2026-03-29):
 *   TC3  — approvalAnswer forwarding edge cases (null, wrong types, valid shape)
 *   TC5  — spawn path delivers instructions via appendSystemPrompt
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

// ── TC5: appendSystemPrompt on spawn path ─────────────────────────────────────

describe("TC5 — instructions delivered via appendSystemPrompt on spawn path", () => {
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

  it("spawn path: omits appendSystemPrompt when no instructionsFilePath is set", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);
    const cfg = parseConfigFromStderr(stderrText(ctx));
    expect(cfg).not.toBeNull();
    expect(cfg!["appendSystemPrompt"]).toBeUndefined();
    expect(cfg!["systemPromptFile"]).toBeUndefined();
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
