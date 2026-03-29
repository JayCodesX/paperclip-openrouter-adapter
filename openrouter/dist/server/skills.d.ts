export interface OragerSkillsDir {
    /** Absolute path to the ephemeral skills temp directory. */
    dir: string;
    /** Names of skills that were successfully symlinked. */
    linked: string[];
    /** Skill names that were desired but not found in the Paperclip skills dir. */
    missing: string[];
}
/**
 * Create an ephemeral temp directory populated with symlinks to the desired
 * Paperclip skills, suitable for passing to orager as an `addDirs` entry.
 *
 * @param desiredSkills - Skill names requested by Paperclip (empty = all available).
 * @returns OragerSkillsDir — dir path + linked/missing lists.
 *          Returns null if no Paperclip skills directory is found (non-fatal).
 */
export declare function buildOragerSkillsDir(desiredSkills: string[]): Promise<OragerSkillsDir | null>;
/**
 * Remove the ephemeral skills temp directory created by buildOragerSkillsDir.
 * Non-fatal — errors are swallowed so cleanup never crashes a run.
 */
export declare function cleanupOragerSkillsDir(dir: string): Promise<void>;
declare const SNAPSHOT_BASE: {
    adapterType: string;
    supported: boolean;
    mode: "ephemeral";
    warnings: string[];
};
export declare function listOpenRouterSkills(_ctx: unknown): Promise<typeof SNAPSHOT_BASE & {
    desiredSkills: string[];
    entries: string[];
}>;
export declare function syncOpenRouterSkills(_ctx: unknown, desiredSkills: string[]): Promise<typeof SNAPSHOT_BASE & {
    desiredSkills: string[];
    entries: string[];
}>;
export {};
//# sourceMappingURL=skills.d.ts.map