import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const model = process.env.OBSIGENT_MODEL ?? "gemma4:e2b";
const endpoint = process.env.OBSIGENT_OLLAMA_ORIGIN ?? "http://localhost:11434";

function commandExists(command) {
  const result = spawnSync("command", ["-v", command], { shell: true, stdio: "ignore" });
  return result.status === 0;
}

async function canReachOllama() {
  try {
    const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOllama() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await canReachOllama()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Ollama did not become ready at ${endpoint}`);
}

if (!commandExists("ollama")) {
  console.error("Ollama is not installed. Install it from https://ollama.com/download");
  process.exit(1);
}

let serverStarted = false;
if (!(await canReachOllama())) {
  console.log("Starting Ollama server...");
  const child = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  serverStarted = true;
  await waitForOllama();
}

console.log(`Pulling ${model}...`);
const pull = spawnSync("ollama", ["pull", model], { stdio: "inherit" });
if (pull.status !== 0) {
  process.exit(pull.status ?? 1);
}

console.log(`Ready: ${model} at ${endpoint}`);
if (serverStarted) {
  console.log(
    "Ollama was started in the background. Obsigent will unload the model after idle time.",
  );
}
