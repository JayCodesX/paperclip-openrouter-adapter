import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Orager stream-json events ─────────────────────────────────────────────────

function parseOragerAssistantEvent(
  event: Record<string, unknown>,
  ts: string,
  rawLine: string,
): TranscriptEntry[] {
  const message = asRecord(event.message);
  if (!message) return [{ kind: "stdout", ts, text: rawLine }];
  const content = Array.isArray(message.content) ? message.content : [];
  const entries: TranscriptEntry[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
      entries.push({ kind: "thinking", ts, text: b.thinking });
    } else if (b.type === "text" && typeof b.text === "string" && b.text) {
      entries.push({ kind: "assistant", ts, text: b.text });
    } else if (b.type === "tool_use") {
      entries.push({
        kind: "tool_call",
        ts,
        name: typeof b.name === "string" ? b.name : "unknown",
        toolUseId:
          typeof b.id === "string"
            ? b.id
            : typeof b.tool_use_id === "string"
              ? b.tool_use_id
              : undefined,
        input: b.input ?? {},
      } as TranscriptEntry);
    }
  }
  // Fall back to stdout when message has no recognized content blocks
  return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: rawLine }];
}

function parseOragerUserEvent(
  event: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const message = asRecord(event.message) ?? {};
  const content = Array.isArray(message.content) ? message.content : [];
  const entries: TranscriptEntry[] = [];
  for (const blockRaw of content) {
    const block = asRecord(blockRaw);
    if (!block) continue;
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) entries.push({ kind: "user", ts, text });
    } else if (blockType === "tool_result") {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const isError = block.is_error === true;
      let text = "";
      if (typeof block.content === "string") {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        const parts: string[] = [];
        for (const part of block.content) {
          const p = asRecord(part);
          if (p && typeof p.text === "string") parts.push(p.text);
        }
        text = parts.join("\n");
      }
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId,
        content: text,
        isError,
      } as TranscriptEntry);
    }
  }
  return entries;
}

function parseOragerResultEvent(
  event: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const resultText =
    typeof event.result === "string" ? event.result : "";
  const subtype =
    typeof event.subtype === "string" ? event.subtype : "error";
  const isSuccess = subtype === "success";
  const usageRaw = asRecord(event.usage);
  const totalCostUsd =
    typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0;

  const entries: TranscriptEntry[] = [];

  if (resultText) {
    entries.push({ kind: "assistant", ts, text: resultText });
  }

  entries.push({
    kind: "result",
    ts,
    text: resultText,
    inputTokens: usageRaw
      ? typeof usageRaw.input_tokens === "number"
        ? usageRaw.input_tokens
        : 0
      : 0,
    outputTokens: usageRaw
      ? typeof usageRaw.output_tokens === "number"
        ? usageRaw.output_tokens
        : 0
      : 0,
    cachedTokens: usageRaw
      ? typeof usageRaw.cache_read_input_tokens === "number"
        ? usageRaw.cache_read_input_tokens
        : 0
      : 0,
    costUsd: totalCostUsd || 0,
    subtype: isSuccess ? "success" : subtype,
    isError: !isSuccess,
    errors: isSuccess ? [] : [resultText || subtype],
    model: "openrouter",
  } as TranscriptEntry);

  return entries;
}

// ── HTTP adapter SSE / result lines ──────────────────────────────────────────

function parseHttpResultEvent(
  parsed: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const content =
    typeof parsed.content === "string" ? parsed.content : "";
  const model = typeof parsed.model === "string" ? parsed.model : "unknown";
  const usage = asRecord(parsed.usage);
  const reasoning =
    typeof parsed.reasoning === "string" ? parsed.reasoning : "";

  const entries: TranscriptEntry[] = [];

  if (reasoning) {
    entries.unshift({ kind: "thinking", ts, text: reasoning });
  }

  if (content) {
    entries.push({ kind: "assistant", ts, text: content });
  }

  entries.push({
    kind: "result",
    ts,
    text: content,
    inputTokens: usage
      ? typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : 0
      : 0,
    outputTokens: usage
      ? typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : 0
      : 0,
    cachedTokens:
      typeof parsed.cachedTokens === "number" ? parsed.cachedTokens : 0,
    costUsd: 0,
    subtype: "success",
    isError: false,
    errors: [],
    model,
  } as TranscriptEntry);

  return entries;
}

