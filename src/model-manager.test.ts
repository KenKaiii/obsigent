import { describe, expect, it } from "vitest";
import {
  getVisionModel,
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

  it("falls back for an installed model outside the catalog", () => {
    expect(isVisionCatalogModel("custom-vision:latest")).toBe(false);
    expect(getVisionModel("custom-vision:latest")).toEqual({
      id: "custom-vision:latest",
      label: "custom-vision:latest",
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
