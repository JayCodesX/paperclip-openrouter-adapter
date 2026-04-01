import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { mintDaemonJwt } from "./jwt-utils.js";
import { _resetModelCacheForTesting } from "./list-models.js";
import { processRateLimitTracker } from "../rate-limit-tracker.js";
import { buildOragerSkillsDir, cleanupOragerSkillsDir } from "./skills.js";

// ── Structured logging ────────────────────────────────────────────────────────
// When ORAGER_LOG_FILE is set, JSON structured log lines are appended to that
// file in addition to the normal human-readable stderr output.

const STRUCTURED_LOG_FILE = process.env.ORAGER_LOG_FILE ?? "";

interface StructuredLogEntry {
  level: "info" | "warn" | "error";
  ts: number;
  event: string;
  agentId?: string;
  runId?: string;
  model?: string;
  resolvedModel?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheHitRatio?: number;
  costUsd?: number;
  turnCount?: number;
  subtype?: string;
  message?: string;
  [key: string]: unknown;
}

// In-memory log buffer — used by tests and for in-process diagnostics.
// Capped at 10,000 entries (ring-buffer eviction) so long-lived Paperclip
// worker processes do not accumulate unbounded memory across thousands of runs.
const LOG_BUFFER_MAX = 10_000;

// L-09: Ring buffer for O(1) eviction instead of O(n) Array.shift().
class RingBuffer<T> {
  private _buf: T[] = [];
  private _head = 0;
  private _size = 0;
  constructor(private _cap: number) {}
  push(item: T): void {
    if (this._size < this._cap) {
      this._buf.push(item);
      this._size++;
    } else {
      this._buf[this._head] = item;
      this._head = (this._head + 1) % this._cap;
    }
  }
  toArray(): T[] {
    if (this._size < this._cap) return this._buf.slice();
    return [...this._buf.slice(this._head), ...this._buf.slice(0, this._head)];
  }
  get length(): number { return this._size; }
  clear(): void { this._buf.length = 0; this._head = 0; this._size = 0; }
}

const _structuredLogBuffer = new RingBuffer<StructuredLogEntry>(LOG_BUFFER_MAX);

function structuredLog(entry: StructuredLogEntry): void {
  _structuredLogBuffer.push(entry);
  if (!STRUCTURED_LOG_FILE) return;
  try {
    appendFileSync(STRUCTURED_LOG_FILE, JSON.stringify({ ...entry, ts: entry.ts }) + "\n");
  } catch { /* never fail a run due to log write error */ }
}

// ── API key pool ──────────────────────────────────────────────────────────────
// Collects all configured API keys (primary + apiKeys array) and returns the
// full pool so orager can rotate through them internally on 429 errors.
// Key rotation is handled by orager's callWithRetry — not the adapter.

function buildApiKeyPool(config: Record<string, unknown>): { primary: string; pool: string[] } {
  const extra = Array.isArray(config.apiKeys)
    ? (config.apiKeys as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];
  const primary = (typeof config.apiKey === "string" ? config.apiKey.trim() : "") || (process.env.OPENROUTER_API_KEY ?? "");
  const pool = primary && !extra.includes(primary) ? [primary, ...extra] : extra.length > 0 ? extra : [primary];
  return { primary, pool };
}

// ── Shared NDJSON stream event processing ─────────────────────────────────────

/** The parsed shape of a "question" event from the orager event stream. */
export type OragerQuestionEvent = {
  type: "question";
  prompt: string;
  choices: Array<{ key: string; label: string; description?: string }>;
  toolCallId: string;
  toolName: string;
};

/** Mutable state accumulated while processing an orager event stream. */
export interface OragerStreamState {
  sessionId: string;
  resolvedModel: string;
  sessionLost: boolean;
  resultEvent: Record<string, unknown> | null;
  questionEvent: OragerQuestionEvent | null;
}

/**
 * Process a single parsed orager NDJSON event and update `state` in place.
 *
 * Shared by the daemon (HTTP streaming) and spawn (stdout) paths so event
 * handling stays in sync across both. Differences between paths — e.g. the
 * structured-log call on session loss — are handled via the `onSessionLost`
 * callback.
 *
 * @param event        - Parsed JSON object from the stream.
 * @param state        - Mutable stream state to update.
 * @param onLog        - Log sink (same signature as Paperclip's onLog).
 * @param onSessionLost - Called (once) when a session-loss is detected so the
 *                        caller can emit a path-specific structuredLog entry.
 */
export function processOragerEvent(
  event: Record<string, unknown>,
  state: OragerStreamState,
  onLog: (stream: "stdout" | "stderr", text: string) => Promise<void> | void,
  onSessionLost: () => void,
): void {
  if (event.type === "system" && typeof event.session_id === "string") {
    state.sessionId = event.session_id;
    if (typeof event.model === "string" && event.model) {
      state.resolvedModel = event.model;
    }
  }
  if (event.type === "warn" && typeof event.message === "string") {
    void onLog("stderr", `[openrouter adapter] ${event.message}\n`);
    if (event["subtype"] === "session_lost") {
      if (!state.sessionLost) {
        state.sessionLost = true;
        onSessionLost();
      }
    }
  }
  if (event.type === "result") {
    state.resultEvent = event;
  }
  if (event.type === "question" && !state.questionEvent) {
    // M-20: Validate shape before casting — ensure required fields exist with
    // correct types to prevent downstream crashes from malformed events.
    if (
      typeof event.prompt === "string" &&
      Array.isArray(event.choices) &&
      typeof event.toolCallId === "string" &&
      typeof event.toolName === "string"
    ) {
      state.questionEvent = event as OragerQuestionEvent;
    }
  }
}

// ── Daemon auto-start rate limiter ────────────────────────────────────────
// Prevents hammering the system with repeated daemon spawn attempts if the
// daemon keeps failing to start. Allows at most one auto-start attempt per
// 2 minutes across all requests in this process.
let _lastAutoStartAttemptMs = 0;
const AUTO_START_COOLDOWN_MS = (() => {
  const v = parseInt(process.env["ORAGER_DAEMON_COOLDOWN_MS"] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 2 * 60 * 1000; // default: 2 minutes
})();

// ── Daemon circuit breaker (per daemon URL) ────────────────────────────────
// Tracks consecutive daemon failures per daemon URL. After DAEMON_CB_THRESHOLD
// consecutive failures, that daemon is bypassed for DAEMON_CB_RESET_MS ms.
// Keyed by daemon base URL so multiple daemon instances don't interfere.
const DAEMON_CB_THRESHOLD = 3;
const DAEMON_CB_RESET_MS = 60_000; // 1 minute
const _daemonCircuitState = new Map<string, { failures: number; openedAt: number }>();

function isDaemonCircuitOpen(url: string): boolean {
  const state = _daemonCircuitState.get(url);
  if (!state || state.failures < DAEMON_CB_THRESHOLD) return false;
  if (Date.now() - state.openedAt >= DAEMON_CB_RESET_MS) {
    // Reset to half-open — allow one probe
    state.failures = DAEMON_CB_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordDaemonSuccess(url: string): void {
  _daemonCircuitState.delete(url);
}

function recordDaemonFailure(url: string): void {
  const state = _daemonCircuitState.get(url) ?? { failures: 0, openedAt: 0 };
  state.failures++;
  if (state.failures >= DAEMON_CB_THRESHOLD) state.openedAt = Date.now();
  _daemonCircuitState.set(url, state);
}

// ── Daemon client ─────────────────────────────────────────────────────────────
// If ORAGER_DAEMON_URL is set (or config.daemonUrl is set), the adapter sends
// requests to the persistent orager daemon instead of spawning a new process.
// The daemon eliminates Node.js startup overhead and keeps all caches warm.

const DAEMON_KEY_PATH = path.join(os.homedir(), ".orager", "daemon.key");

/** How old (in ms) a daemon signing key can be before we emit a rotation warning. */
const DAEMON_KEY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
let _daemonKeyAgeWarningEmitted = false;

async function readDaemonSigningKey(
  onLog?: (stream: "stdout" | "stderr", line: string) => Promise<void> | void,
  keyPath = DAEMON_KEY_PATH,
): Promise<string | null> {
  try {
    const [key, stat] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.stat(keyPath),
    ]);
    const trimmed = key.trim();
    if (!trimmed) return null;

    // Warn if the key file is readable by group or world — anyone on the system
    // with that access could forge daemon JWTs and execute arbitrary agent runs.
    if (stat.mode & 0o077) {
      const modeOctal = (stat.mode & 0o777).toString(8).padStart(3, "0");
      const msg =
        `[openrouter adapter] WARNING: daemon signing key at ${keyPath} has unsafe permissions (${modeOctal}). ` +
        `Run: chmod 600 ${keyPath}`;
      if (onLog) void onLog("stderr", msg + "\n");
      structuredLog({ level: "warn", ts: Date.now(), event: "daemon_key_unsafe_permissions", keyPath, mode: modeOctal });
    }

    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > DAEMON_KEY_MAX_AGE_MS && onLog && !_daemonKeyAgeWarningEmitted) {
      _daemonKeyAgeWarningEmitted = true;
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      void onLog(
        "stderr",
        `[openrouter adapter] WARNING: daemon signing key at ${keyPath} is ${ageDays} days old. ` +
        `Consider rotating it (delete the file and restart the daemon to generate a new key).\n`,
      );
    }

    return trimmed;
  } catch {
    return null;
  }
}

// mintDaemonJwt is imported from ./jwt-utils.js

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

/**
 * Attempt to auto-start the orager daemon if ORAGER_DAEMON_AUTOSTART=true
 * is set in the environment. Spawns orager --serve detached and polls
 * /health until it responds (up to 5s). Non-fatal — falls through to spawn
 * if start fails.
 */
async function tryAutoStartDaemon(
  daemonUrl: string,
  cliPath: string,
  apiKey: string,
  env: Record<string, string>,
  onLog: (stream: "stdout" | "stderr", line: string) => Promise<void> | void,
  configAutoStart = false,
): Promise<boolean> {
  // Allow auto-start via env var OR config field
  if (process.env.ORAGER_DAEMON_AUTOSTART !== "true" && !configAutoStart) return false;

  // Rate-limit: only attempt auto-start once per 2 minutes
  const now = Date.now();
  if (now - _lastAutoStartAttemptMs < AUTO_START_COOLDOWN_MS) return false;
  _lastAutoStartAttemptMs = now;

  // Extract port from URL
  let port = 3456;
  try {
    port = parseInt(new URL(daemonUrl).port, 10) || 3456;
  } catch { /* use default */ }

  try {
    await ensureCommandResolvable(cliPath, process.cwd(), env);
  } catch {
    return false; // Can't find binary — skip
  }

  void onLog("stderr", `[openrouter adapter] auto-starting orager daemon on port ${port}...\n`);

  const child = spawn(cliPath, ["--serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: { ...env, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || apiKey, ORAGER_API_KEY: env.ORAGER_API_KEY || apiKey },
  });
  child.unref();

  // Poll /health until daemon responds (up to 5s)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 300));
    if (await isDaemonAlive(daemonUrl)) {
      void onLog("stderr", `[openrouter adapter] daemon started on port ${port}\n`);
      return true;
    }
  }
  void onLog("stderr", `[openrouter adapter] daemon did not start in time — falling back to spawn\n`);
  return false;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// skills/ dir is at the root of the adapter package (two levels up from dist/server/)
const SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");
// L-13: Skills directory validation moved from module-level floating promise
// to lazy, cached check on first use.
let _skillsDirChecked = false;
let _skillsDirValid = false;
async function ensureSkillsDirChecked(): Promise<boolean> {
  if (_skillsDirChecked) return _skillsDirValid;
  _skillsDirChecked = true;
  try {
    const s = await fs.stat(SKILLS_DIR);
    _skillsDirValid = s.isDirectory();
    if (!_skillsDirValid) {
      process.stderr.write(`[openrouter adapter] WARNING: bundled skills directory is not a directory: ${SKILLS_DIR}\n`);
    }
  } catch {
    process.stderr.write(`[openrouter adapter] WARNING: bundled skills directory not found: ${SKILLS_DIR} — Paperclip skills (get-task, post-comment, etc.) will not be available\n`);
    _skillsDirValid = false;
  }
  return _skillsDirValid;
}
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

/**
 * Return true if `host` is a loopback address (IPv4 127.x.x.x, IPv6 ::1,
 * IPv6-mapped IPv4 loopback ::ffff:127.x.x.x / ::ffff:7f00:1, or "localhost").
 * Used to block SSRF attacks that try to reach local services.
 */
function isLoopbackHost(host: string): boolean {
  // Node.js URL.hostname returns bracketed IPv6 (e.g. "[::1]", "[::ffff:7f00:1]")
  // Strip brackets to normalize before matching.
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    /^127\./.test(h) ||
    // IPv6-mapped IPv4 loopback: ::ffff:127.x.x.x or ::ffff:7f00:1
    /^::ffff:127\./i.test(h) ||
    h === "::ffff:7f00:1"
  );
}

/**
 * Validate that a string is a well-formed http/https URL.
 * Returns the trimmed URL if valid, empty string if not.
 * Used for siteUrl, siteName (informational headers), and webhookUrl (outbound POST)
 * to prevent SSRF via misconfigured or attacker-controlled agent config.
 */
function validateHttpUrl(raw: string, fieldName: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return raw;
  } catch {
    process.stderr.write(
      `[openrouter adapter] WARNING: config.${fieldName} '${raw.slice(0, 100)}' is not a valid URL — ignoring\n`,
    );
    return "";
  }
}

/**
 * Wrap asNumber to reject NaN and Infinity, falling back to `defaultVal`.
 * Prevents garbage config values (e.g. temperature: Infinity, maxTurns: NaN)
 * from propagating into orager where they may cause undefined behavior.
 */
function safeNumber(value: unknown, defaultVal: number): number {
  const n = asNumber(value, defaultVal);
  return Number.isFinite(n) ? n : defaultVal;
}

/**
 * Read a fetch Response body up to `maxBytes`, then cancel the stream.
 * Prevents OOM when a malicious or buggy server sends a huge error body.
 */
async function readBodyCapped(response: Response, maxBytes = 4096): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return new TextDecoder().decode(buf);
}

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
 * Options sent to the orager daemon via POST /run.
 * Mirrors orager's AgentLoopOptions (minus apiKey/onEmit/onLog which are daemon-side).
 * Typed explicitly so TypeScript catches misspelled field names at the call site.
 */
interface DaemonRunOpts {
  // ── Identity / session ──────────────────────────────────────────────────
  apiKey?: string;
  model?: string;
  models?: string[];
  sessionId?: string | null;
  cwd?: string;
  addDirs?: string[];
  // ── Run control ─────────────────────────────────────────────────────────
  maxTurns?: number;
  maxRetries?: number;
  verbose?: boolean;
  forceResume?: boolean;
  timeoutSec?: number;
  useFinishTool?: boolean;
  profile?: string;
  settingsFile?: string;
  // ── Sampling ────────────────────────────────────────────────────────────
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  seed?: number;
  stop?: string[];
  parallel_tool_calls?: boolean;
  tool_choice?: string | Record<string, unknown>;
  response_format?: Record<string, unknown>;
  // ── Model routing ───────────────────────────────────────────────────────
  reasoning?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  preset?: string;
  transforms?: string[];
  // ── Cost limits ─────────────────────────────────────────────────────────
  maxCostUsd?: number;
  maxCostUsdSoft?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
  // ── Site identity ───────────────────────────────────────────────────────
  siteUrl?: string;
  siteName?: string;
  // ── Tool settings ───────────────────────────────────────────────────────
  toolTimeouts?: Record<string, number>;
  maxSpawnDepth?: number;
  maxIdenticalToolCallTurns?: number;
  toolErrorBudgetHardStop?: number | boolean;
  enableBrowserTools?: boolean;
  tagToolOutputs?: boolean;
  trackFileChanges?: boolean;
  // Note: dangerouslySkipPermissions, sandboxRoot, bashPolicy, requireApproval
  // are intentionally absent — the daemon strips them unconditionally (security
  // boundary). They are spawn-path-only opts.
  // ── Summarization ───────────────────────────────────────────────────────
  summarizeAt?: number;
  summarizeModel?: string;
  summarizeKeepRecentTurns?: number;
  summarizePrompt?: string;
  summarizeFallbackKeep?: number;
  // ── Vision routing ──────────────────────────────────────────────────────
  visionModel?: string;
  // ── Plan mode ───────────────────────────────────────────────────────────
  planMode?: boolean;
  // ── Context ─────────────────────────────────────────────────────────────
  readProjectInstructions?: boolean;
  injectContext?: boolean;
  appendSystemPrompt?: string;
  promptContent?: Array<Record<string, unknown>>;
  // ── Approval ────────────────────────────────────────────────────────────
  approvalMode?: string;
  approvalAnswer?: { choiceKey: string; toolCallId: string } | string | null;
  approvalTimeoutMs?: number;
  // ── Turn routing ────────────────────────────────────────────────────────
  turnModelRules?: unknown;
  // ── Hooks ───────────────────────────────────────────────────────────────
  hooks?: unknown;
  hookTimeoutMs?: number;
  hookErrorMode?: string;
  webhookUrl?: string;
  webhookFormat?: "discord";
  // ── MCP ─────────────────────────────────────────────────────────────────
  mcpServers?: unknown;
  requireMcpServers?: string[];
  // ── API key pool ────────────────────────────────────────────────────────
  apiKeys?: string[];
  requiredEnvVars?: string[];
  // ── Per-agent API key isolation ─────────────────────────────────────────
  agentApiKey?: string;
  // ── Memory ──────────────────────────────────────────────────────────────
  memoryKey?: string;
  memoryRetrieval?: "local" | "fts" | "embedding";
  memoryEmbeddingModel?: string;
  memoryRetrievalThreshold?: number;
  memoryMaxChars?: number;
  // ── Per-run env injection ────────────────────────────────────────────────
  // Paperclip context vars (PAPERCLIP_API_KEY, PAPERCLIP_TASK_ID, etc.) must
  // be injected per-run in daemon mode since the daemon process doesn't have them.
  env?: Record<string, string>;
}

/**
 * Execute an agent run by POSTing to the orager daemon.
 * Returns the same AdapterExecutionResult shape as the spawn path.
 */
