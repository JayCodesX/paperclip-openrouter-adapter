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
    desiredSkills: [],
    entries: [],
    warnings: [
        "Skills are loaded from directories passed to orager via addDirs. " +
            "The adapter automatically includes the bundled Paperclip skills directory. " +
            "Add custom skill directories via config.addDirs (array of absolute paths).",
    ],
};
export async function listOpenRouterSkills(_ctx) {
    return SNAPSHOT;
}
export async function syncOpenRouterSkills(_ctx, desiredSkills) {
    // Validate that desired skills are non-empty strings; warn on unresolvable entries.
    const warnings = [...SNAPSHOT.warnings];
    const invalid = desiredSkills.filter((s) => typeof s !== "string" || !s.trim());
    if (invalid.length > 0) {
        warnings.push(`${invalid.length} desired skill entr${invalid.length === 1 ? "y" : "ies"} could not be resolved (empty or non-string). ` +
            "Provide absolute filesystem paths to skill directories.");
    }
    return { ...SNAPSHOT, desiredSkills: desiredSkills.filter((s) => typeof s === "string" && s.trim()), warnings };
}
//# sourceMappingURL=skills.js.map