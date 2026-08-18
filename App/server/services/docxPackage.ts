import JSZip from "jszip";

/**
 * The zip layer under every Word tool: open a `.docx`, reach its XML parts,
 * put changed ones back, and save.
 *
 * A `.docx` is an Open Packaging Convention zip. `word/document.xml` holds the
 * body; the styles, numbering definitions, headers, footers, footnotes and
 * comments each live in their own part, and `[Content_Types].xml` plus the
 * `_rels` parts stitch them together. Nothing here understands what is inside
 * a part — that is {@link file://./docxRead.ts} and
 * {@link file://./docxEdit.ts}. This module's whole job is to make sure that
 * a part we never opened is byte-identical in the file we hand back, and that
 * a file which is not a Word document is refused with a message a model can
 * act on rather than a stack trace.
 */

/** `.docx` — the ordinary Word document. */
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** `.dotx` — a Word template. Same body part, different content type. */
export const DOTX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template";
/** `.docm` — a macro-enabled document. We read and edit it; macros ride along. */
export const DOCM_MIME = "application/vnd.ms-word.document.macroEnabled.12";
/** `.dotm` — a macro-enabled template. */
export const DOTM_MIME = "application/vnd.ms-word.template.macroEnabled.12";

/** The main body part of a WordprocessingML package. */
export const DOCUMENT_PART = "word/document.xml";

const WORD_EXTENSIONS = new Set([".docx", ".dotx", ".docm", ".dotm"]);
// Lowercased on the way in, because `macroEnabled` is spelled with a capital
// E in the registered type and the comparison below folds case.
const WORD_MIMES = new Set(
  [DOCX_MIME, DOTX_MIME, DOCM_MIME, DOTM_MIME].map((mime) => mime.toLowerCase()),
);

/**
 * Per-part read ceiling.
 *
 * A zip is a decompression bomb waiting to happen: 25 MB of upload can hold
 * gigabytes of `word/document.xml`. We never extract a whole archive — only
 * the handful of parts named below — and the ceiling is consulted against the
 * size the entry declares *before* anything is inflated, because a check that
 * runs after the allocation is not a check. 64 MB is far above any real
 * document's body part.
 */
export const MAX_PART_BYTES = 64 * 1024 * 1024;

/** Ceiling on everything we hold decompressed at once, across all parts. */
export const MAX_TOTAL_PART_BYTES = 128 * 1024 * 1024;

/** A caller-fixable problem with the file itself. */
export class DocxError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "DocxError";
    this.status = status;
  }
}