async function executeViaDaemon(
  baseUrl: string,
  signingKey: string,
  agentId: string,
  runId: string,
  prompt: string,
  promptContent: Array<{ type: string; [key: string]: unknown }> | null,
  daemonOpts: DaemonRunOpts,
  timeoutSec: number,
  onLog: (stream: "stdout" | "stderr", line: string) => Promise<void> | void,
): Promise<AdapterExecutionResult | null> {
  const token = mintDaemonJwt(signingKey, agentId);
  const tokenMintedAt = Date.now();
  /** Re-mint if more than 12 minutes have passed (leaves 3-min buffer before 15-min expiry). */
  function freshToken(): string {
    return Date.now() - tokenMintedAt > 12 * 60 * 1000
      ? mintDaemonJwt(signingKey, agentId)
      : token;
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${freshToken()}`,
      },
      body: JSON.stringify({ prompt, promptContent: promptContent ?? undefined, opts: daemonOpts }),
      signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      exitCode: 1,
      signal: null,
      timedOut: isTimeout,
      errorMessage: `Daemon request failed: ${msg}`,
      errorCode: isTimeout ? "timeout" : "daemon_error",
    };
  }

  if (response.status === 503) {
    // Respect Retry-After header then retry the daemon once.
    // If still saturated after the retry, return null to trigger spawn fallback (#1).
    const retryAfterSec = Math.min(
      Math.max(parseInt(response.headers.get("Retry-After") ?? "5", 10) || 5, 1),
      30,
    );
    // Cap wait to half of timeoutSec so we never wait longer than the run budget.
    // Without this cap, a 30s Retry-After combined with a 60s timeout would cause
    // the second fetch's AbortSignal.timeout() to fire mid-wait, masking a timeout
    // as a silent spawn fallback.
    const maxWaitMs = timeoutSec > 0 ? Math.max(Math.floor((timeoutSec * 1000) / 2), 1000) : 30_000;
    const waitMs = Math.min(retryAfterSec * 1000, maxWaitMs);
    structuredLog({ level: "warn", ts: Date.now(), event: "daemon_retry", agentId, runId, message: `Daemon at capacity, retrying in ${Math.round(waitMs / 1000)}s` });
    void onLog("stderr", `[openrouter adapter] daemon at capacity — retrying in ${Math.round(waitMs / 1000)}s\n`);
    await new Promise<void>((r) => setTimeout(r, waitMs));
    // Retry with a fresh token (original may expire if wait was long)
    const retryToken = mintDaemonJwt(signingKey, agentId);
    try {
      response = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${retryToken}`,
        },
        body: JSON.stringify({ prompt, promptContent: promptContent ?? undefined, opts: daemonOpts }),
        signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      });
    } catch (retryErr) {
      // For timeout/abort errors, surface as a structured error rather than
      // silently falling back to spawn (which would start a second full run).
      const isTimeout = retryErr instanceof Error && retryErr.name === "TimeoutError";
      const isAbort = retryErr instanceof Error && retryErr.name === "AbortError";
      if (isTimeout || isAbort) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: isTimeout,
          errorMessage: `Daemon retry request ${isTimeout ? "timed out" : "was aborted"}`,
          errorCode: isTimeout ? "timeout" : "daemon_error",
        };
      }
      // Other network failure on retry — fall back to spawn
      return null;
    }
    if (response.status === 503) {
      // Still at capacity after retry — fall back to spawn
      return null;
    }
  }

  // 429 = rate-limited. Respect Retry-After header and retry once, then fall
  // back to spawn. Unlike 503 (capacity), 429 means the API key is rate-limited;
  // retrying quickly would just receive another 429.
  // The process-level processRateLimitTracker is updated so callers can check
  // rate-limit state and so the gate activates on the next request if needed.
  if (response.status === 429) {
    const retryAfterSec = Math.min(
      Math.max(parseInt(response.headers.get("Retry-After") ?? "10", 10) || 10, 1),
      60,
    );
    const maxWaitMs = timeoutSec > 0 ? Math.max(Math.floor((timeoutSec * 1000) / 2), 1000) : 60_000;
    const waitMs = Math.min(retryAfterSec * 1000, maxWaitMs);
    processRateLimitTracker.recordRateLimit(waitMs);
    processRateLimitTracker.updateFromHeaders(response.headers);
    structuredLog({ level: "warn", ts: Date.now(), event: "daemon_rate_limited", agentId, runId, waitMs, message: `Daemon rate-limited (429), retrying in ${Math.round(waitMs / 1000)}s` });
    void onLog("stderr", `[openrouter adapter] daemon rate-limited — retrying in ${Math.round(waitMs / 1000)}s\n`);
    await new Promise<void>((r) => setTimeout(r, waitMs));
    const retryToken = mintDaemonJwt(signingKey, agentId);
    try {
      response = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${retryToken}`,
        },
        body: JSON.stringify({ prompt, promptContent: promptContent ?? undefined, opts: daemonOpts }),
        signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      });
    } catch (retryErr) {
      const isTimeout = retryErr instanceof Error && retryErr.name === "TimeoutError";
      const isAbort = retryErr instanceof Error && retryErr.name === "AbortError";
      if (isTimeout || isAbort) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: isTimeout,
          errorMessage: `Daemon retry request after 429 ${isTimeout ? "timed out" : "was aborted"}`,
          errorCode: isTimeout ? "timeout" : "daemon_error",
        };
      }
      return null;
    }
    if (response.status === 429) {
      // Still rate-limited after retry — fall back to spawn
      return null;
    }
  }

  if (!response.ok) {
    const text = await readBodyCapped(response, 4096).catch(() => "");
    const isAuth = response.status === 401 || response.status === 403;
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Daemon error ${response.status}: ${text.slice(0, 200)}`,
      errorCode: isAuth ? "auth_error" : "daemon_error",
    };
  }

  // Successful response — clear any recorded rate-limit back-off state.
  processRateLimitTracker.clearRateLimit();

  if (!response.body) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Daemon response has no body",
      errorCode: "daemon_error",
    };
  }

  // Stream NDJSON from daemon — same parsing logic as the spawn stdout path
  /** Hard cap on the in-memory line buffer to prevent OOM from runaway output. */
  const MAX_STREAM_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

  const streamState: OragerStreamState = {
    sessionId: "",
    resolvedModel: "",
    sessionLost: false,
    resultEvent: null,
    questionEvent: null,
  };
  let buffer = "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Guard against a single massive line consuming unbounded memory
      if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
        const nextNewline = buffer.indexOf("\n", MAX_STREAM_BUFFER_BYTES);
        const discarded = nextNewline >= 0 ? buffer.slice(0, nextNewline) : buffer;
        // Check if the oversized segment contains critical events before discarding
        if (discarded.includes('"type":"result"') || discarded.includes('"type":"question"')) {
          void onLog("stderr",
            `[openrouter adapter] WARNING: oversized stream segment (~${discarded.length} bytes) may contain a result/question event — attempting to parse\n`
          );
          structuredLog({ level: "warn", ts: Date.now(), event: "daemon_oversized_segment_critical", agentId, segmentBytes: discarded.length, message: "Oversized segment contains result/question event — attempting recovery" });
          // M-21: Split by newlines first, then attempt parsing each line.
          // The previous regex approach used greedy [^\n]* which could capture
          // malformed partial JSON from adjacent events.
          let recoveredCritical = false;
          for (const candidateLine of discarded.split("\n")) {
            const trimmed = candidateLine.trim();
            if (!trimmed.startsWith("{")) continue;
            try {
              const event = JSON.parse(trimmed) as Record<string, unknown>;
              if (event.type === "result") {
                streamState.resultEvent = event;
                recoveredCritical = true;
              }
              if (event.type === "question") {
                processOragerEvent(event, streamState, onLog, () => {});
                recoveredCritical = true;
              }
            } catch {
              // Individual line parse failure — try next line
            }
          }
          if (!recoveredCritical) {
            structuredLog({ level: "error", ts: Date.now(), event: "daemon_oversized_segment_unrecoverable", agentId, segmentBytes: discarded.length, message: "Could not parse result event from oversized segment — run will end with synthesised error" });
            void onLog("stderr", `[openrouter adapter] ERROR: could not parse result event from oversized segment (${discarded.length} bytes) — run result lost\n`);
          }
        } else {
          void onLog("stderr",
            `[openrouter adapter] daemon stream segment exceeded ${MAX_STREAM_BUFFER_BYTES} bytes — discarding oversized segment\n`
          );
          structuredLog({ level: "warn", ts: Date.now(), event: "daemon_oversized_segment_discarded", agentId, segmentBytes: discarded.length });
        }
        // Skip forward to the next newline to resync the parser
        buffer = nextNewline >= 0 ? buffer.slice(nextNewline + 1) : "";
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void onLog("stdout", line + "\n");
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processOragerEvent(event, streamState, onLog, () => {
            structuredLog({ level: "warn", ts: Date.now(), event: "session_not_found", agentId, runId, message: "Daemon session not found — started fresh" });
          });
        } catch {
          // Non-JSON lines are expected (blank lines, partial chunks) — only warn
          // on lines that LOOK like JSON (start with '{') since those represent
          // actual parse failures that could mask dropped result/question events.
          if (line.trimStart().startsWith("{")) {
            void onLog("stderr",
              `[openrouter adapter] WARNING: failed to parse JSON event from daemon stream: ${line.slice(0, 200)}\n`,
            );
            // Also emit to structured log so parse failures are visible in
            // operational dashboards, not just in the ephemeral stderr stream.
            structuredLog({
              level: "warn",
              ts: Date.now(),
              event: "daemon_stream_parse_error",
              agentId,
              linePreview: line.slice(0, 200),
            });
          }
        }
      }
    }
    // flush
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer) as Record<string, unknown>;
        processOragerEvent(event, streamState, onLog, () => {
          structuredLog({ level: "warn", ts: Date.now(), event: "session_not_found", agentId, runId, message: "Daemon session not found — started fresh" });
        });
      } catch { /* ok */ }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const { resultEvent, sessionId, resolvedModel, sessionLost, questionEvent } = streamState;

  if (!resultEvent) {
    structuredLog({ level: "error", ts: Date.now(), event: "daemon_no_result", agentId, runId, message: "Daemon stream ended without a result event — daemon may have crashed or restarted" });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Daemon run ended without a result event",
      errorCode: "no_result",
    };
  }

  const hasCostField = typeof resultEvent.total_cost_usd === "number";
  if (!hasCostField) {
    void onLog("stderr", "[openrouter adapter] WARNING: result event missing total_cost_usd\n");
  }

  const builtResult = buildAdapterResult({
    resultEvent,
    sessionId,
    resolvedModel,
    sessionLost,
    cwd: daemonOpts.cwd ?? "",
    workspaceId: null,
    workspaceRepoUrl: null,
    workspaceRepoRef: null,
    exitCode: null,  // helper will compute it from subtype
    signal: null,
  });

  return {
    ...builtResult,
    question: questionEvent
      ? { prompt: questionEvent.prompt, choices: questionEvent.choices }
      : null,
  };
}

// ── Shared result builder ─────────────────────────────────────────────────────
// Used by both the daemon path and the spawn path to assemble the final
// AdapterExecutionResult from a parsed "result" event. Centralising the logic
// here ensures the two paths stay in sync and reduces duplication.

interface BuildAdapterResultOpts {
  resultEvent: Record<string, unknown>;
  sessionId: string;
  resolvedModel: string;
  sessionLost: boolean;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function buildAdapterResult(opts: BuildAdapterResultOpts): AdapterExecutionResult {
  const {
    resultEvent, sessionId, resolvedModel, sessionLost,
    cwd, workspaceId, workspaceRepoUrl, workspaceRepoRef,
    exitCode, signal,
  } = opts;

  const subtype =
    typeof resultEvent.subtype === "string" ? resultEvent.subtype : "error";
  const resultText =
    typeof resultEvent.result === "string" ? resultEvent.result : "";
  const usageRaw =
    typeof resultEvent.usage === "object" && resultEvent.usage !== null
      ? (resultEvent.usage as Record<string, unknown>)
      : null;
  const hasCostField = typeof resultEvent.total_cost_usd === "number";
  const totalCostUsd = hasCostField ? (resultEvent.total_cost_usd as number) : 0;

  const effectiveSessionId =
    sessionId || (typeof resultEvent.session_id === "string" ? resultEvent.session_id : "");

  const isSuccess = subtype === "success";
  const isMaxTurns = subtype === "error_max_turns";
  const softStop = isSuccess || isMaxTurns;
  const clearSession = isMaxTurns || sessionLost;

  const cacheHitRatio =
    typeof usageRaw?.input_tokens === "number" && usageRaw.input_tokens > 0
      ? (typeof usageRaw.cache_read_input_tokens === "number"
          ? usageRaw.cache_read_input_tokens
          : 0) / usageRaw.input_tokens
      : 0;

  const newSessionParams = effectiveSessionId
    ? {
        oragerSessionId: effectiveSessionId,
        cwd,
        updatedAt: new Date().toISOString(),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      }
    : null;

  return {
    exitCode: exitCode ?? (softStop ? 0 : 1),
    signal,
    timedOut: false,
    errorMessage: softStop
      ? undefined
      : `Agent loop ended: ${subtype}${resultText ? ` — ${resultText}` : ""}`,
    errorCode: softStop ? undefined : subtype,
    clearSession,
    model: resolvedModel || undefined,
    usage: usageRaw
      ? {
          inputTokens:
            typeof usageRaw.input_tokens === "number" ? usageRaw.input_tokens : 0,
          outputTokens:
            typeof usageRaw.output_tokens === "number" ? usageRaw.output_tokens : 0,
          cachedInputTokens:
            typeof usageRaw.cache_read_input_tokens === "number"
              ? usageRaw.cache_read_input_tokens
              : 0,
        }
      : undefined,
    provider: "openrouter",
    biller: "openrouter",
    billingType: "api" as const,
    costUsd: totalCostUsd,
    sessionParams: newSessionParams,
    sessionDisplayId: effectiveSessionId || null,
    summary: resultText,
    resultJson: {
      result: resultText,
      subtype,
      sessionId: effectiveSessionId,
      totalCostUsd,
      cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
      turnCount:
        typeof resultEvent.turnCount === "number" ? resultEvent.turnCount : undefined,
      filesChanged: Array.isArray(resultEvent.filesChanged)
        ? (resultEvent.filesChanged as string[])
        : undefined,
      cacheWriteInputTokens:
        typeof usageRaw?.cache_creation_input_tokens === "number"
          ? usageRaw.cache_creation_input_tokens
          : undefined,
    },
    question: null, // caller sets this if needed
  };
}

const DEFAULT_CLI = "orager";
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRIES = 3;
// Ordered fallback chain tried when the configured model doesn't support vision.
// Gemini 2.0 Flash first (fast + cheap), then GPT-4o, then Claude Sonnet.
const DEFAULT_VISION_FALLBACK_MODELS = [
  "google/gemini-2.0-flash-001",
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4-5",
];
const DEFAULT_TIMEOUT_SEC = 300; // 5 min — fallback used inside defaultTimeoutForModel
const DEFAULT_GRACE_SEC = 20;

/**
 * Pick a sensible default timeout for the given model.
 * Reasoning/thinking models need more time; fast chat models need less.
 * All values are in seconds.
 *
 * Mirrors orager's `defaultTimeoutForModel` in loop-helpers.ts — the adapter
 * needs this locally to set the outer process/network timeout, while orager uses
 * it to self-terminate the loop via AbortSignal.timeout().
 */
function defaultTimeoutForModel(model: string): number {
  const lower = model.toLowerCase();
  // Extended thinking / reasoning models — can think for minutes
  if (/\br1\b|deepseek-r1|\/o1|\/o3|thinking|reasoning/.test(lower)) return 600;
  // Fast chat / flash models
  if (/haiku|flash|mini|turbo/.test(lower)) return 120;
  // Default
  return DEFAULT_TIMEOUT_SEC;
}

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

  // Wake-reason-based model routing — allows routing smarter/faster models
  // based on why the agent was triggered, without changing the base config.
  const wakeReasonModels = parseObject(config.wakeReasonModels);
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : "";
  let effectiveModel =
    (wakeReason && typeof wakeReasonModels[wakeReason] === "string"
      ? (wakeReasonModels[wakeReason] as string)
      : null) ?? model;

  // Emit a structured log entry when wakeReason routes to a different model so
  // the routing decision is captured in the structured audit trail.
  if (wakeReason && effectiveModel !== model) {
    structuredLog({
      level: "info",
      ts: Date.now(),
      event: "wake_reason_model_routed",
      agentId: agent.id,
      runId,
      wakeReason,
      requestedModel: model,
      effectiveModel,
      message: `wakeReasonModels: routing '${wakeReason}' → '${effectiveModel}' (base model: '${model}')`,
    });
  }

  const onlineSearch = asBoolean(config.onlineSearch, false);

