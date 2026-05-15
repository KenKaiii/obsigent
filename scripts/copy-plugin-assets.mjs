import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const defaultPluginDir = path.join(
  "/Users/kenkai/Documents/Obsidian Vault",
  ".obsidian",
  "plugins",
  "obsigent",
);

const pluginDir = process.env.OBSIGENT_PLUGIN_DIR ?? defaultPluginDir;
const rootDir = process.cwd();

await mkdir(pluginDir, { recursive: true });

for (const fileName of ["manifest.json", "styles.css"]) {
  await copyFile(path.join(rootDir, fileName), path.join(pluginDir, fileName));
}

console.log(`Copied plugin assets to ${pluginDir}`);
