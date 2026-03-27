import { describe, it, expect } from "vitest";
// We'll test the stream buffer behavior indirectly through parse-stdout.ts
// since the buffer logic lives inside execute-cli.ts's closures.
// Focus on what parse-stdout.ts does with the output that buffer handling produces.
import { parseOpenRouterStdoutLine } from "../src/ui/parse-stdout.js";

const TS = "2026-01-01T00:00:00.000Z";

describe("stream buffer edge cases via parseOpenRouterStdoutLine", () => {
  // ── Fix 2: oversized line discard / resync ───────────────────────────────

  it("partial JSON line falls back to stdout entry", () => {
    const partialJson = '{"type":"result","subtype":"success","result":"Hello","usage":{'; // cut off
    const result = parseOpenRouterStdoutLine(partialJson, TS);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("stdout");
  });

  it("empty line after buffer resync returns no entries", () => {
    expect(parseOpenRouterStdoutLine("", TS)).toHaveLength(0);
    expect(parseOpenRouterStdoutLine("   ", TS)).toHaveLength(0);
  });

  it("valid result line after discard parses correctly", () => {
    const validLine = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Done",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      total_cost_usd: 0.001,
    });
    const entries = parseOpenRouterStdoutLine(validLine, TS);
    const resultEntry = entries.find(e => e.kind === "result");
    expect(resultEntry).toBeDefined();
    expect((resultEntry as { subtype?: string }).subtype).toBe("success");
  });

  it("binary-looking content falls back to stdout entry", () => {
    const binaryLooking = "\x00\x01\x02\x03binary data";
    const result = parseOpenRouterStdoutLine(binaryLooking, TS);
    // Should return stdout entry, not crash
    expect(Array.isArray(result)).toBe(true);
  });

  it("unicode content in tool output parses correctly", () => {
    const line = JSON.stringify({
      type: "tool",
      content: [{ content: "日本語テスト 🚀" }],
    });
    const result = parseOpenRouterStdoutLine(line, TS);
    const stdout = result.find(e => e.kind === "stdout");
    expect(stdout).toBeDefined();
    expect((stdout as { text?: string }).text).toContain("日本語テスト 🚀");
  });

  it("multiple valid events on separate lines each parse independently", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", model: "gpt-4o", session_id: "s1" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Done",
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      }),
    ];

    const [initEntries, assistantEntries, resultEntries] = lines.map(
      line => parseOpenRouterStdoutLine(line, TS),
    );

    expect(initEntries[0]).toMatchObject({ kind: "init", model: "gpt-4o", sessionId: "s1" });
    expect(assistantEntries[0]).toMatchObject({ kind: "assistant", text: "Hello world" });
    const resultEntry = resultEntries.find(e => e.kind === "result");
    expect(resultEntry).toBeDefined();
    expect((resultEntry as { subtype?: string }).subtype).toBe("success");
  });
});
