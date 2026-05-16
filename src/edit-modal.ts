import { type App, Modal } from "obsidian";
import type { EditProposal } from "./edit-proposals";

export async function openEditProposalModal(app: App, proposal: EditProposal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    class EditProposalModal extends Modal {
      private resolved = false;

      public override onOpen(): void {
        this.setTitle("Approve Obsigent edit");
        this.contentEl.empty();
        this.contentEl.createEl("p", {
          text:
            proposal.kind === "replace-selection" ? "Replace selected text?" : "Append to note?",
        });
        const diff = this.contentEl.createDiv({ cls: "obsigent-edit-diff" });
        diff.createEl("pre", {
          cls: "obsigent-edit-before",
          text: proposal.before || "[empty]",
        });
        diff.createEl("pre", {
          cls: "obsigent-edit-after",
          text: proposal.after || "[empty]",
        });

        const actions = this.contentEl.createDiv({ cls: "obsigent-write-actions" });
        const rejectButton = actions.createEl("button", { text: "Reject", type: "button" });
        rejectButton.addEventListener("click", () => this.finish(false));
        const approveButton = actions.createEl("button", {
          cls: "mod-cta",
          text: "Apply edit",
          type: "button",
        });
        approveButton.addEventListener("click", () => this.finish(true));
      }

      public override onClose(): void {
        this.finish(false);
      }

      private finish(approved: boolean): void {
        if (this.resolved) {
          return;
        }
        this.resolved = true;
        resolve(approved);
        this.close();
      }
    }

    new EditProposalModal(app).open();
  });
}
