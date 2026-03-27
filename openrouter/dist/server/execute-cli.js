import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { mintDaemonJwt } from "./jwt-utils.js";
// ── Structured logging ────────────────────────────────────────────────────────
// When ORAGER_LOG_FILE is set, JSON structured log lines are appended to that
// file in addition to the normal human-readable stderr output.
const STRUCTURED_LOG_FILE = process.env.ORAGER_LOG_FILE ?? "";
function structuredLog(entry) {
    if (!STRUCTURED_LOG_FILE)
        return;
    try {
        appendFileSync(STRUCTURED_LOG_FILE, JSON.stringify({ ...entry, ts: entry.ts }) + "\n");
    }
    catch { /* never fail a run due to log write error */ }
}
// ── Cost anomaly detection ────────────────────────────────────────────────────
// Module-level rolling window shared across all runs in this process.
// Resets on process restart. Zero-cost runs (dry-run, free-tier) are excluded.
const COST_WINDOW_SIZE = 20;
const _costWindow = [];
function recordRunCost(costUsd) {
    if (costUsd <= 0)
        return;
    _costWindow.push(costUsd);
    if (_costWindow.length > COST_WINDOW_SIZE)
        _costWindow.shift();
}
function checkCostAnomaly(costUsd, agentId, runId, onLog) {
    if (_costWindow.length < 3)
        return;
    const avg = _costWindow.reduce((a, b) => a + b, 0) / _costWindow.length;
    if (avg > 0 && costUsd > avg * 2) {
        const multiplier = (costUsd / avg).toFixed(1);
        const msg = `[openrouter adapter] COST ANOMALY: run cost $${costUsd.toFixed(4)} is ` +
            `>${multiplier}x the rolling average ($${avg.toFixed(4)}, window=${_costWindow.length} runs)\n`;
        void onLog("stderr", msg);
        structuredLog({
            level: "warn",
            ts: Date.now(),
            event: "cost_anomaly",
            agentId,
            runId,
            costUsd,
            rollingAvgCostUsd: avg,
            windowSize: _costWindow.length,
        });
    }
}
// ── API key pool ──────────────────────────────────────────────────────────────
// Collects all configured API keys (primary + apiKeys array) and returns the
// full pool so orager can rotate through them internally on 429 errors.
// Key rotation is handled by orager's callWithRetry — not the adapter.
function buildApiKeyPool(config) {
    const extra = Array.isArray(config.apiKeys)
        ? config.apiKeys.filter((k) => typeof k === "string" && k.trim().length > 0)
        : [];
    const primary = (typeof config.apiKey === "string" ? config.apiKey.trim() : "") || (process.env.OPENROUTER_API_KEY ?? "");
    const pool = primary && !extra.includes(primary) ? [primary, ...extra] : extra.length > 0 ? extra : [primary];
    return { primary, pool };
}
// ── Daemon circuit breaker (per daemon URL) ────────────────────────────────
// Tracks consecutive daemon failures per daemon URL. After DAEMON_CB_THRESHOLD
// consecutive failures, that daemon is bypassed for DAEMON_CB_RESET_MS ms.
// Keyed by daemon base URL so multiple daemon instances don't interfere.
const DAEMON_CB_THRESHOLD = 3;
const DAEMON_CB_RESET_MS = 60_000; // 1 minute
const _daemonCircuitState = new Map();
function isDaemonCircuitOpen(url) {
    const state = _daemonCircuitState.get(url);
    if (!state || state.failures < DAEMON_CB_THRESHOLD)
        return false;
    if (Date.now() - state.openedAt >= DAEMON_CB_RESET_MS) {
        // Reset to half-open — allow one probe
        state.failures = DAEMON_CB_THRESHOLD - 1;
        return false;
    }
    return true;
}
function recordDaemonSuccess(url) {
    _daemonCircuitState.delete(url);
}
function recordDaemonFailure(url) {
    const state = _daemonCircuitState.get(url) ?? { failures: 0, openedAt: 0 };
    state.failures++;
    if (state.failures >= DAEMON_CB_THRESHOLD)
        state.openedAt = Date.now();
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
async function readDaemonSigningKey(onLog) {
    try {
        const [key, stat] = await Promise.all([
            fs.readFile(DAEMON_KEY_PATH, "utf8"),
            fs.stat(DAEMON_KEY_PATH),
        ]);
        const trimmed = key.trim();
        if (!trimmed)
            return null;
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > DAEMON_KEY_MAX_AGE_MS && onLog && !_daemonKeyAgeWarningEmitted) {
            _daemonKeyAgeWarningEmitted = true;
            const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
            void onLog("stderr", `[openrouter adapter] WARNING: daemon signing key at ${DAEMON_KEY_PATH} is ${ageDays} days old. ` +
                `Consider rotating it (delete the file and restart the daemon to generate a new key).\n`);
        }
        return trimmed;
    }
    catch {
        return null;
    }
}
// mintDaemonJwt is imported from ./jwt-utils.js
async function isDaemonAlive(baseUrl) {
    try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok)
            return false;
        const body = await res.json();
        return body.status === "ok";
    }
    catch {
        return false;
    }
}
/**
 * Attempt to auto-start the orager daemon if ORAGER_DAEMON_AUTOSTART=true
 * is set in the environment. Spawns orager --serve detached and polls
 * /health until it responds (up to 5s). Non-fatal — falls through to spawn
 * if start fails.
 */
