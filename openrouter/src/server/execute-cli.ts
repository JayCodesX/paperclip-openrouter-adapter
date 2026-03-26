import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";

// ── Daemon client ─────────────────────────────────────────────────────────────
// If ORAGER_DAEMON_URL is set (or config.daemonUrl is set), the adapter sends
// requests to the persistent orager daemon instead of spawning a new process.
// The daemon eliminates Node.js startup overhead and keeps all caches warm.

const DAEMON_KEY_PATH = path.join(os.homedir(), ".orager", "daemon.key");

async function readDaemonSigningKey(): Promise<string | null> {
  try {
    const key = await fs.readFile(DAEMON_KEY_PATH, "utf8");
    return key.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Mint a short-lived HS256 JWT for authenticating to the orager daemon.
 * Mirrors the implementation in orager/src/jwt.ts — must stay in sync.
 */
function mintDaemonJwt(signingKey: string, agentId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ agentId, scope: "run", iat: now, exp: now + 300 }));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", signingKey).update(data).digest("base64url");
  return `${data}.${sig}`;
}

async function isDaemonAlive(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = await res.json() as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// skills/ dir is at the root of the adapter package (two levels up from dist/server/)
const SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";

// ── Local utility shims ───────────────────────────────────────────────────────
// These mirror functions in newer versions of @paperclipai/adapter-utils that
// may not yet be exported in the installed version.

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
}

const SENSITIVE_KEY_RE =
  /(?:key|token|secret|password|credential|auth|bearer|api_key)/i;

