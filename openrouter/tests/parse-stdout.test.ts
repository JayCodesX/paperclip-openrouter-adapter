import { describe, it, expect } from "vitest";
import { parseOpenRouterStdoutLine } from "../src/ui/parse-stdout.js";

describe("parseOpenRouterStdoutLine", () => {
  const TS = "2026-01-01T00:00:00.000Z";

  // ── Empty / whitespace ──────────────────────────────────────────────────────

  it("returns [] for empty string", () => {
    expect(parseOpenRouterStdoutLine("", TS)).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(parseOpenRouterStdoutLine("   \t\n  ", TS)).toEqual([]);
  });

  // ── SSE delta lines (HTTP adapter) ──────────────────────────────────────────

  it("parses SSE data line with content delta", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`;
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "Hello", ts: TS });
  });

  it("parses SSE data line with reasoning delta", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Let me think..." } }] })}`;
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "Let me think...", ts: TS });
  });

  it("parses SSE data line with both content and reasoning delta", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer", reasoning: "Thought" } }] })}`;
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "Answer" });
    expect(result[1]).toMatchObject({ kind: "thinking", text: "Thought" });
  });

  it("returns [] for SSE data: [DONE]", () => {
    expect(parseOpenRouterStdoutLine("data: [DONE]", TS)).toEqual([]);
  });

  it("returns stdout for invalid JSON in data: line", () => {
    const line = "data: not valid json {{";
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", ts: TS });
  });

  it("returns [] for SSE with empty content (falsy content not pushed)", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "" } }] })}`;
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toEqual([]);
  });

  it("returns [] for SSE with no choices", () => {
    const line = `data: ${JSON.stringify({ choices: [] })}`;
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  it("returns [] for SSE with no delta", () => {
    const line = `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`;
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  // ── Orager system.init ──────────────────────────────────────────────────────

  it("parses system.init event into init entry", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "gpt-4o",
      session_id: "abc-123",
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "init",
      model: "gpt-4o",
      sessionId: "abc-123",
      ts: TS,
    });
  });

  it("uses 'unknown' model when system.init has no model field", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "init", model: "unknown", sessionId: "s1" });
  });

  it("uses empty string sessionId when system.init has no session_id field", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-3" });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "init", model: "claude-3", sessionId: "" });
  });

  it("returns [] for other system events", () => {
    const line = JSON.stringify({ type: "system", subtype: "shutdown" });
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  it("returns [] for system event with no subtype", () => {
    const line = JSON.stringify({ type: "system" });
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  // ── Orager assistant event ──────────────────────────────────────────────────

  it("parses assistant text block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "I will help you." }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "I will help you.", ts: TS });
  });

  it("parses assistant thinking block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "I should analyze this carefully." }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "I should analyze this carefully.", ts: TS });
  });

  it("parses assistant tool_use block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tool_call",
      name: "bash",
      toolUseId: "call_1",
      ts: TS,
    });
  });

  it("parses assistant tool_use block with tool_use_id field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", tool_use_id: "call_2", name: "read_file", input: { path: "/tmp/x" } }],
      },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_call", name: "read_file", toolUseId: "call_2" });
  });

  it("uses 'unknown' name for tool_use block with no name", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "c1", input: {} }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_call", name: "unknown" });
  });

  it("parses mixed content blocks (text + thinking + tool_use)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Planning..." },
          { type: "text", text: "Here is what I will do." },
          { type: "tool_use", id: "call_3", name: "bash", input: { command: "pwd" } },
        ],
      },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "Planning..." });
    expect(result[1]).toMatchObject({ kind: "assistant", text: "Here is what I will do." });
    expect(result[2]).toMatchObject({ kind: "tool_call", name: "bash" });
  });

  it("falls back to stdout when assistant event has no recognizable blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "unknown_type", data: "foo" }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", ts: TS });
  });

  it("falls back to stdout when assistant event has empty content array", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [] } });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", ts: TS });
  });

  it("falls back to stdout when assistant event has no message", () => {
    const line = JSON.stringify({ type: "assistant" });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", ts: TS });
  });

  it("skips text blocks with empty string text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });

  it("skips thinking blocks with empty string thinking", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "" }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });

  // ── Orager user event (tool results) ────────────────────────────────────────

  it("parses user event with tool_result block", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "output here", is_error: false },
        ],
      },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "call_1",
      content: "output here",
      isError: false,
      ts: TS,
    });
  });

  it("parses user event with error tool_result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call_2", content: "Command failed", is_error: true },
        ],
      },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result[0]).toMatchObject({
      kind: "tool_result",
      isError: true,
      content: "Command failed",
    });
  });

  it("parses user event with text block", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "User says hello" }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "user", text: "User says hello", ts: TS });
  });

  it("parses user event with array content in tool_result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_3",
            content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }],
            is_error: false,
          },
        ],
      },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tool_result",
      content: "part1\npart2",
      isError: false,
    });
  });

  it("returns [] for user event with no recognized blocks", () => {
    const line = JSON.stringify({ type: "user", message: { content: [] } });
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  it("skips user text block with empty text", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "" }] },
    });
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  it("uses empty string toolUseId when tool_result has no tool_use_id", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok", is_error: false }] },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "tool_result", toolUseId: "" });
  });

  // ── Orager tool event ────────────────────────────────────────────────────────

  it("parses tool event content into stdout entries", () => {
    const line = JSON.stringify({
      type: "tool",
      content: [
        { content: "Running bash...", other: "ignored" },
        { content: "Done." },
      ],
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "stdout", text: "Running bash...", ts: TS });
    expect(result[1]).toMatchObject({ kind: "stdout", text: "Done.", ts: TS });
  });

  it("returns [] for tool event with no content strings", () => {
    const line = JSON.stringify({ type: "tool", content: [{ other: "data" }] });
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  it("returns [] for tool event with empty content array", () => {
    const line = JSON.stringify({ type: "tool", content: [] });
    expect(parseOpenRouterStdoutLine(line, TS)).toEqual([]);
  });

  it("skips tool content items with empty string content", () => {
    const line = JSON.stringify({
      type: "tool",
      content: [{ content: "" }, { content: "non-empty" }],
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", text: "non-empty" });
  });

  // ── Orager result event (success) ────────────────────────────────────────────

  it("parses orager success result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Done!",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      total_cost_usd: 0.001,
      session_id: "s1",
      finish_reason: "stop",
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result");
    expect(resultEntry).toBeDefined();
    expect(resultEntry).toMatchObject({
      kind: "result",
      subtype: "success",
      isError: false,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
      costUsd: 0.001,
    });
  });

  it("parses orager error result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      result: "Something went wrong",
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result");
    expect(resultEntry).toBeDefined();
    expect(resultEntry).toMatchObject({
      kind: "result",
      subtype: "error",
      isError: true,
      inputTokens: 20,
      outputTokens: 5,
    });
  });

  it("orager result event also pushes assistant text when result string non-empty", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Task complete.",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const assistantEntry = result.find((r) => r.kind === "assistant");
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry).toMatchObject({ kind: "assistant", text: "Task complete." });
  });

  it("orager result event does not push assistant text when result is empty", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const assistantEntry = result.find((r) => r.kind === "assistant");
    expect(assistantEntry).toBeUndefined();
  });

  it("orager result event uses zero tokens when usage is missing", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
      total_cost_usd: 0,
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result");
    expect(resultEntry).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    });
  });

  it("orager error result populates errors array with result text", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      result: "Timed out",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result") as Record<string, unknown> | undefined;
    expect(resultEntry).toBeDefined();
    expect((resultEntry as { errors?: string[] })?.errors).toContain("Timed out");
  });

  it("orager success result has empty errors array", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result") as Record<string, unknown> | undefined;
    expect((resultEntry as { errors?: string[] })?.errors).toEqual([]);
  });

  // ── HTTP adapter result (no subtype) ──────────────────────────────────────────

  it("parses HTTP adapter result event", () => {
    const line = JSON.stringify({
      type: "result",
      model: "gpt-4o",
      content: "Here is the answer.",
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result");
    expect(resultEntry).toMatchObject({
      kind: "result",
      subtype: "success",
      isError: false,
      inputTokens: 200,
      outputTokens: 80,
    });
  });

  it("HTTP adapter result also emits assistant entry for non-empty content", () => {
    const line = JSON.stringify({
      type: "result",
      model: "gpt-4o",
      content: "Here is the answer.",
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const assistantEntry = result.find((r) => r.kind === "assistant");
    expect(assistantEntry).toMatchObject({ kind: "assistant", text: "Here is the answer." });
  });

  it("HTTP adapter result emits thinking entry when reasoning present", () => {
    const line = JSON.stringify({
      type: "result",
      model: "gpt-4o",
      content: "Answer.",
      reasoning: "Let me think step by step.",
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const thinkingEntry = result.find((r) => r.kind === "thinking");
    expect(thinkingEntry).toMatchObject({ kind: "thinking", text: "Let me think step by step." });
  });

  it("HTTP adapter result uses 'unknown' model when model field absent", () => {
    const line = JSON.stringify({
      type: "result",
      content: "Hi",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result") as Record<string, unknown> | undefined;
    expect((resultEntry as { model?: string })?.model).toBe("unknown");
  });

  it("HTTP adapter result uses zero tokens when usage missing", () => {
    const line = JSON.stringify({ type: "result", model: "gpt-4", content: "hi" });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result");
    expect(resultEntry).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it("HTTP adapter result has costUsd of 0", () => {
    const line = JSON.stringify({
      type: "result",
      model: "gpt-4",
      content: "hi",
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const resultEntry = result.find((r) => r.kind === "result");
    expect(resultEntry).toMatchObject({ costUsd: 0 });
  });

  // ── Unrecognized lines ────────────────────────────────────────────────────────

  it("returns stdout entry for unrecognized JSON", () => {
    const line = JSON.stringify({ type: "unknown_event", data: "some data" });
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", ts: TS });
  });

  it("returns stdout entry for non-JSON text", () => {
    const line = "plain text log line here";
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", text: "plain text log line here", ts: TS });
  });

  it("returns stdout entry for JSON array (not an object)", () => {
    const line = JSON.stringify([1, 2, 3]);
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });

  it("returns stdout entry for JSON number", () => {
    const result = parseOpenRouterStdoutLine("42", TS);
    expect(result[0]).toMatchObject({ kind: "stdout" });
  });

  it("trims leading and trailing whitespace before parsing", () => {
    const line = `  ${JSON.stringify({ type: "system", subtype: "init", model: "x", session_id: "y" })}  `;
    const result = parseOpenRouterStdoutLine(line, TS);
    expect(result[0]).toMatchObject({ kind: "init", model: "x" });
  });
});
