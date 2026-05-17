import type { ImageContent, TextContent } from "@kenkaiiii/gg-ai";
import mammoth from "mammoth";

export const ACCEPTED_ATTACHMENT_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".csv",
  ".docx",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".pdf",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".txt",
  ".webp",
] as const;

export const ATTACHMENT_ACCEPT = ["image/*", ...ACCEPTED_ATTACHMENT_EXTENSIONS].join(",");

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS_PER_FILE = 80_000;
const MAX_PDF_PAGES = 40;
type PdfTextItem = Readonly<{ str: string }>;

type PdfJsModule = Readonly<{
  getDocument: (source: Record<string, unknown>) => {
    promise: Promise<{
      numPages: number;
      destroy: () => Promise<void>;
      getPage: (pageNumber: number) => Promise<{
        cleanup: () => void;
        getTextContent: () => Promise<{ items: readonly unknown[] }>;
      }>;
    }>;
  };
}>;

type PdfWorkerModule = Readonly<{
  WorkerMessageHandler: unknown;
}>;

type PdfWorkerGlobal = typeof globalThis & {
  pdfjsWorker?: PdfWorkerModule;
};

const IMAGE_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

const TEXT_EXTENSIONS = new Set([".csv", ".json", ".md", ".txt"]);

export type AttachmentContentPart = TextContent | ImageContent;

export type ProcessedAttachment = Readonly<{
  name: string;
  size: number;
  parts: readonly AttachmentContentPart[];
}>;

export function isSupportedAttachment(file: File): boolean {
  return isImageFile(file) || getAttachmentExtension(file.name) !== null;
}

export async function processAttachment(file: File): Promise<ProcessedAttachment> {
  const extension = getAttachmentExtension(file.name);
  if (!extension && !isImageFile(file)) {
    throw new Error(`${file.name} is not a supported attachment type.`);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than the 20 MB attachment limit.`);
  }

  const imageMimeType = getImageMimeType(file, extension);
  if (imageMimeType) {
    const data = await fileToBase64(file);
    return {
      name: file.name,
      size: file.size,
      parts: [
        makeTextPart(`Attached image: ${file.name} (${formatBytes(file.size)}).`),
        { type: "image", mediaType: imageMimeType, data },
      ],
    };
  }

  const arrayBuffer = await file.arrayBuffer();
  if (!extension) {
    throw new Error(`${file.name} is not a supported text attachment type.`);
  }

  const text = await extractTextAttachment(file, extension, arrayBuffer);
  return {
    name: file.name,
    size: file.size,
    parts: [makeTextPart(formatAttachmentText(file.name, file.size, text))],
  };
}

function getAttachmentExtension(fileName: string): string | null {
  const lowerName = fileName.toLowerCase();
  const extension = ACCEPTED_ATTACHMENT_EXTENSIONS.find((item) => lowerName.endsWith(item));
  return extension ?? null;
}

async function extractTextAttachment(
  file: File,
  extension: string,
  arrayBuffer: ArrayBuffer,
): Promise<string> {
  if (extension === ".pdf") {
    return extractPdfText(arrayBuffer);
  }
  if (extension === ".docx") {
    return extractDocxText(arrayBuffer);
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return file.text();
  }

  throw new Error(`${file.name} is not a supported text attachment type.`);
}

async function extractPdfText(arrayBuffer: ArrayBuffer): Promise<string> {
  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({
    data: new Uint8Array(arrayBuffer.slice(0)),
    disableFontFace: true,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    useWorkerFetch: false,
  });

  const document = await loadingTask.promise;
  try {
    const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .flatMap((item): string[] => (isPdfTextItem(item) ? [item.str] : []))
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();
      if (pageText) {
        pages.push(`--- Page ${pageNumber} ---\n${pageText}`);
      }
      page.cleanup();
    }

    const truncatedNotice =
      document.numPages > pageCount
        ? `\n\n[Only the first ${pageCount} of ${document.numPages} pages were extracted.]`
        : "";
    return `${pages.join("\n\n")}${truncatedNotice}`.trim() || "[No extractable PDF text found.]";
  } finally {
    await document.destroy();
  }
}

async function loadPdfJs(): Promise<PdfJsModule> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJsModule>,
    import("pdfjs-dist/legacy/build/pdf.worker.mjs") as Promise<PdfWorkerModule>,
  ]);
  (globalThis as PdfWorkerGlobal).pdfjsWorker = worker;
  return pdfjs;
}

async function extractDocxText(arrayBuffer: ArrayBuffer): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer });
  const warnings = result.messages.map((message) => message.message).filter(Boolean);
  const warningText = warnings.length ? `\n\n[DOCX warnings: ${warnings.join("; ")}]` : "";
  return `${result.value.trim()}${warningText}`.trim() || "[No extractable DOCX text found.]";
}

function makeTextPart(text: string): TextContent {
  return { type: "text", text: truncateText(text, MAX_TEXT_CHARS_PER_FILE) };
}

function formatAttachmentText(fileName: string, size: number, text: string): string {
  return `Attached file: ${fileName} (${formatBytes(size)})\n\n${text}`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[Attachment text truncated by ${omitted} characters.]`;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function getImageMimeType(file: File, extension: string | null): string | null {
  if (file.type.startsWith("image/")) {
    return file.type;
  }
  return extension ? (IMAGE_MIME_TYPES_BY_EXTENSION[extension] ?? null) : null;
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return typeof (item as { str?: unknown }).str === "string";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
