import { models as fallbackModels } from "../index.js";

const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60_000;

type AdapterModel = { id: string; label: string };

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
      models.push({ id, label: name || id });
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
