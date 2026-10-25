import fs from "node:fs";

import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import type { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomDocument } from "../../db/entities/DataRoomDocument.js";
import { DataRoomFolder } from "../../db/entities/DataRoomFolder.js";
import { Resource } from "../../db/entities/Resource.js";
import { DATA_ROOM_LIMITS, isAcceptedDataRoomFile } from "../../../shared/dataRooms.js";
import { resolveResourceFile } from "../resources.js";
import {
  type DataRoomActor,
  actorColumns,
  auditRoom,
  documentText,
  nextDocumentPosition,
  requireRoom,
} from "./access.js";
import { DataRoomConflictError, DataRoomNotFoundError, DataRoomValidationError } from "./errors.js";
import { cancelDataRoomJobs, enqueueDataRoomJob } from "./queue.js";
import {
  acceptedFileMessage,
  canonicalMimeType,
  cleanFilename,
  deleteDocumentBytes,
  extractDocumentText,
  resolveDocumentPath,
  titleFromFilename,
  writeDocumentBytes,
} from "./storage.js";

/**
 * Filing documents in a room: from an upload, from the Resources library, or
 * from bytes an AI Employee holds (a chat attachment, a file it converted).
 * Each one has its text read on the way in and, when the room has an AI
 * Employee, a brief queued.
 */

async function requireFolderIn(
  roomId: string,
  folderId: string | null,
): Promise<DataRoomFolder | null> {
  if (!folderId) return null;
  const folder = await AppDataSource.getRepository(DataRoomFolder).findOneBy({
    id: folderId,
    roomId,
  });
  if (!folder) throw new DataRoomNotFoundError("Folder not found");
  return folder;
}

export async function requireDocument(
  roomId: string,
  documentId: string,
): Promise<DataRoomDocument> {
  const document = await AppDataSource.getRepository(DataRoomDocument).findOneBy({
    id: documentId,
    roomId,
  });
  if (!document) throw new DataRoomNotFoundError("Document not found");
  return document;
}

/** File `bytes` in the room. The one path every way of adding a document takes. */
export async function addDocumentFromBytes(args: {
  room: DataRoom;
  bytes: Buffer;
  filename: string;
  folderId?: string | null;
  title?: string;
  sourceResourceId?: string | null;
  actor: DataRoomActor;
}): Promise<DataRoomDocument> {
  const room = args.room;
  const filename = cleanFilename(args.filename);
  if (args.bytes.length === 0) throw new DataRoomValidationError("The file is empty.");
  if (args.bytes.length > DATA_ROOM_LIMITS.documentBytes) {
    throw new DataRoomValidationError("A document must be 50 MB or smaller.");
  }
  const folder = await requireFolderIn(room.id, args.folderId ?? null);
  const count = await AppDataSource.getRepository(DataRoomDocument).countBy({ roomId: room.id });
  if (count >= DATA_ROOM_LIMITS.documentsPerRoom) {
    throw new DataRoomConflictError(
      `A room can hold at most ${DATA_ROOM_LIMITS.documentsPerRoom.toLocaleString("en-US")} documents.`,
    );
  }
  const title = (args.title?.replace(/\s+/g, " ").trim() || titleFromFilename(filename)).slice(
    0,
    DATA_ROOM_LIMITS.documentTitleChars,
  );
  const extracted = await extractDocumentText(args.bytes, filename);
  const stored = await writeDocumentBytes(room.companyId, filename, args.bytes);
  const who = actorColumns(args.actor);
  const repo = AppDataSource.getRepository(DataRoomDocument);
  let saved: DataRoomDocument;
  try {
    saved = await repo.save(
      repo.create({
        companyId: room.companyId,
        roomId: room.id,
        folderId: folder?.id ?? null,
        title,
        filename,
        mimeType: canonicalMimeType(filename),
        sizeBytes: args.bytes.length,
        storageKey: stored.storageKey,
        sha256: stored.sha256,
        position: await nextDocumentPosition(room.id, folder?.id ?? null),
        pageCount: extracted.pageCount,
        textStatus: extracted.status,
        textChars: extracted.text.length,
        text: extracted.text,
        sourceResourceId: args.sourceResourceId ?? null,
        uploadedByUserId: who.userId,
        uploadedByEmployeeId: who.employeeId,
      }),
    );
  } catch (error) {
    await deleteDocumentBytes(room.companyId, stored.storageKey);
    throw error;
  }
  await auditRoom(args.actor, room, "document_added", {
    documentId: saved.id,
    title: saved.title,
    folder: folder?.name ?? null,
  });
  if (room.aiEmployeeId && saved.textStatus === "extracted") {
    await enqueueDataRoomJob({
      companyId: room.companyId,
      roomId: room.id,
      kind: "brief",
      targetId: saved.id,
    });
  }
  return saved;
}