/**
 * Parses a single stdout line emitted by either the HTTP adapter or the
 * CLI-based agent loop (orager) into TranscriptEntry objects for the
 * Paperclip run viewer.
 *
 * HTTP adapter emits:
 *   1. SSE data lines:  `data: <openai-delta-json>`
 *   2. A final result:  `{"type":"result","model":"...","content":"...","usage":...}`
 *
 * Orager (CLI agent loop) emits stream-json events:
 *   1. `{"type":"system","subtype":"init",...}`
 *   2. `{"type":"assistant","message":{"content":[...]}}`
 *   3. `{"type":"user","message":{"content":[...]}}`  (tool results)
 *   4. `{"type":"tool","content":[...]}`
 *   5. `{"type":"result","subtype":"success","result":"...","usage":{...},...}`
 */
export function parseOpenRouterStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // ── SSE delta lines (HTTP adapter) ──────────────────────────────────────
  if (trimmed.startsWith("data:")) {
    const dataStr = trimmed.slice("data:".length).trim();
    if (dataStr === "[DONE]") return [];

    const parsed = asRecord(safeJsonParse(dataStr));
    if (!parsed) return [{ kind: "stdout", ts, text: trimmed }];

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const entries: TranscriptEntry[] = [];
    for (const choiceRaw of choices) {
      const choice = asRecord(choiceRaw);
      if (!choice) continue;
      const delta = asRecord(choice.delta);
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        entries.push({ kind: "assistant", ts, text: delta.content });
      }
      if (typeof delta.reasoning === "string" && delta.reasoning) {
        entries.push({ kind: "thinking", ts, text: delta.reasoning });
      }
    }
    return entries;
  }

  // ── JSON events ───────────────────────────────────────────────────────────
  const parsed = asRecord(safeJsonParse(trimmed));
  if (!parsed) return [{ kind: "stdout", ts, text: trimmed }];

  // Orager: system.init — emit an init entry (model + session ID)
  if (parsed.type === "system" && parsed.subtype === "init") {
    return [
      {
        kind: "init",
        ts,
        model: typeof parsed.model === "string" ? parsed.model : "unknown",
        sessionId:
          typeof parsed.session_id === "string" ? parsed.session_id : "",
      } as TranscriptEntry,
    ];
  }

  // Orager: other system events — nothing to render
  if (parsed.type === "system") return [];

  // Orager: assistant event with content blocks
  if (parsed.type === "assistant") {
    return parseOragerAssistantEvent(parsed, ts, trimmed);
  }

  // Orager: user event (carries tool_result blocks back to the model)
  if (parsed.type === "user") {
    return parseOragerUserEvent(parsed, ts);
  }

  // Orager: tool results — surface as stdout so the user can see what ran
  if (parsed.type === "tool") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    const entries: TranscriptEntry[] = [];
    for (const item of content) {
      const r = asRecord(item);
      if (!r) continue;
      if (typeof r.content === "string" && r.content) {
        entries.push({ kind: "stdout", ts, text: r.content });
      }
    }
    return entries;
  }

  // Orager result (has "subtype" and "result" fields)
  // HTTP adapter result (has "content" and "model" fields, no "subtype")
  if (parsed.type === "result") {
    if (typeof parsed.subtype === "string") {
      // Orager format
      return parseOragerResultEvent(parsed, ts);
    }
    // HTTP adapter format
    return parseHttpResultEvent(parsed, ts);
  }

  return [{ kind: "stdout", ts, text: trimmed }];
}
