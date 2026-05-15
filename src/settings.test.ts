import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";

describe("DEFAULT_SETTINGS", () => {
  it("starts in approve-writes mode", () => {
    expect(DEFAULT_SETTINGS.safetyMode).toBe("approve-writes");
  });

  it("uses a local endpoint", () => {
    expect(DEFAULT_SETTINGS.localEndpoint).toMatch(/^http:\/\/localhost:/u);
  });
});