function redactEnvForLogs(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

async function ensureAbsoluteDirectory(
  dir: string,
  opts: { createIfMissing?: boolean } = {},
): Promise<void> {
  if (!path.isAbsolute(dir)) {
    throw new Error(`Directory must be an absolute path: ${dir}`);
  }
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`Path exists but is not a directory: ${dir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && opts.createIfMissing) {
      await fs.mkdir(dir, { recursive: true });
    } else {
      throw err;
    }
  }
}

async function ensureCommandResolvable(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  // If the command contains a path separator it's an explicit path — just check it exists
  if (command.includes("/") || command.includes("\\")) {
    try {
      await fs.access(command, fsConstants.X_OK);
    } catch {
      throw new Error(`Command not executable: ${command}`);
    }
    return;
  }
  // Otherwise search PATH
  const pathDirs = (env.PATH ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathDirs) {
    const full = path.join(dir, command);
    try {
      await fs.access(full, fsConstants.X_OK);
      return; // found
    } catch {
      // try next
    }
  }
  throw new Error(
    `Command "${command}" not found in PATH (cwd: ${cwd}). Install it or set cliPath in the adapter config.`,
  );
}

function ensurePathInEnv(env: Record<string, string>): Record<string, string> {
  if (env.PATH) return env;
  // Fallback: inherit PATH from process.env
  return { ...env, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
}

/**
 * Execute an agent run by POSTing to the orager daemon.
 * Returns the same AdapterExecutionResult shape as the spawn path.
 */
async function executeViaDaemon(
  baseUrl: string,
  signingKey: string,
  agentId: string,
  prompt: string,
  daemonOpts: Record<string, unknown>,
  timeoutSec: number,
  onLog: (stream: "stdout" | "stderr", line: string) => Promise<void> | void,
): Promise<AdapterExecutionResult | null> {
  const token = mintDaemonJwt(signingKey, agentId);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt, opts: daemonOpts }),
      signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
    });
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Daemon request failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "spawn_error",
    };
  }

  if (response.status === 503) {
    // Respect Retry-After header (max 30s wait) then retry the daemon once.
    // If still saturated after the retry, return null to trigger spawn fallback (#1).
    const retryAfterSec = Math.min(
      parseInt(response.headers.get("Retry-After") ?? "5", 10),
      30,
    );
    void onLog("stderr", `[openrouter adapter] daemon at capacity — retrying in ${retryAfterSec}s\n`);
    await new Promise<void>((r) => setTimeout(r, retryAfterSec * 1000));
    // Retry with a fresh token (original may expire if wait was long)
    const retryToken = mintDaemonJwt(signingKey, agentId);
    try {
      response = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${retryToken}`,
        },
        body: JSON.stringify({ prompt, opts: daemonOpts }),
        signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      });
    } catch {
      // Retry network failure — fall back to spawn
      return null;
    }
    if (response.status === 503) {
      // Still at capacity after retry — fall back to spawn
      return null;
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Daemon error ${response.status}: ${text.slice(0, 200)}`,
      errorCode: "spawn_error",
    };
  }

  if (!response.body) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Daemon response has no body",
      errorCode: "spawn_error",
    };
  }

  // Stream NDJSON from daemon — same parsing logic as the spawn stdout path
  let resultEvent: Record<string, unknown> | null = null;
  let sessionId = "";
  let resolvedModel = "";
  let sessionLost = false;
  let buffer = "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      void onLog("stdout", line + "\n");
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "system" && typeof event.session_id === "string") {
          sessionId = event.session_id;
          if (typeof event.model === "string") resolvedModel = event.model;
        }
        if (event.type === "result") resultEvent = event;
      } catch {
        // non-JSON lines ok
      }
    }
  }
  // flush
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer) as Record<string, unknown>;
      if (event.type === "result") resultEvent = event;
    } catch { /* ok */ }
  }

  if (!resultEvent) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Daemon run ended without a result event",
    };
  }

  const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : "error";
  const resultText = typeof resultEvent.result === "string" ? resultEvent.result : "";
  const usageRaw = typeof resultEvent.usage === "object" && resultEvent.usage !== null
    ? (resultEvent.usage as Record<string, unknown>) : null;
  const totalCostUsd = typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : 0;

  if (!sessionId && typeof resultEvent.session_id === "string") sessionId = resultEvent.session_id;

  const isSuccess = subtype === "success";
  const isMaxTurns = subtype === "error_max_turns";
  const softStop = isSuccess || isMaxTurns;
  const clearSession = isMaxTurns || sessionLost;

  const newSessionParams = sessionId
    ? { oragerSessionId: sessionId, updatedAt: new Date().toISOString() }
    : null;

  return {
    exitCode: softStop ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage: softStop ? undefined : `Agent loop ended: ${subtype}${resultText ? ` — ${resultText}` : ""}`,
    clearSession,
    model: resolvedModel || undefined,
    usage: usageRaw
      ? {
          inputTokens: typeof usageRaw.input_tokens === "number" ? usageRaw.input_tokens : 0,
          outputTokens: typeof usageRaw.output_tokens === "number" ? usageRaw.output_tokens : 0,
          cachedInputTokens: typeof usageRaw.cache_read_input_tokens === "number" ? usageRaw.cache_read_input_tokens : 0,
        }
      : undefined,
    provider: "openrouter",
    biller: "openrouter",
    billingType: "api",
    costUsd: totalCostUsd,
    sessionParams: newSessionParams,
    sessionDisplayId: sessionId || null,
    summary: resultText,
    resultJson: { result: resultText, subtype, sessionId, totalCostUsd },
  };
}

const DEFAULT_CLI = "orager";
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_SEC = 300; // 5 min — agent loops take longer than single completions
const DEFAULT_GRACE_SEC = 20;

/**
 * Execute an autonomous agent loop by spawning the `orager` CLI as a
 * subprocess, using the same pattern as local CLI adapters in Paperclip.
 *
 * Orager writes stream-json events to stdout; this function streams those
 * lines back to Paperclip via `onLog` and returns a structured result once
 * the process exits.
 */
export async function executeAgentLoop(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } =
    ctx;

  // ── Config ─────────────────────────────────────────────────────────────────
  // Support both cliPath and the generic "command" field from the Paperclip UI
  const cliPath = asString(config.cliPath ?? config.command, DEFAULT_CLI);
  const model = asString(config.model, DEFAULT_MODEL);
  // Support both maxTurns and maxTurnsPerRun (alias for compatibility)
  const maxTurns = asNumber(
    config.maxTurnsPerRun ?? config.maxTurns,
    DEFAULT_MAX_TURNS,
  );
  const maxRetries = asNumber(config.maxRetries, DEFAULT_MAX_RETRIES);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);
  const dangerouslySkipPermissions = asBoolean(
    config.dangerouslySkipPermissions,
    false,
  );
  const siteUrl = asString(config.siteUrl, "");
  const siteName = asString(config.siteName, "");
  const sandboxRoot = asString(config.sandboxRoot, "");
  const useFinishTool = asBoolean(config.useFinishTool, false);

  // Sampling
  const temperature =
    typeof config.temperature === "number" ? config.temperature : undefined;
  const top_p = typeof config.top_p === "number" ? config.top_p : undefined;
  const top_k = typeof config.top_k === "number" ? config.top_k : undefined;
  const frequency_penalty =
    typeof config.frequency_penalty === "number"
      ? config.frequency_penalty
      : undefined;
  const presence_penalty =
    typeof config.presence_penalty === "number"
      ? config.presence_penalty
      : undefined;
  const repetition_penalty =
    typeof config.repetition_penalty === "number"
      ? config.repetition_penalty
      : undefined;
  const min_p = typeof config.min_p === "number" ? config.min_p : undefined;
  const seed = typeof config.seed === "number" ? config.seed : undefined;
  const stopTokens = Array.isArray(config.stop)
    ? config.stop.filter((s: unknown) => typeof s === "string")
    : [];

  // Tool control
  const toolChoice = asString(config.tool_choice, "");
  // Default parallel tool calls to true — matches OpenRouter's default and enables
  // Auto Exacto optimization for tool-calling requests. Set parallel_tool_calls: false
  // in config to disable (e.g. for strictly sequential workflows).
  const parallelToolCalls =
    typeof config.parallel_tool_calls === "boolean"
      ? config.parallel_tool_calls
      : true;

  // Reasoning
  const reasoningConfig = parseObject(config.reasoning);
  const reasoningEffort =
    typeof reasoningConfig.effort === "string" ? reasoningConfig.effort : "";
  const reasoningMaxTokens =
    typeof reasoningConfig.max_tokens === "number"
      ? reasoningConfig.max_tokens
      : undefined;
  // Default reasoning to excluded — reasoning tokens cost 2-3x and are rarely needed
  // for routine agent tasks. Set reasoning.exclude: false to enable explicitly.
  const reasoningExclude = reasoningConfig.exclude !== false;

  // Provider routing
  const providerConfig = parseObject(config.provider);
  const providerOrder = Array.isArray(providerConfig.order)
    ? providerConfig.order
        .filter((s: unknown) => typeof s === "string")
        .join(",")
    : "";
  const providerIgnore = Array.isArray(providerConfig.ignore)
    ? providerConfig.ignore
        .filter((s: unknown) => typeof s === "string")
        .join(",")
    : "";
  const providerOnly = Array.isArray(providerConfig.only)
    ? providerConfig.only
        .filter((s: unknown) => typeof s === "string")
        .join(",")
    : "";
  const dataCollection =
    typeof providerConfig.data_collection === "string"
      ? providerConfig.data_collection
      : "";
  const zdr = providerConfig.zdr === true;
  // Default sort to "latency" for agent loops — minimizes time-to-first-token.
  // Overridden if providerOrder is set (explicit ordering takes precedence).
  // Set provider.sort: "price" to override back to cost-optimized routing.
  const sort =
    typeof providerConfig.sort === "string"
      ? providerConfig.sort
      : providerOrder
        ? ""
        : "latency";
  // require_parameters: only route to providers supporting all request params.
  // Prevents silent fallbacks to providers that ignore tool definitions.
  const requireParameters = providerConfig.require_parameters !== false;
  const quantizations = Array.isArray(providerConfig.quantizations)
    ? providerConfig.quantizations
        .filter((s: unknown) => typeof s === "string")
        .join(",")
    : "";

  // OpenRouter Preset — named server-side config for routing/model settings.
  // Reference format: "preset-slug" or "org/preset-slug".
  // Allows updating routing strategy without redeploying adapter.
  const preset = typeof config.preset === "string" ? config.preset.trim() : "";

  // Fallback models
  const models = Array.isArray(config.models)
    ? config.models.filter(
        (m: unknown) =>
          typeof m === "string" && (m as string).trim().length > 0,
      )
    : [];

  // Transforms
  const transforms = Array.isArray(config.transforms)
    ? config.transforms
        .filter(
          (t: unknown) =>
            typeof t === "string" && (t as string).trim().length > 0,
        )
        .join(",")
    : "";

  // Cost limits
  const maxCostUsd =
    typeof config.maxCostUsd === "number" ? config.maxCostUsd : undefined;
  const costPerInputToken =
    typeof config.costPerInputToken === "number"
      ? config.costPerInputToken
      : undefined;
  const costPerOutputToken =
    typeof config.costPerOutputToken === "number"
      ? config.costPerOutputToken
      : undefined;

  // Approval
  const requireApproval = asBoolean(config.requireApproval, false);
  const requireApprovalFor = asString(config.requireApprovalFor, "");

  // Extra tool spec files
  const toolsFiles = Array.isArray(config.toolsFiles)
    ? config.toolsFiles.filter((f: unknown) => typeof f === "string")
    : [];

  // Skills directories — always include bundled Paperclip skills so the
  // model gets native get-task, post-comment, list-issues, update-issue-status tools
  const addDirs: string[] = [SKILLS_DIR];
  if (Array.isArray(config.addDirs)) {
    for (const d of config.addDirs) {
      if (typeof d === "string" && d.trim()) addDirs.push(d.trim());
    }
  }

  // Extra passthrough args (extraArgs or args alias)
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  // ── API key ────────────────────────────────────────────────────────────────
  const apiKey =
    asString(config.apiKey, "") || (process.env.OPENROUTER_API_KEY ?? "");

  // ── Workspace / runtime context ────────────────────────────────────────────
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath =
    asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(
    context.paperclipRuntimeServiceIntents,
  )
    ? context.paperclipRuntimeServiceIntents.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");

  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      )
    : [];

  // ── cwd ────────────────────────────────────────────────────────────────────
  const configuredCwd = asString(config.cwd, "");
  // If workspace is agent_home strategy and config has a cwd override, use the override
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome
    ? ""
    : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();

  // Ensure cwd exists
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  } catch {
    // Non-fatal — spawn will fail with a clearer error if cwd is truly invalid
  }

  const taskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;

  // ── Instructions file ──────────────────────────────────────────────────────
  // Passed to orager via --system-prompt-file so it lands in the system prompt
  // (not the user message) — mirroring claude-local's --append-system-prompt-file.
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();

  // ── Prompt ─────────────────────────────────────────────────────────────────
  // Keep the prompt minimal — the paperclip/SKILL.md skill (loaded via --add-dir)
  // contains the full heartbeat procedure. Orager's native skills (get-task,
  // list-issues, post-comment, update-issue-status) handle all API interaction.
  const DEFAULT_PROMPT_TEMPLATE =
    "You are {{agent.name}}, a Paperclip AI agent.\n\n" +
    "Wake reason: {{context.wakeReason}}\n" +
    "Workspace: {{context.paperclipWorkspace.cwd}}\n\n" +
    "Follow the Paperclip heartbeat procedure using your available skills.\n\n" +
    "IMPORTANT: Your only job is to work on Paperclip tasks. " +
    "Do not explore the filesystem, read config files, or attempt workarounds. " +
    "If a skill fails or you have no assigned tasks, exit immediately.";

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const userMessage = renderTemplate(promptTemplate, templateData);
  const sessionHandoff = asString(
    context.paperclipSessionHandoffMarkdown,
    "",
  ).trim();
  const renderedBootstrap = (
    config.bootstrapPromptTemplate
      ? renderTemplate(asString(config.bootstrapPromptTemplate, ""), templateData)
      : ""
  ).trim();

  // ── Session ────────────────────────────────────────────────────────────────
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const storedSessionId = asString(runtimeSessionParams.oragerSessionId, "");

  const previousSessionId = storedSessionId;

  // Only prepend bootstrap + handoff on the first run
  // (instructions go to --system-prompt-file, not the user message)
  const isFirstRun = !previousSessionId;
  const prompt = joinPromptSections([
    isFirstRun ? renderedBootstrap : null,
    isFirstRun ? sessionHandoff : null,
    userMessage,
  ]);

  // ── Build config object and write to temp file ────────────────────────────
  // Instead of building 50+ CLI args, we write all config to a temp JSON file
  // and pass --config-file <path> as the only config arg. This avoids argument
  // length limits on some systems and keeps the subprocess invocation clean.
  // The file is chmod 600 before writing so only the current user can read it.
  // Orager reads and immediately deletes the file before doing anything else.
  const configObj: Record<string, unknown> = {
    outputFormat: "stream-json",
    model,
    maxTurns: maxTurns > 0 ? maxTurns : undefined,
    maxRetries,
    addDirs,
  };

  if (previousSessionId) configObj.sessionId = previousSessionId;
  if (instructionsFilePath) configObj.systemPromptFile = instructionsFilePath;
  if (dangerouslySkipPermissions) configObj.dangerouslySkipPermissions = true;
  if (sandboxRoot) configObj.sandboxRoot = sandboxRoot;
  if (useFinishTool) configObj.useFinishTool = true;
  if (siteUrl) configObj.siteUrl = siteUrl;
  if (siteName) configObj.siteName = siteName;

  // Sampling
  if (temperature !== undefined) configObj.temperature = temperature;
  if (top_p !== undefined) configObj.top_p = top_p;
  if (top_k !== undefined) configObj.top_k = top_k;
  if (frequency_penalty !== undefined) configObj.frequency_penalty = frequency_penalty;
  if (presence_penalty !== undefined) configObj.presence_penalty = presence_penalty;
  if (repetition_penalty !== undefined) configObj.repetition_penalty = repetition_penalty;
  if (min_p !== undefined) configObj.min_p = min_p;
  if (seed !== undefined) configObj.seed = seed;
  if (stopTokens.length > 0) configObj.stop = stopTokens;

  // Tool control
  if (toolChoice) configObj.tool_choice = toolChoice;
  configObj.parallel_tool_calls = parallelToolCalls;

  // Reasoning
  if (reasoningEffort) configObj.reasoningEffort = reasoningEffort;
  if (reasoningMaxTokens !== undefined) configObj.reasoningMaxTokens = reasoningMaxTokens;
  if (reasoningExclude) configObj.reasoningExclude = true;

  // Provider routing — pass as comma-separated strings (matching CLI format)
  if (providerOrder) configObj.providerOrder = providerOrder.split(",").filter(Boolean);
  if (providerIgnore) configObj.providerIgnore = providerIgnore.split(",").filter(Boolean);
  if (providerOnly) configObj.providerOnly = providerOnly.split(",").filter(Boolean);
  if (dataCollection) configObj.dataCollection = dataCollection;
  if (zdr) configObj.zdr = true;
  if (sort) configObj.sort = sort;
  if (requireParameters) configObj.require_parameters = true;
  if (quantizations) configObj.quantizations = quantizations.split(",").filter(Boolean);
  if (preset) configObj.preset = preset;

  // Fallback models
  if (models.length > 0) configObj.models = models;

  // Transforms
  if (transforms) configObj.transforms = transforms.split(",").filter(Boolean);

  // Cost limits
  if (maxCostUsd !== undefined) configObj.maxCostUsd = maxCostUsd;
  if (costPerInputToken !== undefined) configObj.costPerInputToken = costPerInputToken;
  if (costPerOutputToken !== undefined) configObj.costPerOutputToken = costPerOutputToken;

  // Approval
  if (requireApprovalFor) configObj.requireApprovalFor = requireApprovalFor;
  else if (requireApproval) configObj.requireApproval = true;

  // Extra tools
  if (toolsFiles.length > 0) configObj.toolsFiles = toolsFiles;

  // Write config to a crypto-random temp file, chmod 600 before writing content
  const configFileName = `orager-config-${crypto.randomBytes(16).toString("hex")}.json`;
  const configFilePath = path.join(os.tmpdir(), configFileName);
  let configFileWritten = false;
  try {
    // Create the file with mode 600 (owner read/write only) before writing content
    const fd = await fs.open(configFilePath, "w", 0o600);
    await fd.write(JSON.stringify(configObj));
    await fd.close();
    configFileWritten = true;
  } catch (err) {
    // Config file write failed — fall back to individual CLI args is not
    // implemented; surface the error so the caller sees it rather than silently
    // proceeding with no config.
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to write orager config file: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "spawn_error",
    };
  }

  // Build minimal CLI args — just the prompt source, output format, verbose flag,
  // and the config file path. All model/provider/sampling config is in the file.
  const args: string[] = [
    "--print",
    "-",
    "--verbose",
    "--config-file",
    configFilePath,
  ];

  // Extra passthrough args (not included in config file — caller-supplied raw flags)
  if (extraArgs.length > 0) args.push(...extraArgs);

  // ── Environment ────────────────────────────────────────────────────────────
  const paperclipEnv = buildPaperclipEnv(agent);

  const contextEnv: Record<string, string> = {};

  // Task / wake context
  if (taskId) contextEnv.PAPERCLIP_TASK_ID = taskId;
  if (typeof context.wakeReason === "string" && context.wakeReason.trim())
    contextEnv.PAPERCLIP_WAKE_REASON = context.wakeReason.trim();
  const commentId =
    (typeof context.wakeCommentId === "string" &&
      context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  if (commentId) contextEnv.PAPERCLIP_WAKE_COMMENT_ID = commentId;
  if (typeof context.approvalId === "string" && context.approvalId.trim())
    contextEnv.PAPERCLIP_APPROVAL_ID = context.approvalId.trim();
  if (
    typeof context.approvalStatus === "string" &&
    context.approvalStatus.trim()
  )
    contextEnv.PAPERCLIP_APPROVAL_STATUS = context.approvalStatus.trim();
  if (linkedIssueIds.length > 0)
    contextEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  // Workspace context
  if (effectiveWorkspaceCwd)
    contextEnv.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource)
    contextEnv.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceStrategy)
    contextEnv.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  if (workspaceId)
    contextEnv.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl)
    contextEnv.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef)
    contextEnv.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (workspaceBranch)
    contextEnv.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  if (workspaceWorktreePath)
    contextEnv.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  if (agentHome)
    contextEnv.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0)
    contextEnv.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  if (runtimeServiceIntents.length > 0)
    contextEnv.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON =
      JSON.stringify(runtimeServiceIntents);
  if (runtimeServices.length > 0)
    contextEnv.PAPERCLIP_RUNTIME_SERVICES_JSON =
      JSON.stringify(runtimeServices);
  if (runtimePrimaryUrl)
    contextEnv.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;

  const configEnv = parseObject(config.env);
  const env: Record<string, string> = {
    ...paperclipEnv,
    ...contextEnv,
    PAPERCLIP_RUN_ID: runId,
    OPENROUTER_API_KEY: apiKey,
    ORAGER_API_KEY: apiKey,
  };
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  for (const [k, v] of Object.entries(configEnv)) {
    if (typeof v === "string") env[k] = v;
  }

  // Merge with process.env and ensure PATH is populated
  const effectiveEnv = ensurePathInEnv({ ...(process.env as Record<string, string>), ...env });

  // ── Daemon fast-path ────────────────────────────────────────────────────────
  // If ORAGER_DAEMON_URL (or config.daemonUrl) is set, attempt to route this
  // run through the persistent orager daemon instead of spawning a subprocess.
  // The daemon eliminates Node.js startup overhead (~50-200ms) and keeps all
  // in-process caches warm (skills, tool results, LLM prompt cache via sticky routing).
  // Falls back to the spawn path if the daemon is unreachable.
  const daemonBaseUrl =
    asString(config.daemonUrl, "") || process.env.ORAGER_DAEMON_URL || "";

  if (daemonBaseUrl) {
    const signingKey = await readDaemonSigningKey();
    const alive = signingKey ? await isDaemonAlive(daemonBaseUrl) : false;

    if (alive && signingKey) {
      // Build opts for daemon (AgentLoopOptions without apiKey/onEmit/onLog)
      const daemonOpts: Record<string, unknown> = {
        model,
        models: models.length > 0 ? models : undefined,
        sessionId: previousSessionId || null,
        addDirs,
        maxTurns: maxTurns > 0 ? maxTurns : 0,
        maxRetries,
        cwd,
        dangerouslySkipPermissions,
        verbose: false,
        useFinishTool,
        siteUrl: siteUrl || undefined,
        siteName: siteName || undefined,
        sandboxRoot: sandboxRoot || undefined,
        parallel_tool_calls: parallelToolCalls,
        tool_choice: toolChoice || undefined,
        temperature,
        top_p,
        top_k,
        frequency_penalty,
        presence_penalty,
        repetition_penalty,
        min_p,
        seed,
        stop: stopTokens.length > 0 ? stopTokens : undefined,
        reasoning: (reasoningEffort || reasoningMaxTokens || reasoningExclude)
          ? {
              ...(reasoningEffort ? { effort: reasoningEffort } : {}),
              ...(reasoningMaxTokens ? { max_tokens: reasoningMaxTokens } : {}),
              ...(reasoningExclude ? { exclude: true } : {}),
            }
          : undefined,
        provider: (providerOrder || providerIgnore || providerOnly || dataCollection || zdr || sort || quantizations || requireParameters)
          ? {
              ...(providerOrder ? { order: providerOrder.split(",").filter(Boolean) } : {}),
              ...(providerIgnore ? { ignore: providerIgnore.split(",").filter(Boolean) } : {}),
              ...(providerOnly ? { only: providerOnly.split(",").filter(Boolean) } : {}),
              ...(dataCollection ? { data_collection: dataCollection } : {}),
              ...(zdr ? { zdr: true } : {}),
              ...(sort ? { sort } : {}),
              ...(quantizations ? { quantizations: quantizations.split(",").filter(Boolean) } : {}),
              ...(requireParameters ? { require_parameters: true } : {}),
            }
          : undefined,
        preset: preset || undefined,
        transforms: transforms ? transforms.split(",").filter(Boolean) : undefined,
        maxCostUsd,
        costPerInputToken,
        costPerOutputToken,
        appendSystemPrompt: instructionsFilePath
          ? await fs.readFile(instructionsFilePath, "utf8").catch(() => undefined)
          : undefined,
      };

      const daemonResult = await executeViaDaemon(
        daemonBaseUrl,
        signingKey,
        agent.id,
        prompt,
        daemonOpts,
        timeoutSec,
        onLog,
      );
      if (daemonResult !== null) {
        return daemonResult;
      }
      // null = daemon at capacity after retry — fall through to spawn
      void onLog("stderr", `[openrouter adapter] daemon at capacity after retry — falling back to spawn\n`);
    } else {
      void onLog("stderr", `[openrouter adapter] daemon at ${daemonBaseUrl} unreachable — falling back to spawn\n`);
    }
  }

  // ── onMeta ─────────────────────────────────────────────────────────────────
  if (onMeta) {
    await onMeta({
      adapterType: "openrouter-cli",
      command: cliPath,
      cwd,
      commandArgs: args,
      commandNotes: [
        `model: ${model}`,
        `maxTurns: ${maxTurns}`,
        previousSessionId ? `resume: ${previousSessionId}` : "new session",
        ...(instructionsFilePath
          ? [`instructions: ${instructionsFilePath}`]
          : []),
      ],
      env: redactEnvForLogs(env),
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        bootstrapPromptChars: renderedBootstrap.length,
        sessionHandoffChars: sessionHandoff.length,
        heartbeatPromptChars: userMessage.length,
      },
      context,
    });
  }

  // ── Validate command before spawning ───────────────────────────────────────
  try {
    await ensureCommandResolvable(cliPath, cwd, effectiveEnv);
  } catch (err) {
    // Clean up the config file since we won't be spawning orager to delete it
    if (configFileWritten) {
      await fs.unlink(configFilePath).catch(() => {});
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Cannot find orager CLI "${cliPath}": ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "spawn_error",
    };
  }

  // ── Spawn orager ───────────────────────────────────────────────────────────
  return new Promise<AdapterExecutionResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cliPath, args, {
        cwd,
        env: effectiveEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (spawnErr) {
      // Clean up the config file on spawn failure — orager won't get to delete it
      fs.unlink(configFilePath).catch(() => {});
      resolve({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to spawn ${cliPath}: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
        errorCode: "spawn_error",
      });
      return;
    }

    // Write prompt to stdin
    try {
      proc.stdin?.write(prompt, "utf8");
      proc.stdin?.end();
    } catch {
      // stdin write failure is non-fatal; the process may still produce output
    }

    let resultEvent: Record<string, unknown> | null = null;
    let sessionId = "";
    let resolvedModel = "";
    let sessionLost = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        // Force kill after grace period if the process doesn't exit on its own
        if (graceSec > 0) {
          graceTimer = setTimeout(() => {
            proc.kill("SIGKILL");
          }, graceSec * 1000);
        }
      }, timeoutSec * 1000);
    }

    // Read stdout line by line and stream to Paperclip
    let stdoutBuffer = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuffer +=
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void onLog("stdout", line + "\n");
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "system" && typeof event.session_id === "string") {
            sessionId = event.session_id;
            if (typeof event.model === "string" && event.model) {
              resolvedModel = event.model;
            }
          }
          if (event.type === "result") {
            resultEvent = event;
          }
        } catch {
          // non-JSON lines are fine — tool output, bash stdout, etc.
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Orager silently starts a fresh session when the requested session isn't
      // found. Detect this so we can clear the stale session ID on Paperclip's
      // side, ensuring the next run is treated as a fresh start (with
      // instructions re-injected via --system-prompt-file).
      if (text.includes("not found, starting fresh")) sessionLost = true;
      void onLog("stderr", text);
    });

    proc.on("close", (code, signal) => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);

      // Flush any partial line remaining in the buffer
      if (stdoutBuffer.trim()) {
        void onLog("stdout", stdoutBuffer + "\n");
        try {
          const event = JSON.parse(stdoutBuffer) as Record<string, unknown>;
          if (event.type === "result") resultEvent = event;
          if (
            event.type === "system" &&
            typeof event.session_id === "string"
          ) {
            sessionId = event.session_id;
          }
        } catch {
          // ok
        }
      }

      if (timedOut) {
        resolve({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          errorMessage: `Agent loop timed out after ${timeoutSec}s`,
          errorCode: "timeout",
        });
        return;
      }

      if (!resultEvent) {
        resolve({
          exitCode: code ?? 1,
          signal: signal ?? null,
          timedOut: false,
          errorMessage: `orager exited without a result event (exit code ${code ?? "null"})`,
        });
        return;
      }

      const subtype =
        typeof resultEvent.subtype === "string" ? resultEvent.subtype : "error";
      const resultText =
        typeof resultEvent.result === "string" ? resultEvent.result : "";
      const usageRaw =
        typeof resultEvent.usage === "object" && resultEvent.usage !== null
          ? (resultEvent.usage as Record<string, unknown>)
          : null;
      const totalCostUsd =
        typeof resultEvent.total_cost_usd === "number"
          ? resultEvent.total_cost_usd
          : 0;

      // Fall back to result event's session_id if not captured from init
      if (!sessionId && typeof resultEvent.session_id === "string") {
        sessionId = resultEvent.session_id;
      }

      const isSuccess = subtype === "success";
      const isMaxTurns = subtype === "error_max_turns";
      // error_max_turns is a soft stop — the run completed
      // partially, the process exited cleanly, so we preserve exitCode 0 and
      // clear the session so it won't be resumed.
      const softStop = isSuccess || isMaxTurns;
      // If orager started a fresh session because the previous one wasn't found,
      // clear the session on Paperclip's side too so the next run is treated as
      // first-run (instructions re-injected, bootstrap included).
      const clearSession = isMaxTurns || sessionLost;

      const newSessionParams = sessionId
        ? {
            oragerSessionId: sessionId,
            updatedAt: new Date().toISOString(),
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          }
        : null;

      resolve({
        exitCode: code ?? (softStop ? 0 : 1),
        signal: null,
        timedOut: false,
        errorMessage: softStop
          ? undefined
          : `Agent loop ended: ${subtype}${resultText ? ` — ${resultText}` : ""}`,
        clearSession,
        model: resolvedModel || undefined,
        usage: usageRaw
          ? {
              inputTokens:
                typeof usageRaw.input_tokens === "number"
                  ? usageRaw.input_tokens
                  : 0,
              outputTokens:
                typeof usageRaw.output_tokens === "number"
                  ? usageRaw.output_tokens
                  : 0,
              cachedInputTokens:
                typeof usageRaw.cache_read_input_tokens === "number"
                  ? usageRaw.cache_read_input_tokens
                  : 0,
            }
          : undefined,
        provider: "openrouter",
        biller: "openrouter",
        billingType: "api",
        costUsd: totalCostUsd,
        sessionParams: newSessionParams,
        sessionDisplayId: sessionId || null,
        summary: resultText,
        resultJson: {
          result: resultText,
          subtype,
          sessionId,
          totalCostUsd,
        },
      });
    });

    proc.on("error", (err) => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to start orager: ${err.message}`,
        errorCode: "spawn_error",
      });
    });
  });
}
