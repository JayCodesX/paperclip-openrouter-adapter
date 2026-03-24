import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

export function printOpenRouterStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  // --- SSE delta lines ---
  if (line.startsWith("data:")) {
    const dataStr = line.slice("data:".length).trim();
    if (dataStr === "[DONE]") {
      console.log(pc.blue("[openrouter] stream done"));
      return;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      if (debug) console.log(pc.gray(line));
      return;
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choiceRaw of choices) {
      const choice = asRecord(choiceRaw);
      if (!choice) continue;
      const delta = asRecord(choice.delta);
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        process.stdout.write(pc.green(delta.content));
      }
    }

    // Usage appears on the final chunk
    const usage = asRecord(parsed.usage);
    if (usage) {
      console.log(
        pc.blue(
          `\n[openrouter] usage — prompt: ${usage.prompt_tokens ?? 0}, completion: ${usage.completion_tokens ?? 0}, total: ${usage.total_tokens ?? 0}`,
        ),
      );
    }
    return;
  }

  // --- Final result line ---
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    if (debug) console.log(pc.gray(line));
    return;
  }

  if (parsed.type === "result") {
    const model =
      typeof parsed.model === "string" ? parsed.model : "unknown";
    console.log(pc.blue(`[openrouter] result — model: ${model}`));
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}
