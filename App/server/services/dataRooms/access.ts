import { In, IsNull } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomDocument } from "../../db/entities/DataRoomDocument.js";
import type { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { recordAudit } from "../audit.js";
import { DataRoomNotFoundError } from "./errors.js";

/**
 * The pieces every data room module shares: who is acting, the room's
 * History, and — the one rule that matters most — which documents a guest
 * may see.
 */

/** Who changed a room: a Member, an AI Employee through its tools, or the server. */
export type DataRoomActor =
  | { kind: "user"; userId: string }
  | { kind: "ai"; employeeId: string }
  | { kind: "system" };

export function actorColumns(actor: DataRoomActor): {
  userId: string | null;
  employeeId: string | null;
} {
  return {
    userId: actor.kind === "user" ? actor.userId : null,
    employeeId: actor.kind === "ai" ? actor.employeeId : null,
  };
}

/**
 * The room's History (`data_room` in the audit ledger): who in the company
 * created it, filed documents, invited or revoked guests, answered questions.
 * What guests did is the room's activity (`DataRoomEvent`), not History.
 */
export async function auditRoom(
  actor: DataRoomActor,
  room: Pick<DataRoom, "id" | "companyId" | "name">,
  action: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await recordAudit({
    companyId: room.companyId,
    actorKind: actor.kind === "user" ? "user" : actor.kind === "ai" ? "ai" : "system",
    actorUserId: actor.kind === "user" ? actor.userId : null,
    actorEmployeeId: actor.kind === "ai" ? actor.employeeId : null,
    action: `data_room.${action}`,
    targetType: "data_room",
    targetId: room.id,
    targetLabel: room.name,
    metadata,
  });
}

export async function requireRoom(companyId: string, roomId: string): Promise<DataRoom> {
  const room = await AppDataSource.getRepository(DataRoom).findOneBy({ id: roomId, companyId });
  if (!room) throw new DataRoomNotFoundError("Data room not found");
  return room;
}

export function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** The folders a guest was given; an empty list means every folder and the top level. */
export function guestFolderIds(guest: Pick<DataRoomGuest, "folderIdsJson">): string[] {
  return parseJsonArray<unknown>(guest.folderIdsJson).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

export function guestSeesEverything(guest: Pick<DataRoomGuest, "folderIdsJson">): boolean {
  return guestFolderIds(guest).length === 0;
}

/** The documents this guest can open, without their text. */
export async function documentsForGuest(
  roomId: string,
  guest: Pick<DataRoomGuest, "folderIdsJson">,
): Promise<DataRoomDocument[]> {
  const repo = AppDataSource.getRepository(DataRoomDocument);
  if (guestSeesEverything(guest)) {
    return repo.find({ where: { roomId }, order: { position: "ASC", createdAt: "ASC" } });
  }
  const folderIds = guestFolderIds(guest);
  return repo.find({
    where: { roomId, folderId: In(folderIds) },
    order: { position: "ASC", createdAt: "ASC" },
  });
}

/** Whether one document is inside what this guest can open. */
export function guestCanSeeDocument(
  guest: Pick<DataRoomGuest, "folderIdsJson">,
  document: Pick<DataRoomDocument, "folderId">,
): boolean {
  if (guestSeesEverything(guest)) return true;
  return document.folderId !== null && guestFolderIds(guest).includes(document.folderId);
}

/** Documents with their text, for AI work. Only ever called with ids already scoped. */
export async function documentsWithText(
  roomId: string,
  documentIds?: string[],
): Promise<Array<DataRoomDocument & { text: string }>> {
  if (documentIds && documentIds.length === 0) return [];
  const query = AppDataSource.getRepository(DataRoomDocument)
    .createQueryBuilder("document")
    .addSelect("document.text")
    .where("document.roomId = :roomId", { roomId })
    .orderBy("document.position", "ASC")
    .addOrderBy("document.createdAt", "ASC");
  if (documentIds) query.andWhere("document.id IN (:...documentIds)", { documentIds });
  return (await query.getMany()) as Array<DataRoomDocument & { text: string }>;
}

export async function documentText(documentId: string): Promise<string> {
  const row = await AppDataSource.getRepository(DataRoomDocument)
    .createQueryBuilder("document")
    .addSelect("document.text")
    .where("document.id = :documentId", { documentId })
    .getOne();
  return row?.text ?? "";
}

/** The next position at the end of a folder (or the top level). */
export async function nextDocumentPosition(
  roomId: string,
  folderId: string | null,
): Promise<number> {
  const last = await AppDataSource.getRepository(DataRoomDocument).findOne({
    where: { roomId, folderId: folderId ?? IsNull() },
    order: { position: "DESC" },
    select: { id: true, position: true },
  });
  return last ? last.position + 1 : 0;
}
