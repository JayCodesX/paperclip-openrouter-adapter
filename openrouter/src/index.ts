export const type = "openrouter";
export const label = "OpenRouter (orager)";

// Any valid OpenRouter model ID works. Full list at https://openrouter.ai/models
export const models: { id: string; label: string; supportsVision: boolean; supportsReasoning: boolean }[] = [
  // DeepSeek — text only
  { id: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek V3 0324", supportsVision: false, supportsReasoning: false },
  { id: "deepseek/deepseek-chat", label: "DeepSeek V3 (latest)", supportsVision: false, supportsReasoning: false },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1 (reasoning)", supportsVision: false, supportsReasoning: true },
  { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1 (free, reasoning)", supportsVision: false, supportsReasoning: true },
  // Anthropic — all Claude models support vision and extended thinking
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", supportsVision: true, supportsReasoning: true },
  { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", supportsVision: true, supportsReasoning: true },
  { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6", supportsVision: true, supportsReasoning: true },
  { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", supportsVision: true, supportsReasoning: true },
  // OpenAI
  { id: "openai/gpt-4o", label: "GPT-4o", supportsVision: true, supportsReasoning: false },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", supportsVision: true, supportsReasoning: false },
  { id: "openai/o3", label: "OpenAI o3 (reasoning)", supportsVision: true, supportsReasoning: true },
  // Google — all Gemini models support vision
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", supportsVision: true, supportsReasoning: false },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", supportsVision: true, supportsReasoning: false },
  // Meta — Llama 3.3 70B is text only
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", supportsVision: false, supportsReasoning: false },
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
- model (string, optional): Any OpenRouter model ID (default: deepseek/deepseek-chat-v3-0324).
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
- planMode (boolean, optional): Run the agent in plan-only mode — the model may only read files and propose a plan; no write/execute tools are allowed.
- onlineSearch (boolean, optional): Append the :online variant suffix to the model string so OpenRouter routes to a web-search-capable provider. Has no effect if the model already includes a variant suffix (:nitro, :free, etc.).
- agentId (string, optional): Override the agent identity sent to the orager daemon (used as metadata.user_id in Anthropic requests and as the JWT subject). Defaults to the Paperclip platform agent ID. Useful for tracing cross-agent flows.
- extraArgs (string[], optional): Extra CLI arguments passed through to orager verbatim. WARNING: passing "--dangerously-skip-permissions" here bypasses all tool approval gates — never expose this to untrusted config.

## Wake-reason model routing
- wakeReasonModels (object, optional): Map wake-reason → model ID. Overrides the base model for specific triggers.
  Example: { "comment": "deepseek/deepseek-r1", "review": "openai/gpt-4o" }

## MCP servers
- mcpServers (object, optional): MCP server definitions passed to orager.
  Example: { "myServer": { "command": "npx", "args": ["-y", "@my/mcp-server"] } }
- requireMcpServers (string[], optional): MCP server names that must be available; run fails if any are missing.

## Developer / operator
- dryRun (boolean, optional): Log config and exit without making any API calls or spawning orager.
- settingsFile (string, optional): Path to an alternative ~/.orager/settings.json file.
- hookErrorMode ("ignore"|"warn"|"fail", optional): What to do when a hook script exits non-zero.
- toolErrorBudgetHardStop (boolean, optional): Hard-stop the run when the tool error budget is exhausted.
`;

// Session codec for the orager agent loop.
// Stores the orager session ID so conversations can be resumed across runs.
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      typeof record.oragerSessionId === "string" &&
      record.oragerSessionId.trim().length > 0
        ? record.oragerSessionId.trim()
        : null;
    if (!sessionId) return null;
    return {
      oragerSessionId: sessionId,
      updatedAt:
        typeof record.updatedAt === "string" ? record.updatedAt : null,
    };
  },

  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      typeof params.oragerSessionId === "string" &&
      params.oragerSessionId.trim().length > 0
        ? params.oragerSessionId.trim()
        : null;
    if (!sessionId) return null;
    return {
      oragerSessionId: sessionId,
      updatedAt:
        typeof params.updatedAt === "string" ? params.updatedAt : null,
    };
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    const sessionId =
      typeof params.oragerSessionId === "string" &&
      params.oragerSessionId.trim().length > 0
        ? params.oragerSessionId.trim()
        : null;
    if (!sessionId) return null;
    const updatedAt =
      typeof params.updatedAt === "string" ? params.updatedAt : null;
    return updatedAt
      ? `session:${sessionId.slice(0, 8)} · ${updatedAt}`
      : `session:${sessionId.slice(0, 8)}`;
  },
};

export { buildAdapterResult, processRateLimitTracker } from "./server/execute-cli.js";
export { RateLimitTracker } from "./rate-limit-tracker.js";
export type { RateLimitState } from "./rate-limit-tracker.js";
export type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
