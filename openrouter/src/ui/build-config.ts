import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenRouterConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.bootstrapPrompt) ac.bootstrapPromptTemplate = v.bootstrapPrompt;

  // Agent-loop defaults
  ac.timeoutSec = 0;   // unlimited — agent loops can run for minutes
  ac.graceSec = 20;    // 20s between SIGTERM and SIGKILL
  ac.maxTurns = 20;

  return ac;
}
