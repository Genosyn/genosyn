import { test, describe } from "node:test";
import assert from "node:assert/strict";

import JSZip from "jszip";

import {
  DOCM_MIME,
  DOCUMENT_PART,
  DOCX_MIME,
  DOTM_MIME,
  DOTX_MIME,
  DocxError,
  DocxPackage,
  MAX_PART_BYTES,
  isWordFilename,
  isWordMime,
  looksLikeWordDocument,
  packDocx,
} from "./docxPackage.js";
import { W_NAMESPACES, docxFixture, para } from "../test/docxFixtures.js";

/**
 * The zip layer has two jobs, and both of them fail quietly when they break.
 *
 * The first is fidelity. A part nobody opened has to leave `save()` as the
 * bytes it arrived as, because Word is unforgiving about its own package: a
 * header re-encoded on the way through is a document that opens with a repair
 * prompt, and a test that only checks the body would never see it. So the
 * tests here compare whole parts against the exact strings that went in, not
 * against what the reader makes of them.
 *
 * The second is the refusal sentence. An employee handed a `.doc`, a
 * spreadsheet or a Pages export needs to tell a human what to do next, and
 * "could not read the document" only sends it round the loop again. Each
 * refusal below is therefore asserted on the phrase that distinguishes it —
 * the whole point of the module is that these messages are not
 * interchangeable.
 */

/**
 * Enough of a content-types part to build a package with. Nothing in this
 * module parses it; only its position in the archive matters.
 */
const MINIMAL_TYPES =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

/**
 * The body part, spelled out here rather than taken from the fixture builder,
 * so the fidelity tests have an exact string to hold the saved bytes against.
 */
const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<w:document ${W_NAMESPACES}><w:body>${para("Quarterly report")}</w:body></w:document>`;

/** A header part with bytes the test controls, for the same reason. */
const HEADER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<w:hdr ${W_NAMESPACES}>${para("Acme Ltd - confidential")}</w:hdr>`;

/** A package whose body and header are byte-for-byte the strings above. */
function exactFixture(): Promise<Buffer> {
  return docxFixture({
    body: "",
    rawDocument: DOCUMENT_XML,
    extraFiles: { "word/header1.xml": HEADER_XML },
  });
}

/** A zip that is not a Word package — packDocx insists on OPC parts, so build it raw. */
async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(files)) zip.file(path, body);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Run something that must fail, check the status, and hand back the sentence. */
async function refusalFrom(run: () => Promise<unknown>, status = 400): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof DocxError)) throw error;
    assert.equal(error.status, status);
    return error.message;
  }
  return assert.fail("expected a DocxError, but the call succeeded");
}

/** Open bytes that must be refused, and return the message the caller would see. */
function refusalFor(bytes: Buffer): Promise<string> {
  return refusalFrom(() => DocxPackage.open(bytes));
}

/** Every file entry of a package, by path, as the bytes the archive holds. */
async function entriesOf(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = new Map<string, Buffer>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    entries.set(path, await entry.async("nodebuffer"));
  }
  return entries;
}