  // ── agentId override — caller-supplied identity for Anthropic metadata ──────
  // When config.agentId is provided it overrides agent.id as the identity sent
  // to the orager daemon (JWT subject → metadata.user_id in Anthropic requests).
  // Paperclip platform logging always uses agent.id regardless of this override.
  const configAgentId =
    typeof config.agentId === "string" && config.agentId.trim()
      ? config.agentId.trim()
      : null;
  const effectiveAgentId = configAgentId ?? agent.id;

  // Support both maxTurns and maxTurnsPerRun (alias for compatibility)
  const maxTurns = Math.max(0, safeNumber(
    config.maxTurnsPerRun ?? config.maxTurns,
    DEFAULT_MAX_TURNS,
  ));
  const maxRetries = Math.max(0, safeNumber(config.maxRetries, DEFAULT_MAX_RETRIES));
  let timeoutSec = Math.max(0, safeNumber(config.timeoutSec, defaultTimeoutForModel(effectiveModel)));
  const rawGraceSec = Math.max(0, safeNumber(config.graceSec, DEFAULT_GRACE_SEC));
  const graceSec = (timeoutSec > 0 && rawGraceSec >= timeoutSec)
    ? Math.max(1, Math.floor(timeoutSec * 0.1))
    : rawGraceSec;
  const dangerouslySkipPermissions = asBoolean(
    config.dangerouslySkipPermissions,
    false,
  );
  const siteUrl = validateHttpUrl(asString(config.siteUrl, ""), "siteUrl");
  const siteName = asString(config.siteName, "");
  const sandboxRoot = asString(config.sandboxRoot, "");
  const useFinishTool = asBoolean(config.useFinishTool, false);
  const profile = asString(config.profile, "").trim();
  const _rawSettingsFile = asString(config.settingsFile, "").trim(); // validated after cwd is resolved
  const forceResume = asBoolean(config.forceResume, false);
  const daemonAutoStart = asBoolean(config.daemonAutoStart, false);

  // Sampling — reject NaN/Infinity for all sampling params
  const temperature =
    typeof config.temperature === "number" && Number.isFinite(config.temperature) ? config.temperature : undefined;
  const top_p = typeof config.top_p === "number" && Number.isFinite(config.top_p) ? config.top_p : undefined;
  const top_k = typeof config.top_k === "number" && Number.isFinite(config.top_k) ? config.top_k : undefined;
  const frequency_penalty =
    typeof config.frequency_penalty === "number" && Number.isFinite(config.frequency_penalty)
      ? config.frequency_penalty
      : undefined;
  const presence_penalty =
    typeof config.presence_penalty === "number" && Number.isFinite(config.presence_penalty)
      ? config.presence_penalty
      : undefined;
  const repetition_penalty =
    typeof config.repetition_penalty === "number" && Number.isFinite(config.repetition_penalty)
      ? config.repetition_penalty
      : undefined;
  const min_p = typeof config.min_p === "number" && Number.isFinite(config.min_p) ? config.min_p : undefined;
  const seed = typeof config.seed === "number" && Number.isInteger(config.seed) ? config.seed : undefined;
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

  // Cost limits — must be positive if specified; zero/negative disables enforcement
  // so a misconfigured value would silently turn off cost controls.
  const maxCostUsd =
    typeof config.maxCostUsd === "number" && config.maxCostUsd > 0
      ? config.maxCostUsd
      : undefined;
  const maxCostUsdSoft =
    typeof config.maxCostUsdSoft === "number" && config.maxCostUsdSoft > 0
      ? config.maxCostUsdSoft
      : undefined;
  const costPerInputToken =
    typeof config.costPerInputToken === "number"
      ? config.costPerInputToken
      : undefined;
  const costPerOutputToken =
    typeof config.costPerOutputToken === "number"
      ? config.costPerOutputToken
      : undefined;

  // Approval
  // requireApprovalFor: comma-separated list of tool names → string[]
  // requireApproval: true → "all" (require approval for every tool)
  // AgentLoopOptions.requireApproval is "all" | string[], never a boolean.
  const _requireApprovalBool = asBoolean(config.requireApproval, false);
  const _requireApprovalForStr = asString(config.requireApprovalFor, "");
  const _requireApprovalForArr = Array.isArray(config.requireApprovalFor)
    ? (config.requireApprovalFor as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : _requireApprovalForStr
      ? _requireApprovalForStr.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const effectiveRequireApproval: "all" | string[] | undefined =
    _requireApprovalForArr.length > 0
      ? _requireApprovalForArr
      : _requireApprovalBool
        ? "all"
        : undefined;

  // Always use question mode in the adapter — never block on TTY
  const approvalMode = "question";

  // Check for approval answer from previous run's question
  const questionAnswer = parseObject(context.questionAnswer);
  const approvalAnswer =
    typeof questionAnswer.choiceKey === "string" && typeof questionAnswer.toolCallId === "string"
      ? { choiceKey: questionAnswer.choiceKey, toolCallId: questionAnswer.toolCallId }
      : null;

  // Dry-run mode
  const dryRun = asBoolean(config.dryRun, false);

  // Required env vars
  const requiredEnvVars = Array.isArray(config.requiredEnvVars)
    ? config.requiredEnvVars.filter((v: unknown) => typeof v === "string")
    : [];

  // Summarize config
  const summarizeAt =
    typeof config.summarizeAt === "number" && config.summarizeAt > 0 && config.summarizeAt <= 1
      ? config.summarizeAt
      : undefined;
  const summarizeModel =
    typeof config.summarizeModel === "string" && config.summarizeModel.trim()
      ? config.summarizeModel.trim()
      : undefined;
  const summarizeKeepRecentTurns =
    typeof config.summarizeKeepRecentTurns === "number" && config.summarizeKeepRecentTurns >= 0
      ? config.summarizeKeepRecentTurns
      : undefined;
  const summarizePrompt =
    typeof config.summarizePrompt === "string" && config.summarizePrompt.trim()
      ? config.summarizePrompt.trim()
      : undefined;
  const summarizeFallbackKeep =
    typeof config.summarizeFallbackKeep === "number" && config.summarizeFallbackKeep >= 0
      ? config.summarizeFallbackKeep
      : undefined;
  const webhookUrl = (() => {
    const raw = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
    const validated = validateHttpUrl(raw, "webhookUrl");
    if (validated) {
      try {
        const wu = new URL(validated);
        if (isLoopbackHost(wu.hostname.toLowerCase())) {
          void onLog(
            "stderr",
            `[openrouter adapter] WARNING: config.webhookUrl '${raw.slice(0, 100)}' points to loopback — loopback SSRF guard triggered, ignoring\n`,
          );
          return "";
        }
      } catch {
        return "";
      }
    }
    return validated || undefined;
  })();
  const webhookFormat: "discord" | undefined = (() => {
    const raw = typeof config.webhookFormat === "string" ? config.webhookFormat.trim() : "";
    return raw === "discord" ? "discord" : undefined;
  })();

  // Extended agent loop options
  const tagToolOutputs =
    typeof config.tagToolOutputs === "boolean" ? config.tagToolOutputs : undefined;
  const planMode = asBoolean(config.planMode, false);
  const injectContext = asBoolean(config.injectContext, false);
  const bashPolicy = parseObject(config.bashPolicy);
  const hooksRaw = parseObject(config.hooks);
  // L-12: Accept both string and object-valued hooks. Previously only string
  // hooks were kept, silently dropping structured hook configurations.
  const hooks = Object.keys(hooksRaw).length > 0
    ? Object.fromEntries(
        Object.entries(hooksRaw).filter(([, v]) => typeof v === "string" || (typeof v === "object" && v !== null)),
      ) as Record<string, unknown>
    : undefined;
  const trackFileChanges = asBoolean(config.trackFileChanges, false);
  const enableBrowserTools = asBoolean(config.enableBrowserTools, false);
  const readProjectInstructions =
    typeof config.readProjectInstructions === "boolean" ? config.readProjectInstructions : undefined;
  const hookTimeoutMs =
    typeof config.hookTimeoutMs === "number" && config.hookTimeoutMs > 0
      ? config.hookTimeoutMs
      : undefined;
  const hookErrorMode =
    config.hookErrorMode === "ignore" || config.hookErrorMode === "warn" || config.hookErrorMode === "fail"
      ? (config.hookErrorMode as "ignore" | "warn" | "fail")
      : undefined;
  const approvalTimeoutMs =
    typeof config.approvalTimeoutMs === "number" && config.approvalTimeoutMs > 0
      ? config.approvalTimeoutMs
      : undefined;
  const turnModelRules = Array.isArray(config.turnModelRules) ? config.turnModelRules : undefined;

  // Advanced loop controls
  const mcpServersRaw = parseObject(config.mcpServers);
  const mcpServers =
    Object.keys(mcpServersRaw).length > 0
      ? (mcpServersRaw as Record<string, { command: string; args?: string[]; env?: Record<string, string> }>)
      : undefined;
  const requireMcpServers =
    Array.isArray(config.requireMcpServers)
      ? (config.requireMcpServers as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : undefined;
  const toolTimeoutsRaw = parseObject(config.toolTimeouts);
  const toolTimeouts =
    Object.keys(toolTimeoutsRaw).length > 0
      ? Object.fromEntries(
          Object.entries(toolTimeoutsRaw)
            .filter(([, v]) => typeof v === "number")
            .map(([k, v]) => [k, v as number]),
        )
      : undefined;
  const maxSpawnDepth =
    typeof config.maxSpawnDepth === "number" && config.maxSpawnDepth >= 0
      ? config.maxSpawnDepth
      : undefined;
  const maxIdenticalToolCallTurns =
    typeof config.maxIdenticalToolCallTurns === "number" && config.maxIdenticalToolCallTurns >= 0
      ? config.maxIdenticalToolCallTurns
      : undefined;
  const toolErrorBudgetHardStop = asBoolean(config.toolErrorBudgetHardStop, false) || undefined;

  // Extra tool spec files
  const toolsFiles = Array.isArray(config.toolsFiles)
    ? config.toolsFiles.filter((f: unknown) => typeof f === "string")
    : [];

  // Skills directories — build an ephemeral temp dir with symlinks to the desired
  // Paperclip skills so they are dynamically injected per run (same pattern as
  // claude_local). Falls back to the static bundled skills dir when no Paperclip
  // skills directory is found.
  const desiredSkillNames = Array.isArray(config.desiredSkills)
    ? (config.desiredSkills as unknown[]).filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
    : [];
  const ephemeralSkillsDir = await buildOragerSkillsDir(desiredSkillNames);
  if (ephemeralSkillsDir) {
    if (ephemeralSkillsDir.missing.length > 0) {
      structuredLog({ level: "warn", ts: Date.now(), event: "skills_missing", agentId: agent.id, runId, message: `Desired skills not found: ${ephemeralSkillsDir.missing.join(", ")}` });
    }
    structuredLog({ level: "info", ts: Date.now(), event: "skills_linked", agentId: agent.id, runId, message: `Linked ${ephemeralSkillsDir.linked.length} skill(s) into ephemeral dir: ${ephemeralSkillsDir.linked.join(", ") || "(none)"}` });
  }
  const skillsDirOk = await ensureSkillsDirChecked();
  const addDirs: string[] = ephemeralSkillsDir ? [ephemeralSkillsDir.dir] : (skillsDirOk ? [SKILLS_DIR] : []);
  if (Array.isArray(config.addDirs)) {
    for (const d of config.addDirs) {
      if (typeof d === "string" && d.trim()) addDirs.push(d.trim());
    }
  }

  // Extra passthrough args (extraArgs or args alias)
  // WARNING: extraArgs are passed verbatim to the orager CLI with no sanitisation.
  // Including "--dangerously-skip-permissions" in extraArgs bypasses all tool
  // approval gates. Do not expose this field to untrusted configuration sources.
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  // ── API key pool ───────────────────────────────────────────────────────────
  // The primary key is used for the subprocess env var; the full pool is passed
  // to orager so it can rotate through keys internally on 429 errors.
  const { primary: apiKey, pool: apiKeyPool } = buildApiKeyPool(config);

  if (!apiKey) {
    structuredLog({ level: "error", ts: Date.now(), event: "api_key_missing", agentId: agent.id, runId });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenRouter API key is required. Set OPENROUTER_API_KEY or config.apiKey.",
      errorCode: "config_error",
    };
  }

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

  // ── settingsFile validation ───────────────────────────────────────────────
  // Relative paths must resolve within cwd (symlink-safe).
  // Absolute paths must be under an allowlist of safe roots (default: home dir;
  // extend via ORAGER_SETTINGS_ALLOWED_ROOTS env var, colon-separated).
  // Null bytes are always rejected.
  // On the daemon path settingsFile is stripped by sanitizeDaemonRunOpts anyway.
  const settingsFile = await (async () => {
    const raw = _rawSettingsFile;
    if (!raw) return "";
    if (raw.includes("\x00")) {
      void onLog("stderr", `[openrouter adapter] WARNING: settingsFile contains null bytes — ignoring\n`);
      return "";
    }
    if (path.isAbsolute(raw)) {
      // Restrict absolute paths to an allowlist of safe root directories.
      // Default: home directory only. Operators can extend via ORAGER_SETTINGS_ALLOWED_ROOTS
      // (colon-separated list of absolute paths).
      const extraRoots = (process.env["ORAGER_SETTINGS_ALLOWED_ROOTS"] ?? "")
        .split(":")
        .map((r) => r.trim())
        .filter(Boolean);
      const allowedRoots = [os.homedir(), ...extraRoots];
      const isAllowed = allowedRoots.some(
        (root) => raw === root || raw.startsWith(root + path.sep),
      );
      if (!isAllowed) {
        void onLog(
          "stderr",
          `[openrouter adapter] WARNING: settingsFile '${raw}' is outside allowed roots ` +
            `(${allowedRoots.map((r) => `'${r}'`).join(", ")}) — ignoring. ` +
            `Set ORAGER_SETTINGS_ALLOWED_ROOTS to allow additional directories.\n`,
        );
        return "";
      }
      return raw;
    }
    const abs = path.resolve(cwd, raw);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      real = abs; // file may not exist yet; fall back to lexical path
    }
    let realCwd = cwd;
    try { realCwd = await fs.realpath(cwd); } catch { /* fallback */ }
    if (!real.startsWith(realCwd + path.sep) && real !== realCwd) {
      void onLog("stderr", `[openrouter adapter] WARNING: settingsFile '${raw}' resolves outside cwd — ignoring\n`);
      return "";
    }
    return real;
  })();

