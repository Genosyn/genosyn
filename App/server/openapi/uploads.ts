import type { ZodTypeAny } from "zod";
import { applicationFieldsSchema } from "../routes/careers.js";
import { contractFieldsSchema } from "../routes/contracts.js";
import { manualApplicationSchema } from "../routes/recruiting.js";
import { createMultipartSchema } from "../routes/signatures.js";
import { documentUploadFields } from "../routes/dataRooms.js";
import type { JsonSchema } from "./schemaConversion.js";

/**
 * The routes that take a file, and the form they take it in.
 *
 * Express hands a validator only `req.body`, and multer fills that in from a
 * multipart form before any validator runs, so an upload route's file field is
 * the one part of its request the router stack cannot tell the API reference.
 * This table can. Every upload in the App uses one file field — `file`, or
 * `resume` for applications — and some read a few text fields beside it; where
 * those fields are validated with a zod schema, the table points at that
 * schema rather than repeating it.
 *
 * The coverage test fails on a route that runs multer without an entry here,
 * and on an entry whose route is gone.
 */

export type MultipartUpload = {
  /** The form field the file arrives in. */
  fileField: string;
  /** What the file is, for the field's description. */
  file: string;
  /** Whether the file may be left out. */
  fileOptional?: boolean;
  /** The text fields beside the file, as the zod schema the handler parses them with… */
  fieldsSchema?: ZodTypeAny;
  /** …or as plain OpenAPI properties when the handler reads them by hand. */
  fields?: Record<string, JsonSchema>;
};

/** Keyed by `METHOD /openapi/path`. */
export const MULTIPART_UPLOADS: Record<string, MultipartUpload> = {
  "POST /api/auth/me/avatar": { fileField: "file", file: "The new avatar image." },
  "POST /api/companies/{cid}/employees/{eid}/avatar": {
    fileField: "file",
    file: "The AI Employee's new avatar image.",
  },
  "POST /api/companies/{cid}/employees/{eid}/chat-attachments": {
    fileField: "file",
    file: "A file to attach to the next chat message.",
  },
  "POST /api/companies/{cid}/ask-ai/attachments": {
    fileField: "file",
    file: "A file to attach to the next Ask AI question.",
  },
  "POST /api/companies/{cid}/bases/{baseSlug}/tables/{tableId}/rows/{rowId}/attachments": {
    fileField: "file",
    file: "A file to attach to the row.",
  },
  "POST /api/companies/{cid}/workspace/attachments": {
    fileField: "file",
    file: "A file to attach to the next workspace message.",
  },
  "POST /api/companies/{cid}/resources/upload": {
    fileField: "file",
    file: "A PDF, EPUB, document or text file, up to 25 MB.",
    fields: {
      folderId: { type: "string", format: "uuid", description: "The Folder to file it in." },
      tagIds: { type: "string", description: "A JSON array of up to 20 tag ids." },
      tags: { type: "string", description: "Comma-separated tag names (legacy)." },
    },
  },
  "POST /api/companies/{cid}/repositories/{slug}/session-attachments": {
    fileField: "file",
    file: "A file to attach to the next Work session request.",
  },
  "POST /api/companies/{cid}/bank-feeds/{id}/import": {
    fileField: "file",
    file: "A CSV bank statement.",
  },
  "POST /api/companies/{cid}/contracts": {
    fileField: "file",
    file: "The signed agreement.",
    fieldsSchema: contractFieldsSchema,
  },
  "POST /api/companies/{cid}/signature-envelopes": {
    fileField: "file",
    file: "The PDF to send for signature.",
    fieldsSchema: createMultipartSchema,
  },
  "POST /api/companies/{cid}/data-rooms/{roomId}/documents": {
    fileField: "file",
    file: "A PDF, Word, Excel, PowerPoint, text or image file, up to 50 MB.",
    fieldsSchema: documentUploadFields,
  },
  "POST /api/companies/{cid}/mail/accounts/{aid}/outbox-attachments": {
    fileField: "file",
    file: "A file to attach to an outgoing email.",
  },
  "POST /api/companies/{cid}/revenue/documents/upload": {
    fileField: "file",
    file: "A document to store and link to Revenue records.",
  },
  "POST /api/companies/{cid}/meetings/{id}/recording": {
    fileField: "file",
    file: "The meeting's audio or video recording.",
  },
  "POST /api/companies/{cid}/recruiting/settings/logo": {
    fileField: "file",
    file: "The careers site logo image.",
  },
  "POST /api/companies/{cid}/recruiting/openings/{openingId}/applications": {
    fileField: "resume",
    file: "The candidate's resume, one file under 10 MB.",
    fileOptional: true,
    fieldsSchema: manualApplicationSchema,
  },
  "POST /api/careers/sites/{siteSlug}/openings/{openingSlug}/applications": {
    fileField: "resume",
    file: "The applicant's resume, one file under 10 MB.",
    fileOptional: true,
    fieldsSchema: applicationFieldsSchema,
  },
};

/** Routes whose request body is raw bytes rather than JSON or a form. */
export const RAW_UPLOADS: Record<string, { contentType: string; description: string }> = {
  "POST /api/backups/upload": {
    contentType: "application/zip",
    description: "A backup archive, streamed as the request body.",
  },
};
