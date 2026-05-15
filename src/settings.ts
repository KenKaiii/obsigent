export type ObsigentSettings = Readonly<{
  localEndpoint: string;
  model: string;
  safetyMode: "read-only" | "approve-writes";
  excludedFolders: readonly string[];
  unloadAfterIdleMinutes: number;
  debug: boolean;
}>;

export const DEFAULT_SETTINGS: ObsigentSettings = {
  localEndpoint: "http://localhost:11434",
  model: "gemma4:e2b",
  safetyMode: "approve-writes",
  excludedFolders: [".obsidian", ".git"],
  unloadAfterIdleMinutes: 5,
  debug: false,
};
