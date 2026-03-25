import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

const SNAPSHOT: AdapterSkillSnapshot = {
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

export async function listOpenRouterSkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return SNAPSHOT;
}

export async function syncOpenRouterSkills(
  _ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return SNAPSHOT;
}
