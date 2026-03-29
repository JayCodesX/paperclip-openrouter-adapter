import { processRateLimitTracker } from "../rate-limit-tracker.js";
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
declare const COST_ANOMALY_COOLDOWN_RUNS = 10;
declare function recordRunCost(costUsd: number): void;
declare function checkCostAnomaly(costUsd: number, agentId: string, runId: string, onLog: (stream: "stdout" | "stderr", line: string) => Promise<void> | void): void;
/**
 * Build the memory key for orager.
 *
 * - Falls back to `agentId` alone when `repoUrl` is null or empty.
 * - Otherwise returns `${agentId}_${repoSlug(repoUrl)}` truncated to 128 chars.
 */
export declare function buildMemoryKey(agentId: string, repoUrl: string | null): string;
export declare const VISION_CACHE_TTL_MS: number;
export declare function checkVisionSupport(apiKey: string, model: string): Promise<boolean | null>;
declare function buildApiKeyPool(config: Record<string, unknown>): {
    primary: string;
    pool: string[];
};
export declare const SESSION_NOT_FOUND_MARKER = "not found, starting fresh";
declare let _lastAutoStartAttemptMs: number;
declare const AUTO_START_COOLDOWN_MS: number;
declare const DAEMON_CB_THRESHOLD = 3;
declare const DAEMON_CB_RESET_MS = 60000;
declare function isDaemonCircuitOpen(url: string): boolean;
declare function recordDaemonSuccess(url: string): void;
declare function recordDaemonFailure(url: string): void;
declare const DAEMON_KEY_PATH: string;
/** How old (in ms) a daemon signing key can be before we emit a rotation warning. */
declare const DAEMON_KEY_MAX_AGE_MS: number;
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
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
declare function buildAdapterResult(opts: BuildAdapterResultOpts): AdapterExecutionResult;
declare const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-2";
/**
 * Execute an autonomous agent loop by spawning the `orager` CLI as a
 * subprocess, using the same pattern as local CLI adapters in Paperclip.
 *
 * Orager writes stream-json events to stdout; this function streams those
 * lines back to Paperclip via `onLog` and returns a structured result once
 * the process exits.
 */
export declare function executeAgentLoop(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
export declare function _resetStateForTesting(): void;
/** Drain and return all structured log entries captured since the last reset. */
export declare function _drainStructuredLogForTesting(): StructuredLogEntry[];
export { buildApiKeyPool, recordRunCost, checkCostAnomaly, DEFAULT_MODEL, DAEMON_KEY_PATH, DAEMON_KEY_MAX_AGE_MS, isDaemonCircuitOpen, recordDaemonFailure, recordDaemonSuccess, DAEMON_CB_THRESHOLD, DAEMON_CB_RESET_MS, buildAdapterResult, processRateLimitTracker, _lastAutoStartAttemptMs, AUTO_START_COOLDOWN_MS, COST_ANOMALY_COOLDOWN_RUNS, };
//# sourceMappingURL=execute-cli.d.ts.map