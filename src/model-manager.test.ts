import { describe, expect, it } from "vitest";
import {
  EMBEDDING_MODELS,
  getEmbeddingModel,
  getVisionModel,
  isEmbeddingCatalogModel,
  isVisionCatalogModel,
  toPullProgress,
  VISION_MODELS,
} from "./model-manager";

describe("model manager", () => {
  it("only exposes known local vision model choices", () => {
    expect(VISION_MODELS.map((model) => model.id)).toContain("gemma4:e2b");
    expect(VISION_MODELS.map((model) => model.id)).toContain("gemma3:4b");
    expect(VISION_MODELS.every((model) => model.sizeLabel.length > 0)).toBe(true);
  });

  it("exposes known local embedding model choices", () => {
    expect(EMBEDDING_MODELS.map((model) => model.id)).toContain("nomic-embed-text");
    expect(EMBEDDING_MODELS.map((model) => model.id)).toContain("mxbai-embed-large");
    expect(EMBEDDING_MODELS.every((model) => model.sizeLabel.length > 0)).toBe(true);
  });

  it("falls back for installed models outside the catalog", () => {
    expect(isVisionCatalogModel("custom-vision:latest")).toBe(false);
    expect(getVisionModel("custom-vision:latest")).toEqual({
      id: "custom-vision:latest",
      label: "custom-vision:latest",
      sizeLabel: "Installed",
    });
    expect(isEmbeddingCatalogModel("custom-embedding:latest")).toBe(false);
    expect(getEmbeddingModel("custom-embedding:latest")).toEqual({
      id: "custom-embedding:latest",
      label: "custom-embedding:latest",
      sizeLabel: "Installed",
    });
  });

  it("computes pull percentages from Ollama progress chunks", () => {
    expect(
      toPullProgress("gemma3:4b", {
        status: "pulling manifest",
        completed: 25,
        total: 100,
      }),
    ).toEqual({
      model: "gemma3:4b",
      status: "pulling manifest",
      completed: 25,
      total: 100,
      percent: 25,
    });
  });
});