describe("recognising a Word file", () => {
  test("accepts the four extensions Word writes, whatever the casing", () => {
    for (const name of [
      "report.docx",
      "macros.docm",
      "letterhead.dotx",
      "letterhead.dotm",
      "REPORT.DOCX",
      "Q3.Report.DocX",
    ]) {
      assert.equal(isWordFilename(name), true, name);
    }
  });

  test("rejects the neighbours that get mistaken for a .docx", () => {
    // `.doc` is the one that matters: it is a different format wearing a
    // nearly identical name, and treating it as a package is how the tools
    // used to report a perfectly good document as unreadable.
    for (const name of ["minutes.doc", "report.pdf", "budget.xlsx", "notes.docx.pdf", "README"]) {
      assert.equal(isWordFilename(name), false, name);
    }
  });

  test("accepts a declared mime type with parameters attached", () => {
    // Every type this module exports has to be one it recognises. A fetched
    // URL or a mail attachment with no usable filename has nothing else to go
    // on, and `.docm` arrives from Word's own export with exactly this type.
    for (const mime of [DOCX_MIME, DOTX_MIME, DOCM_MIME, DOTM_MIME]) {
      assert.equal(isWordMime(mime), true, mime);
    }
    // Mail servers append a charset or a name and shout the type; all of it
    // still means the same thing.
    assert.equal(isWordMime(`${DOCX_MIME}; charset=UTF-8`), true);
    assert.equal(isWordMime(` ${DOCX_MIME.toUpperCase()} ; name=report.docx`), true);
  });

  test("rejects mime types that are not WordprocessingML", () => {
    for (const mime of [
      "application/pdf",
      "application/msword",
      "application/octet-stream",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "",
    ]) {
      assert.equal(isWordMime(mime), false, mime);
    }
  });

  test("either signal alone is enough", () => {
    // Browsers upload .docx as application/octet-stream and mail servers send
    // the right type with a mangled filename; insisting on both loses real
    // documents either way.
    assert.equal(looksLikeWordDocument("application/octet-stream", "contract.docx"), true);
    assert.equal(looksLikeWordDocument(DOCX_MIME, "contract"), true);
    assert.equal(looksLikeWordDocument("application/pdf", "contract.pdf"), false);
  });
});

describe("DocxPackage.open", () => {
  test("opens a Word package and exposes its parts", async () => {
    const pkg = await DocxPackage.open(await exactFixture());
    assert.ok(pkg.parts.includes(DOCUMENT_PART));
    assert.ok(pkg.parts.includes("[Content_Types].xml"));
    assert.equal(pkg.has(DOCUMENT_PART), true);
    assert.equal(pkg.has("word/settings.xml"), false);
    assert.equal(await pkg.requireText(DOCUMENT_PART), DOCUMENT_XML);
    assert.equal(await pkg.text("word/header1.xml"), HEADER_XML);
  });

  test("a Word document that carries a spreadsheet part is still a Word document", async () => {
    // The "this is an Excel workbook" verdict keys off an `xl/` part, so it
    // must only ever be reached once word/document.xml has been ruled out.
    // Reorder those checks and a report with a worksheet inside it starts
    // being refused as the wrong file type.
    const bytes = await docxFixture({
      body: para("Sales"),
      extraFiles: { "xl/workbook.xml": "<workbook/>" },
    });
    const pkg = await DocxPackage.open(bytes);
    assert.equal(pkg.has("xl/workbook.xml"), true);
    assert.match(await pkg.requireText(DOCUMENT_PART), /Sales/);
  });

  test("says the file is empty", async () => {
    assert.match(await refusalFor(Buffer.alloc(0)), /empty/);
  });

  test("says bytes that are not an archive are not an archive", async () => {
    const message = await refusalFor(Buffer.from("Dear Sir, please find attached...", "utf8"));
    assert.match(message, /not even a zip archive/);
  });

  test("names a PDF and points at the PDF tools", async () => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.alloc(256, 0x20)]);
    const message = await refusalFor(bytes);
    assert.match(message, /PDF/);
    assert.match(message, /read_pdf_layout/);
  });

  test("names a legacy .doc and says how to convert it", async () => {
    // The OLE2 compound-file header. This is the single most common wrong
    // file: a human clicks "Word document" and gets the 1997 format.
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const message = await refusalFor(Buffer.concat([ole, Buffer.alloc(512)]));
    assert.match(message, /97/);
    assert.match(message, /Save As/);
  });

  test("names an Excel workbook", async () => {
    const bytes = await zipOf({
      "[Content_Types].xml": MINIMAL_TYPES,
      "xl/workbook.xml": "<workbook/>",
      "xl/worksheets/sheet1.xml": "<worksheet/>",
    });
    assert.match(await refusalFor(bytes), /Excel workbook \(\.xlsx\)/);
  });

  test("names a PowerPoint presentation", async () => {
    const bytes = await zipOf({
      "[Content_Types].xml": MINIMAL_TYPES,
      "ppt/presentation.xml": "<presentation/>",
    });
    assert.match(await refusalFor(bytes), /PowerPoint/);
  });

  test("names an OpenDocument or EPUB file", async () => {
    const bytes = await zipOf({
      mimetype: "application/vnd.oasis.opendocument.text",
      "META-INF/manifest.xml": "<manifest/>",
      "content.xml": "<office/>",
    });
    assert.match(await refusalFor(bytes), /OpenDocument or EPUB/);
  });

  test("names an Apple Pages document", async () => {
    const bytes = await zipOf({
      "Index/Document.iwa": "not really iwa",
      "Metadata/DocumentIdentifier": "id",
      "preview.jpg": "jpeg",
    });
    assert.match(await refusalFor(bytes), /Apple Pages/);
  });

  test("lists what an unrecognised zip actually contains", async () => {
    // Nothing here can name the format, so the next best thing for whoever
    // reads the message is the manifest.
    const bytes = await zipOf({ "readme.txt": "hello", "src/main.rs": "fn main() {}" });
    const message = await refusalFor(bytes);
    assert.match(message, /no word\/document\.xml part/);
    assert.match(message, /readme\.txt/);
    assert.match(message, /src\/main\.rs/);
  });

  test("reports a corrupt archive as a problem with the file", async () => {
    // A half-uploaded attachment is the caller's problem to fix, not a 500.
    const truncated = (await exactFixture()).subarray(0, 64);
    assert.match(await refusalFor(truncated), /Could not open the file as a Word document/);
  });

  test("every refusal says something different", async () => {
    // If two of these ever collapse into the same sentence, the employee
    // loses the only thing telling it which follow-up to ask for.
    const messages = [
      await refusalFor(Buffer.from("just some text", "utf8")),
      await refusalFor(Buffer.concat([Buffer.from("%PDF-1.4", "latin1"), Buffer.alloc(64)])),
      await refusalFor(
        Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.alloc(64),
        ]),
      ),
      await refusalFor(await zipOf({ "xl/workbook.xml": "<w/>" })),
      await refusalFor(await zipOf({ "ppt/presentation.xml": "<p/>" })),
      await refusalFor(await zipOf({ mimetype: "application/epub+zip" })),
      await refusalFor(await zipOf({ "Index/Document.iwa": "x" })),
    ];
    assert.equal(new Set(messages).size, messages.length);
  });
});

