// Skills are loaded by orager via the addDirs mechanism.
// The adapter automatically includes the bundled Paperclip skills directory
// (get-task, post-comment, list-issues, update-issue-status, etc.) and any
// extra directories configured via config.addDirs.
//
// This means skills ARE supported — they just live on the filesystem rather
// than being managed through Paperclip's skills sync API.

const SNAPSHOT = {
  adapterType: "openrouter",
  supported: true,
  mode: "add-dir",
  desiredSkills: [] as string[],
  entries: [] as string[],
  warnings: [
    "Skills are loaded from directories passed to orager via addDirs. " +
      "The adapter automatically includes the bundled Paperclip skills directory. " +
      "Add custom skill directories via config.addDirs (array of absolute paths).",
  ],
};

export async function listOpenRouterSkills(_ctx: unknown): Promise<typeof SNAPSHOT> {
  return SNAPSHOT;
}

export async function syncOpenRouterSkills(
  _ctx: unknown,
  desiredSkills: string[],
): Promise<typeof SNAPSHOT> {
  // NOTE: This adapter uses mode "add-dir" — skills are loaded by orager from
  // filesystem directories, not registered through Paperclip's sync API.
  // Calling syncOpenRouterSkills does NOT automatically make desiredSkills
  // available to the agent. To add skill directories at runtime, include them
  // in config.addDirs (array of absolute paths on the server running the adapter).
  const warnings: string[] = [
    ...SNAPSHOT.warnings,
    "syncOpenRouterSkills does not write skills to disk. " +
      "Add skill directories to config.addDirs to make them available to the agent.",
  ];
  const invalid = desiredSkills.filter((s) => typeof s !== "string" || !s.trim());
  if (invalid.length > 0) {
    warnings.push(
      `${invalid.length} desired skill entr${invalid.length === 1 ? "y" : "ies"} could not be resolved (empty or non-string). ` +
        "Provide absolute filesystem paths to skill directories.",
    );
  }
  return { ...SNAPSHOT, desiredSkills: desiredSkills.filter((s) => typeof s === "string" && s.trim()), warnings };
}
