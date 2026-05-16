import type { Provider } from "@kenkaiiii/gg-ai";
import { getOllamaProviderName } from "./ollama-provider";
import { getOpenAiCompatibleProviderName } from "./openai-compatible-provider";
import type { ObsigentSettings } from "./settings";

export type ChatProviderConfig = Readonly<{
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}>;

export function getChatProviderConfig(settings: ObsigentSettings): ChatProviderConfig {
  if (settings.provider === "openai-compatible") {
    return {
      provider: getOpenAiCompatibleProviderName() as Provider,
      baseUrl: settings.openAiCompatibleEndpoint.replace(/\/+$/u, ""),
      model: settings.model,
    };
  }

  return {
    provider: getOllamaProviderName() as Provider,
    baseUrl: settings.localEndpoint.replace(/\/v1\/?$/u, ""),
    model: settings.model,
  };
}
