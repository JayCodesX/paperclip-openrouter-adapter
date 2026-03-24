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
//# sourceMappingURL=execute-cli.d.ts.map