describe("save", () => {
  test("a save with no edits returns every part exactly as it arrived", async () => {
    // This is the load-bearing property of the module: an employee that opens
    // a contract to read one clause and saves it must not have touched the
    // signature block, the fonts or the tracked changes on the way past.
    const original = await exactFixture();
    const saved = await (await DocxPackage.open(original)).save();

    const before = await entriesOf(original);
    const after = await entriesOf(saved);
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const [path, bytes] of before) {
      assert.ok(after.get(path)?.equals(bytes), `${path} did not survive the round trip`);
    }
    assert.equal(await (await DocxPackage.open(saved)).requireText(DOCUMENT_PART), DOCUMENT_XML);
  });

  test("editing the body leaves the header byte-identical", async () => {
    // Headers are where the letterhead and the questionnaire's answer boxes
    // live; re-encoding one is how a document picks up a repair prompt.
    const pkg = await DocxPackage.open(await exactFixture());
    pkg.setText(DOCUMENT_PART, DOCUMENT_XML.replace("Quarterly report", "Annual report"));

    const reopened = await DocxPackage.open(await pkg.save());
    assert.match(await reopened.requireText(DOCUMENT_PART), /Annual report/);
    assert.equal(await reopened.text("word/header1.xml"), HEADER_XML);
  });

  test("a second save still carries the edit", async () => {
    // save() clears the dirty set once it has written; if that write were ever
    // deferred instead, the second file would silently be the unedited one.
    const pkg = await DocxPackage.open(await exactFixture());
    pkg.setText(DOCUMENT_PART, "<w:document/>");
    await pkg.save();
    const reopened = await DocxPackage.open(await pkg.save());
    assert.equal(await reopened.requireText(DOCUMENT_PART), "<w:document/>");
  });

  test("a saved package lists files only, the way a real one does", async () => {
    // packDocx passes `createFolders: false` because Word's own packages carry
    // no explicit directory entries, and save() documents the same intent.
    // An edited document must not come back structurally different from the
    // one that went in.
    const original = await exactFixture();
    const before = await JSZip.loadAsync(original);
    assert.deepEqual(
      Object.keys(before.files).filter((path) => before.files[path].dir),
      [],
    );

    const pkg = await DocxPackage.open(original);
    pkg.setText(DOCUMENT_PART, "<w:document/>");
    const after = await JSZip.loadAsync(await pkg.save());
    assert.deepEqual(
      Object.keys(after.files).filter((path) => after.files[path].dir),
      [],
    );
  });
});

