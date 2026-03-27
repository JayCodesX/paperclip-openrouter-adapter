import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenRouterConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // ── Core ─────────────────────────────────────────────────────────────────────
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

  // ── Agent-loop defaults ───────────────────────────────────────────────────────
  ac.timeoutSec = 0;   // unlimited — agent loops can run for minutes
  ac.graceSec = 20;    // 20s between SIGTERM and SIGKILL
  ac.maxTurns = 20;

  // ── Daemon ───────────────────────────────────────────────────────────────────
  if (typeof vc.daemonUrl === "string" && vc.daemonUrl.trim()) {
    ac.daemonUrl = vc.daemonUrl.trim();
  }
  if (typeof vc.daemonKeyFile === "string" && vc.daemonKeyFile.trim()) {
    ac.daemonKeyFile = vc.daemonKeyFile.trim();
  }
  if (typeof vc.daemonAutoStart === "boolean") {
    ac.daemonAutoStart = vc.daemonAutoStart;
  }

  // ── Sampling ─────────────────────────────────────────────────────────────────
  if (typeof vc.temperature === "number" && Number.isFinite(vc.temperature)) {
    ac.temperature = vc.temperature;
  }
  if (typeof vc.top_p === "number" && Number.isFinite(vc.top_p)) {
    ac.top_p = vc.top_p;
  }
  if (typeof vc.top_k === "number" && Number.isFinite(vc.top_k)) {
    ac.top_k = vc.top_k;
  }
  if (typeof vc.frequency_penalty === "number" && Number.isFinite(vc.frequency_penalty)) {
    ac.frequency_penalty = vc.frequency_penalty;
  }
  if (typeof vc.presence_penalty === "number" && Number.isFinite(vc.presence_penalty)) {
    ac.presence_penalty = vc.presence_penalty;
  }
  if (typeof vc.repetition_penalty === "number" && Number.isFinite(vc.repetition_penalty)) {
    ac.repetition_penalty = vc.repetition_penalty;
  }
  if (typeof vc.min_p === "number" && Number.isFinite(vc.min_p)) {
    ac.min_p = vc.min_p;
  }
  if (typeof vc.seed === "number" && Number.isInteger(vc.seed)) {
    ac.seed = vc.seed;
  }
  if (Array.isArray(vc.stop) && vc.stop.length > 0) {
    ac.stop = vc.stop;
  }

  // ── Provider routing ─────────────────────────────────────────────────────────
  // Passed as a nested object; execute-cli.ts reads config.provider.*
  const provider: Record<string, unknown> = {};
  if (Array.isArray(vc.providerOrder) && vc.providerOrder.length > 0) {
    provider.order = vc.providerOrder;
  }
  if (Array.isArray(vc.providerOnly) && vc.providerOnly.length > 0) {
    provider.only = vc.providerOnly;
  }
  if (Array.isArray(vc.providerIgnore) && vc.providerIgnore.length > 0) {
    provider.ignore = vc.providerIgnore;
  }
  if (typeof vc.dataCollection === "string" && vc.dataCollection.trim()) {
    provider.data_collection = vc.dataCollection.trim();
  }
  if (typeof vc.zeroDataRetention === "boolean") {
    provider.zdr = vc.zeroDataRetention;
  }
  if (typeof vc.providerSort === "string" && vc.providerSort.trim()) {
    provider.sort = vc.providerSort.trim();
  }
  if (Array.isArray(vc.quantizations) && vc.quantizations.length > 0) {
    provider.quantizations = vc.quantizations;
  }
  if (Object.keys(provider).length > 0) {
    ac.provider = provider;
  }

  // ── Reasoning ────────────────────────────────────────────────────────────────
  // Passed as a nested object; execute-cli.ts reads config.reasoning.*
  const reasoning: Record<string, unknown> = {};
  if (typeof vc.reasoningEffort === "string" && vc.reasoningEffort.trim()) {
    reasoning.effort = vc.reasoningEffort.trim();
  }
  if (typeof vc.reasoningMaxTokens === "number" && vc.reasoningMaxTokens > 0) {
    reasoning.max_tokens = vc.reasoningMaxTokens;
  }
  if (typeof vc.reasoningExclude === "boolean") {
    reasoning.exclude = vc.reasoningExclude;
  }
  if (Object.keys(reasoning).length > 0) {
    ac.reasoning = reasoning;
  }

  // ── Cost limits ──────────────────────────────────────────────────────────────
  if (typeof vc.maxCostUsd === "number" && vc.maxCostUsd > 0) {
    ac.maxCostUsd = vc.maxCostUsd;
  }
  if (typeof vc.maxCostUsdSoft === "number" && vc.maxCostUsdSoft > 0) {
    ac.maxCostUsdSoft = vc.maxCostUsdSoft;
  }
  if (typeof vc.costPerInputToken === "number" && vc.costPerInputToken > 0) {
    ac.costPerInputToken = vc.costPerInputToken;
  }
  if (typeof vc.costPerOutputToken === "number" && vc.costPerOutputToken > 0) {
    ac.costPerOutputToken = vc.costPerOutputToken;
  }

  // ── Approval ─────────────────────────────────────────────────────────────────
  if (typeof vc.requireApproval === "boolean" && vc.requireApproval) {
    ac.requireApproval = true;
  }
  if (typeof vc.requireApprovalFor === "string" && vc.requireApprovalFor.trim()) {
    ac.requireApprovalFor = vc.requireApprovalFor.trim();
  } else if (Array.isArray(vc.requireApprovalFor) && vc.requireApprovalFor.length > 0) {
    ac.requireApprovalFor = vc.requireApprovalFor;
  }

  // ── Context summarization ────────────────────────────────────────────────────
  if (typeof vc.summarizeAt === "number" && vc.summarizeAt > 0 && vc.summarizeAt <= 1) {
    ac.summarizeAt = vc.summarizeAt;
  }
  if (typeof vc.summarizeModel === "string" && vc.summarizeModel.trim()) {
    ac.summarizeModel = vc.summarizeModel.trim();
  }
  if (typeof vc.summarizeKeepRecentTurns === "number" && vc.summarizeKeepRecentTurns >= 0) {
    ac.summarizeKeepRecentTurns = vc.summarizeKeepRecentTurns;
  }

  // ── Agent behavior (orager-exclusive) ────────────────────────────────────────
  if (typeof vc.planMode === "boolean" && vc.planMode) {
    ac.planMode = true;
  }
  if (typeof vc.injectContext === "boolean" && vc.injectContext) {
    ac.injectContext = true;
  }
  if (typeof vc.tagToolOutputs === "boolean") {
    // Only set when explicitly overriding — orager defaults to true
    ac.tagToolOutputs = vc.tagToolOutputs;
  }
  if (typeof vc.enableBrowserTools === "boolean" && vc.enableBrowserTools) {
    ac.enableBrowserTools = true;
  }
  // trackFileChanges: must be set for onMeta.filesChanged to be populated
  if (typeof vc.trackFileChanges === "boolean" && vc.trackFileChanges) {
    ac.trackFileChanges = true;
  }

  // ── Security (orager-exclusive) ──────────────────────────────────────────────
  if (vc.bashPolicy !== null && typeof vc.bashPolicy === "object") {
    ac.bashPolicy = vc.bashPolicy;
  }
  if (vc.hooks !== null && typeof vc.hooks === "object" && Object.keys(vc.hooks as object).length > 0) {
    ac.hooks = vc.hooks;
  }

  // ── Misc ─────────────────────────────────────────────────────────────────────
  if (typeof vc.forceResume === "boolean" && vc.forceResume) {
    ac.forceResume = true;
  }
  if (Array.isArray(vc.requiredEnvVars) && vc.requiredEnvVars.length > 0) {
    ac.requiredEnvVars = vc.requiredEnvVars;
  }
  if (typeof vc.siteUrl === "string" && vc.siteUrl.trim()) {
    ac.siteUrl = vc.siteUrl.trim();
  }
  if (typeof vc.siteName === "string" && vc.siteName.trim()) {
    ac.siteName = vc.siteName.trim();
  }
  if (typeof vc.sandboxRoot === "string" && vc.sandboxRoot.trim()) {
    ac.sandboxRoot = vc.sandboxRoot.trim();
  }

  return ac;
}