/** File an uploaded file; the temporary upload is the caller's to remove. */
export async function addDocumentFromUpload(args: {
  companyId: string;
  roomId: string;
  file: { path: string; originalname: string };
  folderId?: string | null;
  title?: string;
  actor: DataRoomActor;
}): Promise<DataRoomDocument> {
  const room = await requireRoom(args.companyId, args.roomId);
  const bytes = await fs.promises.readFile(args.file.path);
  return addDocumentFromBytes({
    room,
    bytes,
    filename: args.file.originalname,
    folderId: args.folderId,
    title: args.title,
    actor: args.actor,
  });
}

/**
 * Copy a Resource into the room. An uploaded file is copied as it is; a
 * pasted or fetched Resource becomes a Markdown document of its text. The
 * room keeps its own copy, so changing or deleting the Resource later leaves
 * what guests were shown untouched.
 */
export async function addDocumentFromResource(args: {
  companyId: string;
  roomId: string;
  resource: { id?: string; slug?: string };
  folderId?: string | null;
  title?: string;
  actor: DataRoomActor;
}): Promise<DataRoomDocument> {
  const room = await requireRoom(args.companyId, args.roomId);
  const where = args.resource.id
    ? { companyId: args.companyId, id: args.resource.id }
    : args.resource.slug
      ? { companyId: args.companyId, slug: args.resource.slug }
      : null;
  if (!where) throw new DataRoomValidationError("Choose a Resource.");
  const resource = await AppDataSource.getRepository(Resource).findOneBy(where);
  if (!resource) throw new DataRoomNotFoundError("Resource not found");
  if (resource.storageKey && resource.sourceFilename) {
    if (!isAcceptedDataRoomFile(resource.sourceFilename)) {
      throw new DataRoomValidationError(
        `"${resource.title}" is not a file a room accepts. ${acceptedFileMessage()}`,
      );
    }
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: args.companyId });
    const absolute = company ? resolveResourceFile(company.slug, resource.storageKey) : null;
    if (!absolute) throw new DataRoomNotFoundError("The Resource's file is missing.");
    return addDocumentFromBytes({
      room,
      bytes: await fs.promises.readFile(absolute),
      filename: resource.sourceFilename,
      folderId: args.folderId,
      title: args.title ?? resource.title,
      sourceResourceId: resource.id,
      actor: args.actor,
    });
  }
  if (!resource.bodyText.trim()) {
    throw new DataRoomValidationError(`"${resource.title}" has no text or file to copy.`);
  }
  const markdown = `# ${resource.title}\n\n${resource.sourceUrl ? `Source: ${resource.sourceUrl}\n\n` : ""}${resource.bodyText}`;
  return addDocumentFromBytes({
    room,
    bytes: Buffer.from(markdown, "utf8"),
    filename: `${resource.slug || "resource"}.md`,
    folderId: args.folderId,
    title: args.title ?? resource.title,
    sourceResourceId: resource.id,
    actor: args.actor,
  });
}

