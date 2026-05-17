import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await execFileAsync("zip", ["-j", "dist/obsigent.zip", "main.js", "manifest.json", "styles.css"]);
console.log("Packaged dist/obsigent.zip");
