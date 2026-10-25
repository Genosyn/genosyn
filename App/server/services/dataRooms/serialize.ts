import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomDocument } from "../../db/entities/DataRoomDocument.js";
import type { DataRoomFolder } from "../../db/entities/DataRoomFolder.js";
import { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { DataRoomJob } from "../../db/entities/DataRoomJob.js";
import type { DataRoomQuestion } from "../../db/entities/DataRoomQuestion.js";
import {
  viewerKindFor,
  type DataRoomCitation,
  type DataRoomDocumentBrief,
  type DataRoomInsights,
  type DataRoomQuestionStatus,
  type DataRoomReadiness,
  type DataRoomStatus,
} from "../../../shared/dataRooms.js";
import { getActiveModel } from "../models.js";
import { isModelConnected } from "../providers.js";
import { guestFolderIds, parseJsonArray, parseJsonObject, requireRoom } from "./access.js";
import { listQuestions } from "./questions.js";
import { type RoomCounts, listDataRooms, listFolders, roomCounts } from "./rooms.js";

/**
 * What a room looks like to the company — Members through the API and AI
 * Employees through their tools. Never a token, a storage key or a document's
 * raw text: those stay on the server.
 */

export type EmployeeStub = { id: string; name: string; slug: string; avatarKey: string | null };

export async function employeeStubs(
  companyId: string,
  ids: Array<string | null>,
): Promise<Map<string, EmployeeStub>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId, id: In(unique) },
    select: { id: true, name: true, slug: true, avatarKey: true },
  });
  return new Map(
    employees.map((employee) => [
      employee.id,
      { id: employee.id, name: employee.name, slug: employee.slug, avatarKey: employee.avatarKey },
    ]),
  );
}

export function serializeRoom(
  room: DataRoom,
  extras: { counts?: RoomCounts; aiEmployee?: EmployeeStub | null } = {},
) {
  const readiness = parseJsonObject<DataRoomReadiness>(room.readinessJson);
  return {
    id: room.id,
    name: room.name,
    purpose: room.purpose,
    status: room.status,
    description: room.description,
    welcomeMessage: room.welcomeMessage,
    allowDownloads: room.allowDownloads,
    watermark: room.watermark,
    requireTerms: room.requireTerms,
    termsText: room.termsText,
    aiEmployeeId: room.aiEmployeeId,
    aiEmployee: extras.aiEmployee ?? null,
    aiAnswerMode: room.aiAnswerMode,
    readiness,
    readinessAt: room.readinessAt?.toISOString() ?? null,
    readinessScore: readiness?.score ?? null,
    insights: parseJsonObject<DataRoomInsights>(room.insightsJson),
    insightsAt: room.insightsAt?.toISOString() ?? null,
    lastGuestActivityAt: room.lastGuestActivityAt?.toISOString() ?? null,
    closedAt: room.closedAt?.toISOString() ?? null,
    createdByUserId: room.createdByUserId,
    createdByEmployeeId: room.createdByEmployeeId,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    ...(extras.counts ? { counts: extras.counts } : {}),
  };
}

export function serializeFolder(folder: DataRoomFolder, number: number) {
  return { id: folder.id, name: folder.name, position: folder.position, number };
}