async function tryAutoStartDaemon(daemonUrl, cliPath, apiKey, env, onLog) {
    if (process.env.ORAGER_DAEMON_AUTOSTART !== "true")
        return false;
    // Extract port from URL
    let port = 3456;
    try {
        port = parseInt(new URL(daemonUrl).port, 10) || 3456;
    }
    catch { /* use default */ }
    try {
        await ensureCommandResolvable(cliPath, process.cwd(), env);
    }
    catch {
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
        await new Promise((r) => setTimeout(r, 300));
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
import { asString, asNumber, asBoolean, parseObject, buildPaperclipEnv, renderTemplate, joinPromptSections, } from "@paperclipai/adapter-utils/server-utils";
// ── Local utility shims ───────────────────────────────────────────────────────
// These mirror functions in newer versions of @paperclipai/adapter-utils that
// may not yet be exported in the installed version.
/**
 * Wrap asNumber to reject NaN and Infinity, falling back to `defaultVal`.
 * Prevents garbage config values (e.g. temperature: Infinity, maxTurns: NaN)
 * from propagating into orager where they may cause undefined behavior.
 */
function safeNumber(value, defaultVal) {
    const n = asNumber(value, defaultVal);
    return Number.isFinite(n) ? n : defaultVal;
}
/**
 * Read a fetch Response body up to `maxBytes`, then cancel the stream.
 * Prevents OOM when a malicious or buggy server sends a huge error body.
 */
async function readBodyCapped(response, maxBytes = 4096) {
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done || !value)
                break;
            chunks.push(value);
            total += value.byteLength;
            if (total >= maxBytes)
                break;
        }
    }
    finally {
        reader.cancel().catch(() => { });
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return new TextDecoder().decode(buf);
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((v) => typeof v === "string" && v.trim().length > 0);
}
const SENSITIVE_KEY_RE = /(?:key|token|secret|password|credential|auth|bearer|api_key)/i;
function redactEnvForLogs(env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? "[REDACTED]" : v;
    }
    return out;
}
async function ensureAbsoluteDirectory(dir, opts = {}) {
    if (!path.isAbsolute(dir)) {
        throw new Error(`Directory must be an absolute path: ${dir}`);
    }
    try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) {
            throw new Error(`Path exists but is not a directory: ${dir}`);
        }
    }
    catch (err) {
        if (err.code === "ENOENT" && opts.createIfMissing) {
            await fs.mkdir(dir, { recursive: true });
        }
        else {
            throw err;
        }
    }
}
async function ensureCommandResolvable(command, cwd, env) {
    // If the command contains a path separator it's an explicit path — just check it exists
    if (command.includes("/") || command.includes("\\")) {
        try {
            await fs.access(command, fsConstants.X_OK);
        }
        catch {
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
        }
        catch {
            // try next
        }
    }
    throw new Error(`Command "${command}" not found in PATH (cwd: ${cwd}). Install it or set cliPath in the adapter config.`);
}
function ensurePathInEnv(env) {
    if (env.PATH)
        return env;
    // Fallback: inherit PATH from process.env
    return { ...env, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
}
/**
 * Check that all required environment variable names are present and non-empty.
 * Returns an array of missing variable names.
 */
function checkRequiredEnvVars(required, env) {
    if (!Array.isArray(required))
        return [];
    return required.filter((v) => typeof v === "string" && v.trim().length > 0 && !env[v.trim()]);
}
/**
 * Execute an agent run by POSTing to the orager daemon.
 * Returns the same AdapterExecutionResult shape as the spawn path.
 */
async function executeViaDaemon(baseUrl, signingKey, agentId, prompt, promptContent, daemonOpts, timeoutSec, onLog, maxCostUsdSoft) {
    const token = mintDaemonJwt(signingKey, agentId);
    const tokenMintedAt = Date.now();
    /** Re-mint if more than 12 minutes have passed (leaves 3-min buffer before 15-min expiry). */
    function freshToken() {
        return Date.now() - tokenMintedAt > 12 * 60 * 1000
            ? mintDaemonJwt(signingKey, agentId)
            : token;
    }
    let response;
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
    }
    catch (err) {
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
        // Respect Retry-After header (max 30s wait) then retry the daemon once.
        // If still saturated after the retry, return null to trigger spawn fallback (#1).
        const retryAfterSec = Math.min(Math.max(parseInt(response.headers.get("Retry-After") ?? "5", 10) || 5, 1), 30);
        structuredLog({ level: "warn", ts: Date.now(), event: "daemon_retry", agentId, runId: "", message: `Daemon at capacity, retrying in ${retryAfterSec}s` });
        void onLog("stderr", `[openrouter adapter] daemon at capacity — retrying in ${retryAfterSec}s\n`);
        await new Promise((r) => setTimeout(r, Math.min(retryAfterSec * 1000, 4 * 60 * 1000)));
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
        }
        catch {
            // Retry network failure — fall back to spawn
            return null;
        }
        if (response.status === 503) {
            // Still at capacity after retry — fall back to spawn
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
    let resultEvent = null;
    let questionEvent = null;
    let sessionId = "";
    let resolvedModel = "";
    let sessionLost = false;
    let buffer = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        // Guard against a single massive line consuming unbounded memory
        if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
            const nextNewline = buffer.indexOf("\n", MAX_STREAM_BUFFER_BYTES);
            const discarded = nextNewline >= 0 ? buffer.slice(0, nextNewline) : buffer;
            // Check if the oversized segment contains critical events before discarding
            if (discarded.includes('"type":"result"') || discarded.includes('"type":"question"')) {
                void onLog("stderr", `[openrouter adapter] WARNING: oversized stream segment (~${discarded.length} bytes) may contain a result/question event — attempting to parse\n`);
                // Try to extract and process the critical event from the oversized line
                const criticalMatch = discarded.match(/\{"type":"(?:result|question)"[^\n]*/);
                if (criticalMatch) {
                    try {
                        const event = JSON.parse(criticalMatch[0]);
                        if (event.type === "result")
                            resultEvent = event;
                    }
                    catch { /* best effort */ }
                }
            }
            else {
                void onLog("stderr", `[openrouter adapter] daemon stream segment exceeded ${MAX_STREAM_BUFFER_BYTES} bytes — discarding oversized segment\n`);
            }
            // Skip forward to the next newline to resync the parser
            buffer = nextNewline >= 0 ? buffer.slice(nextNewline + 1) : "";
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim())
                continue;
            void onLog("stdout", line + "\n");
            try {
                const event = JSON.parse(line);
                if (event.type === "system" && typeof event.session_id === "string") {
                    sessionId = event.session_id;
                    if (typeof event.model === "string")
                        resolvedModel = event.model;
                }
                if (event.type === "result")
                    resultEvent = event;
                // Keep the first question event — if multiple are emitted, the first is the
                // one awaiting a response; later ones arrive after the daemon has resumed.
                if (event.type === "question" && !questionEvent) {
                    questionEvent = event;
                }
            }
            catch {
                // Non-JSON lines are expected (blank lines, partial chunks) — only warn
                // on lines that LOOK like JSON (start with '{') since those represent
                // actual parse failures that could mask dropped result/question events.
                if (line.trimStart().startsWith("{")) {
                    void onLog("stderr", `[openrouter adapter] WARNING: failed to parse JSON event from daemon stream: ${line.slice(0, 200)}\n`);
                }
            }
        }
    }
    // flush
    if (buffer.trim()) {
        try {
            const event = JSON.parse(buffer);
            if (event.type === "result")
                resultEvent = event;
        }
        catch { /* ok */ }
    }
    if (!resultEvent) {
        structuredLog({ level: "error", ts: Date.now(), event: "daemon_no_result", agentId, runId: "", message: "Daemon stream ended without a result event — daemon may have crashed or restarted" });
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
        ? resultEvent.usage : null;
    const hasCost = typeof resultEvent.total_cost_usd === "number";
    if (!hasCost) {
        void onLog("stderr", "[openrouter adapter] WARNING: result event missing total_cost_usd\n");
    }
    const totalCostUsd = hasCost ? resultEvent.total_cost_usd : 0;
    if (!sessionId && typeof resultEvent.session_id === "string")
        sessionId = resultEvent.session_id;
    if (maxCostUsdSoft !== undefined && totalCostUsd >= maxCostUsdSoft) {
        structuredLog({ level: "warn", ts: Date.now(), event: "soft_cost_limit", agentId, runId: "", costUsd: totalCostUsd, message: `Run cost $${totalCostUsd.toFixed(4)} exceeded soft limit $${maxCostUsdSoft}` });
        void onLog("stderr", `[openrouter adapter] soft cost limit reached ($${totalCostUsd.toFixed(4)} >= $${maxCostUsdSoft}) — consider adjusting maxCostUsd\n`);
    }
    const cacheHitRatio = typeof usageRaw?.input_tokens === "number" && usageRaw.input_tokens > 0
        ? (typeof usageRaw.cache_read_input_tokens === "number" ? usageRaw.cache_read_input_tokens : 0) / usageRaw.input_tokens
        : 0;
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
        resultJson: {
            result: resultText,
            subtype,
            sessionId,
            totalCostUsd,
            cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
            turnCount: typeof resultEvent.turnCount === "number" ? resultEvent.turnCount : undefined,
        },
        question: questionEvent
            ? { prompt: questionEvent.prompt, choices: questionEvent.choices }
            : null,
    };
}
const DEFAULT_CLI = "orager";
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-2";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRIES = 3;
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
function defaultTimeoutForModel(model) {
    const lower = model.toLowerCase();
    // Extended thinking / reasoning models — can think for minutes
    if (/\br1\b|deepseek-r1|\/o1|\/o3|thinking|reasoning/.test(lower))
        return 600;
    // Fast chat / flash models
    if (/haiku|flash|mini|turbo/.test(lower))
        return 120;
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
export async function executeAgentLoop(ctx) {
    const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;
    // ── Config ─────────────────────────────────────────────────────────────────
    // Support both cliPath and the generic "command" field from the Paperclip UI
    const cliPath = asString(config.cliPath ?? config.command, DEFAULT_CLI);
    const model = asString(config.model, DEFAULT_MODEL);
    // Wake-reason-based model routing — allows routing smarter/faster models
    // based on why the agent was triggered, without changing the base config.
    const wakeReasonModels = parseObject(config.wakeReasonModels);
    const wakeReason = typeof context.wakeReason === "string" && context.wakeReason.trim()
        ? context.wakeReason.trim()
        : "";
    const effectiveModel = (wakeReason && typeof wakeReasonModels[wakeReason] === "string"
        ? wakeReasonModels[wakeReason]
        : null) ?? model;
    // Support both maxTurns and maxTurnsPerRun (alias for compatibility)
    const maxTurns = Math.max(0, safeNumber(config.maxTurnsPerRun ?? config.maxTurns, DEFAULT_MAX_TURNS));
    const maxRetries = Math.max(0, safeNumber(config.maxRetries, DEFAULT_MAX_RETRIES));
    const timeoutSec = Math.max(0, safeNumber(config.timeoutSec, defaultTimeoutForModel(effectiveModel)));
    const rawGraceSec = Math.max(0, safeNumber(config.graceSec, DEFAULT_GRACE_SEC));
    const graceSec = (timeoutSec > 0 && rawGraceSec >= timeoutSec)
        ? Math.max(1, Math.floor(timeoutSec * 0.1))
        : rawGraceSec;
    const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
    const siteUrl = asString(config.siteUrl, "");
    const siteName = asString(config.siteName, "");
    const sandboxRoot = asString(config.sandboxRoot, "");
    const useFinishTool = asBoolean(config.useFinishTool, false);
    const profile = asString(config.profile, "").trim();
    const settingsFile = asString(config.settingsFile, "").trim();
    const forceResume = asBoolean(config.forceResume, false);
    // Sampling — reject NaN/Infinity for all sampling params
    const temperature = typeof config.temperature === "number" && Number.isFinite(config.temperature) ? config.temperature : undefined;
    const top_p = typeof config.top_p === "number" && Number.isFinite(config.top_p) ? config.top_p : undefined;
    const top_k = typeof config.top_k === "number" && Number.isFinite(config.top_k) ? config.top_k : undefined;
    const frequency_penalty = typeof config.frequency_penalty === "number" && Number.isFinite(config.frequency_penalty)
        ? config.frequency_penalty
        : undefined;
    const presence_penalty = typeof config.presence_penalty === "number" && Number.isFinite(config.presence_penalty)
        ? config.presence_penalty
        : undefined;
    const repetition_penalty = typeof config.repetition_penalty === "number" && Number.isFinite(config.repetition_penalty)
        ? config.repetition_penalty
        : undefined;
    const min_p = typeof config.min_p === "number" && Number.isFinite(config.min_p) ? config.min_p : undefined;
    const seed = typeof config.seed === "number" && Number.isInteger(config.seed) ? config.seed : undefined;
    const stopTokens = Array.isArray(config.stop)
        ? config.stop.filter((s) => typeof s === "string")
        : [];
    // Tool control
    const toolChoice = asString(config.tool_choice, "");
    // Default parallel tool calls to true — matches OpenRouter's default and enables
    // Auto Exacto optimization for tool-calling requests. Set parallel_tool_calls: false
    // in config to disable (e.g. for strictly sequential workflows).
    const parallelToolCalls = typeof config.parallel_tool_calls === "boolean"
        ? config.parallel_tool_calls
        : true;
    // Reasoning
    const reasoningConfig = parseObject(config.reasoning);
    const reasoningEffort = typeof reasoningConfig.effort === "string" ? reasoningConfig.effort : "";
    const reasoningMaxTokens = typeof reasoningConfig.max_tokens === "number"
        ? reasoningConfig.max_tokens
        : undefined;
    // Default reasoning to excluded — reasoning tokens cost 2-3x and are rarely needed
    // for routine agent tasks. Set reasoning.exclude: false to enable explicitly.
    const reasoningExclude = reasoningConfig.exclude !== false;
    // Provider routing
    const providerConfig = parseObject(config.provider);
    const providerOrder = Array.isArray(providerConfig.order)
        ? providerConfig.order
            .filter((s) => typeof s === "string")
            .join(",")
        : "";
    const providerIgnore = Array.isArray(providerConfig.ignore)
        ? providerConfig.ignore
            .filter((s) => typeof s === "string")
            .join(",")
        : "";
    const providerOnly = Array.isArray(providerConfig.only)
        ? providerConfig.only
            .filter((s) => typeof s === "string")
            .join(",")
        : "";
    const dataCollection = typeof providerConfig.data_collection === "string"
        ? providerConfig.data_collection
        : "";
    const zdr = providerConfig.zdr === true;
    // Default sort to "latency" for agent loops — minimizes time-to-first-token.
    // Overridden if providerOrder is set (explicit ordering takes precedence).
    // Set provider.sort: "price" to override back to cost-optimized routing.
    const sort = typeof providerConfig.sort === "string"
        ? providerConfig.sort
        : providerOrder
            ? ""
            : "latency";
    // require_parameters: only route to providers supporting all request params.
    // Prevents silent fallbacks to providers that ignore tool definitions.
    const requireParameters = providerConfig.require_parameters !== false;
    const quantizations = Array.isArray(providerConfig.quantizations)
        ? providerConfig.quantizations
            .filter((s) => typeof s === "string")
            .join(",")
        : "";
    // OpenRouter Preset — named server-side config for routing/model settings.
    // Reference format: "preset-slug" or "org/preset-slug".
    // Allows updating routing strategy without redeploying adapter.
    const preset = typeof config.preset === "string" ? config.preset.trim() : "";
    // Fallback models
    const models = Array.isArray(config.models)
        ? config.models.filter((m) => typeof m === "string" && m.trim().length > 0)
        : [];
    // Transforms
    const transforms = Array.isArray(config.transforms)
        ? config.transforms
            .filter((t) => typeof t === "string" && t.trim().length > 0)
            .join(",")
        : "";
    // Cost limits
    const maxCostUsd = typeof config.maxCostUsd === "number" ? config.maxCostUsd : undefined;
    const maxCostUsdSoft = typeof config.maxCostUsdSoft === "number" ? config.maxCostUsdSoft : undefined;
    const costPerInputToken = typeof config.costPerInputToken === "number"
        ? config.costPerInputToken
        : undefined;
    const costPerOutputToken = typeof config.costPerOutputToken === "number"
        ? config.costPerOutputToken
        : undefined;
    // Approval
    // requireApprovalFor: comma-separated list of tool names → string[]
    // requireApproval: true → "all" (require approval for every tool)
    // AgentLoopOptions.requireApproval is "all" | string[], never a boolean.
    const _requireApprovalBool = asBoolean(config.requireApproval, false);
    const _requireApprovalForStr = asString(config.requireApprovalFor, "");
    const _requireApprovalForArr = Array.isArray(config.requireApprovalFor)
        ? config.requireApprovalFor.filter((v) => typeof v === "string" && v.trim().length > 0)
        : _requireApprovalForStr
            ? _requireApprovalForStr.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
    const effectiveRequireApproval = _requireApprovalForArr.length > 0
        ? _requireApprovalForArr
        : _requireApprovalBool
            ? "all"
            : undefined;
    // Always use question mode in the adapter — never block on TTY
    const approvalMode = "question";
    // Check for approval answer from previous run's question
    const questionAnswer = parseObject(context.questionAnswer);
    const approvalAnswer = typeof questionAnswer.choiceKey === "string" && typeof questionAnswer.toolCallId === "string"
        ? { choiceKey: questionAnswer.choiceKey, toolCallId: questionAnswer.toolCallId }
        : null;
    // Dry-run mode
    const dryRun = asBoolean(config.dryRun, false);
    // Required env vars
    const requiredEnvVars = Array.isArray(config.requiredEnvVars)
        ? config.requiredEnvVars.filter((v) => typeof v === "string")
        : [];
    // Summarize config
    const summarizeAt = typeof config.summarizeAt === "number" && config.summarizeAt > 0 && config.summarizeAt <= 1
        ? config.summarizeAt
        : undefined;
    const summarizeModel = typeof config.summarizeModel === "string" && config.summarizeModel.trim()
        ? config.summarizeModel.trim()
        : undefined;
    const summarizeKeepRecentTurns = typeof config.summarizeKeepRecentTurns === "number" && config.summarizeKeepRecentTurns >= 0
        ? config.summarizeKeepRecentTurns
        : undefined;
    const summarizePrompt = typeof config.summarizePrompt === "string" && config.summarizePrompt.trim()
        ? config.summarizePrompt.trim()
        : undefined;
    const summarizeFallbackKeep = typeof config.summarizeFallbackKeep === "number" && config.summarizeFallbackKeep >= 0
        ? config.summarizeFallbackKeep
        : undefined;
    const webhookUrl = typeof config.webhookUrl === "string" && config.webhookUrl.trim()
        ? config.webhookUrl.trim()
        : undefined;
    // Extended agent loop options
    const tagToolOutputs = typeof config.tagToolOutputs === "boolean" ? config.tagToolOutputs : undefined;
    const planMode = asBoolean(config.planMode, false);
    const injectContext = asBoolean(config.injectContext, false);
    const bashPolicy = parseObject(config.bashPolicy);
    const hooksRaw = parseObject(config.hooks);
    const hooks = Object.keys(hooksRaw).length > 0
        ? Object.fromEntries(Object.entries(hooksRaw).filter(([, v]) => typeof v === "string"))
        : undefined;
    const trackFileChanges = asBoolean(config.trackFileChanges, false);
    const enableBrowserTools = asBoolean(config.enableBrowserTools, false);
    const hookTimeoutMs = typeof config.hookTimeoutMs === "number" && config.hookTimeoutMs > 0
        ? config.hookTimeoutMs
        : undefined;
    const hookErrorMode = config.hookErrorMode === "ignore" || config.hookErrorMode === "warn" || config.hookErrorMode === "fail"
        ? config.hookErrorMode
        : undefined;
    const approvalTimeoutMs = typeof config.approvalTimeoutMs === "number" && config.approvalTimeoutMs > 0
        ? config.approvalTimeoutMs
        : undefined;
    const turnModelRules = Array.isArray(config.turnModelRules) ? config.turnModelRules : undefined;
    // Advanced loop controls
    const mcpServersRaw = parseObject(config.mcpServers);
    const mcpServers = Object.keys(mcpServersRaw).length > 0
        ? mcpServersRaw
        : undefined;
    const requireMcpServers = Array.isArray(config.requireMcpServers)
        ? config.requireMcpServers.filter((s) => typeof s === "string" && s.trim().length > 0)
        : undefined;
    const toolTimeoutsRaw = parseObject(config.toolTimeouts);
    const toolTimeouts = Object.keys(toolTimeoutsRaw).length > 0
        ? Object.fromEntries(Object.entries(toolTimeoutsRaw)
            .filter(([, v]) => typeof v === "number")
            .map(([k, v]) => [k, v]))
        : undefined;
    const maxSpawnDepth = typeof config.maxSpawnDepth === "number" && config.maxSpawnDepth >= 0
        ? config.maxSpawnDepth
        : undefined;
    const maxIdenticalToolCallTurns = typeof config.maxIdenticalToolCallTurns === "number" && config.maxIdenticalToolCallTurns >= 0
        ? config.maxIdenticalToolCallTurns
        : undefined;
    const toolErrorBudgetHardStop = asBoolean(config.toolErrorBudgetHardStop, false) || undefined;
    // Extra tool spec files
    const toolsFiles = Array.isArray(config.toolsFiles)
        ? config.toolsFiles.filter((f) => typeof f === "string")
        : [];
    // Skills directories — always include bundled Paperclip skills so the
    // model gets native get-task, post-comment, list-issues, update-issue-status tools
    const addDirs = [SKILLS_DIR];
    if (Array.isArray(config.addDirs)) {
        for (const d of config.addDirs) {
            if (typeof d === "string" && d.trim())
                addDirs.push(d.trim());
        }
    }
    // Extra passthrough args (extraArgs or args alias)
    const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0)
            return fromExtraArgs;
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
    const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
    const agentHome = asString(workspaceContext.agentHome, "") || null;
    const workspaceHints = Array.isArray(context.paperclipWorkspaces)
        ? context.paperclipWorkspaces.filter((v) => typeof v === "object" && v !== null)
        : [];
    const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
        ? context.paperclipRuntimeServiceIntents.filter((v) => typeof v === "object" && v !== null)
        : [];
    const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
        ? context.paperclipRuntimeServices.filter((v) => typeof v === "object" && v !== null)
        : [];
    const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
    const linkedIssueIds = Array.isArray(context.issueIds)
        ? context.issueIds.filter((v) => typeof v === "string" && v.trim().length > 0)
        : [];
    // ── cwd ────────────────────────────────────────────────────────────────────
    const configuredCwd = asString(config.cwd, "");
    // If workspace is agent_home strategy and config has a cwd override, use the override
    const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
    const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome
        ? ""
        : workspaceCwd;
    const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
    // Ensure cwd exists
    try {
        await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    }
    catch {
        // Non-fatal — spawn will fail with a clearer error if cwd is truly invalid
    }
    const taskId = (typeof context.taskId === "string" && context.taskId.trim()) ||
        (typeof context.issueId === "string" && context.issueId.trim()) ||
        null;
    // ── Instructions file ──────────────────────────────────────────────────────
    // Passed to orager via --system-prompt-file so it lands in the system prompt
    // (not the user message) — mirroring claude-local's --append-system-prompt-file.
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    // Validate instructionsFilePath: must resolve (with symlinks expanded) within cwd.
    // Without realpath(), a symlink at <cwd>/instructions.md → /etc/passwd bypasses the prefix check.
    const safeInstructionsFilePath = await (async () => {
        if (!instructionsFilePath)
            return "";
        const abs = path.isAbsolute(instructionsFilePath)
            ? instructionsFilePath
            : path.resolve(cwd, instructionsFilePath);
        // Resolve symlinks before prefix check to prevent symlink traversal attacks.
        let real;
        try {
            real = await fs.realpath(abs);
        }
        catch {
            void onLog("stderr", `[openrouter adapter] WARNING: instructionsFilePath '${instructionsFilePath}' could not be resolved — ignoring\n`);
            return "";
        }
        // Must stay within cwd (prevent ../../etc/passwd traversal)
        if (!real.startsWith(cwd + path.sep) && real !== cwd) {
            void onLog("stderr", `[openrouter adapter] WARNING: instructionsFilePath '${instructionsFilePath}' is outside cwd — ignoring\n`);
            return "";
        }
        return real;
    })();
    // ── Prompt ─────────────────────────────────────────────────────────────────
    // Keep the prompt minimal — the paperclip/SKILL.md skill (loaded via --add-dir)
    // contains the full heartbeat procedure. Orager's native skills (get-task,
    // list-issues, post-comment, update-issue-status) handle all API interaction.
    const DEFAULT_PROMPT_TEMPLATE = "You are {{agent.name}}, a Paperclip AI agent.\n\n" +
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
    const sessionHandoff = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const renderedBootstrap = (config.bootstrapPromptTemplate
        ? renderTemplate(asString(config.bootstrapPromptTemplate, ""), templateData)
        : "").trim();
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
    // ── Image attachments ─────────────────────────────────────────────────────────
    // If Paperclip provides image attachments in the context, build a multimodal
    // content array for the first user message. Supported by any vision-capable
    // model on OpenRouter (GPT-4o, Claude, Gemini 2.5, Llama 3.2 Vision, etc.).
    // Attachment format expected: { url: string, mimeType?: string }[]
    const rawAttachments = Array.isArray(context.attachments)
        ? context.attachments
        : [];
    const imageAttachments = rawAttachments.filter((a) => typeof a === "object" &&
        a !== null &&
        typeof a.url === "string" &&
        /^https?:\/\//.test(a.url) &&
        (!a.mimeType ||
            /^image\//.test(a.mimeType)));
    const promptContent = imageAttachments.length > 0
        ? [
            { type: "text", text: prompt },
            ...imageAttachments.map((a) => ({
                type: "image_url",
                image_url: { url: a.url },
            })),
        ]
        : null;
    // ── Build config object and write to temp file ────────────────────────────
    // Instead of building 50+ CLI args, we write all config to a temp JSON file
    // and pass --config-file <path> as the only config arg. This avoids argument
    // length limits on some systems and keeps the subprocess invocation clean.
    // The file is chmod 600 before writing so only the current user can read it.
    // Orager reads and immediately deletes the file before doing anything else.
    const configObj = {
        outputFormat: "stream-json",
        model: effectiveModel,
        maxTurns: maxTurns > 0 ? maxTurns : undefined,
        maxRetries,
        addDirs,
    };
    if (previousSessionId)
        configObj.sessionId = previousSessionId;
    if (safeInstructionsFilePath)
        configObj.systemPromptFile = safeInstructionsFilePath;
    if (dangerouslySkipPermissions)
        configObj.dangerouslySkipPermissions = true;
    if (sandboxRoot)
        configObj.sandboxRoot = sandboxRoot;
    if (useFinishTool)
        configObj.useFinishTool = true;
    if (profile)
        configObj.profile = profile;
    if (settingsFile)
        configObj.settingsFile = settingsFile;
    if (forceResume)
        configObj.forceResume = true;
    if (siteUrl)
        configObj.siteUrl = siteUrl;
    if (siteName)
        configObj.siteName = siteName;
    // Sampling
    if (temperature !== undefined)
        configObj.temperature = temperature;
    if (top_p !== undefined)
        configObj.top_p = top_p;
    if (top_k !== undefined)
        configObj.top_k = top_k;
    if (frequency_penalty !== undefined)
        configObj.frequency_penalty = frequency_penalty;
    if (presence_penalty !== undefined)
        configObj.presence_penalty = presence_penalty;
    if (repetition_penalty !== undefined)
        configObj.repetition_penalty = repetition_penalty;
    if (min_p !== undefined)
        configObj.min_p = min_p;
    if (seed !== undefined)
        configObj.seed = seed;
    if (stopTokens.length > 0)
        configObj.stop = stopTokens;
    // Tool control
    if (toolChoice)
        configObj.tool_choice = toolChoice;
    configObj.parallel_tool_calls = parallelToolCalls;
    // Reasoning
    if (reasoningEffort)
        configObj.reasoningEffort = reasoningEffort;
    if (reasoningMaxTokens !== undefined)
        configObj.reasoningMaxTokens = reasoningMaxTokens;
    if (reasoningExclude)
        configObj.reasoningExclude = true;
    // Provider routing — pass as comma-separated strings (matching CLI format)
    if (providerOrder)
        configObj.providerOrder = providerOrder.split(",").filter(Boolean);
    if (providerIgnore)
        configObj.providerIgnore = providerIgnore.split(",").filter(Boolean);
    if (providerOnly)
        configObj.providerOnly = providerOnly.split(",").filter(Boolean);
    if (dataCollection)
        configObj.dataCollection = dataCollection;
    if (zdr)
        configObj.zdr = true;
    if (sort)
        configObj.sort = sort;
    if (requireParameters)
        configObj.require_parameters = true;
    if (quantizations)
        configObj.quantizations = quantizations.split(",").filter(Boolean);
    if (preset)
        configObj.preset = preset;
    // Fallback models
    if (models.length > 0)
        configObj.models = models;
    // Transforms
    if (transforms)
        configObj.transforms = transforms.split(",").filter(Boolean);
    // Cost limits
    if (maxCostUsd !== undefined)
        configObj.maxCostUsd = maxCostUsd;
    if (maxCostUsdSoft !== undefined)
        configObj.maxCostUsdSoft = maxCostUsdSoft;
    if (costPerInputToken !== undefined)
        configObj.costPerInputToken = costPerInputToken;
    if (costPerOutputToken !== undefined)
        configObj.costPerOutputToken = costPerOutputToken;
    // Approval — requireApproval must be "all" or string[], never a boolean
    if (effectiveRequireApproval !== undefined)
        configObj.requireApproval = effectiveRequireApproval;
    configObj.approvalMode = approvalMode;
    if (approvalAnswer)
        configObj.approvalAnswer = approvalAnswer;
    // Extra tools
    if (toolsFiles.length > 0)
        configObj.toolsFiles = toolsFiles;
    // Summarize config
    if (summarizeAt !== undefined)
        configObj.summarizeAt = summarizeAt;
    if (summarizeModel)
        configObj.summarizeModel = summarizeModel;
    if (summarizeKeepRecentTurns !== undefined)
        configObj.summarizeKeepRecentTurns = summarizeKeepRecentTurns;
    // Extended agent loop options
    if (tagToolOutputs !== undefined)
        configObj.tagToolOutputs = tagToolOutputs;
    if (planMode)
        configObj.planMode = true;
    if (injectContext)
        configObj.injectContext = true;
    if (Object.keys(bashPolicy).length > 0)
        configObj.bashPolicy = bashPolicy;
    if (trackFileChanges)
        configObj.trackFileChanges = true;
    if (enableBrowserTools)
        configObj.enableBrowserTools = true;
    if (turnModelRules)
        configObj.turnModelRules = turnModelRules;
    if (summarizePrompt)
        configObj.summarizePrompt = summarizePrompt;
    if (summarizeFallbackKeep !== undefined)
        configObj.summarizeFallbackKeep = summarizeFallbackKeep;
    if (webhookUrl)
        configObj.webhookUrl = webhookUrl;
    if (hooks)
        configObj.hooks = hooks;
    if (hookTimeoutMs !== undefined)
        configObj.hookTimeoutMs = hookTimeoutMs;
    if (hookErrorMode !== undefined)
        configObj.hookErrorMode = hookErrorMode;
    if (approvalTimeoutMs !== undefined)
        configObj.approvalTimeoutMs = approvalTimeoutMs;
    if (mcpServers)
        configObj.mcpServers = mcpServers;
    if (requireMcpServers && requireMcpServers.length > 0)
        configObj.requireMcpServers = requireMcpServers;
    if (toolTimeouts)
        configObj.toolTimeouts = toolTimeouts;
    if (maxSpawnDepth !== undefined)
        configObj.maxSpawnDepth = maxSpawnDepth;
    if (maxIdenticalToolCallTurns !== undefined)
        configObj.maxIdenticalToolCallTurns = maxIdenticalToolCallTurns;
    if (toolErrorBudgetHardStop)
        configObj.toolErrorBudgetHardStop = true;
    // Multimodal prompt content
    if (promptContent)
        configObj.promptContent = promptContent;
    // Run-level timeout — orager self-terminates via AbortSignal.timeout() when exceeded.
    // The adapter's outer process timeout (timeoutSec + 10s grace) remains as belt-and-suspenders.
    configObj.timeoutSec = timeoutSec;
    // Full API key pool — orager rotates through these on 429 errors internally.
    if (apiKeyPool.length > 1)
        configObj.apiKeys = apiKeyPool;
    // Required env vars — pass through so orager also validates (belt-and-suspenders
    // for the spawn path; adapter-level check above handles daemon path).
    if (requiredEnvVars.length > 0)
        configObj.requiredEnvVars = requiredEnvVars;
    // Response format (JSON healing)
    const responseFormat = parseObject(config.responseFormat);
    if (typeof responseFormat.type === "string" && responseFormat.type) {
        configObj.response_format = responseFormat;
    }
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
    }
    catch (err) {
        // Config file write failed — fall back to individual CLI args is not
        // implemented; surface the error so the caller sees it rather than silently
        // proceeding with no config.
        return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: `Failed to write orager config file: ${err instanceof Error ? err.message : String(err)}`,
            errorCode: "config_error",
        };
    }
    // Build minimal CLI args — just the prompt source, output format, verbose flag,
    // and the config file path. All model/provider/sampling config is in the file.
    const args = [
        "--print",
        "-",
        "--verbose",
        "--config-file",
        configFilePath,
    ];
    // Extra passthrough args (not included in config file — caller-supplied raw flags)
    if (extraArgs.length > 0)
        args.push(...extraArgs);
    // ── Environment ────────────────────────────────────────────────────────────
    const paperclipEnv = buildPaperclipEnv(agent);
    const contextEnv = {};
    // Task / wake context
    if (taskId)
        contextEnv.PAPERCLIP_TASK_ID = taskId;
    if (typeof context.wakeReason === "string" && context.wakeReason.trim())
        contextEnv.PAPERCLIP_WAKE_REASON = context.wakeReason.trim();
    const commentId = (typeof context.wakeCommentId === "string" &&
        context.wakeCommentId.trim()) ||
        (typeof context.commentId === "string" && context.commentId.trim()) ||
        null;
    if (commentId)
        contextEnv.PAPERCLIP_WAKE_COMMENT_ID = commentId;
    if (typeof context.approvalId === "string" && context.approvalId.trim())
        contextEnv.PAPERCLIP_APPROVAL_ID = context.approvalId.trim();
    if (typeof context.approvalStatus === "string" &&
        context.approvalStatus.trim())
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
    const env = {
        ...paperclipEnv,
        ...contextEnv,
        PAPERCLIP_RUN_ID: runId,
        OPENROUTER_API_KEY: apiKey,
        ORAGER_API_KEY: apiKey,
    };
    if (authToken)
        env.PAPERCLIP_API_KEY = authToken;
    for (const [k, v] of Object.entries(configEnv)) {
        if (typeof v === "string")
            env[k] = v;
    }
    // ── OpenTelemetry passthrough ─────────────────────────────────────────────
    // Config-level OTEL overrides (otelEndpoint, otelServiceName, otelResourceAttributes)
    // take precedence over process.env values so the caller can control tracing
    // without changing the server environment. process.env OTEL vars are inherited
    // automatically via the process.env spread below.
    const otelEndpoint = typeof config.otelEndpoint === "string" ? config.otelEndpoint.trim() : "";
    const otelServiceName = typeof config.otelServiceName === "string" ? config.otelServiceName.trim() : "";
    const otelResourceAttrs = typeof config.otelResourceAttributes === "string" ? config.otelResourceAttributes.trim() : "";
    if (otelEndpoint)
        env.OTEL_EXPORTER_OTLP_ENDPOINT = otelEndpoint;
    if (otelServiceName)
        env.OTEL_SERVICE_NAME = otelServiceName;
    if (otelResourceAttrs)
        env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttrs;
    // Merge with process.env and ensure PATH is populated
    const effectiveEnv = ensurePathInEnv({ ...process.env, ...env });
    // ── Per-agent environment validation ────────────────────────────────────────
    const missingVars = checkRequiredEnvVars(requiredEnvVars, effectiveEnv);
    if (missingVars.length > 0) {
        structuredLog({ level: "error", ts: Date.now(), event: "env_var_missing", agentId: agent.id, runId, message: `Missing: ${missingVars.join(", ")}` });
        return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: `Missing required environment variables: ${missingVars.join(", ")}`,
            errorCode: "config_error",
        };
    }
    // ── Dry-run mode ────────────────────────────────────────────────────────────
    if (dryRun) {
        // Clean up the config file written above — no subprocess will delete it for us
        if (configFileWritten)
            await fs.unlink(configFilePath).catch(() => { });
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
    // ── Daemon fast-path ────────────────────────────────────────────────────────
    // If ORAGER_DAEMON_URL (or config.daemonUrl) is set, attempt to route this
    // run through the persistent orager daemon instead of spawning a subprocess.
    // The daemon eliminates Node.js startup overhead (~50-200ms) and keeps all
    // in-process caches warm (skills, tool results, LLM prompt cache via sticky routing).
    // Falls back to the spawn path if the daemon is unreachable.
    const _rawDaemonUrl = asString(config.daemonUrl, "") || process.env.ORAGER_DAEMON_URL || "";
    // Security: reject non-loopback daemon URLs to prevent SSRF. The daemon binds
    // to 127.0.0.1 by design and should never be reached via an external address.
    const daemonBaseUrl = (() => {
        if (!_rawDaemonUrl)
            return "";
        try {
            const u = new URL(_rawDaemonUrl);
            const host = u.hostname.toLowerCase();
            const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || /^127\./.test(host);
            if (!isLoopback) {
                void onLog("stderr", `[openrouter adapter] WARNING: ignoring non-loopback daemonUrl '${_rawDaemonUrl}' — daemon must be on localhost\n`);
                return "";
            }
        }
        catch {
            void onLog("stderr", `[openrouter adapter] WARNING: ignoring invalid daemonUrl '${_rawDaemonUrl}'\n`);
            return "";
        }
        return _rawDaemonUrl;
    })();
    if (daemonBaseUrl) {
        if (isDaemonCircuitOpen(daemonBaseUrl)) {
            void onLog("stderr", `[openrouter adapter] daemon circuit breaker open — falling back to spawn\n`);
            structuredLog({ level: "warn", ts: Date.now(), event: "daemon_circuit_open", agentId: agent.id, runId });
        }
        else {
            let signingKey = await readDaemonSigningKey(onLog);
            let alive = signingKey ? await isDaemonAlive(daemonBaseUrl) : false;
            if (!alive) {
                alive = await tryAutoStartDaemon(daemonBaseUrl, cliPath, apiKey, effectiveEnv, onLog);
                if (alive) {
                    // Re-read signing key in case it was just generated
                    signingKey = await readDaemonSigningKey(onLog);
                }
            }
            if (alive && signingKey) {
                // Build opts for daemon — includes apiKey so key rotation takes effect
                const daemonOpts = {
                    apiKey,
                    model: effectiveModel,
                    models: models.length > 0 ? models : undefined,
                    sessionId: previousSessionId || null,
                    addDirs,
                    maxTurns: maxTurns > 0 ? maxTurns : 0,
                    maxRetries,
                    cwd,
                    dangerouslySkipPermissions,
                    forceResume: forceResume || undefined,
                    verbose: false,
                    useFinishTool,
                    profile: profile || undefined,
                    settingsFile: settingsFile || undefined,
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
                    maxCostUsdSoft,
                    costPerInputToken,
                    costPerOutputToken,
                    requireApproval: effectiveRequireApproval,
                    summarizeAt,
                    summarizeModel: summarizeModel || undefined,
                    summarizeKeepRecentTurns,
                    tagToolOutputs,
                    planMode: planMode || undefined,
                    injectContext: injectContext || undefined,
                    bashPolicy: Object.keys(bashPolicy).length > 0 ? bashPolicy : undefined,
                    trackFileChanges: trackFileChanges || undefined,
                    enableBrowserTools: enableBrowserTools || undefined,
                    turnModelRules,
                    summarizePrompt,
                    summarizeFallbackKeep,
                    webhookUrl,
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
                    appendSystemPrompt: safeInstructionsFilePath
                        ? await fs.readFile(safeInstructionsFilePath, "utf8").catch(() => undefined)
                        : undefined,
                    promptContent: promptContent ?? undefined,
                    approvalMode,
                    ...(approvalAnswer ? { approvalAnswer } : {}),
                    ...(typeof responseFormat.type === "string" && responseFormat.type ? { response_format: responseFormat } : {}),
                    timeoutSec,
                    ...(apiKeyPool.length > 1 ? { apiKeys: apiKeyPool } : {}),
                    ...(requiredEnvVars.length > 0 ? { requiredEnvVars } : {}),
                };
                const daemonResult = await executeViaDaemon(daemonBaseUrl, signingKey, agent.id, prompt, promptContent, daemonOpts, timeoutSec, onLog, maxCostUsdSoft);
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
                        cacheHitRatio: typeof daemonResult.resultJson?.cacheHitRatio === "number" ? daemonResult.resultJson.cacheHitRatio : undefined,
                        costUsd: daemonResult.costUsd ?? undefined,
                        turnCount: typeof daemonResult.resultJson?.turnCount === "number" ? daemonResult.resultJson.turnCount : undefined,
                        subtype: typeof daemonResult.resultJson?.subtype === "string" ? daemonResult.resultJson.subtype : undefined,
                    });
                    recordDaemonSuccess(daemonBaseUrl);
                    if (configFileWritten) {
                        await fs.unlink(configFilePath).catch(() => { });
                    }
                    // Augment session params with workspace metadata to match the spawn path
                    if (daemonResult.sessionParams) {
                        daemonResult.sessionParams = {
                            ...daemonResult.sessionParams,
                            ...(workspaceId ? { workspaceId } : {}),
                            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
                            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
                        };
                    }
                    // Cost anomaly detection
                    if (typeof daemonResult.costUsd === "number") {
                        recordRunCost(daemonResult.costUsd);
                        checkCostAnomaly(daemonResult.costUsd, agent.id, runId, onLog);
                    }
                    return daemonResult;
                }
                // null = daemon at capacity after retry — fall through to spawn
                recordDaemonFailure(daemonBaseUrl);
                structuredLog({ level: "warn", ts: Date.now(), event: "daemon_fallback", agentId: agent.id, runId, message: "Daemon unavailable, falling back to spawn" });
                void onLog("stderr", `[openrouter adapter] daemon at capacity after retry — falling back to spawn\n`);
            }
            else {
                structuredLog({ level: "warn", ts: Date.now(), event: "daemon_fallback", agentId: agent.id, runId, message: "Daemon unavailable, falling back to spawn" });
                void onLog("stderr", `[openrouter adapter] daemon at ${daemonBaseUrl} unreachable — falling back to spawn\n`);
            }
        } // end circuit-breaker else
    }
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
    }
    catch (err) {
        // Clean up the config file since we won't be spawning orager to delete it
        if (configFileWritten) {
            await fs.unlink(configFilePath).catch(() => { });
        }
        return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: `Cannot find orager CLI "${cliPath}": ${err instanceof Error ? err.message : String(err)}`,
            errorCode: "cli_not_found",
        };
    }
    // ── Spawn orager ───────────────────────────────────────────────────────────
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(cliPath, args, {
                cwd,
                env: effectiveEnv,
                stdio: ["pipe", "pipe", "pipe"],
                detached: true,
            });
            proc.unref();
        }
        catch (spawnErr) {
            // Clean up the config file on spawn failure — orager won't get to delete it
            fs.unlink(configFilePath).catch(() => { });
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
        }
        catch {
            // stdin write failure is non-fatal; the process may still produce output
        }
        let resultEvent = null;
        let questionEvent = null;
        let sessionId = "";
        let resolvedModel = "";
        let sessionLost = false;
        let timedOut = false;
        let timeoutTimer;
        let graceTimer;
        if (timeoutSec > 0) {
            timeoutTimer = setTimeout(() => {
                timedOut = true;
                // Kill the entire process group to clean up orager subprocesses
                try {
                    process.kill(-(proc.pid), "SIGTERM");
                }
                catch {
                    proc.kill("SIGTERM");
                }
                // Force kill after grace period if the process doesn't exit on its own
                if (graceSec > 0) {
                    graceTimer = setTimeout(() => {
                        try {
                            process.kill(-(proc.pid), "SIGKILL");
                        }
                        catch {
                            proc.kill("SIGKILL");
                        }
                    }, graceSec * 1000);
                }
            }, timeoutSec * 1000);
        }
        // Read stdout line by line and stream to Paperclip.
        // Cap the in-memory buffer to prevent OOM from runaway binary output.
        const MAX_STDOUT_BUFFER_BYTES = 1 * 1024 * 1024; // 1 MB per partial line
        let stdoutBuffer = "";
        proc.stdout?.on("data", (chunk) => {
            stdoutBuffer +=
                typeof chunk === "string" ? chunk : chunk.toString("utf8");
            if (stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
                void onLog("stderr", `[openrouter adapter] stdout line exceeded ${MAX_STDOUT_BUFFER_BYTES} bytes — discarding oversized line\n`);
                // Drop to next newline to resync the parser
                const nextNl = stdoutBuffer.indexOf("\n", MAX_STDOUT_BUFFER_BYTES);
                stdoutBuffer = nextNl >= 0 ? stdoutBuffer.slice(nextNl + 1) : "";
            }
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim())
                    continue;
                void onLog("stdout", line + "\n");
                try {
                    const event = JSON.parse(line);
                    if (event.type === "system" && typeof event.session_id === "string") {
                        sessionId = event.session_id;
                        if (typeof event.model === "string" && event.model) {
                            resolvedModel = event.model;
                        }
                    }
                    if (event.type === "result") {
                        resultEvent = event;
                    }
                    // Keep the first question event — later ones arrive after the daemon has resumed
                    if (event.type === "question" && !questionEvent) {
                        questionEvent = event;
                    }
                }
                catch {
                    // non-JSON lines are fine — tool output, bash stdout, etc.
                }
            }
        });
        proc.stderr?.on("data", (chunk) => {
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            // Orager silently starts a fresh session when the requested session isn't
            // found. Detect this so we can clear the stale session ID on Paperclip's
            // side, ensuring the next run is treated as a fresh start (with
            // instructions re-injected via --system-prompt-file).
            if (text.includes("not found, starting fresh"))
                sessionLost = true;
            void onLog("stderr", text);
        });
        proc.on("close", (code, signal) => {
            if (timeoutTimer !== undefined)
                clearTimeout(timeoutTimer);
            if (graceTimer !== undefined)
                clearTimeout(graceTimer);
            // Flush any partial line remaining in the buffer
            if (stdoutBuffer.trim()) {
                void onLog("stdout", stdoutBuffer + "\n");
                try {
                    const event = JSON.parse(stdoutBuffer);
                    if (event.type === "result")
                        resultEvent = event;
                    if (event.type === "system" &&
                        typeof event.session_id === "string") {
                        sessionId = event.session_id;
                    }
                }
                catch {
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
            const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : "error";
            const resultText = typeof resultEvent.result === "string" ? resultEvent.result : "";
            const usageRaw = typeof resultEvent.usage === "object" && resultEvent.usage !== null
                ? resultEvent.usage
                : null;
            const hasCostField = typeof resultEvent.total_cost_usd === "number";
            if (!hasCostField) {
                void onLog("stderr", "[openrouter adapter] WARNING: result event missing total_cost_usd — cost will be reported as $0\n");
                structuredLog({
                    level: "warn",
                    ts: Date.now(),
                    event: "missing_cost_data",
                    agentId: agent.id,
                    runId,
                    message: "result event missing total_cost_usd field",
                });
            }
            const totalCostUsd = hasCostField ? resultEvent.total_cost_usd : 0;
            // Fall back to result event's session_id if not captured from init
            if (!sessionId && typeof resultEvent.session_id === "string") {
                sessionId = resultEvent.session_id;
            }
            if (maxCostUsdSoft !== undefined && totalCostUsd >= maxCostUsdSoft) {
                structuredLog({ level: "warn", ts: Date.now(), event: "soft_cost_limit", agentId: agent.id, runId, costUsd: totalCostUsd, message: `Run cost $${totalCostUsd.toFixed(4)} exceeded soft limit $${maxCostUsdSoft}` });
                void onLog("stderr", `[openrouter adapter] soft cost limit reached ($${totalCostUsd.toFixed(4)} >= $${maxCostUsdSoft}) — consider adjusting maxCostUsd\n`);
            }
            const cacheHitRatio = typeof usageRaw?.input_tokens === "number" && usageRaw.input_tokens > 0
                ? (typeof usageRaw.cache_read_input_tokens === "number" ? usageRaw.cache_read_input_tokens : 0) / usageRaw.input_tokens
                : 0;
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
            const spawnResult = {
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
                        inputTokens: typeof usageRaw.input_tokens === "number"
                            ? usageRaw.input_tokens
                            : 0,
                        outputTokens: typeof usageRaw.output_tokens === "number"
                            ? usageRaw.output_tokens
                            : 0,
                        cachedInputTokens: typeof usageRaw.cache_read_input_tokens === "number"
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
                    cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
                    turnCount: typeof resultEvent?.turnCount === "number" ? resultEvent.turnCount : undefined,
                },
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
                cacheHitRatio: typeof spawnResult.resultJson?.cacheHitRatio === "number" ? spawnResult.resultJson.cacheHitRatio : undefined,
                costUsd: spawnResult.costUsd,
                turnCount: typeof spawnResult.resultJson?.turnCount === "number" ? spawnResult.resultJson.turnCount : undefined,
                subtype: typeof spawnResult.resultJson?.subtype === "string" ? spawnResult.resultJson.subtype : undefined,
            });
            // Cost anomaly detection
            recordRunCost(spawnResult.costUsd ?? 0);
            checkCostAnomaly(spawnResult.costUsd ?? 0, agent.id, runId, onLog);
            resolve(spawnResult);
        });
        proc.on("error", (err) => {
            if (timeoutTimer !== undefined)
                clearTimeout(timeoutTimer);
            if (graceTimer !== undefined)
                clearTimeout(graceTimer);
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
// ── Test helpers (exported for unit tests only) ───────────────────────────────
export function _resetStateForTesting() {
    _costWindow.length = 0;
}
export { buildApiKeyPool, recordRunCost, checkCostAnomaly };
//# sourceMappingURL=execute-cli.js.map