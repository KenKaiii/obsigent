import { describe, expect, it } from "vitest";
import { getOllamaProviderName } from "./ollama-provider";
import { getOpenAiCompatibleProviderName } from "./openai-compatible-provider";
import { getChatProviderConfig } from "./provider-config";
import { DEFAULT_SETTINGS } from "./settings";

describe("provider config", () => {
  it("uses Ollama by default", () => {
    expect(getChatProviderConfig(DEFAULT_SETTINGS)).toEqual({
      provider: getOllamaProviderName(),
      baseUrl: "http://localhost:11434",
      model: DEFAULT_SETTINGS.model,
    });
  });

  it("uses OpenAI-compatible endpoint when selected", () => {
    expect(
      getChatProviderConfig({
        ...DEFAULT_SETTINGS,
        provider: "openai-compatible",
        openAiCompatibleEndpoint: "http://localhost:1234/v1/",
        model: "local-model",
      }),
    ).toEqual({
      provider: getOpenAiCompatibleProviderName(),
      baseUrl: "http://localhost:1234/v1",
      model: "local-model",
    });
  });
});
