export type EditProposal = Readonly<{
  kind: "replace-selection" | "append-to-note";
  before: string;
  after: string;
}>;

export function createSelectionEditProposal(before: string, after: string): EditProposal {
  return {
    kind: "replace-selection",
    before,
    after: cleanAssistantEditText(after),
  };
}

export function parseAssistantEditProposal(response: string, before: string): EditProposal {
  return createSelectionEditProposal(before, response);
}

function cleanAssistantEditText(response: string): string {
  const fenced = /^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(response.trim());
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const editBlock = /<edit>([\s\S]*?)<\/edit>/iu.exec(response.trim());
  if (editBlock?.[1]) {
    return editBlock[1].trim();
  }

  return response.trim();
}

export function assertSelectionFresh(currentSelection: string, proposal: EditProposal): void {
  if (currentSelection !== proposal.before) {
    throw new Error("Selection changed before the proposed edit could be applied.");
  }
}
