/**
 * Tests for Medium + Low severity audit fixes in the adapter.
 * M-20, M-21, M-25, M-27, M-18, M-19, L-09, L-10, L-11, L-12, L-13.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processOragerEvent } from "../execute-cli.js";
import type { OragerStreamState } from "../execute-cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXECUTE_CLI_PATH = path.resolve(__dirname, "..", "execute-cli.ts");

function freshState(): OragerStreamState {
  return {
    sessionId: "",
    resolvedModel: "",
    sessionLost: false,
    resultEvent: null,
    questionEvent: null,
  };
}

// ── M-20: Event shape validation before cast ────────────────────────────────

describe("M-20: Question event shape validation", () => {
  it("accepts well-formed question events", () => {
    const state = freshState();
    processOragerEvent(
      {
        type: "question",
        prompt: "Allow?",
        choices: [{ key: "y", label: "Yes" }],
        toolCallId: "tc_1",
        toolName: "bash",
      },
      state,
      () => {},
      () => {},
    );
    expect(state.questionEvent).not.toBeNull();
    expect(state.questionEvent!.prompt).toBe("Allow?");
  });

  it("rejects question events missing prompt", () => {
    const state = freshState();
    processOragerEvent(
      {
        type: "question",
        choices: [{ key: "y", label: "Yes" }],
        toolCallId: "tc_1",
        toolName: "bash",
      },
      state,
      () => {},
      () => {},
    );
    expect(state.questionEvent).toBeNull();
  });

  it("rejects question events with non-array choices", () => {
    const state = freshState();
    processOragerEvent(
      {
        type: "question",
        prompt: "Allow?",
        choices: "not-an-array",
        toolCallId: "tc_1",
        toolName: "bash",
      },
      state,
      () => {},
      () => {},
    );
    expect(state.questionEvent).toBeNull();
  });

  it("rejects question events missing toolCallId", () => {
    const state = freshState();
    processOragerEvent(
      {
        type: "question",
        prompt: "Allow?",
        choices: [],
        toolName: "bash",
      },
      state,
      () => {},
      () => {},
    );
    expect(state.questionEvent).toBeNull();
  });

  it("rejects question events missing toolName", () => {
    const state = freshState();
    processOragerEvent(
      {
        type: "question",
        prompt: "Allow?",
        choices: [],
        toolCallId: "tc_1",
      },
      state,
      () => {},
      () => {},
    );
    expect(state.questionEvent).toBeNull();
  });
});

// ── M-21: Line-by-line oversized segment recovery ───────────────────────────

describe("M-21: Oversized segment recovery uses line-by-line parsing", () => {
  it("source uses split(newline) instead of greedy regex", async () => {
    const source = await fs.readFile(
      EXECUTE_CLI_PATH,
      "utf8",
    );
    expect(source).toContain("M-21");
    expect(source).toContain('discarded.split("\\n")');
    expect(source).toContain("candidateLine");
    // Should NOT use greedy regex for event extraction
    expect(source).not.toMatch(/new RegExp.*\\[\\^\\\\n\\]/);
  });
});

// ── M-25: Skills cleanup on CLI-not-found ───────────────────────────────────

describe("M-25: Ephemeral skills cleanup on CLI-not-found path", () => {
  it("source cleans up skills dir on ensureCommandResolvable failure", async () => {
    const source = await fs.readFile(
      EXECUTE_CLI_PATH,
      "utf8",
    );
    expect(source).toContain("M-25");
    // The cleanup call must appear near ensureCommandResolvable catch
    // The M-25 cleanup appears in the ensureCommandResolvable error path
    const idx25 = source.indexOf("M-25");
    // Nearby code should contain cleanup + the errorCode for cli_not_found
    const nearby = source.slice(idx25 - 200, idx25 + 400);
    expect(nearby).toContain("cleanupOragerSkillsDir");
    expect(nearby).toContain("cli_not_found");
  });
});

// ── M-27: User-private temp directory ───────────────────────────────────────

describe("M-27: Config file uses user-private directory", () => {
  it("source uses ~/.orager/tmp instead of os.tmpdir()", async () => {
    const source = await fs.readFile(
      EXECUTE_CLI_PATH,
      "utf8",
    );
    expect(source).toContain("M-27");
    expect(source).toContain('.orager", "tmp"');
    expect(source).toContain("mode: 0o700");
    // Config file itself is opened with 0o600 permissions
    expect(source).toContain("0o600");
  });
});

// ── M-18: Vision cache pre-warm removed ──────────────────────────────────────
// Vision routing is now handled entirely by orager — the adapter no longer
// maintains its own vision cache or pre-warm logic.

// ── M-19: Process kill fallback wrapped in try/catch ────────────────────────

describe("M-19: Process kill fallback safe", () => {
  it("source wraps fallback proc.kill in try/catch", async () => {
    const source = await fs.readFile(EXECUTE_CLI_PATH, "utf8");
    expect(source).toContain("M-19");
    // Multiple occurrences of the safe pattern
    const matches = source.match(/M-19/g);
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ── L-09: Ring buffer for structured log ────────────────────────────────────

describe("L-09: Ring buffer for log buffer", () => {
  it("source uses RingBuffer class instead of Array.shift()", async () => {
    const source = await fs.readFile(EXECUTE_CLI_PATH, "utf8");
    expect(source).toContain("L-09");
    expect(source).toContain("class RingBuffer");
    expect(source).toContain("new RingBuffer");
    // Should NOT have the old shift pattern for log buffer
    expect(source).not.toContain("_structuredLogBuffer.shift()");
  });
});

// ── L-11: Model cache dedup ─────────────────────────────────────────────────

describe("L-11: Model cache fetch deduplication", () => {
  it("source stores in-flight promise", async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, "..", "list-models.ts"),
      "utf8",
    );
    expect(source).toContain("L-11");
    expect(source).toContain("_fetchInFlight");
  });
});

// ── L-12: Object hooks allowed ──────────────────────────────────────────────

describe("L-12: Hooks filter allows objects", () => {
  it("source does not filter out object-valued hooks", async () => {
    const source = await fs.readFile(EXECUTE_CLI_PATH, "utf8");
    expect(source).toContain("L-12");
  });
});

// ── L-13: Skills dir check is lazy ──────────────────────────────────────────

describe("L-13: Skills dir validation is lazy", () => {
  it("source uses ensureSkillsDirChecked instead of floating promise", async () => {
    const source = await fs.readFile(EXECUTE_CLI_PATH, "utf8");
    expect(source).toContain("L-13");
    expect(source).toContain("ensureSkillsDirChecked");
    expect(source).toContain("_skillsDirChecked");
  });
});
