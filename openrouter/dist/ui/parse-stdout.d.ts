import type { TranscriptEntry } from "@paperclipai/adapter-utils";
/**
 * Parses a single stdout line emitted by either the HTTP adapter or the
 * CLI-based agent loop (orager) into TranscriptEntry objects for the
 * Paperclip run viewer.
 *
 * HTTP adapter emits:
 *   1. SSE data lines:  `data: <openai-delta-json>`
 *   2. A final result:  `{"type":"result","model":"...","content":"...","usage":...}`
 *
 * Orager (CLI agent loop) emits stream-json events:
 *   1. `{"type":"system","subtype":"init",...}`
 *   2. `{"type":"assistant","message":{"content":[...]}}`
 *   3. `{"type":"user","message":{"content":[...]}}`  (tool results)
 *   4. `{"type":"tool","content":[...]}`
 *   5. `{"type":"result","subtype":"success","result":"...","usage":{...},...}`
 */
export declare function parseOpenRouterStdoutLine(line: string, ts: string): TranscriptEntry[];
//# sourceMappingURL=parse-stdout.d.ts.map