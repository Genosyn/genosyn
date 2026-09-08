import JSZip from "jszip";
import { TextDecoder } from "node:util";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const WORKBOOK_PART = "xl/workbook.xml";
export const XLSX_MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
export const XLSX_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const XLSX_MAX_PART_BYTES = 32 * 1024 * 1024;
export const XLSX_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export class XlsxError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "XlsxError";
    this.status = status;
  }
}

/** Recognize older Excel files too, so their unsupported-format error is actionable. */
export function looksLikeSpreadsheet(mimeType: string, filename: string): boolean {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (/\.(csv|tsv)$/i.test(filename) || ["text/csv", "text/tab-separated-values"].includes(mime))
    return false;
  return (
    /\.(xlsx|xls|xlsm|xlsb|xltx|xltm)$/i.test(filename) ||
    mime === XLSX_MIME ||
    mime === "application/vnd.ms-excel" ||
    mime.startsWith("application/vnd.ms-excel.") ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.template"
  );
}

async function collectBounded(
  stream: NodeJS.ReadableStream,
  limit: number,
  label: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(
          new XlsxError(`${label} exceeds the ${Math.floor(limit / 1024 / 1024)} MB size limit.`),
        );
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (error: Error) => {
      if (!failed) reject(new XlsxError(`Could not read ${label}: ${error.message}`));
    });
    stream.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks, size));
    });
  });
}

/** ZIP parts stay compressed until needed; edits replace only explicitly changed XML. */
export class XlsxPackage {
  private readonly cache = new Map<string, string>();

  private constructor(private readonly zip: JSZip) {}

  static async open(bytes: Buffer): Promise<XlsxPackage> {
    if (bytes.length === 0) throw new XlsxError("The workbook is empty.");
    if (bytes.length > XLSX_MAX_ARCHIVE_BYTES)
      throw new XlsxError("The workbook exceeds the 25 MB file limit.");
    if (
      bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    ) {
      throw new XlsxError(
        "This is a legacy .xls workbook or an encrypted Office file. Open it in Excel, remove any file password, and save a copy as .xlsx.",
      );
    }
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new XlsxError(
        "This file is not an .xlsx workbook. Export or save the original Excel form as .xlsx.",
      );
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new XlsxError(
        "The workbook ZIP archive is unreadable or encrypted. Open it in Excel and save an unencrypted .xlsx copy.",
      );
    }
    const entries = Object.values(zip.files);
    if (entries.length > MAX_ENTRIES)
      throw new XlsxError("This workbook has too many package parts to process.");
    let expanded = 0;
    for (const entry of entries) {
      const original =
        (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
      if (
        original.startsWith("/") ||
        original.includes("\\") ||
        original.split("/").includes("..") ||
        original.includes("\0")
      ) {
        throw new XlsxError(
          "The workbook contains an invalid package part path. Save a fresh .xlsx copy in Excel.",
        );
      }
      const size =
        (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ??
        0;
      if (!Number.isSafeInteger(size) || size < 0 || size > XLSX_MAX_PART_BYTES) {
        throw new XlsxError(`Workbook part ${entry.name} exceeds the 32 MB expanded size limit.`);
      }
      expanded += size;
      if (expanded > XLSX_MAX_TOTAL_BYTES)
        throw new XlsxError("This workbook exceeds the 128 MB expanded size limit.");
    }
    if (!zip.file(WORKBOOK_PART)) {
      throw new XlsxError(
        zip.file("xl/workbook.bin")
          ? "Binary .xlsb workbooks are not supported. Save an .xlsx copy in Excel."
          : "This file has no Excel workbook XML. Export or save it as .xlsx.",
      );
    }
    return new XlsxPackage(zip);
  }

  get parts(): string[] {
    return Object.values(this.zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name);
  }

  has(part: string): boolean {
    return Boolean(this.zip.file(part));
  }

  async text(part: string): Promise<string | null> {
    const cached = this.cache.get(part);
    if (cached !== undefined) return cached;
    const entry = this.zip.file(part);
    if (!entry) return null;
    const bytes = await collectBounded(entry.nodeStream("nodebuffer"), XLSX_MAX_PART_BYTES, part);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new XlsxError(`${part} is not UTF-8 XML. Save a fresh .xlsx copy in Excel.`);
    }
    this.cache.set(part, source);
    return source;
  }

  async requireText(part: string): Promise<string> {
    const source = await this.text(part);
    if (source === null)
      throw new XlsxError(`The workbook is missing ${part}. Save a fresh .xlsx copy in Excel.`);
    return source;
  }

  setText(part: string, source: string): void {
    if (Buffer.byteLength(source, "utf8") > XLSX_MAX_PART_BYTES)
      throw new XlsxError(`The edited ${part} exceeds the 32 MB size limit.`);
    this.cache.set(part, source);
    this.zip.file(part, source, { createFolders: false });
  }

  async save(): Promise<Buffer> {
    return collectBounded(
      this.zip.generateNodeStream({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
        streamFiles: true,
      }),
      XLSX_MAX_ARCHIVE_BYTES,
      "The edited workbook",
    );
  }
}
