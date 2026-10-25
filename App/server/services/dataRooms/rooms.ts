import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomDocument } from "../../db/entities/DataRoomDocument.js";
import { DataRoomEvent } from "../../db/entities/DataRoomEvent.js";
import { DataRoomFolder } from "../../db/entities/DataRoomFolder.js";
import { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { DataRoomJob } from "../../db/entities/DataRoomJob.js";
import { DataRoomQuestion } from "../../db/entities/DataRoomQuestion.js";
import {
  DATA_ROOM_AI_ANSWER_MODES,
  DATA_ROOM_DEFAULT_FOLDERS,
  DATA_ROOM_LIMITS,
  DATA_ROOM_PURPOSES,
  type DataRoomAiAnswerMode,
  type DataRoomPurpose,
  type DataRoomStatus,
} from "../../../shared/dataRooms.js";
import { type DataRoomActor, actorColumns, auditRoom, requireRoom } from "./access.js";
import { DataRoomConflictError, DataRoomNotFoundError, DataRoomValidationError } from "./errors.js";
import { cancelDataRoomJobs, enqueueDataRoomJob } from "./queue.js";
import { deleteDocumentBytes } from "./storage.js";

/**
 * Rooms and their folders: creating a room with the index its purpose
 * usually has, changing its settings, closing it, and deleting it with every
 * file, guest and question in it.
 */

function cleanName(value: string, label: string, max: number): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) throw new DataRoomValidationError(`${label} is required.`);
  if (name.length > max)
    throw new DataRoomValidationError(`${label} must be ${max} characters or fewer.`);
  return name;
}

function cleanText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (text.length > max) {
    throw new DataRoomValidationError(
      `${label} must be ${max.toLocaleString("en-US")} characters or fewer.`,
    );
  }
  return text;
}

async function assertEmployee(companyId: string, employeeId: string | null): Promise<void> {
  if (!employeeId) return;
  const exists = await AppDataSource.getRepository(AIEmployee).existsBy({
    id: employeeId,
    companyId,
  });
  if (!exists) throw new DataRoomNotFoundError("AI Employee not found");
}

export async function createDataRoom(args: {
  companyId: string;
  name: string;
  purpose: DataRoomPurpose;
  description?: string;
  welcomeMessage?: string;
  aiEmployeeId?: string | null;
  /** Start with the purpose's usual folders (the default). */
  seedFolders?: boolean;
  actor: DataRoomActor;
}): Promise<DataRoom> {
  if (!DATA_ROOM_PURPOSES.includes(args.purpose)) {
    throw new DataRoomValidationError("Choose what the room is for.");
  }
  const name = cleanName(args.name, "A name", DATA_ROOM_LIMITS.nameChars);
  await assertEmployee(args.companyId, args.aiEmployeeId ?? null);
  const who = actorColumns(args.actor);
  const room = await AppDataSource.transaction(async (manager) => {
    const saved = await manager.getRepository(DataRoom).save(
      manager.getRepository(DataRoom).create({
        companyId: args.companyId,
        name,
        purpose: args.purpose,
        status: "open",
        description: cleanText(
          args.description ?? "",
          "The description",
          DATA_ROOM_LIMITS.descriptionChars,
        ),
        welcomeMessage: cleanText(
          args.welcomeMessage ?? "",
          "The welcome message",
          DATA_ROOM_LIMITS.welcomeChars,
        ),
        aiEmployeeId: args.aiEmployeeId ?? null,
        aiAnswerMode: "draft",
        createdByUserId: who.userId,
        createdByEmployeeId: who.employeeId,
      }),
    );
    if (args.seedFolders !== false) {
      const folders = DATA_ROOM_DEFAULT_FOLDERS[args.purpose].map((folderName, position) =>
        manager.getRepository(DataRoomFolder).create({
          companyId: args.companyId,
          roomId: saved.id,
          name: folderName,
          position,
        }),
      );
      await manager.getRepository(DataRoomFolder).save(folders);
    }
    return saved;
  });
  await auditRoom(args.actor, room, "created", { purpose: room.purpose });
  return room;
}

export type RoomCounts = {
  documents: number;
  folders: number;
  guests: number;
  guestsVisited: number;
  openQuestions: number;
};

