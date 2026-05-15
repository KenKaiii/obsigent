import { describe, expect, it } from "vitest";
import { ATTACHMENT_ACCEPT, isSupportedAttachment, processAttachment } from "./attachments";

function makeFile(content: string, name: string, type = "text/plain"): File {
  return new File([content], name, { type });
}

describe("attachments", () => {
  it("exposes a picker accept list for supported attachment types", () => {
    expect(ATTACHMENT_ACCEPT).toContain(".png");
    expect(ATTACHMENT_ACCEPT).toContain(".pdf");
    expect(ATTACHMENT_ACCEPT).toContain(".csv");
    expect(ATTACHMENT_ACCEPT).toContain(".xlsx");
  });

  it("rejects unsupported attachment extensions", () => {
    expect(isSupportedAttachment(makeFile("hi", "notes.txt"))).toBe(true);
    expect(isSupportedAttachment(makeFile("hi", "archive.zip", "application/zip"))).toBe(false);
  });

  it("processes text-like files into text content parts", async () => {
    const attachment = await processAttachment(makeFile("a,b\n1,2", "data.csv", "text/csv"));

    expect(attachment.name).toBe("data.csv");
    expect(attachment.parts).toEqual([
      {
        type: "text",
        text: "Attached file: data.csv (7 B)\n\na,b\n1,2",
      },
    ]);
  });

  it("processes image files into image content parts", async () => {
    const attachment = await processAttachment(makeFile("fake-image", "photo.png", "image/png"));

    expect(attachment.parts[0]).toEqual({
      type: "text",
      text: "Attached image: photo.png (10 B).",
    });
    expect(attachment.parts[1]).toMatchObject({
      type: "image",
      mediaType: "image/png",
    });
  });
});
