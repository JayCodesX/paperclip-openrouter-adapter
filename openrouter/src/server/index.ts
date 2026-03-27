// Paperclip calls `execute` on every adapter run.
// We expose `executeAgentLoop` under that name so the orager agent loop
// is triggered automatically when this adapter is selected.
export { executeAgentLoop as execute } from "./execute-cli.js";

export { testEnvironment } from "./test.js";

// Re-export the session codec so paperclip can import it from the server entry.
export { sessionCodec } from "../index.js";

export { listOpenRouterModels } from "./list-models.js";

export { listOpenRouterSkills, syncOpenRouterSkills } from "./skills.js";

export { listOragerSessions, searchOragerSessions, getOragerSession } from "./sessions.js";
export type { SessionSummary, ListSessionsResult, SearchSessionsResult, SessionBrowserOptions } from "./sessions.js";
