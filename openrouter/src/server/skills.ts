// Skills are not managed by the OpenRouter adapter.
// Return a "not supported" snapshot so the skills screen renders cleanly.

const SNAPSHOT = {
  adapterType: "openrouter",
  supported: false,
  mode: null,
  desiredSkills: [],
  entries: [],
  warnings: [
    "Skills are not managed by the OpenRouter adapter. " +
      "Install skills directly in your orager/Claude environment.",
  ],
};

export async function listOpenRouterSkills(_ctx: unknown): Promise<typeof SNAPSHOT> {
  return SNAPSHOT;
}

export async function syncOpenRouterSkills(
  _ctx: unknown,
  _desiredSkills: string[],
): Promise<typeof SNAPSHOT> {
  return SNAPSHOT;
}
