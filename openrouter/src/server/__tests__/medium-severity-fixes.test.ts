/**
 * Tests for Medium severity audit fixes in the adapter (M-20, M-21, M-25, M-27).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { processOragerEvent } from "../execute-cli.js";
import type { OragerStreamState } from "../execute-cli.js";

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
      path.join(process.cwd(), "src/server/execute-cli.ts"),
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
      path.join(process.cwd(), "src/server/execute-cli.ts"),
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
      path.join(process.cwd(), "src/server/execute-cli.ts"),
      "utf8",
    );
    expect(source).toContain("M-27");
    expect(source).toContain('.orager", "tmp"');
    expect(source).toContain("mode: 0o700");
    // Config file itself is opened with 0o600 permissions
    expect(source).toContain("0o600");
  });
});
