import { describe, expect, it } from "vitest";
import { shouldOfferEmbeddingModelDownload } from "./semantic-index-status";

describe("shouldOfferEmbeddingModelDownload", () => {
  it("offers download when the status includes the configured Ollama pull command", () => {
    expect(
      shouldOfferEmbeddingModelDownload(
        "Embedding model nomic-embed-text is not installed in Ollama. Run: ollama pull nomic-embed-text",
        "nomic-embed-text",
      ),
    ).toBe(true);
  });

  it("does not offer download for unrelated index failures", () => {
    expect(
      shouldOfferEmbeddingModelDownload(
        "Ollama embedding APIs are unavailable at http://localhost:11434.",
        "nomic-embed-text",
      ),
    ).toBe(false);
  });
});
