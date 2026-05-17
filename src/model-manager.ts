export type VisionModel = Readonly<{
  id: string;
  label: string;
  sizeLabel: string;
}>;

export type EmbeddingModel = Readonly<{
  id: string;
  label: string;
  sizeLabel: string;
}>;

export type LocalModel = Readonly<{
  name: string;
  size: number;
}>;

export type PullProgress = Readonly<{
  model: string;
  status: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
}>;

type OllamaTagsResponse = Readonly<{
  models?: readonly Readonly<{
    name?: string;
    model?: string;
    size?: number;
  }>[];
}>;

type OllamaPullChunk = Readonly<{
  status?: string;
  completed?: number;
  total?: number;
}>;

export const EMBEDDING_MODELS: readonly EmbeddingModel[] = [
  {
    id: "nomic-embed-text",
    label: "Nomic Embed Text",
    sizeLabel: "~274 MB",
  },
  {
    id: "mxbai-embed-large",
    label: "Mxbai Embed Large",
    sizeLabel: "~670 MB",
  },
  {
    id: "embeddinggemma",
    label: "EmbeddingGemma",
    sizeLabel: "Recommended",
  },
];

export const VISION_MODELS: readonly VisionModel[] = [
  {
    id: "gemma4:e2b",
    label: "Gemma 4 E2B",
    sizeLabel: "Current",
  },
  {
    id: "gemma3:4b",
    label: "Gemma 3 4B",
    sizeLabel: "~3.3 GB",
  },
  {
    id: "qwen2.5vl:3b",
    label: "Qwen2.5-VL 3B",
    sizeLabel: "~2.9 GB",
  },
  {
    id: "moondream:1.8b",
    label: "Moondream 1.8B",
    sizeLabel: "~1.7 GB",
  },
  {
    id: "granite3.2-vision:2b",
    label: "Granite Vision 2B",
    sizeLabel: "~2.4 GB",
  },
];

export async function listLocalModels(
  endpoint: string,
  signal?: AbortSignal,
): Promise<LocalModel[]> {
  const url = new URL("/api/tags", getOllamaOrigin(endpoint));
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as OllamaTagsResponse;
  return (body.models ?? [])
    .flatMap((model): LocalModel[] => {
      const name = model.name ?? model.model;
      if (!name) {
        return [];
      }

      return [
        {
          name,
          size: model.size ?? 0,
        },
      ];
    })
    .sort((first, second) => first.name.localeCompare(second.name));
}

export async function pullModel(
  endpoint: string,
  model: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL("/api/pull", getOllamaOrigin(endpoint));
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error("Ollama pull response did not include a stream body.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          continue;
        }

        onProgress(toPullProgress(model, parsePullChunk(trimmedLine)));
      }
    }

    if (buffer.trim()) {
      onProgress(toPullProgress(model, parsePullChunk(buffer.trim())));
    }
  } finally {
    reader.releaseLock();
  }
}

export function getEmbeddingModel(modelId: string): EmbeddingModel {
  return (
    EMBEDDING_MODELS.find((model) => model.id === modelId) ?? {
      id: modelId,
      label: modelId,
      sizeLabel: "Installed",
    }
  );
}

export function getVisionModel(modelId: string): VisionModel {
  return (
    VISION_MODELS.find((model) => model.id === modelId) ?? {
      id: modelId,
      label: modelId,
      sizeLabel: "Installed",
    }
  );
}

export function isVisionCatalogModel(modelId: string): boolean {
  return VISION_MODELS.some((model) => model.id === modelId);
}

function parsePullChunk(line: string): OllamaPullChunk {
  const parsed = JSON.parse(line) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as OllamaPullChunk) : {};
}

export function toPullProgress(model: string, chunk: OllamaPullChunk): PullProgress {
  const completed = typeof chunk.completed === "number" ? chunk.completed : null;
  const total = typeof chunk.total === "number" && chunk.total > 0 ? chunk.total : null;
  const percent =
    completed !== null && total !== null ? Math.min(100, (completed / total) * 100) : null;
  return {
    model,
    status: chunk.status ?? "pulling",
    completed,
    total,
    percent,
  };
}

function getOllamaOrigin(endpoint: string): string {
  return new URL(endpoint).origin;
}
