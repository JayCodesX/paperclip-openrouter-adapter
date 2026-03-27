declare const SNAPSHOT: {
    adapterType: string;
    supported: boolean;
    mode: string;
    desiredSkills: string[];
    entries: string[];
    warnings: string[];
};
export declare function listOpenRouterSkills(_ctx: unknown): Promise<typeof SNAPSHOT>;
export declare function syncOpenRouterSkills(_ctx: unknown, desiredSkills: string[]): Promise<typeof SNAPSHOT>;
export {};
//# sourceMappingURL=skills.d.ts.map