  const taskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;

  // ── Instructions file ──────────────────────────────────────────────────────
  // Passed to orager via --system-prompt-file so it lands in the system prompt
  // (not the user message) — mirroring claude-local's --append-system-prompt-file.
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();

  // Validate instructionsFilePath: must resolve (with symlinks expanded) within cwd.
  // Without realpath(), a symlink at <cwd>/instructions.md → /etc/passwd bypasses the prefix check.
  const safeInstructionsFilePath = await (async () => {
    if (!instructionsFilePath) return "";
    const abs = path.isAbsolute(instructionsFilePath)
      ? instructionsFilePath
      : path.resolve(cwd, instructionsFilePath);
    // Resolve symlinks before prefix check to prevent symlink traversal attacks.
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      void onLog("stderr", `[openrouter adapter] WARNING: instructionsFilePath '${instructionsFilePath}' could not be resolved — ignoring\n`);
      return "";
    }
    // Also realpath the cwd itself so the prefix check is correct on platforms
    // where cwd may contain symlinks (e.g. macOS /tmp → /private/tmp).
    let realCwd = cwd;
    try {
      realCwd = await fs.realpath(cwd);
    } catch {
      // cwd doesn't exist yet or isn't accessible — fall back to raw cwd
    }
    // Must stay within cwd OR the same paperclip instance root.
    // Paperclip stores instructions under ~/.paperclip/instances/<id>/companies/…
    // while the workspace may be under ~/.paperclip/instances/<id>/workspaces/…
    // Both are trusted paths set by the orchestrator.
    const withinCwd = real.startsWith(realCwd + path.sep) || real === realCwd;
    const paperclipInstanceRoot = (() => {
      const marker = `${path.sep}.paperclip${path.sep}instances${path.sep}`;
      const idx = realCwd.indexOf(marker);
      if (idx < 0) return null;
      // e.g. /Users/x/.paperclip/instances/default
      const afterMarker = realCwd.indexOf(path.sep, idx + marker.length);
      return afterMarker < 0 ? realCwd.slice(0, realCwd.length) : realCwd.slice(0, afterMarker);
    })();
    const withinPaperclipInstance = paperclipInstanceRoot
      ? real.startsWith(paperclipInstanceRoot + path.sep)
      : false;
    if (!withinCwd && !withinPaperclipInstance) {
      void onLog("stderr", `[openrouter adapter] WARNING: instructionsFilePath '${instructionsFilePath}' is outside cwd — ignoring\n`);
      return "";
    }
    return real;
  })();

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
  const storedCwd = asString(runtimeSessionParams.cwd, "");

  // Reject session resume if cwd changed (mirrors claude-local behavior).
  // forceResume bypasses this check for intentional cross-cwd resumption.
  const cwdMismatch = storedCwd && storedCwd !== cwd && !forceResume;
  if (cwdMismatch) {
    void onLog(
      "stderr",
      `[openrouter adapter] session ${storedSessionId} was created in '${storedCwd}' but current cwd is '${cwd}' — starting fresh (use forceResume: true to override)\n`,
    );
    structuredLog({ level: "warn", ts: Date.now(), event: "session_cwd_mismatch", agentId: agent.id, runId, storedCwd, currentCwd: cwd });
  }
  const previousSessionId = cwdMismatch ? "" : storedSessionId;

  // Only prepend bootstrap + handoff on the first run
  // (instructions go to --system-prompt-file, not the user message)
  const isFirstRun = !previousSessionId;
  const prompt = joinPromptSections([
    isFirstRun ? renderedBootstrap : null,
    isFirstRun ? sessionHandoff : null,
    userMessage,
  ]);

  // ── Image attachments ─────────────────────────────────────────────────────────
  // If Paperclip provides image attachments in the context, build a multimodal
  // content array for the first user message. Supported by any vision-capable
  // model on OpenRouter (GPT-4o, Claude, Gemini 2.5, Llama 3.2 Vision, etc.).
  // Attachment format expected: { url: string, mimeType?: string }[]
  const rawAttachments = Array.isArray(context.attachments)
    ? context.attachments
    : [];
  const imageAttachments = rawAttachments.filter(
    (a): a is { url: string; mimeType?: string } => {
      if (typeof a !== "object" || a === null) return false;
      const att = a as Record<string, unknown>;
      if (typeof att.url !== "string") return false;
      // Validate URL is well-formed http/https — catches malformed URLs like
      // "https://[unterminated" that a simple regex would accept.
      try {
        const u = new URL(att.url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      } catch {
        return false;
      }
      if (att.mimeType !== undefined && (typeof att.mimeType !== "string" || !/^image\//.test(att.mimeType))) return false;
      return true;
    },
  );

  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

  const promptContent: ContentBlock[] | null =
    imageAttachments.length > 0
      ? [
          { type: "text", text: prompt },
          ...imageAttachments.map((a) => ({
            type: "image_url" as const,
            image_url: { url: a.url },
          })),
        ]
      : null;

  // ── Vision routing — delegated to orager ─────────────────────────────────
  // Vision capability detection and model swapping is handled inside orager's
  // loop.ts using its live model metadata cache. The adapter's job is simply to
  // pass the configured visionModel through so orager can act on it.
  // config.visionModel is set by the user via the Paperclip adapter config UI.
  const visionFallbackNote: string | null = promptContent !== null && asString(config.visionModel, "").trim()
    ? `visionModel configured: ${asString(config.visionModel, "").trim()} (routing handled by orager)`
    : null;

  // Pre-read the instructions file once, shared by both spawn and daemon paths.
  // Using appendSystemPrompt (string content) on both paths guarantees identical
  // orager semantics regardless of which execution path is taken. Previously the
  // spawn path sent systemPromptFile (a path string) while the daemon path sent
  // appendSystemPrompt (file contents) — orager may treat these differently. (audit F6/H5)
  const instructionsFileContent: string | undefined = safeInstructionsFilePath
    ? await fs.readFile(safeInstructionsFilePath, "utf8").catch(() => undefined)
    : undefined;

  // ── Build config object and write to temp file ────────────────────────────
  // Instead of building 50+ CLI args, we write all config to a temp JSON file
  // and pass --config-file <path> as the only config arg. This avoids argument
  // length limits on some systems and keeps the subprocess invocation clean.
  // The file is chmod 600 before writing so only the current user can read it.
  // Orager reads and immediately deletes the file before doing anything else.
  //
  // NB: buildConfigFilePayload and buildDaemonRunOpts (further below) are both
  // closures over the variables extracted above. Keeping them as named local
  // functions means adding a new field only requires one change per path, and
  // makes the two parallel representations easy to diff against each other.
  const buildConfigFilePayload = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {
      outputFormat: "stream-json",
      model: effectiveModel,
      maxTurns: maxTurns > 0 ? maxTurns : undefined,
      maxRetries,
      addDirs,
    };

    if (previousSessionId) obj.sessionId = previousSessionId;
    if (instructionsFileContent) obj.appendSystemPrompt = instructionsFileContent;
    if (dangerouslySkipPermissions) obj.dangerouslySkipPermissions = true;
    if (sandboxRoot) obj.sandboxRoot = sandboxRoot;
    if (useFinishTool) obj.useFinishTool = true;
    if (profile) obj.profile = profile;
    if (settingsFile) obj.settingsFile = settingsFile;
    if (forceResume) obj.forceResume = true;
    if (siteUrl) obj.siteUrl = siteUrl;
    if (siteName) obj.siteName = siteName;

    // Sampling
    if (temperature !== undefined) obj.temperature = temperature;
    if (top_p !== undefined) obj.top_p = top_p;
    if (top_k !== undefined) obj.top_k = top_k;
    if (frequency_penalty !== undefined) obj.frequency_penalty = frequency_penalty;
    if (presence_penalty !== undefined) obj.presence_penalty = presence_penalty;
    if (repetition_penalty !== undefined) obj.repetition_penalty = repetition_penalty;
    if (min_p !== undefined) obj.min_p = min_p;
    if (seed !== undefined) obj.seed = seed;
    if (stopTokens.length > 0) obj.stop = stopTokens;

    // Tool control
    if (toolChoice) obj.tool_choice = toolChoice;
    obj.parallel_tool_calls = parallelToolCalls;

    // Reasoning — only send when effort or max_tokens is explicitly set.
    // Sending reasoningExclude alone for non-reasoning models is a no-op that
    // can trigger require_parameters filtering.
    if (reasoningEffort) obj.reasoningEffort = reasoningEffort;
    if (reasoningMaxTokens !== undefined) obj.reasoningMaxTokens = reasoningMaxTokens;
    if ((reasoningEffort || reasoningMaxTokens) && reasoningExclude) obj.reasoningExclude = true;

    // Provider routing — pass as comma-separated strings (matching CLI format)
    if (providerOrder) obj.providerOrder = providerOrder.split(",").filter(Boolean);
    if (providerIgnore) obj.providerIgnore = providerIgnore.split(",").filter(Boolean);
    if (providerOnly) obj.providerOnly = providerOnly.split(",").filter(Boolean);
    if (dataCollection) obj.dataCollection = dataCollection;
    if (zdr) obj.zdr = true;
    if (sort) obj.sort = sort;
    if (requireParameters) obj.require_parameters = true;
    if (quantizations) obj.quantizations = quantizations.split(",").filter(Boolean);
    if (preset) obj.preset = preset;

    // Fallback models (orager applies :online suffix when onlineSearch is set)
    if (models.length > 0) obj.models = models;

    // Transforms
    if (transforms) obj.transforms = transforms.split(",").filter(Boolean);

    // Cost limits
    if (maxCostUsd !== undefined) obj.maxCostUsd = maxCostUsd;
    if (maxCostUsdSoft !== undefined) obj.maxCostUsdSoft = maxCostUsdSoft;
    if (costPerInputToken !== undefined) obj.costPerInputToken = costPerInputToken;
    if (costPerOutputToken !== undefined) obj.costPerOutputToken = costPerOutputToken;

    // Approval — requireApproval must be "all" or string[], never a boolean
    if (effectiveRequireApproval !== undefined) obj.requireApproval = effectiveRequireApproval;
    obj.approvalMode = approvalMode;
    if (approvalAnswer) obj.approvalAnswer = approvalAnswer;

    // Extra tools
    if (toolsFiles.length > 0) obj.toolsFiles = toolsFiles;

    // Summarize config
    if (summarizeAt !== undefined) obj.summarizeAt = summarizeAt;
    if (summarizeModel) obj.summarizeModel = summarizeModel;
    if (summarizeKeepRecentTurns !== undefined) obj.summarizeKeepRecentTurns = summarizeKeepRecentTurns;

    // Vision model — pass through to orager which owns vision routing logic
    const _visionModel = asString(config.visionModel, "").trim();
    if (_visionModel) obj.visionModel = _visionModel;

    // Extended agent loop options
    if (tagToolOutputs !== undefined) obj.tagToolOutputs = tagToolOutputs;
    if (planMode) obj.planMode = true;
    if (injectContext) obj.injectContext = true;
    if (Object.keys(bashPolicy).length > 0) obj.bashPolicy = bashPolicy;
    if (trackFileChanges) obj.trackFileChanges = true;
    if (enableBrowserTools) obj.enableBrowserTools = true;
    if (readProjectInstructions !== undefined) obj.readProjectInstructions = readProjectInstructions;
    if (turnModelRules) obj.turnModelRules = turnModelRules;
    if (summarizePrompt) obj.summarizePrompt = summarizePrompt;
    if (summarizeFallbackKeep !== undefined) obj.summarizeFallbackKeep = summarizeFallbackKeep;
    if (webhookUrl) obj.webhookUrl = webhookUrl;
    if (webhookUrl && webhookFormat) obj.webhookFormat = webhookFormat;
    if (hooks) obj.hooks = hooks;
    if (hookTimeoutMs !== undefined) obj.hookTimeoutMs = hookTimeoutMs;
    if (hookErrorMode !== undefined) obj.hookErrorMode = hookErrorMode;
    if (approvalTimeoutMs !== undefined) obj.approvalTimeoutMs = approvalTimeoutMs;
    if (mcpServers) obj.mcpServers = mcpServers;
    if (requireMcpServers && requireMcpServers.length > 0) obj.requireMcpServers = requireMcpServers;
    if (toolTimeouts) obj.toolTimeouts = toolTimeouts;
    if (maxSpawnDepth !== undefined) obj.maxSpawnDepth = maxSpawnDepth;
    if (maxIdenticalToolCallTurns !== undefined) obj.maxIdenticalToolCallTurns = maxIdenticalToolCallTurns;
    if (toolErrorBudgetHardStop) obj.toolErrorBudgetHardStop = true;

    // Multimodal prompt content
    if (promptContent) obj.promptContent = promptContent;

    // Run-level timeout — orager self-terminates via AbortSignal.timeout() when exceeded.
    // The adapter's outer process timeout (timeoutSec + 10s grace) remains as belt-and-suspenders.
    obj.timeoutSec = timeoutSec;

    // Full API key pool — orager rotates through these on 429 errors internally.
    if (apiKeyPool.length > 1) obj.apiKeys = apiKeyPool;

    // Required env vars — pass through so orager also validates (belt-and-suspenders
    // for the spawn path; adapter-level check above handles daemon path).
    if (requiredEnvVars.length > 0) obj.requiredEnvVars = requiredEnvVars;
    if (workspaceRepoUrl) obj.repoUrl = workspaceRepoUrl;

    // Per-agent API key isolation
    const _agentApiKey = asString(config.agentApiKey, "");
    if (_agentApiKey.trim()) obj.agentApiKey = _agentApiKey.trim();

    const _memoryRetrieval = asString(config.memoryRetrieval, "");
    if (_memoryRetrieval === "embedding" || _memoryRetrieval === "fts" || _memoryRetrieval === "local") {
      obj.memoryRetrieval = _memoryRetrieval;
      if (_memoryRetrieval === "embedding") {
        const embModel = asString(config.memoryEmbeddingModel, "");
        if (embModel) obj.memoryEmbeddingModel = embModel;
      }
    }
    const _memoryMaxChars = asNumber(config.memoryMaxChars, 0);
    if (_memoryMaxChars > 0) obj.memoryMaxChars = _memoryMaxChars;

    // Response format (JSON healing)
    const _responseFormat = parseObject(config.responseFormat);
    if (typeof _responseFormat.type === "string" && _responseFormat.type) {
      obj.response_format = _responseFormat;
    }

    return obj;
  };

  const configObj = buildConfigFilePayload();

  // M-27: Write config to a user-private directory instead of world-listable /tmp.
  // ~/.orager/tmp/ is only readable by the current user, preventing filename
  // discovery by other users on multi-tenant systems.
  const privateDir = path.join(os.homedir(), ".orager", "tmp");
  await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
  const configFileName = `orager-config-${crypto.randomBytes(16).toString("hex")}.json`;
  const configFilePath = path.join(privateDir, configFileName);
  let configFileWritten = false;
  try {
    // Create the file with mode 600 (owner read/write only) before writing content
    const fd = await fs.open(configFilePath, "w", 0o600);
    await fd.writeFile(JSON.stringify(configObj), "utf8");
    await fd.close();
    configFileWritten = true;
  } catch (err) {
    // Config file write failed — fall back to individual CLI args is not
    // implemented; surface the error so the caller sees it rather than silently
    // proceeding with no config.
    if (ephemeralSkillsDir) await cleanupOragerSkillsDir(ephemeralSkillsDir.dir);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to write orager config file: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "config_error",
    };
  }

  // Security: block dangerous flags that could bypass security controls, override
  // adapter config, or change the process mode. Must stay in sync with orager CLI
  // flag names. Categories:
  //   • Security bypass:   --dangerously-skip-permissions
  //   • Config override:   --config-file, --settings-file
  //   • Session hijack:    --resume (could load another user's session history)
  //   • Model override:    --model (could redirect conversation to attacker-controlled endpoint)
  //   • Prompt injection:  --system-prompt-file (could inject arbitrary system prompt from disk)
  //   • Output control:    --output-format (adapter controls output format)
  //   • Daemon/proc mode:  --serve, --port, --max-concurrent, --idle-timeout, --allowed-cwd
  //   • Subcommands:       --status, --sessions, --list-sessions, --search-sessions,
  //                        --trash-session, --restore-session, --delete-session,
  //                        --delete-trashed, --rollback-session, --prune-sessions,
  //                        --rotate-key, --clear-model-cache
  const BLOCKED_EXTRA_ARGS = new Set([
    "--dangerously-skip-permissions",
    "--config-file",
    "--settings-file",
    "--resume",
    "--model",
    "--system-prompt-file",
    "--output-format",
    "--serve",
    "--port",
    "--max-concurrent",
    "--idle-timeout",
    "--allowed-cwd",
    "--status",
    "--sessions",
    "--list-sessions",
    "--search-sessions",
    "--trash-session",
    "--restore-session",
    "--delete-session",
    "--delete-trashed",
    "--rollback-session",
    "--prune-sessions",
    "--rotate-key",
    "--clear-model-cache",
  ]);
  // Also catch "--flag=value" variants (e.g. "--config-file=/tmp/evil").
  const blockedFound = extraArgs.filter((a) =>
    [...BLOCKED_EXTRA_ARGS].some(flag => a === flag || a.startsWith(flag + "=")),
  );
  if (blockedFound.length > 0) {
    structuredLog({ level: "error", ts: Date.now(), event: "blocked_extra_args", agentId: agent.id, runId, message: `config.extraArgs contains forbidden flags: ${blockedFound.join(", ")}` });
    if (configFileWritten) await fs.unlink(configFilePath).catch(() => {}); if (ephemeralSkillsDir) await cleanupOragerSkillsDir(ephemeralSkillsDir.dir);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `config.extraArgs contains forbidden flags: ${blockedFound.join(", ")}. These flags bypass security controls and are not permitted.`,
      errorCode: "config_error",
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
    PROTOCOL_API_KEY: apiKey,
    OPENROUTER_API_KEY: apiKey,
    ORAGER_API_KEY: apiKey,
  };
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  for (const [k, v] of Object.entries(configEnv)) {
    if (typeof v === "string") env[k] = v;
  }

  // ── OpenTelemetry passthrough ─────────────────────────────────────────────
  // Config-level OTEL overrides (otelEndpoint, otelServiceName, otelResourceAttributes)
  // take precedence over process.env values so the caller can control tracing
  // without changing the server environment. process.env OTEL vars are inherited
  // automatically via the process.env spread below.
  const otelEndpoint = typeof config.otelEndpoint === "string" ? config.otelEndpoint.trim() : "";
  const otelServiceName = typeof config.otelServiceName === "string" ? config.otelServiceName.trim() : "";
  const otelResourceAttrs = typeof config.otelResourceAttributes === "string" ? config.otelResourceAttributes.trim() : "";
  if (otelEndpoint) env.OTEL_EXPORTER_OTLP_ENDPOINT = otelEndpoint;
  if (otelServiceName) env.OTEL_SERVICE_NAME = otelServiceName;
  if (otelResourceAttrs) env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttrs;

  // Merge with process.env and ensure PATH is populated
  const effectiveEnv = ensurePathInEnv({ ...(process.env as Record<string, string>), ...env });

  // ── Dry-run mode ────────────────────────────────────────────────────────────
  if (dryRun) {
    // Clean up the config file written above — no subprocess will delete it for us
    if (configFileWritten) await fs.unlink(configFilePath).catch(() => {}); if (ephemeralSkillsDir) await cleanupOragerSkillsDir(ephemeralSkillsDir.dir);
    structuredLog({ level: "info", ts: Date.now(), event: "dry_run", agentId: agent.id, runId, model: effectiveModel });
    void onLog("stderr", "[openrouter adapter] DRY RUN — no API calls will be made\n");
    void onLog("stderr", `[openrouter adapter] model: ${effectiveModel}, session: ${previousSessionId || "new"}, cwd: ${cwd}\n`);
    void onLog("stderr", `[openrouter adapter] prompt (${prompt.length} chars): ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "[dry-run] no agent run executed",
      resultJson: { result: "[dry-run]", subtype: "success", sessionId: "", totalCostUsd: 0 },
    };
  }

  const runStartMs = Date.now();
  structuredLog({ level: "info", ts: runStartMs, event: "run_start", agentId: agent.id, runId, model: effectiveModel });

  // ── onMeta ─────────────────────────────────────────────────────────────────
  if (onMeta) {
    await onMeta({
      adapterType: "openrouter-cli",
      command: cliPath,
      cwd,
      commandArgs: args,
      commandNotes: [
        `model: ${effectiveModel}`,
        `maxTurns: ${maxTurns}`,
        previousSessionId ? `resume: ${previousSessionId}` : "new session",
        ...(safeInstructionsFilePath
          ? [`instructions: ${safeInstructionsFilePath}`]
          : []),
        ...(visionFallbackNote ? [visionFallbackNote] : []),
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

  // ── Daemon fast-path ────────────────────────────────────────────────────────
  // By default, route runs through the persistent orager daemon for better
  // performance (no Node.js startup overhead) and visibility (runs appear in
  // the orager dashboard). Falls back to the spawn path if no daemon is found.
  // Auto-detects the daemon by reading ~/.orager/daemon.port when no explicit
  // URL is configured.
  const DAEMON_PORT_FILE = path.join(os.homedir(), ".orager", "daemon.port");
  let _rawDaemonUrl =
    asString(config.daemonUrl, "") || process.env.ORAGER_DAEMON_URL || "";
  if (!_rawDaemonUrl) {
    try {
      const portStr = await fs.readFile(DAEMON_PORT_FILE, "utf8");
      const port = parseInt(portStr.trim(), 10);
      if (!isNaN(port) && port > 0) {
        _rawDaemonUrl = `http://127.0.0.1:${port}`;
      }
    } catch {
      // No port file — daemon not running, will fall through to spawn path
    }
  }
  // Security: reject non-loopback daemon URLs to prevent SSRF. The daemon binds
  // to 127.0.0.1 by design and should never be reached via an external address.
  const daemonBaseUrl = (() => {
    if (!_rawDaemonUrl) return "";
    try {
      const u = new URL(_rawDaemonUrl);
      const host = u.hostname.toLowerCase();
      const isLoopback = isLoopbackHost(host);
      if (!isLoopback) {
        void onLog("stderr", `[openrouter adapter] WARNING: ignoring non-loopback daemonUrl '${_rawDaemonUrl}' — daemon must be on localhost\n`);
        return "";
      }
    } catch {
      void onLog("stderr", `[openrouter adapter] WARNING: ignoring invalid daemonUrl '${_rawDaemonUrl}'\n`);
      return "";
    }
    return _rawDaemonUrl;
  })();

  if (daemonBaseUrl) {
    if (isDaemonCircuitOpen(daemonBaseUrl)) {
      void onLog("stderr", `[openrouter adapter] daemon circuit breaker open — falling back to spawn\n`);
      structuredLog({ level: "warn", ts: Date.now(), event: "daemon_circuit_open", agentId: agent.id, runId });
    } else {
    const daemonKeyFilePath = asString(config.daemonKeyFile ?? config.daemonKeyPath, "").trim();
    let signingKey = await readDaemonSigningKey(onLog, daemonKeyFilePath || undefined);
    let alive = signingKey ? await isDaemonAlive(daemonBaseUrl) : false;

    if (!alive) {
      alive = await tryAutoStartDaemon(daemonBaseUrl, cliPath, apiKey, effectiveEnv, onLog, daemonAutoStart);
      if (alive) {
        // Re-read signing key in case it was just generated
        signingKey = await readDaemonSigningKey(onLog, daemonKeyFilePath || undefined);
      }
    }

    if (alive && signingKey) {
      // Build opts for daemon path — parallel to buildConfigFilePayload above.
      // Uses the same extracted variables but structures provider/reasoning as
      // nested objects (DaemonRunOpts shape) instead of flat config-file fields.
      const buildDaemonRunOpts = async (): Promise<DaemonRunOpts> => {
        const _responseFormat = parseObject(config.responseFormat);
        return {
          // apiKey is daemon-side only — not sent per-request
          model: effectiveModel,
          models: models.length > 0 ? models : undefined,
          sessionId: previousSessionId || null,
          addDirs,
          maxTurns: maxTurns > 0 ? maxTurns : 0,
          maxRetries,
          cwd,
          forceResume: forceResume || undefined,
          verbose: false,
          useFinishTool,
          profile: profile || undefined,
          settingsFile: settingsFile || undefined,
          siteUrl: siteUrl || undefined,
          siteName: siteName || undefined,
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
          // Only send reasoning when effort or max_tokens is set.
          // Sending reasoning: { exclude: true } alone causes require_parameters
          // to filter out providers for non-reasoning models (404).
          reasoning: (reasoningEffort || reasoningMaxTokens)
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
          maxCostUsdSoft,
          costPerInputToken,
          costPerOutputToken,
          summarizeAt,
          summarizeModel: summarizeModel || undefined,
          summarizeKeepRecentTurns,
          // visionModel is daemon-side config — not sent per-request
          tagToolOutputs,
          planMode: planMode || undefined,
          injectContext: injectContext || undefined,
          trackFileChanges: trackFileChanges || undefined,
          enableBrowserTools: enableBrowserTools || undefined,
          readProjectInstructions,
          turnModelRules,
          summarizePrompt,
          summarizeFallbackKeep,
          webhookUrl,
          webhookFormat: (webhookUrl && webhookFormat) ? webhookFormat : undefined,
          hooks,
          hookTimeoutMs,
          hookErrorMode,
          approvalTimeoutMs,
          mcpServers,
          requireMcpServers: requireMcpServers && requireMcpServers.length > 0 ? requireMcpServers : undefined,
          toolTimeouts,
          maxSpawnDepth,
          maxIdenticalToolCallTurns,
          toolErrorBudgetHardStop,
          appendSystemPrompt: instructionsFileContent,
          promptContent: promptContent ?? undefined,
          // approvalMode is daemon-side config — not sent per-request
          ...(approvalAnswer ? { approvalAnswer } : {}),
          ...(typeof _responseFormat.type === "string" && _responseFormat.type ? { response_format: _responseFormat } : {}),
          timeoutSec,
          ...(apiKeyPool.length > 1 ? { apiKeys: apiKeyPool } : {}),
          ...(requiredEnvVars.length > 0 ? { requiredEnvVars } : {}),
          ...(asString(config.agentApiKey, "").trim() ? { agentApiKey: asString(config.agentApiKey, "").trim() } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(["embedding", "fts", "local"].includes(asString(config.memoryRetrieval, ""))
            ? {
                memoryRetrieval: asString(config.memoryRetrieval, "") as "embedding" | "fts" | "local",
                ...(asString(config.memoryRetrieval, "") === "embedding" && asString(config.memoryEmbeddingModel, "")
                  ? { memoryEmbeddingModel: asString(config.memoryEmbeddingModel, "") }
                  : {}),
              }
            : {}),
          ...(asNumber(config.memoryMaxChars, 0) > 0 ? { memoryMaxChars: asNumber(config.memoryMaxChars, 0) } : {}),
          ...(asNumber(config.memoryRetrievalThreshold, -1) >= 0 ? { memoryRetrievalThreshold: asNumber(config.memoryRetrievalThreshold, 0) } : {}),
          // ── Per-run env injection ──────────────────────────────────────────
          // The daemon process doesn't have Paperclip context vars in its env.
          // Pass PAPERCLIP_* vars (and any user-configured configEnv vars) so
          // the agent can authenticate and use Paperclip skills (list-issues,
          // get-task, post-comment, etc.) when running via the daemon path.
          env: (() => {
            const daemonEnv: Record<string, string> = {};
            // All PAPERCLIP_* vars from the constructed env (includes paperclipEnv,
            // contextEnv, PAPERCLIP_RUN_ID, and PAPERCLIP_API_KEY if authToken set)
            for (const [k, v] of Object.entries(env)) {
              if (k.startsWith("PAPERCLIP_")) daemonEnv[k] = v;
            }
            // User-configured env vars from config.env (arbitrary custom vars)
            for (const [k, v] of Object.entries(configEnv)) {
              if (typeof v === "string" && !k.startsWith("PAPERCLIP_")) daemonEnv[k] = v;
            }
            return Object.keys(daemonEnv).length > 0 ? daemonEnv : undefined;
          })(),
        };
      };
      const daemonOpts = await buildDaemonRunOpts();

      const daemonResult = await executeViaDaemon(
        daemonBaseUrl,
        signingKey,
        effectiveAgentId,
        runId,
        prompt,
        promptContent,
        daemonOpts,
        timeoutSec,
        onLog,
      );
      if (daemonResult !== null) {
        structuredLog({
          level: "info",
          ts: Date.now(),
          event: "run_complete",
          agentId: agent.id,
          runId,
          model: effectiveModel,
          resolvedModel: daemonResult.model ?? undefined,
          durationMs: Date.now() - runStartMs,
          inputTokens: daemonResult.usage?.inputTokens,
          outputTokens: daemonResult.usage?.outputTokens,
          cachedInputTokens: daemonResult.usage?.cachedInputTokens,
          cacheWriteInputTokens: typeof (daemonResult.resultJson as Record<string, unknown> | undefined)?.cacheWriteInputTokens === "number" ? (daemonResult.resultJson as Record<string, unknown>).cacheWriteInputTokens as number : undefined,
          cacheHitRatio: typeof (daemonResult.resultJson as Record<string, unknown> | undefined)?.cacheHitRatio === "number" ? (daemonResult.resultJson as Record<string, unknown>).cacheHitRatio as number : undefined,
          costUsd: daemonResult.costUsd ?? undefined,
          turnCount: typeof (daemonResult.resultJson as Record<string, unknown> | undefined)?.turnCount === "number" ? (daemonResult.resultJson as Record<string, unknown>).turnCount as number : undefined,
          subtype: typeof (daemonResult.resultJson as Record<string, unknown> | undefined)?.subtype === "string" ? (daemonResult.resultJson as Record<string, unknown>).subtype as string : undefined,
        });
        recordDaemonSuccess(daemonBaseUrl);
        if (configFileWritten) {
          await fs.unlink(configFilePath).catch(() => {});
        }
        if (ephemeralSkillsDir) await cleanupOragerSkillsDir(ephemeralSkillsDir.dir);
        // Augment session params with workspace metadata to match the spawn path
        if (daemonResult.sessionParams) {
          daemonResult.sessionParams = {
            ...daemonResult.sessionParams,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          };
        }
        return daemonResult;
      }
      // null = daemon at capacity after retry — fall through to spawn
      recordDaemonFailure(daemonBaseUrl);
      structuredLog({ level: "warn", ts: Date.now(), event: "daemon_fallback", agentId: agent.id, runId, message: "Daemon unavailable, falling back to spawn" });
      void onLog("stderr", `[openrouter adapter] daemon at capacity after retry — falling back to spawn\n`);
    } else {
      structuredLog({ level: "warn", ts: Date.now(), event: "daemon_fallback", agentId: agent.id, runId, message: "Daemon unavailable, falling back to spawn" });
      void onLog("stderr", `[openrouter adapter] daemon at ${daemonBaseUrl} unreachable — falling back to spawn\n`);
    }
    } // end circuit-breaker else
  }

  // ── Validate command before spawning ───────────────────────────────────────
  try {
    await ensureCommandResolvable(cliPath, cwd, effectiveEnv);
  } catch (err) {
    // Clean up the config file since we won't be spawning orager to delete it
    if (configFileWritten) {
      await fs.unlink(configFilePath).catch(() => {});
    }
    // M-25: Clean up ephemeral skills directory — was previously orphaned here
    if (ephemeralSkillsDir) await cleanupOragerSkillsDir(ephemeralSkillsDir.dir);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Cannot find orager CLI "${cliPath}": ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "cli_not_found",
    };
  }

  // ── Spawn orager ───────────────────────────────────────────────────────────
  // detached: true — puts orager in its own process group so that on timeout
  // we can send SIGTERM/SIGKILL to the entire group (orager + any subprocesses
  // it spawned, e.g. bash commands) via process.kill(-(proc.pid!), signal).
  // Without detached the kill would only reach orager itself, leaving bash
  // children as orphans.
  //
  // proc.unref() — allows the Node.js event loop to exit even if orager is still
  // running. This is intentional: if Paperclip restarts or the adapter process
  // is killed while a run is in flight, the orphaned orager will continue until
  // its own timeout fires. The alternative (keeping Node alive) is worse for
  // Paperclip availability. The timeout + grace SIGKILL is the cleanup path.
  return new Promise<AdapterExecutionResult>((resolve) => {
    let settled = false;
    function settle(r: AdapterExecutionResult): void {
      if (settled) return;
      settled = true;
      resolve(r);
    }
    let proc: ReturnType<typeof spawn>;
    try {
      // ── OS resource limits (audit N-01) ─────────────────────────────────
      // Wrap the spawn in a shell with ulimit to cap memory and CPU time.
      // Configurable via ORAGER_CLI_MEM_LIMIT_KB (default 4GB) and
      // ORAGER_CLI_CPU_LIMIT_SECS (default unlimited = 0).
      const _rawMemLimit = process.env["ORAGER_CLI_MEM_LIMIT_KB"];
      const memLimitKb = _rawMemLimit !== undefined ? parseInt(_rawMemLimit, 10) : 4 * 1024 * 1024;
      const cpuLimitSecs = parseInt(process.env["ORAGER_CLI_CPU_LIMIT_SECS"] ?? "", 10) || 0;
      const platform = process.platform;
      let spawnCmd: string;
      let spawnArgs: string[];
      if (platform === "darwin" || platform === "linux") {
        // ulimit -v (virtual memory) is only supported on Linux.
        // macOS (Darwin) does not support it and returns "Invalid argument".
        const ulimits: string[] = [];
        if (platform === "linux" && memLimitKb > 0) ulimits.push(`ulimit -v ${memLimitKb}`);
        if (cpuLimitSecs > 0) ulimits.push(`ulimit -t ${cpuLimitSecs}`);
        const quotedArgs = args.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
        spawnCmd = "bash";
        // R-08: Escape cliPath to prevent command injection via malicious config values.
        // Without this, a cliPath like "orager; curl evil.com" would execute arbitrary commands.
        const escapedCliPath = `'${cliPath.replace(/'/g, "'\\''")}'`;
        const prefix = ulimits.length > 0 ? `${ulimits.join(" && ")} && ` : "";
        spawnArgs = ["-c", `${prefix}exec ${escapedCliPath} ${quotedArgs}`];
      } else {
        spawnCmd = cliPath;
        spawnArgs = args;
      }
      proc = spawn(spawnCmd, spawnArgs, {
        cwd,
        env: effectiveEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      proc.unref();
    } catch (spawnErr) {
      // Clean up temp files on spawn failure — orager won't get to delete them
      fs.unlink(configFilePath).catch(() => {});
      if (ephemeralSkillsDir) void cleanupOragerSkillsDir(ephemeralSkillsDir.dir);
      settle({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to spawn ${cliPath}: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
        errorCode: "spawn_error",
      });
      return;
    }

    // Write prompt to stdin.
    // Attach an error handler before writing — on Linux, EPIPE from a process
    // that closes stdin early surfaces as an async 'error' event on the stream,
    // not a thrown exception. Without this listener it becomes an unhandled error.
    proc.stdin?.on("error", (stdinErr: NodeJS.ErrnoException) => {
      if (stdinErr.code !== "EPIPE") {
        void onLog("stderr", `[openrouter adapter] WARNING: stdin error (${stdinErr.message}) — orager may not have received the prompt\n`);
      }
    });
    try {
      proc.stdin?.write(prompt, "utf8");
      proc.stdin?.end();
    } catch (stdinErr) {
      // stdin write failure (e.g. EPIPE) — log so operators can diagnose
      void onLog("stderr", `[openrouter adapter] WARNING: stdin write failed (${stdinErr instanceof Error ? stdinErr.message : String(stdinErr)}) — orager may not have received the prompt\n`);
    }

    const spawnStreamState: OragerStreamState = {
      sessionId: "",
      resolvedModel: "",
      sessionLost: false,
      resultEvent: null,
      questionEvent: null,
    };
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        // Kill the entire process group to clean up orager subprocesses
        try {
          if (proc.pid != null) {
            process.kill(-proc.pid, "SIGTERM");
          } else {
            proc.kill("SIGTERM");
          }
        } catch {
          try { proc.kill("SIGTERM"); } catch { /* M-19: process may have already exited */ }
        }
        // Force kill after grace period if the process doesn't exit on its own
        if (graceSec > 0) {
          graceTimer = setTimeout(() => {
            try {
              if (proc.pid != null) {
                process.kill(-proc.pid, "SIGKILL");
              } else {
                proc.kill("SIGKILL");
              }
            } catch {
              try { proc.kill("SIGKILL"); } catch { /* M-19: process may have already exited */ }
            }
          }, graceSec * 1000);
        }
      }, timeoutSec * 1000);
    }

    // Read stdout line by line and stream to Paperclip.
    // Cap the in-memory buffer to prevent OOM from runaway binary output.
    const MAX_STDOUT_BUFFER_BYTES = 1 * 1024 * 1024; // 1 MB per partial line
    // Total response body cap (audit N-02) — abort if response exceeds limit.
    const MAX_TOTAL_RESPONSE_BYTES = parseInt(process.env["ORAGER_MAX_RESPONSE_BYTES"] ?? "", 10) || 50 * 1024 * 1024;
    let totalResponseBytes = 0;
    let responseTruncated = false;
    let stdoutBuffer = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      const chunkLen = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      totalResponseBytes += chunkLen;
      if (totalResponseBytes > MAX_TOTAL_RESPONSE_BYTES && !responseTruncated) {
        responseTruncated = true;
        void onLog("stderr",
          `[openrouter adapter] response exceeded ${MAX_TOTAL_RESPONSE_BYTES} bytes — killing process\n`
        );
        try {
          if (proc.pid != null) process.kill(-proc.pid, "SIGTERM");
          else proc.kill("SIGTERM");
        } catch { try { proc.kill("SIGTERM"); } catch { /* M-19: process may have already exited */ } }
        return;
      }
      if (responseTruncated) return;
      stdoutBuffer +=
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
        void onLog("stderr",
          `[openrouter adapter] stdout line exceeded ${MAX_STDOUT_BUFFER_BYTES} bytes — discarding oversized line\n`
        );
        // Drop to next newline to resync the parser
        const nextNl = stdoutBuffer.indexOf("\n", MAX_STDOUT_BUFFER_BYTES);
        stdoutBuffer = nextNl >= 0 ? stdoutBuffer.slice(nextNl + 1) : "";
      }
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void onLog("stdout", line + "\n");
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processOragerEvent(event, spawnStreamState, onLog, () => {
            structuredLog({ level: "warn", ts: Date.now(), event: "session_not_found", agentId: agent.id, runId, sessionId: previousSessionId ?? undefined });
          });
        } catch {
          // non-JSON lines are fine — tool output, bash stdout, etc.
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      void onLog("stderr", text);
    });

    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);

      // Flush any partial line remaining in the buffer
      if (stdoutBuffer.trim()) {
        void onLog("stdout", stdoutBuffer + "\n");
        try {
          const event = JSON.parse(stdoutBuffer) as Record<string, unknown>;
          processOragerEvent(event, spawnStreamState, onLog, () => {
            structuredLog({ level: "warn", ts: Date.now(), event: "session_not_found", agentId: agent.id, runId, sessionId: previousSessionId ?? undefined });
          });
        } catch {
          // ok
        }
      }

      if (timedOut) {
        // Clean up config temp file containing API keys (audit B-05)
        if (configFilePath) {
          fs.unlink(configFilePath).catch(() => {});
        }
        if (ephemeralSkillsDir) {
          fs.rm(ephemeralSkillsDir.dir, { recursive: true, force: true }).catch(() => {});
        }
        settle({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          errorMessage: `Agent loop timed out after ${timeoutSec}s`,
          errorCode: "timeout",
        });
        return;
      }

      const { resultEvent, sessionId, resolvedModel, sessionLost, questionEvent } = spawnStreamState;

      if (!resultEvent) {
        settle({
          exitCode: code ?? 1,
          signal: signal ?? null,
          timedOut: false,
          errorMessage: `orager exited without a result event (exit code ${code ?? "null"})`,
          errorCode: "no_result",
        });
        return;
      }

      const hasCostField = typeof resultEvent.total_cost_usd === "number";
      if (!hasCostField) {
        void onLog("stderr",
          "[openrouter adapter] WARNING: result event missing total_cost_usd — cost will be reported as $0\n"
        );
        structuredLog({
          level: "warn",
          ts: Date.now(),
          event: "missing_cost_data",
          agentId: agent.id,
          runId,
          message: "result event missing total_cost_usd field",
        });
      }

      const spawnResult = buildAdapterResult({
        resultEvent,
        sessionId,
        resolvedModel,
        sessionLost,
        cwd,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        exitCode: code,
        signal: null,
      });

      // Apply question event
      const finalResult: AdapterExecutionResult = {
        ...spawnResult,
        question: questionEvent
          ? { prompt: questionEvent.prompt, choices: questionEvent.choices }
          : null,
      };

      structuredLog({
        level: "info",
        ts: Date.now(),
        event: "run_complete",
        agentId: agent.id,
        runId,
        model: effectiveModel,
        resolvedModel: resolvedModel || undefined,
        durationMs: Date.now() - runStartMs,
        inputTokens: spawnResult.usage?.inputTokens,
        outputTokens: spawnResult.usage?.outputTokens,
        cachedInputTokens: spawnResult.usage?.cachedInputTokens,
        cacheWriteInputTokens: typeof spawnResult.resultJson?.cacheWriteInputTokens === "number" ? spawnResult.resultJson.cacheWriteInputTokens : undefined,
        cacheHitRatio: typeof spawnResult.resultJson?.cacheHitRatio === "number" ? spawnResult.resultJson.cacheHitRatio : undefined,
        costUsd: spawnResult.costUsd ?? 0,
        turnCount: typeof spawnResult.resultJson?.turnCount === "number" ? spawnResult.resultJson.turnCount : undefined,
        subtype: typeof spawnResult.resultJson?.subtype === "string" ? spawnResult.resultJson.subtype : undefined,
      });
      // Clean up ephemeral skills dir now that the run is complete
      if (ephemeralSkillsDir) void cleanupOragerSkillsDir(ephemeralSkillsDir.dir);
      settle(finalResult);
    });

    proc.on("error", (err: Error) => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      // Clean up config temp file containing API keys (audit B-05)
      if (configFilePath) {
        fs.unlink(configFilePath).catch(() => {});
      }
      if (ephemeralSkillsDir) {
        fs.rm(ephemeralSkillsDir.dir, { recursive: true, force: true }).catch(() => {});
      }
      settle({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to start orager: ${err.message}`,
        errorCode: "spawn_error",
      });
    });
  });
}

// ── Test helpers (exported for unit tests only) ───────────────────────────────
export function _resetStateForTesting(): void {
  _daemonCircuitState.clear();
  _lastAutoStartAttemptMs = 0;
  _structuredLogBuffer.clear();
  _skillsDirChecked = false;
  _skillsDirValid = false;
  _resetModelCacheForTesting();
}

/** Drain and return all structured log entries captured since the last reset. */
export function _drainStructuredLogForTesting(): StructuredLogEntry[] {
  const entries = _structuredLogBuffer.toArray();
  _structuredLogBuffer.clear();
  return entries;
}
export {
  buildApiKeyPool,
  DEFAULT_MODEL,
  DAEMON_KEY_PATH,
  DAEMON_KEY_MAX_AGE_MS,
  isDaemonCircuitOpen,
  recordDaemonFailure,
  recordDaemonSuccess,
  DAEMON_CB_THRESHOLD,
  DAEMON_CB_RESET_MS,
  buildAdapterResult,
  processRateLimitTracker,
  _lastAutoStartAttemptMs,
  AUTO_START_COOLDOWN_MS,
};

