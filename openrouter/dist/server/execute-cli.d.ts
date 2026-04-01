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
declare function buildApiKeyPool(config: Record<string, unknown>): {
    primary: string;
    pool: string[];
};
/** The parsed shape of a "question" event from the orager event stream. */
export type OragerQuestionEvent = {
    type: "question";
    prompt: string;
    choices: Array<{
        key: string;
        label: string;
        description?: string;
    }>;
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
export declare function processOragerEvent(event: Record<string, unknown>, state: OragerStreamState, onLog: (stream: "stdout" | "stderr", text: string) => Promise<void> | void, onSessionLost: () => void): void;
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
declare const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";
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
export { buildApiKeyPool, DEFAULT_MODEL, DAEMON_KEY_PATH, DAEMON_KEY_MAX_AGE_MS, isDaemonCircuitOpen, recordDaemonFailure, recordDaemonSuccess, DAEMON_CB_THRESHOLD, DAEMON_CB_RESET_MS, buildAdapterResult, processRateLimitTracker, _lastAutoStartAttemptMs, AUTO_START_COOLDOWN_MS, };
//# sourceMappingURL=execute-cli.d.ts.map