describe("contentParts", () => {
  test("lists the body first, then the parts a body-only reader would miss", async () => {
    // A questionnaire's answer boxes routinely sit in a header, and the order
    // is what decides where an extracted answer appears in the report.
    const bytes = await docxFixture({
      body: para("Body"),
      parts: {
        header1: para("h1"),
        header2: para("h2"),
        footer1: para("f1"),
        footnotes: para("fn"),
        endnotes: para("en"),
        comments: para("c"),
      },
    });
    const pkg = await DocxPackage.open(bytes);
    assert.deepEqual(pkg.contentParts(), [
      DOCUMENT_PART,
      "word/comments.xml",
      "word/endnotes.xml",
      "word/footer1.xml",
      "word/footnotes.xml",
      "word/header1.xml",
      "word/header2.xml",
    ]);
  });

  test("leaves out the parts that hold no readable text", async () => {
    // Styles and numbering are full of `w:t`-adjacent noise; reading them
    // would put font names and list labels into the extracted text.
    const bytes = await docxFixture({
      body: para("Body"),
      parts: { header1: para("h1") },
      extraFiles: {
        "word/styles.xml": "<w:styles/>",
        "word/numbering.xml": "<w:numbering/>",
        "word/settings.xml": "<w:settings/>",
        "word/_rels/document.xml.rels": "<Relationships/>",
        "docProps/core.xml": "<coreProperties/>",
      },
    });
    const pkg = await DocxPackage.open(bytes);
    assert.deepEqual(pkg.contentParts(), [DOCUMENT_PART, "word/header1.xml"]);
  });

  test("a document with nothing but a body lists only the body", async () => {
    const pkg = await DocxPackage.open(await docxFixture({ body: para("Body") }));
    assert.deepEqual(pkg.contentParts(), [DOCUMENT_PART]);
  });
});

describe("reading parts", () => {
  test("a second read returns the first read's value, edits included", async () => {
    // The cache is not a micro-optimisation: docxEdit rewrites a part and then
    // reads it back, and a read that went to the zip would hand back the
    // pre-edit XML and quietly drop the change.
    const pkg = await DocxPackage.open(await exactFixture());
    const first = await pkg.requireText(DOCUMENT_PART);
    assert.equal(await pkg.requireText(DOCUMENT_PART), first);

    pkg.setText(DOCUMENT_PART, first.replace("Quarterly", "Annual"));
    assert.match(await pkg.requireText(DOCUMENT_PART), /Annual report/);
  });

  test("returns null for a part the document does not have", async () => {
    const pkg = await DocxPackage.open(await docxFixture({ body: para("Body") }));
    assert.equal(await pkg.text("word/header1.xml"), null);
    assert.equal(await pkg.text("word/footnotes.xml"), null);
  });

  test("requireText refuses a missing part by name", async () => {
    const pkg = await DocxPackage.open(await docxFixture({ body: para("Body") }));
    const message = await refusalFrom(() => pkg.requireText("word/footnotes.xml"));
    assert.match(message, /word\/footnotes\.xml/);
  });

  test("refuses a part that decompresses past the per-part ceiling", async () => {
    // 65 KB of archive holding 64 MB of XML. A zip bomb has to fail the
    // request, not the process, so the ceiling is checked before the bytes
    // are turned into a string.
    const bloat = Buffer.alloc(MAX_PART_BYTES + 4096, 0x41);
    const bytes = await packDocx({
      "[Content_Types].xml": MINIMAL_TYPES,
      "word/document.xml": DOCUMENT_XML,
      "word/bloat.xml": bloat,
    });
    const pkg = await DocxPackage.open(bytes);
    const message = await refusalFrom(() => pkg.text("word/bloat.xml"));
    assert.match(message, /word\/bloat\.xml/);
    assert.match(message, /per-part limit/);
    // The rest of the document is still readable — one oversized part is not
    // a reason to give up on the file.
    assert.equal(await pkg.requireText(DOCUMENT_PART), DOCUMENT_XML);
  });
});

