import { describe, expect, it } from "vitest";
import {
  EMBEDDING_MODELS,
  getEmbeddingModel,
  getVisionModel,
  isVisionCatalogModel,
  toPullProgress,
  VISION_MODELS,
} from "./model-manager";

describe("model manager", () => {
  it("only exposes known local vision model choices", () => {
    expect(VISION_MODELS.map((model) => model.id)).toEqual([
      "gemma4:e2b",
      "qwen2.5vl:3b",
      "granite3.2-vision:2b",
      "moondream:1.8b",
    ]);
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
    expect(getEmbeddingModel("custom-embedding:latest")).toEqual({
      id: "custom-embedding:latest",
      label: "custom-embedding:latest",
      sizeLabel: "Installed",
    });
  });

  it("computes pull percentages from Ollama progress chunks", () => {
    expect(
      toPullProgress("qwen2.5vl:3b", {
        status: "pulling manifest",
        completed: 25,
        total: 100,
      }),
    ).toEqual({
      model: "qwen2.5vl:3b",
      status: "pulling manifest",
      completed: 25,
      total: 100,
      percent: 25,
    });
  });
});
