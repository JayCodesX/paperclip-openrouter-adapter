import { models as fallbackModels } from "../index.js";

const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes — aligns with execute-cli.ts vision cache TTL

export type AdapterModel = { id: string; label: string; supportsVision: boolean };

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

async function fetchModels(): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];

    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id.trim() : "";
      if (!id) continue;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const arch = typeof r.architecture === "object" && r.architecture !== null
        ? r.architecture as Record<string, unknown>
        : null;
      const modalities =
        r.input_modalities ?? arch?.input_modalities ?? [];
      const supportsVision = Array.isArray(modalities) && modalities.includes("image");
      models.push({ id, label: name || id, supportsVision });
    }
    return models;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function listOpenRouterModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  const fetched = await fetchModels();
  if (fetched.length > 0) {
    cached = { expiresAt: now + CACHE_TTL_MS, models: fetched };
    return fetched;
  }

  // Return stale cache rather than falling back to hardcoded list
  if (cached && cached.models.length > 0) return cached.models;

  return fallbackModels;
}

// Synchronous read of the live cache — no fetch triggered.
// Used by checkVisionSupport to avoid a redundant network call when the shared
// list is already warm (populated by a prior listOpenRouterModels call).
// Returns undefined if the cache is cold or expired.
export function getModelFromLiveCache(model: string): AdapterModel | undefined {
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) return undefined;
  return cached.models.find((m) => m.id === model);
}

export function _resetModelCacheForTesting(): void {
  cached = null;
}
