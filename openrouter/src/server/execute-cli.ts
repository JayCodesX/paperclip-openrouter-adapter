import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const parallelToolCalls =
    typeof config.parallel_tool_calls === "boolean"
      ? config.parallel_tool_calls
      : undefined;

  // Reasoning
  const reasoningConfig = parseObject(config.reasoning);
  const reasoningEffort =
    typeof reasoningConfig.effort === "string" ? reasoningConfig.effort : "";
  const reasoningMaxTokens =
    typeof reasoningConfig.max_tokens === "number"
      ? reasoningConfig.max_tokens
      : undefined;
  const reasoningExclude = reasoningConfig.exclude === true;

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
  const sort =
    typeof providerConfig.sort === "string" ? providerConfig.sort : "";
  const quantizations = Array.isArray(providerConfig.quantizations)
    ? providerConfig.quantizations
        .filter((s: unknown) => typeof s === "string")
        .join(",")
    : "";

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

  // resetSession: trash the current session and start fresh.
  // The orager binary trashes it so it's preserved on disk for review but
  // won't be resumed. The adapter clears sessionParams so Paperclip forgets it.
  const resetSession = config.resetSession === true;
  if (resetSession && storedSessionId) {
    try {
      const cliPath = asString(config.cliPath, "orager").trim() || "orager";
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)(cliPath, ["--trash-session", storedSessionId]);
      await onLog("stderr", `[orager] session ${storedSessionId} trashed\n`);
    } catch (err) {
      await onLog("stderr", `[orager] warning: could not trash session: ${String(err)}\n`);
    }
  }

  const previousSessionId = resetSession ? "" : storedSessionId;

  // Only prepend bootstrap + handoff on the first run
  // (instructions go to --system-prompt-file, not the user message)
  const isFirstRun = !previousSessionId;
  const prompt = joinPromptSections([
    isFirstRun ? renderedBootstrap : null,
    isFirstRun ? sessionHandoff : null,
    userMessage,
  ]);

  // ── Build CLI args ─────────────────────────────────────────────────────────
  const args: string[] = [
    "--print",
    "-",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  args.push("--model", model);
  if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
  args.push("--max-retries", String(maxRetries));
  if (previousSessionId) args.push("--resume", previousSessionId);
  if (instructionsFilePath) args.push("--system-prompt-file", instructionsFilePath);
  if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (sandboxRoot) args.push("--sandbox-root", sandboxRoot);
  if (useFinishTool) args.push("--use-finish-tool");
  if (siteUrl) args.push("--site-url", siteUrl);
  if (siteName) args.push("--site-name", siteName);

  // Sampling
  if (temperature !== undefined) args.push("--temperature", String(temperature));
  if (top_p !== undefined) args.push("--top-p", String(top_p));
  if (top_k !== undefined) args.push("--top-k", String(top_k));
  if (frequency_penalty !== undefined)
    args.push("--frequency-penalty", String(frequency_penalty));
  if (presence_penalty !== undefined)
    args.push("--presence-penalty", String(presence_penalty));
  if (repetition_penalty !== undefined)
    args.push("--repetition-penalty", String(repetition_penalty));
  if (min_p !== undefined) args.push("--min-p", String(min_p));
  if (seed !== undefined) args.push("--seed", String(seed));
  for (const s of stopTokens) args.push("--stop", s);

  // Tool control
  if (toolChoice) args.push("--tool-choice", toolChoice);
  if (parallelToolCalls === true) args.push("--parallel-tool-calls");
  if (parallelToolCalls === false) args.push("--no-parallel-tool-calls");

  // Reasoning
  if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
  if (reasoningMaxTokens !== undefined)
    args.push("--reasoning-max-tokens", String(reasoningMaxTokens));
  if (reasoningExclude) args.push("--reasoning-exclude");

  // Provider routing
  if (providerOrder) args.push("--provider-order", providerOrder);
  if (providerIgnore) args.push("--provider-ignore", providerIgnore);
  if (providerOnly) args.push("--provider-only", providerOnly);
  if (dataCollection) args.push("--data-collection", dataCollection);
  if (zdr) args.push("--zdr");
  if (sort) args.push("--sort", sort);
  if (quantizations) args.push("--quantizations", quantizations);

  // Fallback models
  for (const m of models) args.push("--model-fallback", m);

  // Transforms
  if (transforms) args.push("--transforms", transforms);

  // Cost limits
  if (maxCostUsd !== undefined)
    args.push("--max-cost-usd", String(maxCostUsd));
  if (costPerInputToken !== undefined)
    args.push("--cost-per-input-token", String(costPerInputToken));
  if (costPerOutputToken !== undefined)
    args.push("--cost-per-output-token", String(costPerOutputToken));

  // Approval
  if (requireApprovalFor) args.push("--require-approval-for", requireApprovalFor);
  else if (requireApproval) args.push("--require-approval");

  // Extra tools / skills
  for (const f of toolsFiles) args.push("--tools-file", f);
  for (const d of addDirs) args.push("--add-dir", d);

  // Extra passthrough args
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
