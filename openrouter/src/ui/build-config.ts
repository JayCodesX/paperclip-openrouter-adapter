import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenRouterConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.bootstrapPrompt) ac.bootstrapPromptTemplate = v.bootstrapPrompt;

  // Single-model UI selects — mapped to the array fields orager expects.
  const vc = v as unknown as Record<string, unknown>;
  if (typeof vc.fallbackModel === "string" && vc.fallbackModel.trim()) {
    ac.models = [vc.fallbackModel.trim()];
  }
  if (typeof vc.visionModel === "string" && vc.visionModel.trim()) {
    ac.visionFallbackModels = [vc.visionModel.trim()];
  }

  // Agent-loop defaults
  ac.timeoutSec = 0;   // unlimited — agent loops can run for minutes
  ac.graceSec = 20;    // 20s between SIGTERM and SIGKILL
  ac.maxTurns = 20;

  return ac;
}
