export type EmbeddingRequest = Readonly<{
  endpoint: string;
  model: string;
  input: string | readonly string[];
  signal?: AbortSignal;
}>;

export type EmbeddingResult = Readonly<{
  embeddings: readonly (readonly number[])[];
}>;

type OllamaEmbedResponse = Readonly<{
  embeddings?: unknown;
}>;

type OllamaEmbeddingsResponse = Readonly<{
  embedding?: unknown;
}>;

export async function embedWithOllama(request: EmbeddingRequest): Promise<EmbeddingResult> {
  const input = normalizeInput(request.input);
  if (input.length === 0) {
    return { embeddings: [] };
  }

  const embedResult = await requestOllamaEmbed({ ...request, input });
  if (embedResult.ok) {
    return embedResult.value;
  }

  if (isMissingModelResult(embedResult, request.model)) {
    throw new Error(formatMissingEmbeddingModelMessage(request.model));
  }

  if (!embedResult.shouldFallback) {
    throw new Error(embedResult.message);
  }

  const legacyResult = await requestOllamaLegacyEmbeddings({ ...request, input });
  if (legacyResult.ok) {
    return legacyResult.value;
  }

  if (isMissingModelResult(legacyResult, request.model)) {
    throw new Error(formatMissingEmbeddingModelMessage(request.model));
  }

  if (embedResult.status === 404 && legacyResult.status === 404) {
    throw new Error(
      `Ollama embedding APIs are unavailable at ${new URL(request.endpoint).origin}. Update Ollama to a version that supports /api/embed.`,
    );
  }

  throw new Error(
    `${embedResult.message} Legacy /api/embeddings also failed: ${legacyResult.message}`,
  );
}

type ProviderResult =
  | Readonly<{ ok: true; value: EmbeddingResult }>
  | Readonly<{ ok: false; message: string; shouldFallback: boolean; status: number | null }>;

async function requestOllamaEmbed(
  request: Omit<EmbeddingRequest, "input"> & Readonly<{ input: readonly string[] }>,
): Promise<ProviderResult> {
  const url = new URL("/api/embed", new URL(request.endpoint).origin);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: request.model,
      input: request.input.length === 1 ? request.input[0] : request.input,
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `Ollama embeddings endpoint returned ${response.status}: ${await response.text()}`,
      shouldFallback: response.status === 404,
      status: response.status,
    };
  }

  const body = (await response.json()) as OllamaEmbedResponse;
  return parseEmbeddingRows(body.embeddings, request.input.length, "/api/embed");
}

async function requestOllamaLegacyEmbeddings(
  request: Omit<EmbeddingRequest, "input"> & Readonly<{ input: readonly string[] }>,
): Promise<ProviderResult> {
  const embeddings: (readonly number[])[] = [];

  for (const input of request.input) {
    const url = new URL("/api/embeddings", new URL(request.endpoint).origin);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: request.model, prompt: input }),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok) {
      return {
        ok: false,
        message: `Ollama legacy embeddings endpoint returned ${response.status}: ${await response.text()}`,
        shouldFallback: false,
        status: response.status,
      };
    }

    const body = (await response.json()) as OllamaEmbeddingsResponse;
    const parsed = parseEmbeddingVector(body.embedding, "/api/embeddings");
    if (!parsed.ok) {
      return { ok: false, message: parsed.message, shouldFallback: false, status: null };
    }
    embeddings.push(parsed.value);
  }

  return { ok: true, value: { embeddings } };
}

function isMissingModelResult(result: ProviderResult, model: string): boolean {
  return (
    !result.ok && result.status === 404 && result.message.includes(`model \\"${model}\\" not found`)
  );
}

function formatMissingEmbeddingModelMessage(model: string): string {
  return `Embedding model ${model} is not installed in Ollama. Run: ollama pull ${model}`;
}

function normalizeInput(input: string | readonly string[]): readonly string[] {
  const values = typeof input === "string" ? [input] : [...input];
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseEmbeddingRows(
  value: unknown,
  expectedCount: number,
  endpoint: string,
): ProviderResult {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      message: `Ollama ${endpoint} response did not include embeddings.`,
      shouldFallback: false,
      status: null,
    };
  }

  const embeddings = value.map((row) => parseEmbeddingVector(row, endpoint));
  const invalid = embeddings.find((row) => !row.ok);
  if (invalid && !invalid.ok) {
    return { ok: false, message: invalid.message, shouldFallback: false, status: null };
  }

  if (embeddings.length !== expectedCount) {
    return {
      ok: false,
      message: `Ollama ${endpoint} returned ${embeddings.length} embeddings for ${expectedCount} inputs.`,
      shouldFallback: false,
      status: null,
    };
  }

  return {
    ok: true,
    value: { embeddings: embeddings.map((row) => (row.ok ? row.value : [])) },
  };
}

type VectorParseResult =
  | Readonly<{ ok: true; value: readonly number[] }>
  | Readonly<{ ok: false; message: string }>;

function parseEmbeddingVector(value: unknown, endpoint: string): VectorParseResult {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      message: `Ollama ${endpoint} response included an empty or invalid embedding.`,
    };
  }

  const vector = value.flatMap((item): number[] =>
    typeof item === "number" && Number.isFinite(item) ? [item] : [],
  );
  if (vector.length !== value.length) {
    return {
      ok: false,
      message: `Ollama ${endpoint} response included a non-numeric embedding value.`,
    };
  }

  return { ok: true, value: vector };
}
