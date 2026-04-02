/**
 * P3 tests for executeAgentLoop:
 *   - structured log run_complete: fields written to ORAGER_LOG_FILE include
 *     inputTokens, outputTokens, cachedInputTokens, turnCount, subtype, costUsd
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeAgentLoop,
  _resetStateForTesting,
  _drainStructuredLogForTesting,
} from "../src/server/execute-cli.js";

// ── fake orager binary ────────────────────────────────────────────────────────

const RESULT_JSON =
  '{"type":"result","subtype":"success","session_id":"cb-test-session","is_error":false,' +
  '"total_cost_usd":0.002,"turn_count":3,' +
  '"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":5,"cache_read_input_tokens":20},' +
  '"result":"done"}';

async function createFakeBinary(dir: string): Promise<string> {
  const binPath = path.join(dir, "fake-orager");
  const script = [
    "#!/bin/sh",
    "cat > /dev/null",
    `printf '%s\\n' '${RESULT_JSON}'`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(binPath, script, { mode: 0o755 });
  return binPath;
}

function makeCtx(configOverrides: Record<string, unknown> = {}) {
  return {
    runId: "run-p3-test",
    agent: {
      id: "agent-p3",
      companyId: "co",
      name: "P3Agent",
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

let tmpDir: string;
let fakeBin: string;

beforeEach(async () => {
  _resetStateForTesting();
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-p3-test-"));
  tmpDir = await fs.realpath(raw);
  fakeBin = await createFakeBinary(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── structured log run_complete fields ───────────────────────────────────────
// Uses _drainStructuredLogForTesting() which captures all structuredLog() calls
// into an in-memory buffer (regardless of ORAGER_LOG_FILE).

describe("structured log run_complete fields", () => {
  it("writes run_complete event with usage and subtype fields", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    const result = await executeAgentLoop(ctx);
    expect(result.exitCode).toBe(0);

    const entries = _drainStructuredLogForTesting();
    const runComplete = entries.find((e) => e.event === "run_complete");
    expect(runComplete).toBeTruthy();

    expect(runComplete!.level).toBe("info");
    expect(runComplete!.agentId).toBe("agent-p3");
    expect(runComplete!.runId).toBe("run-p3-test");
    expect(typeof runComplete!.durationMs).toBe("number");
    expect(runComplete!.subtype).toBe("success");

    // Usage fields from the fake binary result JSON
    expect(runComplete!.inputTokens).toBe(100);
    expect(runComplete!.outputTokens).toBe(50);
    expect(runComplete!.cachedInputTokens).toBe(20);
    expect(typeof runComplete!.costUsd).toBe("number");
  });

  it("also writes a run_start event before run_complete", async () => {
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);

    const events = _drainStructuredLogForTesting().map((e) => e.event);
    expect(events).toContain("run_start");
    expect(events).toContain("run_complete");
    expect(events.indexOf("run_start")).toBeLessThan(events.indexOf("run_complete"));
  });

  it("writes cacheWriteInputTokens in run_complete when binary reports cache_creation_input_tokens", async () => {
    // RESULT_JSON (defined at the top of this file) includes cache_creation_input_tokens:5
    const ctx = makeCtx({ cliPath: fakeBin, cwd: tmpDir });
    await executeAgentLoop(ctx);

    const entries = _drainStructuredLogForTesting();
    const runComplete = entries.find((e) => e.event === "run_complete");
    expect(runComplete).toBeTruthy();
    // cache_creation_input_tokens: 5 in the fake binary output → cacheWriteInputTokens: 5
    expect(runComplete!.cacheWriteInputTokens).toBe(5);
  });
});
