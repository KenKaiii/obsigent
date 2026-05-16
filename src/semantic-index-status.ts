export function shouldOfferEmbeddingModelDownload(
  statusText: string,
  embeddingModel: string,
): boolean {
  return statusText.includes(`ollama pull ${embeddingModel}`);
}
