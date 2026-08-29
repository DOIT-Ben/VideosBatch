import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import WordExtractor from "word-extractor";

export const MAX_LESSON_FILE_BYTES = 25 * 1024 * 1024;

export type LessonDocumentType = "doc" | "docx" | "pdf";

export interface ParsedLessonDocument {
  sourceKind: "file";
  fileName: string;
  fileType: LessonDocumentType;
  mimeType: string;
  sizeBytes: number;
  text: string;
  characterCount: number;
  paragraphCount: number;
  pageCount?: number;
  warnings: string[];
}

const DOC_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const DOCX_ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08])
];
const MIN_MEANINGFUL_TEXT_CHARACTERS = 40;

function startsWith(buffer: Buffer, signature: Buffer) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function extensionOf(fileName: string) {
  const match = fileName.trim().toLowerCase().match(/\.([^.]+)$/);
  return match?.[1] || "";
}

export function validateLessonFileSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error("Lesson document is empty or has an invalid size.");
  }
  if (sizeBytes > MAX_LESSON_FILE_BYTES) {
    throw new Error("Lesson document is too large. The maximum supported size is 25 MB.");
  }
}

export function detectLessonDocumentType(fileName: string, buffer: Buffer): LessonDocumentType {
  validateLessonFileSize(buffer.length);
  const extension = extensionOf(fileName);
  if (extension !== "doc" && extension !== "docx" && extension !== "pdf") {
    throw new Error("Unsupported lesson document type. Please upload DOC, DOCX, or PDF.");
  }

  if (extension === "pdf") {
    if (!startsWith(buffer, PDF_SIGNATURE)) {
      throw new Error("PDF file signature does not match the .pdf extension.");
    }
    return "pdf";
  }

  if (extension === "doc") {
    if (!startsWith(buffer, DOC_SIGNATURE)) {
      throw new Error("DOC file signature does not match the legacy Word .doc format.");
    }
    return "doc";
  }

  if (!DOCX_ZIP_SIGNATURES.some((signature) => startsWith(buffer, signature))) {
    throw new Error("DOCX file signature does not match an Office Open XML document.");
  }
  return "docx";
}

export function normalizeLessonText(value: string) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function meaningfulCharacterCount(value: string) {
  return value.replace(/\s/g, "").length;
}

function paragraphCount(value: string) {
  return value
    .split(/\n\s*\n|\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean).length;
}

function requireMeaningfulText(text: string, fileType: LessonDocumentType) {
  if (meaningfulCharacterCount(text) >= MIN_MEANINGFUL_TEXT_CHARACTERS) return;
  if (fileType === "pdf") {
    throw new Error("未从 PDF 中提取到足够的教案文字。该 PDF 可能是扫描版，需要 OCR 后再使用。");
  }
  throw new Error("未从教案文件中提取到足够的有效文字，请检查文件内容或改用粘贴文本。");
}

async function parseDocx(buffer: Buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value,
    warnings: result.messages
      .filter((message) => message.type === "warning")
      .map((message) => message.message)
      .filter(Boolean)
  };
}

async function parseDoc(buffer: Buffer) {
  const extractor = new WordExtractor();
  const document = await extractor.extract(buffer);
  return { text: document.getBody(), warnings: [] as string[] };
}

async function parsePdf(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return {
      text: result.text,
      pageCount: result.total,
      warnings: [] as string[]
    };
  } finally {
    await parser.destroy();
  }
}

export async function parseLessonDocument(input: {
  fileName: string;
  mimeType?: string;
  buffer: Buffer;
}): Promise<ParsedLessonDocument> {
  const fileName = input.fileName.trim();
  if (!fileName) throw new Error("Lesson document filename is required.");
  validateLessonFileSize(input.buffer.length);
  const fileType = detectLessonDocumentType(fileName, input.buffer);

  let parsed: { text: string; warnings: string[]; pageCount?: number };
  try {
    if (fileType === "docx") parsed = await parseDocx(input.buffer);
    else if (fileType === "doc") parsed = await parseDoc(input.buffer);
    else parsed = await parsePdf(input.buffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`教案文件解析失败：${detail}`);
  }

  const text = normalizeLessonText(parsed.text);
  requireMeaningfulText(text, fileType);

  return {
    sourceKind: "file",
    fileName,
    fileType,
    mimeType: input.mimeType?.trim() || "application/octet-stream",
    sizeBytes: input.buffer.length,
    text,
    characterCount: text.length,
    paragraphCount: paragraphCount(text),
    pageCount: parsed.pageCount,
    warnings: parsed.warnings
  };
}
