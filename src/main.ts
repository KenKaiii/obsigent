import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { LocalAgentRuntime } from "./local-agent";
import { registerOllamaProvider } from "./ollama-provider";
import type { ObsigentSettings } from "./settings";
import { DEFAULT_SETTINGS } from "./settings";
import { OBSIGENT_VIEW_TYPE, ObsigentView } from "./view";

export default class ObsigentPlugin extends Plugin {
  public readonly localAgent = new LocalAgentRuntime();
  public settings: ObsigentSettings = DEFAULT_SETTINGS;

  public override async onload(): Promise<void> {
    registerOllamaProvider();
    await this.loadSettings();

    this.registerView(OBSIGENT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ObsigentView(leaf, this));

    this.addRibbonIcon("bot", "Open Obsigent", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-obsigent",
      name: "Open local vault agent",
      callback: () => {
        void this.activateView();
      },
    });
  }

  public override onunload(): void {
    this.localAgent.unloadNow(this.settings);
    this.app.workspace.detachLeavesOfType(OBSIGENT_VIEW_TYPE);
  }

  private async activateView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(OBSIGENT_VIEW_TYPE).first();

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Unable to open Obsigent view.");
      return;
    }

    await leaf.setViewState({ type: OBSIGENT_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<ObsigentSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
    };
  }

  public async saveSettings(nextSettings: ObsigentSettings): Promise<void> {
    this.settings = nextSettings;
    await this.saveData(nextSettings);
  }
}
