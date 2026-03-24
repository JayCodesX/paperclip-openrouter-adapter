import type { UIAdapterModule } from "../types";
import { parseOpenRouterStdoutLine } from "@paperclipai/adapter-openrouter/ui";
import { buildOpenRouterConfig } from "@paperclipai/adapter-openrouter/ui";
import { OpenRouterConfigFields } from "./config-fields";

export const openrouterUIAdapter: UIAdapterModule = {
  type: "openrouter",
  label: "OpenRouter (orager)",
  parseStdoutLine: parseOpenRouterStdoutLine,
  ConfigFields: OpenRouterConfigFields,
  buildAdapterConfig: buildOpenRouterConfig,
};