export function serializeDocument(document: DataRoomDocument) {
  return {
    id: document.id,
    folderId: document.folderId,
    title: document.title,
    filename: document.filename,
    mimeType: document.mimeType,
    viewerKind: viewerKindFor(document.filename, document.mimeType),
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
    pageCount: document.pageCount,
    position: document.position,
    textStatus: document.textStatus,
    textChars: document.textChars,
    brief: parseJsonObject<DataRoomDocumentBrief>(document.briefJson),
    briefAt: document.briefAt?.toISOString() ?? null,
    sourceResourceId: document.sourceResourceId,
    uploadedByUserId: document.uploadedByUserId,
    uploadedByEmployeeId: document.uploadedByEmployeeId,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export function serializeGuest(guest: DataRoomGuest) {
  return {
    id: guest.id,
    name: guest.name,
    email: guest.email,
    organization: guest.organization,
    status: guest.status,
    folderIds: guestFolderIds(guest),
    expiresAt: guest.expiresAt?.toISOString() ?? null,
    expired: Boolean(guest.expiresAt && guest.expiresAt.getTime() <= Date.now()),
    termsAcceptedAt: guest.termsAcceptedAt?.toISOString() ?? null,
    termsAcceptedName: guest.termsAcceptedName,
    firstViewedAt: guest.firstViewedAt?.toISOString() ?? null,
    lastViewedAt: guest.lastViewedAt?.toISOString() ?? null,
    visitCount: guest.visitCount,
    totalSeconds: guest.totalSeconds,
    inviteStatus: guest.inviteStatus,
    inviteError: guest.inviteError,
    inviteSentAt: guest.inviteSentAt?.toISOString() ?? null,
    invitedByUserId: guest.invitedByUserId,
    invitedByEmployeeId: guest.invitedByEmployeeId,
    revokedAt: guest.revokedAt?.toISOString() ?? null,
    createdAt: guest.createdAt.toISOString(),
  };
}

export function serializeQuestion(
  question: DataRoomQuestion,
  guest?: Pick<DataRoomGuest, "id" | "name" | "email" | "organization"> | null,
) {
  return {
    id: question.id,
    guestId: question.guestId,
    guest: guest
      ? { id: guest.id, name: guest.name, email: guest.email, organization: guest.organization }
      : null,
    documentId: question.documentId,
    body: question.body,
    status: question.status,
    answer: question.answer,
    citations: parseJsonArray<DataRoomCitation>(question.citationsJson),
    answeredByUserId: question.answeredByUserId,
    answeredByEmployeeId: question.answeredByEmployeeId,
    answeredAt: question.answeredAt?.toISOString() ?? null,
    draftAnswer: question.draftAnswer,
    draftCitations: parseJsonArray<DataRoomCitation>(question.draftCitationsJson),
    draftNote: question.draftNote,
    draftByEmployeeId: question.draftByEmployeeId,
    draftAt: question.draftAt?.toISOString() ?? null,
    injectionFlag: question.injectionFlag,
    createdAt: question.createdAt.toISOString(),
    updatedAt: question.updatedAt.toISOString(),
  };
}

export function serializeJob(job: DataRoomJob) {
  return {
    id: job.id,
    kind: job.kind,
    targetId: job.targetId,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    runAfter: job.runAfter.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

/** The AI work waiting, running, or failed in a room — what its page shows progress for. */
export async function roomJobs(roomId: string): Promise<DataRoomJob[]> {
  return AppDataSource.getRepository(DataRoomJob).find({
    where: { roomId, status: In(["queued", "running", "failed"]) },
    order: { createdAt: "ASC" },
  });
}

// ── Views ───────────────────────────────────────────────────────────────────

/** Every room of the company with its counts, newest activity first. */
export async function roomListView(companyId: string, filters: { status?: DataRoomStatus } = {}) {
  const rows = await listDataRooms(companyId, filters);
  const employees = await employeeStubs(
    companyId,
    rows.map((row) => row.room.aiEmployeeId),
  );
  return {
    rooms: rows.map((row) =>
      serializeRoom(row.room, {
        counts: row.counts,
        aiEmployee: row.room.aiEmployeeId ? (employees.get(row.room.aiEmployeeId) ?? null) : null,
      }),
    ),
  };
}

/** The room with its index, its documents and the AI work in flight. */
/**
 * Whether the room's AI Employee can think at all — without a connected AI
 * Model every brief, review and draft fails, and the room says so up front.
 */
async function aiModelConnected(employeeId: string | null): Promise<boolean> {
  if (!employeeId) return false;
  try {
    const model = await getActiveModel(employeeId);
    return model !== null && isModelConnected(model);
  } catch {
    return false;
  }
}

export async function roomDetailView(companyId: string, roomId: string) {
  const room = await requireRoom(companyId, roomId);
  const [folders, documents, counts, jobs, employees, modelConnected] = await Promise.all([
    listFolders(room.id),
    AppDataSource.getRepository(DataRoomDocument).find({
      where: { roomId: room.id },
      order: { position: "ASC", createdAt: "ASC" },
    }),
    roomCounts([room.id]),
    roomJobs(room.id),
    employeeStubs(companyId, [room.aiEmployeeId]),
    aiModelConnected(room.aiEmployeeId),
  ]);
  const aiEmployee = room.aiEmployeeId ? (employees.get(room.aiEmployeeId) ?? null) : null;
  return {
    room: serializeRoom(room, { counts: counts.get(room.id), aiEmployee }),
    folders: folders.map((folder, index) => serializeFolder(folder, index + 1)),
    documents: documents.map(serializeDocument),
    jobs: jobs.map(serializeJob),
    aiModelConnected: aiEmployee !== null && modelConnected,
  };
}

/** The room's questions, newest first, each with the guest who asked. */
export async function questionsView(
  roomId: string,
  filters: { status?: DataRoomQuestionStatus } = {},
) {
  const [questions, guests] = await Promise.all([
    listQuestions(roomId, filters),
    AppDataSource.getRepository(DataRoomGuest).find({ where: { roomId } }),
  ]);
  const byId = new Map(guests.map((guest) => [guest.id, guest]));
  return {
    questions: questions.map((question) => serializeQuestion(question, byId.get(question.guestId))),
  };
}

export async function questionView(question: DataRoomQuestion) {
  const guest = await AppDataSource.getRepository(DataRoomGuest).findOneBy({
    id: question.guestId,
    roomId: question.roomId,
  });
  return serializeQuestion(question, guest);
}
