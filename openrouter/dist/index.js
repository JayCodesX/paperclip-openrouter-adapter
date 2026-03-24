export const type = "openrouter";
export const label = "OpenRouter (orager)";
// Any valid OpenRouter model ID works. Full list at https://openrouter.ai/models
export const models = [
    // DeepSeek
    { id: "deepseek/deepseek-chat-v3-2", label: "DeepSeek V3.2" },
    { id: "deepseek/deepseek-chat-v3-2:free", label: "DeepSeek V3.2 (free)" },
    { id: "deepseek/deepseek-r1", label: "DeepSeek R1 (reasoning)" },
    { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1 (free, reasoning)" },
    // Anthropic
    { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
    // OpenAI
    { id: "openai/gpt-4o", label: "GPT-4o" },
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
    { id: "openai/o3", label: "OpenAI o3 (reasoning)" },
    // Google
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    // Meta
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
];
export const agentConfigurationDoc = `# openrouter agent configuration

Adapter: openrouter
Execution: orager CLI (multi-turn agent loop with tools — bash, file read/write, web fetch)

Use when:
- You want a full agentic loop (bash, file editing, web browsing) backed by any OpenRouter model
- You want to use DeepSeek R1, GPT-4o, Gemini 2.5 Pro, or any other OpenRouter model as the engine
- You need provider routing, fallback models, or cost controls

Requires: orager installed and on PATH (npm install -g @paperclipai/orager)

## Core fields
- apiKey (string, required): OpenRouter API key. Store as a secret_ref in production.
- model (string, optional): Any OpenRouter model ID (default: deepseek/deepseek-chat-v3-2).
  Append suffixes: :free (free tier), :nitro (fastest), :floor (cheapest), :thinking (reasoning).
- models (string[], optional): Fallback model list tried in order if the primary fails.
- promptTemplate (string, optional): User message template. Supports {{agent.id}}, {{agent.name}}, {{runId}}, etc.
- maxTurns (number, optional): Maximum agent turns per run (default 20).
- timeoutSec (number, optional): Total timeout in seconds (default 300). Set to 0 for no timeout.
- graceSec (number, optional): Seconds between SIGTERM and SIGKILL on timeout (default 20).
- cliPath (string, optional): Path to orager binary (default "orager" — must be in PATH).
- cwd (string, optional): Working directory for the spawned process (default: process.cwd()).
- dangerouslySkipPermissions (boolean, optional): Pass --dangerously-skip-permissions to orager.
- env (object, optional): Extra environment variables passed to the subprocess.

## Reasoning (extended thinking)
- reasoning.effort (string): "xhigh"|"high"|"medium"|"low"|"minimal"|"none"
- reasoning.max_tokens (number): Exact reasoning token budget.
- reasoning.exclude (boolean): Run reasoning internally but omit from response.

## Provider routing
- provider.order (string[]): Preferred provider slugs e.g. ["DeepSeek","Together"].
- provider.data_collection ("allow"|"deny"): "deny" excludes providers that train on your data.
- provider.zdr (boolean): Restrict to Zero Data Retention providers.
- provider.only (string[]): Provider allowlist.
- provider.ignore (string[]): Provider blocklist.
- provider.sort ("price"|"throughput"|"latency"): Provider selection strategy.

## Agent loop options
- maxCostUsd (number, optional): Stop if accumulated cost exceeds this USD amount.
- useFinishTool (boolean, optional): The model calls a finish tool to signal completion.
- requireApproval (boolean, optional): Require human approval before executing any tool.
- sandboxRoot (string, optional): Restrict file operations to this directory.
- extraArgs (string[], optional): Extra CLI arguments passed through to orager verbatim.
`;
export const sessionCodec = {
    deserialize(raw) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            return null;
        const record = raw;
        const sessionId = typeof record.oragerSessionId === "string" &&
            record.oragerSessionId.trim().length > 0
            ? record.oragerSessionId.trim()
            : null;
        if (!sessionId)
            return null;
        return {
            oragerSessionId: sessionId,
            updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
        };
    },
    serialize(params) {
        if (!params)
            return null;
        const sessionId = typeof params.oragerSessionId === "string" &&
            params.oragerSessionId.trim().length > 0
            ? params.oragerSessionId.trim()
            : null;
        if (!sessionId)
            return null;
        return {
            oragerSessionId: sessionId,
            updatedAt: typeof params.updatedAt === "string" ? params.updatedAt : null,
        };
    },
    getDisplayId(params) {
        if (!params)
            return null;
        const sessionId = typeof params.oragerSessionId === "string" &&
            params.oragerSessionId.trim().length > 0
            ? params.oragerSessionId.trim()
            : null;
        if (!sessionId)
            return null;
        const updatedAt = typeof params.updatedAt === "string" ? params.updatedAt : null;
        return updatedAt
            ? `session:${sessionId.slice(0, 8)} · ${updatedAt}`
            : `session:${sessionId.slice(0, 8)}`;
    },
};
//# sourceMappingURL=index.js.map