/** Counts for many rooms at once: one grouped query per table. */
export async function roomCounts(roomIds: string[]): Promise<Map<string, RoomCounts>> {
  const counts = new Map<string, RoomCounts>(
    roomIds.map((id) => [
      id,
      { documents: 0, folders: 0, guests: 0, guestsVisited: 0, openQuestions: 0 },
    ]),
  );
  if (roomIds.length === 0) return counts;
  const grouped = async (
    entity:
      | typeof DataRoomDocument
      | typeof DataRoomFolder
      | typeof DataRoomGuest
      | typeof DataRoomQuestion,
    alias: string,
    where?: { sql: string; params: Record<string, unknown> },
  ): Promise<Array<{ roomId: string; count: string | number }>> => {
    const query = AppDataSource.getRepository(entity)
      .createQueryBuilder(alias)
      .select(`${alias}.roomId`, "roomId")
      .addSelect("COUNT(*)", "count")
      .where(`${alias}.roomId IN (:...roomIds)`, { roomIds })
      .groupBy(`${alias}.roomId`);
    if (where) query.andWhere(where.sql, where.params);
    return query.getRawMany();
  };
  const [documents, folders, guests, visited, questions] = await Promise.all([
    grouped(DataRoomDocument, "document"),
    grouped(DataRoomFolder, "folder"),
    grouped(DataRoomGuest, "guest", {
      sql: "guest.status = :active",
      params: { active: "active" },
    }),
    grouped(DataRoomGuest, "guest", { sql: "guest.firstViewedAt IS NOT NULL", params: {} }),
    grouped(DataRoomQuestion, "question", {
      sql: "question.status = :open",
      params: { open: "open" },
    }),
  ]);
  const apply = (
    rows: Array<{ roomId: string; count: string | number }>,
    key: keyof RoomCounts,
  ) => {
    for (const row of rows) {
      const entry = counts.get(row.roomId);
      if (entry) entry[key] = Number(row.count);
    }
  };
  apply(documents, "documents");
  apply(folders, "folders");
  apply(guests, "guests");
  apply(visited, "guestsVisited");
  apply(questions, "openQuestions");
  return counts;
}

export async function listDataRooms(
  companyId: string,
  filters: { status?: DataRoomStatus } = {},
): Promise<Array<{ room: DataRoom; counts: RoomCounts }>> {
  const rooms = await AppDataSource.getRepository(DataRoom).find({
    where: { companyId, ...(filters.status ? { status: filters.status } : {}) },
    order: { updatedAt: "DESC" },
  });
  const counts = await roomCounts(rooms.map((room) => room.id));
  return rooms.map((room) => ({ room, counts: counts.get(room.id)! }));
}

export type RoomSettingsPatch = {
  name?: string;
  purpose?: DataRoomPurpose;
  description?: string;
  welcomeMessage?: string;
  allowDownloads?: boolean;
  watermark?: boolean;
  requireTerms?: boolean;
  termsText?: string;
  aiEmployeeId?: string | null;
  aiAnswerMode?: DataRoomAiAnswerMode;
  status?: DataRoomStatus;
};

export async function updateDataRoom(args: {
  companyId: string;
  roomId: string;
  patch: RoomSettingsPatch;
  actor: DataRoomActor;
}): Promise<DataRoom> {
  const room = await requireRoom(args.companyId, args.roomId);
  const patch = args.patch;
  const changes: Partial<DataRoom> = {};
  if (patch.name !== undefined)
    changes.name = cleanName(patch.name, "A name", DATA_ROOM_LIMITS.nameChars);
  if (patch.purpose !== undefined) {
    if (!DATA_ROOM_PURPOSES.includes(patch.purpose)) {
      throw new DataRoomValidationError("Choose what the room is for.");
    }
    changes.purpose = patch.purpose;
  }
  if (patch.description !== undefined) {
    changes.description = cleanText(
      patch.description,
      "The description",
      DATA_ROOM_LIMITS.descriptionChars,
    );
  }
  if (patch.welcomeMessage !== undefined) {
    changes.welcomeMessage = cleanText(
      patch.welcomeMessage,
      "The welcome message",
      DATA_ROOM_LIMITS.welcomeChars,
    );
  }
  if (patch.termsText !== undefined) {
    changes.termsText = cleanText(patch.termsText, "The terms", DATA_ROOM_LIMITS.termsChars);
  }
  if (patch.allowDownloads !== undefined) changes.allowDownloads = patch.allowDownloads;
  if (patch.watermark !== undefined) changes.watermark = patch.watermark;
  if (patch.requireTerms !== undefined) changes.requireTerms = patch.requireTerms;
  const requireTerms = changes.requireTerms ?? room.requireTerms;
  const termsText = changes.termsText ?? room.termsText;
  if (requireTerms && !termsText.trim()) {
    throw new DataRoomValidationError(
      "Write the terms guests must accept, or turn the requirement off.",
    );
  }
  if (patch.aiEmployeeId !== undefined) {
    await assertEmployee(args.companyId, patch.aiEmployeeId);
    changes.aiEmployeeId = patch.aiEmployeeId;
  }
  if (patch.aiAnswerMode !== undefined) {
    if (!DATA_ROOM_AI_ANSWER_MODES.includes(patch.aiAnswerMode)) {
      throw new DataRoomValidationError("Choose how the AI Employee answers questions.");
    }
    changes.aiAnswerMode = patch.aiAnswerMode;
  }
  if (patch.status !== undefined && patch.status !== room.status) {
    if (patch.status !== "open" && patch.status !== "closed") {
      throw new DataRoomValidationError("A room is either open or closed.");
    }
    changes.status = patch.status;
    changes.closedAt = patch.status === "closed" ? new Date() : null;
  }
  if (Object.keys(changes).length === 0) return room;
  await AppDataSource.getRepository(DataRoom).update({ id: room.id }, changes);
  const updated = await requireRoom(args.companyId, room.id);
  const action =
    changes.status === "closed"
      ? "closed"
      : changes.status === "open"
        ? "reopened"
        : "settings_changed";
  await auditRoom(args.actor, updated, action, { fields: Object.keys(changes) });
  // A room that just gained an AI Employee gets its documents briefed.
  if (changes.aiEmployeeId && changes.aiEmployeeId !== room.aiEmployeeId) {
    await briefUnbriefedDocuments(updated);
  }
  return updated;
}

