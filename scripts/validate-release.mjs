import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));

const requiredFiles = ["main.js", "manifest.json", "styles.css"];
for (const file of requiredFiles) {
  await readFile(file);
}

if (packageJson.version !== manifest.version) {
  throw new Error(
    `package.json version ${packageJson.version} does not match manifest ${manifest.version}`,
  );
}

if (!versions[manifest.version]) {
  throw new Error(`versions.json does not include ${manifest.version}`);
}

console.log(`Release ${manifest.version} is valid.`);
