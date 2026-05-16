import { describe, expect, it } from "vitest";
import {
  assertSelectionFresh,
  createSelectionEditProposal,
  parseAssistantEditProposal,
} from "./edit-proposals";

describe("edit proposals", () => {
  it("creates replacement proposals for selected text", () => {
    expect(createSelectionEditProposal("rough", "polished")).toEqual({
      kind: "replace-selection",
      before: "rough",
      after: "polished",
    });
  });

  it("extracts fenced assistant edit output", () => {
    expect(parseAssistantEditProposal("```markdown\nBetter text\n```", "old").after).toBe(
      "Better text",
    );
  });

  it("extracts explicit edit blocks", () => {
    expect(parseAssistantEditProposal("<edit>Better text</edit>", "old").after).toBe("Better text");
  });

  it("guards against stale editor selections", () => {
    expect(() =>
      assertSelectionFresh("changed", createSelectionEditProposal("original", "replacement")),
    ).toThrow("Selection changed before the proposed edit could be applied.");
  });
});