/** Queue a brief for every readable document in the room that has none. */
export async function briefUnbriefedDocuments(room: DataRoom): Promise<number> {
  if (!room.aiEmployeeId) return 0;
  const documents = await AppDataSource.getRepository(DataRoomDocument).find({
    where: { roomId: room.id, textStatus: "extracted" },
    select: { id: true, briefJson: true },
  });
  let queued = 0;
  for (const document of documents) {
    if (document.briefJson) continue;
    await enqueueDataRoomJob({
      companyId: room.companyId,
      roomId: room.id,
      kind: "brief",
      targetId: document.id,
    });
    queued += 1;
  }
  return queued;
}

/**
 * Ask the room's AI Employee to brief every readable document still without a
 * brief — the way back after briefs failed, say before a model was connected.
 */
export async function requestMissingBriefs(args: {
  companyId: string;
  roomId: string;
}): Promise<number> {
  const room = await requireRoom(args.companyId, args.roomId);
  if (!room.aiEmployeeId) {
    throw new DataRoomConflictError("Choose the room's AI Employee in its settings first.");
  }
  return briefUnbriefedDocuments(room);
}

/** Delete the room with every document (and its file), folder, guest and question. */
export async function deleteDataRoom(args: {
  companyId: string;
  roomId: string;
  actor: DataRoomActor;
}): Promise<void> {
  const room = await requireRoom(args.companyId, args.roomId);
  const documents = await AppDataSource.getRepository(DataRoomDocument).find({
    where: { roomId: room.id },
    select: { id: true, storageKey: true },
  });
  await cancelDataRoomJobs({ roomId: room.id });
  await AppDataSource.transaction(async (manager) => {
    await manager.getRepository(DataRoomEvent).delete({ roomId: room.id });
    await manager.getRepository(DataRoomQuestion).delete({ roomId: room.id });
    await manager.getRepository(DataRoomGuest).delete({ roomId: room.id });
    await manager.getRepository(DataRoomDocument).delete({ roomId: room.id });
    await manager.getRepository(DataRoomFolder).delete({ roomId: room.id });
    await manager.getRepository(DataRoomJob).delete({ roomId: room.id });
    await manager.getRepository(DataRoom).delete({ id: room.id });
  });
  for (const document of documents) await deleteDocumentBytes(room.companyId, document.storageKey);
  await auditRoom(args.actor, room, "deleted", { documents: documents.length });
}

// ── Folders ─────────────────────────────────────────────────────────────────

export async function listFolders(roomId: string): Promise<DataRoomFolder[]> {
  return AppDataSource.getRepository(DataRoomFolder).find({
    where: { roomId },
    order: { position: "ASC", createdAt: "ASC" },
  });
}

async function requireFolder(roomId: string, folderId: string): Promise<DataRoomFolder> {
  const folder = await AppDataSource.getRepository(DataRoomFolder).findOneBy({
    id: folderId,
    roomId,
  });
  if (!folder) throw new DataRoomNotFoundError("Folder not found");
  return folder;
}

