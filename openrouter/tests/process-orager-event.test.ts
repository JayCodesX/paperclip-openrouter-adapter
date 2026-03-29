/**
 * Unit tests for processOragerEvent — the shared NDJSON stream event handler
 * used by both the daemon (HTTP streaming) and spawn (stdout) paths.
 */
import { describe, it, expect, vi } from "vitest";
import {
  processOragerEvent,
} from "../src/server/execute-cli.js";
import type { OragerStreamState } from "../src/server/execute-cli.js";

function makeState(): OragerStreamState {
  return {
    sessionId: "",
    resolvedModel: "",
    sessionLost: false,
    resultEvent: null,
    questionEvent: null,
  };
}

const noopLog = async () => {};

// ── system event ──────────────────────────────────────────────────────────────

describe("system event", () => {
  it("sets sessionId from session_id field", () => {
    const state = makeState();
    processOragerEvent({ type: "system", session_id: "sess-abc" }, state, noopLog, () => {});
    expect(state.sessionId).toBe("sess-abc");
  });

  it("sets resolvedModel from model field", () => {
    const state = makeState();
    processOragerEvent({ type: "system", session_id: "s", model: "openai/gpt-4o" }, state, noopLog, () => {});
    expect(state.resolvedModel).toBe("openai/gpt-4o");
  });

  it("does not overwrite resolvedModel with an empty string", () => {
    const state = makeState();
    state.resolvedModel = "original-model";
    processOragerEvent({ type: "system", session_id: "s", model: "" }, state, noopLog, () => {});
    expect(state.resolvedModel).toBe("original-model");
  });

  it("ignores system event with non-string session_id", () => {
    const state = makeState();
    processOragerEvent({ type: "system", session_id: 42 }, state, noopLog, () => {});
    expect(state.sessionId).toBe("");
  });
});

// ── result event ──────────────────────────────────────────────────────────────

describe("result event", () => {
  it("captures the result event", () => {
    const state = makeState();
    const evt = { type: "result", subtype: "success", result: "done" };
    processOragerEvent(evt, state, noopLog, () => {});
    expect(state.resultEvent).toBe(evt);
  });

  it("overwrites a previous result event", () => {
    const state = makeState();
    const first = { type: "result", subtype: "success", result: "first" };
    const second = { type: "result", subtype: "success", result: "second" };
    processOragerEvent(first, state, noopLog, () => {});
    processOragerEvent(second, state, noopLog, () => {});
    expect(state.resultEvent).toBe(second);
  });
});

// ── question event ────────────────────────────────────────────────────────────

describe("question event", () => {
  it("captures the first question event", () => {
    const state = makeState();
    const evt = { type: "question", prompt: "Proceed?", choices: [], toolCallId: "t1", toolName: "ask" };
    processOragerEvent(evt, state, noopLog, () => {});
    expect(state.questionEvent?.prompt).toBe("Proceed?");
  });

  it("does not overwrite the first question event with a subsequent one", () => {
    const state = makeState();
    processOragerEvent({ type: "question", prompt: "First?", choices: [], toolCallId: "t1", toolName: "ask" }, state, noopLog, () => {});
    processOragerEvent({ type: "question", prompt: "Second?", choices: [], toolCallId: "t2", toolName: "ask" }, state, noopLog, () => {});
    expect(state.questionEvent?.prompt).toBe("First?");
  });
});

// ── warn event / session_lost ─────────────────────────────────────────────────

describe("warn event — session_lost", () => {
  it("sets sessionLost and calls onSessionLost for subtype session_lost", () => {
    const state = makeState();
    const onSessionLost = vi.fn();
    processOragerEvent(
      { type: "warn", subtype: "session_lost", message: "session x not found, starting fresh" },
      state, noopLog, onSessionLost,
    );
    expect(state.sessionLost).toBe(true);
    expect(onSessionLost).toHaveBeenCalledOnce();
  });

  it("calls onSessionLost only once even if multiple warn events arrive", () => {
    const state = makeState();
    const onSessionLost = vi.fn();
    const evt = { type: "warn", subtype: "session_lost", message: "session x not found, starting fresh" };
    processOragerEvent(evt, state, noopLog, onSessionLost);
    processOragerEvent(evt, state, noopLog, onSessionLost);
    expect(onSessionLost).toHaveBeenCalledOnce();
  });

  it("logs the warn message to stderr", async () => {
    const state = makeState();
    const logs: Array<[string, string]> = [];
    const logFn = async (stream: "stdout" | "stderr", text: string) => { logs.push([stream, text]); };
    processOragerEvent({ type: "warn", message: "something went wrong" }, state, logFn, () => {});
    // Allow any pending microtasks
    await Promise.resolve();
    expect(logs.some(([s, t]) => s === "stderr" && t.includes("something went wrong"))).toBe(true);
  });

  it("does not set sessionLost for a non-session-lost warn message", () => {
    const state = makeState();
    processOragerEvent({ type: "warn", message: "some other warning" }, state, noopLog, () => {});
    expect(state.sessionLost).toBe(false);
  });
});

// ── unknown / ignored event types ────────────────────────────────────────────

describe("unknown event types", () => {
  it("ignores events with unknown type without throwing", () => {
    const state = makeState();
    expect(() => {
      processOragerEvent({ type: "unknown_event_xyz", data: "whatever" }, state, noopLog, () => {});
    }).not.toThrow();
  });

  it("does not mutate state for unrecognised events", () => {
    const state = makeState();
    processOragerEvent({ type: "text_delta", content: "hi" }, state, noopLog, () => {});
    expect(state.sessionId).toBe("");
    expect(state.resultEvent).toBeNull();
    expect(state.questionEvent).toBeNull();
    expect(state.sessionLost).toBe(false);
  });
});
