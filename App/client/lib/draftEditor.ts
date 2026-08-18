/**
 * The rules the draft editor runs on, kept out of the component so they can be
 * unit-tested outside a browser.
 *
 * Only one of them is subtle, and it is the one that bites: **whether the
 * draft is dirty decides whether Send saves first.** A draft edit rebuilds the
 * whole message, so a file the human just attached only reaches Gmail if the
 * save runs — a "dirty" test that looked at the wording alone would drop the
 * attachment on the floor and still report the mail as sent.
 *
 * Deliberately dependency-free; `MailMessage` from the API client satisfies
 * {@link SavedDraft} structurally.
 */

export type SavedDraft = {
  toEmails: string;
  subject: string;
  bodyText: string;
  /** What the server currently holds — one entry per file on the draft. */
  attachments: { index: number }[];
};

export type DraftEdits = {
  to: string;
  subject: string;
  bodyText: string;
  /** Existing attachments the editor still shows, by their saved index. */
  keptIndexes: number[];
  /** Tokens for files staged since the editor opened. */
  stagedIds: string[];
};

/** Every attachment index a freshly-loaded draft starts out keeping. */
export function allAttachmentIndexes(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

/** Whether the editor holds anything the saved draft does not. */
export function draftEditorIsDirty(saved: SavedDraft, edits: DraftEdits): boolean {
  return (
    edits.to !== saved.toEmails ||
    edits.subject !== saved.subject ||
    edits.bodyText !== saved.bodyText ||
    edits.stagedIds.length > 0 ||
    edits.keptIndexes.length !== saved.attachments.length
  );
}

/** Drop one existing attachment from the set the editor is keeping. */
export function withoutAttachment(keptIndexes: number[], index: number): number[] {
  return keptIndexes.filter((i) => i !== index);
}
