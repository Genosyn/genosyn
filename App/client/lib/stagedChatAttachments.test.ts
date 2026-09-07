import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  attachmentUploadError,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
} from "./stagedChatAttachments";

describe("chat attachment upload limits", () => {
  test("allows a pasted screenshot", () =>
    assert.equal(attachmentUploadError({ name: "image.png", size: 5421 }), null));
  test("allows a file exactly at the upload ceiling", () =>
    assert.equal(
      attachmentUploadError({ name: "photo.jpg", size: CHAT_ATTACHMENT_MAX_BYTES }),
      null,
    ));
  test("rejects one byte over the ceiling before uploading", () =>
    assert.match(
      attachmentUploadError({ name: "photo.jpg", size: CHAT_ATTACHMENT_MAX_BYTES + 1 })!,
      /photo.jpg.*25 MB/,
    ));
  test("rejects empty files with the filename in the error", () =>
    assert.match(attachmentUploadError({ name: "empty.png", size: 0 })!, /empty.png.*empty/));
  test("allows ordinary documents alongside images", () =>
    assert.equal(attachmentUploadError({ name: "brief.pdf", size: 1200 }), null));
  test("matches the narrowest AI composer attachment cap", () =>
    assert.equal(CHAT_ATTACHMENT_MAX_COUNT, 10));
});
