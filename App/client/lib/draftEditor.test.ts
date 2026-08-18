import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  allAttachmentIndexes,
  draftEditorIsDirty,
  withoutAttachment,
  type DraftEdits,
  type SavedDraft,
} from "./draftEditor.js";

const SAVED: SavedDraft = {
  toEmails: "accountspayable@syniti.com",
  subject: "Re: Syniti New Supplier Form US",
  bodyText: "HackerBay, Inc. is a U.S. entity.",
  attachments: [{ index: 0 }, { index: 1 }],
};

/** The editor as it looks the moment it opens on {@link SAVED}. */
function pristine(overrides: Partial<DraftEdits> = {}): DraftEdits {
  return {
    to: SAVED.toEmails,
    subject: SAVED.subject,
    bodyText: SAVED.bodyText,
    keptIndexes: allAttachmentIndexes(SAVED.attachments.length),
    stagedIds: [],
    ...overrides,
  };
}

describe("draft editor dirt", () => {
  test("an untouched draft is clean", () => {
    assert.equal(draftEditorIsDirty(SAVED, pristine()), false);
  });

  test("a newly attached file makes it dirty even when the wording is identical", () => {
    // The bug this guards: Send only saves when dirty, so an attachment-only
    // change used to go out as mail with no attachment on it.
    assert.equal(draftEditorIsDirty(SAVED, pristine({ stagedIds: ["staged-1"] })), true);
  });

  test("removing an existing file makes it dirty", () => {
    assert.equal(draftEditorIsDirty(SAVED, pristine({ keptIndexes: [0] })), true);
  });

  test("clearing every file makes it dirty", () => {
    assert.equal(draftEditorIsDirty(SAVED, pristine({ keptIndexes: [] })), true);
  });

  test("edited recipients, subject, and body each count", () => {
    assert.equal(draftEditorIsDirty(SAVED, pristine({ to: "someone@else.com" })), true);
    assert.equal(draftEditorIsDirty(SAVED, pristine({ subject: "Re: something else" })), true);
    assert.equal(draftEditorIsDirty(SAVED, pristine({ bodyText: "Reworded." })), true);
  });

  test("a draft with no files at all is clean until something is staged", () => {
    const empty: SavedDraft = { ...SAVED, attachments: [] };
    const edits = { ...pristine(), keptIndexes: [] };

    assert.equal(draftEditorIsDirty(empty, edits), false);
    assert.equal(draftEditorIsDirty(empty, { ...edits, stagedIds: ["staged-1"] }), true);
  });
});

describe("draft editor attachment bookkeeping", () => {
  test("a freshly loaded draft keeps everything it arrived with", () => {
    assert.deepEqual(allAttachmentIndexes(3), [0, 1, 2]);
    assert.deepEqual(allAttachmentIndexes(0), []);
  });

  test("removing one file leaves the rest at their saved indexes", () => {
    // Indexes address the *saved* attachment list, so the survivors must keep
    // their original numbering — renumbering them would send the wrong file.
    assert.deepEqual(withoutAttachment([0, 1, 2], 1), [0, 2]);
  });

  test("removing the same file twice is a no-op", () => {
    assert.deepEqual(withoutAttachment(withoutAttachment([0, 1], 1), 1), [0]);
  });
});
