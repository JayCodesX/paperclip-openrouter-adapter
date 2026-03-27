declare function recordRunCost(costUsd: number): void;
declare function checkCostAnomaly(costUsd: number, agentId: string, runId: string, onLog: (stream: "stdout" | "stderr", line: string) => Promise<void> | void): void;
declare function getActiveApiKey(config: Record<string, unknown>): string;
declare function rotateApiKey(config: Record<string, unknown>): boolean;
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
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
export { getActiveApiKey, rotateApiKey, recordRunCost, checkCostAnomaly };
//# sourceMappingURL=execute-cli.d.ts.map