describe("packDocx", () => {
  test("writes [Content_Types].xml first however the caller ordered the map", async () => {
    // OPC readers expect it as the first entry, and JSZip writes in insertion
    // order — so a caller listing parts alphabetically must not be able to
    // produce a package Word refuses to open.
    const bytes = await packDocx({
      "word/document.xml": DOCUMENT_XML,
      "_rels/.rels": "<Relationships/>",
      "[Content_Types].xml": MINIMAL_TYPES,
    });
    const paths = Object.keys((await JSZip.loadAsync(bytes)).files);
    assert.equal(paths[0], "[Content_Types].xml");
    assert.deepEqual([...paths].slice(1).sort(), ["_rels/.rels", "word/document.xml"]);
  });

  test("refuses to build a package with no content types", async () => {
    // 500, not 400: nothing a caller uploaded can cause this, so it is our
    // bug and should be reported as one.
    const message = await refusalFrom(() => packDocx({ "word/document.xml": DOCUMENT_XML }), 500);
    assert.match(message, /\[Content_Types\]\.xml/);
  });

  test("what it packs opens again as a Word package", async () => {
    const bytes = await packDocx({
      "[Content_Types].xml": MINIMAL_TYPES,
      "word/document.xml": DOCUMENT_XML,
    });
    const pkg = await DocxPackage.open(bytes);
    assert.equal(await pkg.requireText(DOCUMENT_PART), DOCUMENT_XML);
  });
});

describe("setBytes", () => {
  test("a binary part survives a save and reopen byte for byte", async () => {
    // Images go in this way. Round-tripping them through a UTF-8 string would
    // corrupt every PNG in the document without throwing anything.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]);
    const pkg = await DocxPackage.open(await exactFixture());
    pkg.setBytes("word/media/image1.png", png);

    const saved = await pkg.save();
    const reopened = await DocxPackage.open(saved);
    assert.equal(reopened.has("word/media/image1.png"), true);
    assert.ok((await entriesOf(saved)).get("word/media/image1.png")?.equals(png));
    assert.equal(await reopened.requireText(DOCUMENT_PART), DOCUMENT_XML);
  });

  test("raw bytes win over an edit that was still pending on the same part", async () => {
    // Whichever call came last is what the caller meant; a stale cached string
    // resurfacing on save would undo the replacement without a trace.
    const pkg = await DocxPackage.open(await exactFixture());
    pkg.setText(DOCUMENT_PART, "<w:document>from setText</w:document>");
    pkg.setBytes(DOCUMENT_PART, Buffer.from("<w:document>from setBytes</w:document>", "utf8"));

    assert.equal(await pkg.text(DOCUMENT_PART), "<w:document>from setBytes</w:document>");
    const reopened = await DocxPackage.open(await pkg.save());
    assert.equal(
      await reopened.requireText(DOCUMENT_PART),
      "<w:document>from setBytes</w:document>",
    );
  });
});