export async function createFolder(args: {
  companyId: string;
  roomId: string;
  name: string;
  actor: DataRoomActor;
}): Promise<DataRoomFolder> {
  const room = await requireRoom(args.companyId, args.roomId);
  const name = cleanName(args.name, "A folder name", DATA_ROOM_LIMITS.folderNameChars);
  const folders = await listFolders(room.id);
  if (folders.length >= DATA_ROOM_LIMITS.foldersPerRoom) {
    throw new DataRoomConflictError(
      `A room can have at most ${DATA_ROOM_LIMITS.foldersPerRoom} folders.`,
    );
  }
  const existing = folders.find((folder) => folder.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const repo = AppDataSource.getRepository(DataRoomFolder);
  const folder = await repo.save(
    repo.create({
      companyId: room.companyId,
      roomId: room.id,
      name,
      position: folders.length ? folders[folders.length - 1].position + 1 : 0,
    }),
  );
  await auditRoom(args.actor, room, "folder_created", { folder: name });
  return folder;
}

export async function renameFolder(args: {
  companyId: string;
  roomId: string;
  folderId: string;
  name: string;
  actor: DataRoomActor;
}): Promise<DataRoomFolder> {
  const room = await requireRoom(args.companyId, args.roomId);
  const folder = await requireFolder(room.id, args.folderId);
  const name = cleanName(args.name, "A folder name", DATA_ROOM_LIMITS.folderNameChars);
  const clash = (await listFolders(room.id)).find(
    (other) => other.id !== folder.id && other.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new DataRoomConflictError(`There is already a folder called "${clash.name}".`);
  await AppDataSource.getRepository(DataRoomFolder).update({ id: folder.id }, { name });
  await auditRoom(args.actor, room, "folder_renamed", { from: folder.name, to: name });
  return { ...folder, name };
}

/** Put the room's folders in this order; every folder must be named once. */
export async function reorderFolders(args: {
  companyId: string;
  roomId: string;
  folderIds: string[];
  actor: DataRoomActor;
}): Promise<DataRoomFolder[]> {
  const room = await requireRoom(args.companyId, args.roomId);
  const folders = await listFolders(room.id);
  const ids = new Set(folders.map((folder) => folder.id));
  if (args.folderIds.length !== folders.length || args.folderIds.some((id) => !ids.has(id))) {
    throw new DataRoomValidationError("List every folder of the room exactly once.");
  }
  if (new Set(args.folderIds).size !== args.folderIds.length) {
    throw new DataRoomValidationError("List every folder of the room exactly once.");
  }
  await AppDataSource.transaction(async (manager) => {
    for (const [position, id] of args.folderIds.entries()) {
      await manager.getRepository(DataRoomFolder).update({ id }, { position });
    }
  });
  await auditRoom(args.actor, room, "folders_reordered");
  return listFolders(room.id);
}

/**
 * Remove a folder. Its documents move to the room's top level rather than
 * being deleted, and guests who were given only this folder lose sight of
 * them — which is why their folder lists drop it too.
 */
export async function deleteFolder(args: {
  companyId: string;
  roomId: string;
  folderId: string;
  actor: DataRoomActor;
}): Promise<void> {
  const room = await requireRoom(args.companyId, args.roomId);
  const folder = await requireFolder(room.id, args.folderId);
  const guests = await AppDataSource.getRepository(DataRoomGuest).find({
    where: { roomId: room.id },
    select: { id: true, folderIdsJson: true },
  });
  await AppDataSource.transaction(async (manager) => {
    await manager
      .getRepository(DataRoomDocument)
      .update({ roomId: room.id, folderId: folder.id }, { folderId: null });
    for (const guest of guests) {
      let ids: unknown;
      try {
        ids = JSON.parse(guest.folderIdsJson);
      } catch {
        ids = [];
      }
      if (!Array.isArray(ids) || !ids.includes(folder.id)) continue;
      const remaining = ids.filter((id) => id !== folder.id);
      // A guest whose only folder this was keeps no access rather than all of it.
      await manager
        .getRepository(DataRoomGuest)
        .update(
          { id: guest.id },
          remaining.length === 0
            ? { folderIdsJson: "[]", status: "revoked", revokedAt: new Date() }
            : { folderIdsJson: JSON.stringify(remaining) },
        );
    }
    await manager.getRepository(DataRoomFolder).delete({ id: folder.id });
  });
  await auditRoom(args.actor, room, "folder_deleted", { folder: folder.name });
}
