export function buildOpenRouterConfig(v) {
    const ac = {};
    if (v.model)
        ac.model = v.model;
    if (v.promptTemplate)
        ac.promptTemplate = v.promptTemplate;
    if (v.bootstrapPrompt)
        ac.bootstrapPromptTemplate = v.bootstrapPrompt;
    // Agent-loop defaults
    ac.timeoutSec = 0; // unlimited — agent loops can run for minutes
    ac.graceSec = 20; // 20s between SIGTERM and SIGKILL
    ac.maxTurns = 20;
    return ac;
}
//# sourceMappingURL=build-config.js.map