import assert from "node:assert/strict";
import { test } from "node:test";
import { editedXlsxFilename } from "./xlsxAttachments.js";

test("edited workbook names always retain the .xlsx format", () => {
  assert.equal(editedXlsxFilename("Supplier.XLSX"), "Supplier-edited.xlsx");
  assert.equal(editedXlsxFilename("attachment"), "attachment-edited.xlsx");
  assert.equal(editedXlsxFilename("form.xlsx", "Completed form"), "Completed form.xlsx");
  assert.equal(editedXlsxFilename("form.xlsx", "Completed.pdf"), "Completed.xlsx");
});

test("download names remove directories and controls and respect the filename budget", () => {
  assert.equal(editedXlsxFilename("form.xlsx", "../../complete.xlsx"), "complete.xlsx");
  assert.equal(editedXlsxFilename("form.xlsx", "C:\\forms\\complete.xlsx"), "complete.xlsx");
  assert.equal(editedXlsxFilename("form.xlsx", "complete\r\n.xlsx"), "complete.xlsx");
  assert.equal(editedXlsxFilename("form.xlsx", ".xlsx"), "workbook.xlsx");
  assert.equal(editedXlsxFilename("a".repeat(250) + ".xlsx").length, 200);
  assert.equal(editedXlsxFilename("form.xlsx", "a".repeat(250)).length, 200);
});
