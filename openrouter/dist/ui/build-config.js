export function buildOpenRouterConfig(v) {
    const ac = {};
    // ── Core ─────────────────────────────────────────────────────────────────────
    if (v.model)
        ac.model = v.model;
    if (v.promptTemplate)
        ac.promptTemplate = v.promptTemplate;
    if (v.bootstrapPrompt)
        ac.bootstrapPromptTemplate = v.bootstrapPrompt;
    // Single-model UI selects — mapped to the array fields orager expects.
    const vc = v;
    if (typeof vc.fallbackModel === "string" && vc.fallbackModel.trim()) {
        ac.models = [vc.fallbackModel.trim()];
    }
    if (typeof vc.visionModel === "string" && vc.visionModel.trim()) {
        ac.visionFallbackModels = [vc.visionModel.trim()];
    }
    // ── Agent-loop defaults ───────────────────────────────────────────────────────
    ac.timeoutSec = 0; // unlimited — agent loops can run for minutes
    ac.graceSec = 20; // 20s between SIGTERM and SIGKILL
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
    const provider = {};
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
    const reasoning = {};
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
    }
    else if (Array.isArray(vc.requireApprovalFor) && vc.requireApprovalFor.length > 0) {
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
    if (vc.hooks !== null && typeof vc.hooks === "object" && Object.keys(vc.hooks).length > 0) {
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
    // ── Wake-reason model routing ─────────────────────────────────────────────
    // wakeReasonModels: { "comment": "deepseek/deepseek-r1", "review": "openai/gpt-4o" }
    if (vc.wakeReasonModels !== null &&
        typeof vc.wakeReasonModels === "object" &&
        !Array.isArray(vc.wakeReasonModels) &&
        Object.keys(vc.wakeReasonModels).length > 0) {
        ac.wakeReasonModels = vc.wakeReasonModels;
    }
    // ── MCP servers ───────────────────────────────────────────────────────────
    if (vc.mcpServers !== null &&
        typeof vc.mcpServers === "object" &&
        !Array.isArray(vc.mcpServers) &&
        Object.keys(vc.mcpServers).length > 0) {
        ac.mcpServers = vc.mcpServers;
    }
    if (Array.isArray(vc.requireMcpServers) && vc.requireMcpServers.length > 0) {
        ac.requireMcpServers = vc.requireMcpServers;
    }
    // ── Developer / operator fields ───────────────────────────────────────────
    if (typeof vc.dryRun === "boolean" && vc.dryRun) {
        ac.dryRun = true;
    }
    if (typeof vc.settingsFile === "string" && vc.settingsFile.trim()) {
        ac.settingsFile = vc.settingsFile.trim();
    }
    if (vc.hookErrorMode === "ignore" ||
        vc.hookErrorMode === "warn" ||
        vc.hookErrorMode === "fail") {
        ac.hookErrorMode = vc.hookErrorMode;
    }
    if (typeof vc.toolErrorBudgetHardStop === "boolean" && vc.toolErrorBudgetHardStop) {
        ac.toolErrorBudgetHardStop = true;
    }
    // ── Profile ───────────────────────────────────────────────────────────────
    if (typeof vc.profile === "string" && vc.profile.trim()) {
        ac.profile = vc.profile.trim();
    }
    // ── Webhook ───────────────────────────────────────────────────────────────
    if (typeof vc.webhookUrl === "string" && vc.webhookUrl.trim()) {
        ac.webhookUrl = vc.webhookUrl.trim();
    }
    // ── Extended summarization ────────────────────────────────────────────────
    if (typeof vc.summarizePrompt === "string" && vc.summarizePrompt.trim()) {
        ac.summarizePrompt = vc.summarizePrompt.trim();
    }
    if (typeof vc.summarizeFallbackKeep === "number" && vc.summarizeFallbackKeep >= 0) {
        ac.summarizeFallbackKeep = vc.summarizeFallbackKeep;
    }
    // ── Hook / approval timing ────────────────────────────────────────────────
    if (typeof vc.hookTimeoutMs === "number" && Number.isFinite(vc.hookTimeoutMs) && vc.hookTimeoutMs > 0) {
        ac.hookTimeoutMs = vc.hookTimeoutMs;
    }
    if (typeof vc.approvalTimeoutMs === "number" && Number.isFinite(vc.approvalTimeoutMs) && vc.approvalTimeoutMs > 0) {
        ac.approvalTimeoutMs = vc.approvalTimeoutMs;
    }
    // ── Advanced model routing ────────────────────────────────────────────────
    if (typeof vc.preset === "string" && vc.preset.trim()) {
        ac.preset = vc.preset.trim();
    }
    if (Array.isArray(vc.transforms) && vc.transforms.length > 0) {
        ac.transforms = vc.transforms;
    }
    // ── Tool control ─────────────────────────────────────────────────────────
    if (typeof vc.parallel_tool_calls === "boolean") {
        ac.parallel_tool_calls = vc.parallel_tool_calls;
    }
    if (typeof vc.tool_choice === "string" && vc.tool_choice.trim()) {
        ac.tool_choice = vc.tool_choice.trim();
    }
    // ── OTEL / observability passthrough ─────────────────────────────────────
    if (typeof vc.otelEndpoint === "string" && vc.otelEndpoint.trim()) {
        ac.otelEndpoint = vc.otelEndpoint.trim();
    }
    if (typeof vc.otelServiceName === "string" && vc.otelServiceName.trim()) {
        ac.otelServiceName = vc.otelServiceName.trim();
    }
    if (typeof vc.otelResourceAttributes === "string" && vc.otelResourceAttributes.trim()) {
        ac.otelResourceAttributes = vc.otelResourceAttributes.trim();
    }
    // ── Extra tool spec files ─────────────────────────────────────────────────
    if (Array.isArray(vc.toolsFiles) && vc.toolsFiles.length > 0) {
        ac.toolsFiles = vc.toolsFiles.filter((f) => typeof f === "string" && f.trim());
    }
    // ── Retry control ─────────────────────────────────────────────────────────
    if (typeof vc.maxRetries === "number" && Number.isFinite(vc.maxRetries) && vc.maxRetries >= 0) {
        ac.maxRetries = vc.maxRetries;
    }
    // ── Extra skill / tool directories ────────────────────────────────────────
    // addDirs is an array of absolute filesystem paths. The adapter automatically
    // includes the bundled Paperclip skills directory; entries here are added on top.
    if (Array.isArray(vc.addDirs) && vc.addDirs.length > 0) {
        ac.addDirs = vc.addDirs.filter((d) => typeof d === "string" && d.trim());
    }
    // ── Loop / timing ─────────────────────────────────────────────────────────
    // Override the hardcoded defaults above when caller provides explicit values.
    if (typeof vc.maxTurns === "number" && Number.isFinite(vc.maxTurns) && vc.maxTurns > 0) {
        ac.maxTurns = vc.maxTurns;
    }
    if (typeof vc.timeoutSec === "number" && Number.isFinite(vc.timeoutSec) && vc.timeoutSec >= 0) {
        ac.timeoutSec = vc.timeoutSec;
    }
    if (typeof vc.graceSec === "number" && Number.isFinite(vc.graceSec) && vc.graceSec >= 0) {
        ac.graceSec = vc.graceSec;
    }
    // ── Per-agent API key isolation ───────────────────────────────────────────
    if (typeof vc.agentApiKey === "string" && vc.agentApiKey.trim()) {
        ac.agentApiKey = vc.agentApiKey.trim();
    }
    // ── Memory retrieval ──────────────────────────────────────────────────────
    if (vc.memoryRetrieval === "embedding") {
        ac.memoryRetrieval = "embedding";
        if (typeof vc.memoryEmbeddingModel === "string" && vc.memoryEmbeddingModel.trim()) {
            ac.memoryEmbeddingModel = vc.memoryEmbeddingModel.trim();
        }
    }
    if (typeof vc.memoryMaxChars === "number" && vc.memoryMaxChars > 0)
        ac.memoryMaxChars = vc.memoryMaxChars;
    // ── Agent loop ─────────────────────────────────────────────────────────────
    if (typeof vc.maxIdenticalToolCallTurns === "number" && vc.maxIdenticalToolCallTurns > 0)
        ac.maxIdenticalToolCallTurns = vc.maxIdenticalToolCallTurns;
    // ── Approval mode ──────────────────────────────────────────────────────────
    if (vc.approvalMode === "question" || vc.approvalMode === "auto")
        ac.approvalMode = vc.approvalMode;
    // ── Spawn depth ────────────────────────────────────────────────────────────
    if (typeof vc.maxSpawnDepth === "number" && vc.maxSpawnDepth >= 0)
        ac.maxSpawnDepth = vc.maxSpawnDepth;
    // ── Project instructions ──────────────────────────────────────────────────
    if (typeof vc.readProjectInstructions === "boolean")
        ac.readProjectInstructions = vc.readProjectInstructions;
    return ac;
}
//# sourceMappingURL=build-config.js.map