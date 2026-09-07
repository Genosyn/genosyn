import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dataTransferHasFiles, filesFromDataTransfer, pastedUploadFiles } from "./fileDrop.js";

const png = new File(["pixels"], "screenshot.png", { type: "image/png" });
const jpeg = new File(["pixels"], "photo.jpg", { type: "image/jpeg" });
const pdf = new File(["document"], "brief.pdf", { type: "application/pdf" });
function transfer(files: File[] = [], text = "", items?: unknown[]): DataTransfer {
  return {
    files,
    items: items ?? files.map((file) => ({ kind: "file", getAsFile: () => file })),
    types: files.length ? ["Files"] : [],
    getData: (type: string) => (type === "text/plain" ? text : ""),
  } as unknown as DataTransfer;
}

describe("clipboard attachment extraction", () => {
  test("accepts an OS screenshot exposed only as an item", () => {
    assert.deepEqual(
      pastedUploadFiles(transfer([], "", [{ kind: "file", getAsFile: () => png }])),
      [png],
    );
  });
  test("accepts a copied browser image accompanied by its URL", () => {
    assert.deepEqual(pastedUploadFiles(transfer([png], "https://example.com/photo")), [png]);
  });
  test("keeps images alongside a caption without turning text files into uploads", () => {
    assert.deepEqual(pastedUploadFiles(transfer([png, pdf, jpeg], "A caption")), [png, jpeg]);
  });
  test("ordinary text, HTML selections and URLs contain no image uploads", () => {
    for (const text of ["hello", "https://example.com", "one\ttwo\nthree\tfour"]) {
      assert.deepEqual(pastedUploadFiles(transfer([], text)), []);
    }
  });
  test("leaves a document's text clipboard representation to normal paste", () => {
    assert.deepEqual(pastedUploadFiles(transfer([pdf], "Selected document text")), []);
  });
  test("accepts multiple file-only clipboard attachments in order", () => {
    assert.deepEqual(pastedUploadFiles(transfer([jpeg, png, pdf])), [jpeg, png, pdf]);
  });
  test("whitespace does not hide a file-only paste", () => {
    assert.deepEqual(pastedUploadFiles(transfer([png, pdf], " \n\t")), [png, pdf]);
  });
  test("does not duplicate files present in both clipboard collections", () => {
    assert.deepEqual(filesFromDataTransfer(transfer([png, jpeg])), [png, jpeg]);
  });
  test("falls back to files when a browser exposes null file items", () => {
    assert.deepEqual(
      filesFromDataTransfer(
        transfer([png], "", [
          { kind: "file", getAsFile: () => null },
          { kind: "string", getAsFile: () => null },
        ]),
      ),
      [png],
    );
  });
  test("handles an absent or empty clipboard", () => {
    for (const value of [null, undefined, transfer()]) {
      assert.deepEqual(filesFromDataTransfer(value), []);
      assert.deepEqual(pastedUploadFiles(value), []);
      assert.equal(dataTransferHasFiles(value), false);
    }
  });
  test("detects protected file drags before bytes become readable", () => {
    assert.equal(
      dataTransferHasFiles({ types: ["Files"], files: [] } as unknown as DataTransfer),
      true,
    );
  });
  test("text drags are left to ordinary browser behavior", () => {
    assert.equal(
      dataTransferHasFiles({
        types: ["text/plain", "text/uri-list"],
        files: [],
      } as unknown as DataTransfer),
      false,
    );
    assert.equal(dataTransferHasFiles(transfer([png])), true);
  });
});