export async function updateDocument(args: {
  companyId: string;
  roomId: string;
  documentId: string;
  title?: string;
  folderId?: string | null;
  position?: number;
  actor: DataRoomActor;
}): Promise<DataRoomDocument> {
  const room = await requireRoom(args.companyId, args.roomId);
  const document = await requireDocument(room.id, args.documentId);
  const changes: Partial<DataRoomDocument> = {};
  if (args.title !== undefined) {
    const title = args.title.replace(/\s+/g, " ").trim();
    if (!title) throw new DataRoomValidationError("A title is required.");
    changes.title = title.slice(0, DATA_ROOM_LIMITS.documentTitleChars);
  }
  let folderName: string | null | undefined;
  if (args.folderId !== undefined && args.folderId !== document.folderId) {
    const folder = await requireFolderIn(room.id, args.folderId);
    changes.folderId = folder?.id ?? null;
    folderName = folder?.name ?? null;
    changes.position = await nextDocumentPosition(room.id, changes.folderId);
  }
  if (args.position !== undefined) {
    changes.position = Math.max(0, Math.min(100_000, Math.round(args.position)));
  }
  if (Object.keys(changes).length === 0) return document;
  await AppDataSource.getRepository(DataRoomDocument).update({ id: document.id }, changes);
  if (folderName !== undefined) {
    await auditRoom(args.actor, room, "document_moved", {
      documentId: document.id,
      title: changes.title ?? document.title,
      folder: folderName,
    });
  } else if (changes.title) {
    await auditRoom(args.actor, room, "document_renamed", {
      documentId: document.id,
      from: document.title,
      to: changes.title,
    });
  }
  return requireDocument(room.id, document.id);
}

export async function deleteDocument(args: {
  companyId: string;
  roomId: string;
  documentId: string;
  actor: DataRoomActor;
}): Promise<void> {
  const room = await requireRoom(args.companyId, args.roomId);
  const document = await requireDocument(room.id, args.documentId);
  await cancelDataRoomJobs({ roomId: room.id, targetId: document.id });
  await AppDataSource.getRepository(DataRoomDocument).delete({ id: document.id });
  await deleteDocumentBytes(room.companyId, document.storageKey);
  await auditRoom(args.actor, room, "document_deleted", {
    documentId: document.id,
    title: document.title,
  });
}

/** Queue a fresh brief, as a Member asked. */
export async function requestBrief(args: {
  companyId: string;
  roomId: string;
  documentId: string;
}): Promise<void> {
  const room = await requireRoom(args.companyId, args.roomId);
  const document = await requireDocument(room.id, args.documentId);
  if (!room.aiEmployeeId) {
    throw new DataRoomConflictError("Choose the room's AI Employee in its settings first.");
  }
  if (document.textStatus !== "extracted") {
    throw new DataRoomConflictError(
      "No text could be read from this file, so it cannot be briefed.",
    );
  }
  await enqueueDataRoomJob({
    companyId: room.companyId,
    roomId: room.id,
    kind: "brief",
    targetId: document.id,
  });
}

export type ResolvedDocumentFile = {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export function documentFile(document: DataRoomDocument): ResolvedDocumentFile {
  const absolute = resolveDocumentPath(document.companyId, document.storageKey);
  if (!absolute || !fs.existsSync(absolute))
    throw new DataRoomNotFoundError("The document's file is missing.");
  return {
    path: absolute,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
  };
}

/** The document's readable text, a page at a time. */
export async function readDocumentText(
  document: DataRoomDocument,
  options: { offset?: number; maxChars?: number } = {},
): Promise<{ text: string; offset: number; totalChars: number; truncated: boolean }> {
  const text = await documentText(document.id);
  const offset = Math.max(0, Math.min(text.length, options.offset ?? 0));
  const maxChars = Math.max(1, Math.min(200_000, options.maxChars ?? 50_000));
  const slice = text.slice(offset, offset + maxChars);
  return {
    text: slice,
    offset,
    totalChars: text.length,
    truncated: offset + slice.length < text.length,
  };
}