/** True when the filename's extension is one Word writes. */
export function isWordFilename(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return WORD_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/** True when the declared mime type is one of the WordprocessingML types. */
export function isWordMime(mimeType: string): boolean {
  return WORD_MIMES.has(mimeType.split(";")[0]?.trim().toLowerCase() ?? "");
}

/** Either signal is enough — browsers and mail servers disagree constantly. */
export function looksLikeWordDocument(mimeType: string, filename: string): boolean {
  return isWordMime(mimeType) || isWordFilename(filename);
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** The OLE2 compound-file header that opens a pre-2007 `.doc`. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Buffer, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Say what the caller actually handed us.
 *
 * The failure this exists to prevent is the one that started this whole
 * feature: a tool reports "no readable text" and the employee concludes the
 * document is empty. A `.doc`, a `.pages` bundle and a spreadsheet each need a
 * different next move from the human, so each gets its own sentence.
 */
function describeNonWordBytes(bytes: Buffer, zip: JSZip | null): string {
  if (startsWith(bytes, OLE_MAGIC)) {
    return (
      "That is a legacy Word 97–2003 `.doc` file, not a `.docx`. " +
      "Ask for it to be re-saved as .docx (in Word: File → Save As → Word Document)."
    );
  }
  if (!zip) {
    if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      return "That is a PDF, not a Word document. Use read_pdf_layout / read_pdf_fields instead.";
    }
    return "That file is not a Word document — it is not even a zip archive.";
  }
  const parts = Object.keys(zip.files);
  if (parts.some((p) => p.startsWith("xl/"))) {
    return "That is an Excel workbook (.xlsx), not a Word document.";
  }
  if (parts.some((p) => p.startsWith("ppt/"))) {
    return "That is a PowerPoint presentation (.pptx), not a Word document.";
  }
  if (parts.some((p) => p.startsWith("Index/") || p.endsWith(".iwa"))) {
    return "That is an Apple Pages document, not a Word document. Ask for a .docx export.";
  }
  if (parts.some((p) => p === "mimetype" || p.startsWith("META-INF/"))) {
    return (
      "That is an OpenDocument or EPUB file, not a Word document. " +
      "Ask for a .docx export."
    );
  }
  return (
    `That zip has no ${DOCUMENT_PART} part, so it is not a Word document. ` +
    `It contains: ${parts.slice(0, 8).join(", ")}${parts.length > 8 ? ", …" : ""}`
  );
}

/**
 * An opened Word package.
 *
 * Parts are read lazily and cached, and only a part that was explicitly
 * written is re-encoded on {@link DocxPackage.save} — everything else is
 * carried through by JSZip as the bytes it arrived as.
 */
export class DocxPackage {
  private readonly zip: JSZip;
  private readonly cache = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private decompressedBytes = 0;

  private constructor(zip: JSZip) {
    this.zip = zip;
  }

  /**
   * Open bytes as a Word package, or throw a {@link DocxError} naming what the
   * file actually is.
   */
  static async open(bytes: Buffer): Promise<DocxPackage> {
    if (bytes.length === 0) throw new DocxError("The file is empty.");
    let zip: JSZip | null = null;
    if (startsWith(bytes, ZIP_MAGIC)) {
      try {
        zip = await JSZip.loadAsync(bytes);
      } catch (error) {
        throw new DocxError(
          `Could not open the file as a Word document: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!zip || !zip.file(DOCUMENT_PART)) {
      throw new DocxError(describeNonWordBytes(bytes, zip));
    }
    return new DocxPackage(zip);
  }

  /** Every part path in the package, in the order the archive lists them. */
  get parts(): string[] {
    return Object.keys(this.zip.files).filter((path) => !this.zip.files[path].dir);
  }

  has(part: string): boolean {
    return Boolean(this.zip.file(part));
  }

  /**
   * The size a part claims it will decompress to, from the zip's own header.
   *
   * Checking after inflating is not a check at all: deflate reaches about
   * 1000:1 on repetitive XML, so a 25 MB attachment — the upload ceiling — can
   * put tens of gigabytes through `entry.async` before any ceiling is
   * consulted, and the process is gone before the throw. The header can lie,
   * which is why the post-inflate check below stays as a backstop, but a
   * hostile file has to lie in the direction that makes it small.
   */
  private declaredSize(part: string): number | null {
    const entry = this.zip.files[part] as unknown as
      | { _data?: { uncompressedSize?: number } }
      | undefined;
    const declared = entry?._data?.uncompressedSize;
    return typeof declared === "number" && Number.isFinite(declared) ? declared : null;
  }

  private refuseOversized(part: string, size: number): never {
    throw new DocxError(
      `${part} is ${Math.round(size / (1024 * 1024))} MB uncompressed, over the ` +
        `${MAX_PART_BYTES / (1024 * 1024)} MB per-part limit.`,
    );
  }

  /** Read a part as UTF-8 text, capped and cached. Missing parts return null. */
  async text(part: string): Promise<string | null> {
    const cached = this.cache.get(part);
    if (cached !== undefined) return cached;
    const entry = this.zip.file(part);
    if (!entry) return null;

    const declared = this.declaredSize(part);
    if (declared !== null) {
      if (declared > MAX_PART_BYTES) this.refuseOversized(part, declared);
      if (this.decompressedBytes + declared > MAX_TOTAL_PART_BYTES) {
        throw new DocxError(
          "This document expands to more data than the tools will hold in memory.",
        );
      }
    }

    const buffer = await entry.async("nodebuffer");
    if (buffer.length > MAX_PART_BYTES) this.refuseOversized(part, buffer.length);
    this.decompressedBytes += buffer.length;
    if (this.decompressedBytes > MAX_TOTAL_PART_BYTES) {
      throw new DocxError("This document expands to more data than the tools will hold in memory.");
    }
    const value = buffer.toString("utf8");
    this.cache.set(part, value);
    return value;
  }

  /** Read a part that must exist, e.g. the body. */
  async requireText(part: string): Promise<string> {
    const value = await this.text(part);
    if (value === null) throw new DocxError(`This document has no ${part} part.`);
    return value;
  }

  /** Replace a part's XML. Only parts written here are re-encoded on save. */
  setText(part: string, xml: string): void {
    this.cache.set(part, xml);
    this.dirty.add(part);
  }

  /** Add or replace a part with raw bytes (an embedded image, say). */
  setBytes(part: string, bytes: Buffer): void {
    this.cache.delete(part);
    this.dirty.delete(part);
    this.zip.file(part, bytes, { createFolders: false });
  }

  /**
   * The body part plus every header, footer, footnote, endnote and comment
   * part, in a stable order.
   *
   * A questionnaire's answer boxes routinely sit in a header, and a reader
   * that only looked at `word/document.xml` would report the document as
   * blank — the exact failure these tools exist to fix.
   */
  contentParts(): string[] {
    const rest = this.parts
      .filter((path) => path !== DOCUMENT_PART)
      .filter((path) => /^word\/(header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(path))
      .sort();
    return [DOCUMENT_PART, ...rest];
  }

  /** Serialize back to a `.docx`. */
  async save(): Promise<Buffer> {
    for (const part of this.dirty) {
      const xml = this.cache.get(part);
      if (xml === undefined) continue;
      // `createFolders` is not cosmetic here: JSZip would otherwise add a
      // `word/` directory entry the package it opened did not have, so an
      // edited document would come back structurally different from the one
      // that went in — the one thing this module promises not to do.
      this.zip.file(part, xml, { createFolders: false });
    }
    this.dirty.clear();
    return this.zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      streamFiles: false,
    });
  }
}

/**
 * Build a `.docx` from a map of part path → contents.
 *
 * `[Content_Types].xml` has to be the first entry in the archive for the OPC
 * reader to find it, and JSZip writes entries in insertion order — so the
 * caller's map is inserted with that part first regardless of key order.
 */
export async function packDocx(parts: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  const contentTypes = "[Content_Types].xml";
  if (!parts[contentTypes]) {
    throw new DocxError(`Cannot build a document without ${contentTypes}`, 500);
  }
  zip.file(contentTypes, parts[contentTypes], { createFolders: false });
  for (const [path, body] of Object.entries(parts)) {
    if (path === contentTypes) continue;
    zip.file(path, body, { createFolders: false });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    streamFiles: false,
  });
}
