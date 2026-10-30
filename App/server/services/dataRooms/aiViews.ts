import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { DataRoomDocument } from "../../db/entities/DataRoomDocument.js";
import type { DataRoomFolder } from "../../db/entities/DataRoomFolder.js";
import { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { DataRoomQuestion } from "../../db/entities/DataRoomQuestion.js";
import {
  DATA_ROOM_CHECKLISTS,
  DATA_ROOM_PURPOSE_LABELS,
  READINESS_STATUS_LABELS,
  type DataRoomCitation,
  type DataRoomDocumentBrief,
  type DataRoomQuestionStatus,
  type DataRoomReadiness,
  type DataRoomStatus,
} from "../../../shared/dataRooms.js";
import {
  type DataRoomActor,
  guestFolderIds,
  parseJsonArray,
  parseJsonObject,
  requireRoom,
} from "./access.js";
import {
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  type PageRequest,
} from "../listPaging.js";
import { roomActivity } from "./activity.js";
import { DataRoomNotFoundError, DataRoomValidationError } from "./errors.js";
import { listGuests } from "./guests.js";
import { createFolder, listDataRooms, listFolders, roomCounts } from "./rooms.js";
import { employeeStubs, roomJobs } from "./serialize.js";

/**
 * Data rooms as an AI Employee's tools read them: compact, labelled, and
 * without anything that must stay on the server — no guest link, no storage
 * key, no document text beyond what `read_data_room_document` pages out.
 */

const minutes = (seconds: number) => Math.round((seconds / 60) * 10) / 10;

/** "2.3" for the third document of the second folder; "—" for the top level. */
export function documentIndexNumbers(
  folders: Pick<DataRoomFolder, "id">[],
  documents: Pick<DataRoomDocument, "id" | "folderId">[],
): Map<string, string> {
  const folderNumber = new Map(folders.map((folder, index) => [folder.id, index + 1]));
  const seen = new Map<string, number>();
  const numbers = new Map<string, string>();
  for (const document of documents) {
    const number = document.folderId ? folderNumber.get(document.folderId) : undefined;
    if (!number) {
      numbers.set(document.id, "—");
      continue;
    }
    const next = (seen.get(document.folderId!) ?? 0) + 1;
    seen.set(document.folderId!, next);
    numbers.set(document.id, `${number}.${next}`);
  }
  return numbers;
}

export async function aiRoomList(companyId: string, status?: DataRoomStatus) {
  const rows = await listDataRooms(companyId, { status });
  return rows.map(({ room, counts }) => ({
    id: room.id,
    name: room.name,
    purpose: DATA_ROOM_PURPOSE_LABELS[room.purpose],
    status: room.status,
    documents: counts.documents,
    folders: counts.folders,
    guests: counts.guests,
    guestsWhoVisited: counts.guestsVisited,
    unansweredQuestions: counts.openQuestions,
    readinessScore: parseJsonObject<DataRoomReadiness>(room.readinessJson)?.score ?? null,
    lastGuestActivityAt: room.lastGuestActivityAt?.toISOString() ?? null,
    updatedAt: room.updatedAt.toISOString(),
  }));
}

export async function aiRoomDetail(companyId: string, roomId: string) {
  const room = await requireRoom(companyId, roomId);
  const [folders, documents, guests, counts, jobs, employees] = await Promise.all([
    listFolders(room.id),
    AppDataSource.getRepository(DataRoomDocument).find({
      where: { roomId: room.id },
      order: { position: "ASC", createdAt: "ASC" },
    }),
    listGuests(room.id),
    roomCounts([room.id]),
    roomJobs(room.id),
    employeeStubs(companyId, [room.aiEmployeeId]),
  ]);
  const folderName = new Map(folders.map((folder) => [folder.id, folder.name]));
  const numbers = documentIndexNumbers(folders, documents);
  const readiness = parseJsonObject<DataRoomReadiness>(room.readinessJson);
  const checklist = new Map(DATA_ROOM_CHECKLISTS[room.purpose].map((entry) => [entry.key, entry]));
  return {
    room: {
      id: room.id,
      name: room.name,
      purpose: DATA_ROOM_PURPOSE_LABELS[room.purpose],
      status: room.status,
      description: room.description,
      welcomeMessage: room.welcomeMessage,
      downloads: room.allowDownloads ? "allowed" : "view only",
      watermark: room.watermark,
      termsRequired: room.requireTerms,
      aiEmployee: room.aiEmployeeId ? (employees.get(room.aiEmployeeId)?.name ?? null) : null,
      aiAnswerMode: room.aiAnswerMode,
    },
    folders: folders.map((folder, index) => ({
      id: folder.id,
      number: index + 1,
      name: folder.name,
    })),
    documents: documents.map((document) => {
      const brief = parseJsonObject<DataRoomDocumentBrief>(document.briefJson);
      return {
        id: document.id,
        index: numbers.get(document.id) ?? "—",
        title: document.title,
        folder: document.folderId ? (folderName.get(document.folderId) ?? null) : null,
        filename: document.filename,
        sizeBytes: document.sizeBytes,
        pages: document.pageCount || null,
        hasText: document.textStatus === "extracted",
        summary: brief?.summary ?? null,
        keyFacts: brief?.keyFacts ?? [],
        cautions: brief?.cautions ?? [],
      };
    }),
    guests: guests.map((guest) => {
      const folderIds = guestFolderIds(guest);
      return {
        id: guest.id,
        name: guest.name,
        email: guest.email,
        organization: guest.organization,
        status: guest.status,
        folders: folderIds.length === 0 ? "all" : folderIds.map((id) => folderName.get(id) ?? id),
        expiresAt: guest.expiresAt?.toISOString() ?? null,
        lastVisit: guest.lastViewedAt?.toISOString() ?? null,
        visits: guest.visitCount,
        minutesReading: minutes(guest.totalSeconds),
        invitation: guest.inviteStatus,
      };
    }),
    readiness: readiness
      ? {
          score: readiness.score,
          summary: readiness.summary,
          nextSteps: readiness.nextSteps,
          reviewedAt: room.readinessAt?.toISOString() ?? null,
          stale: readiness.documentCount !== documents.length,
          items: readiness.findings.map((finding) => ({
            item: checklist.get(finding.key)?.label ?? finding.key,
            status: READINESS_STATUS_LABELS[finding.status],
            note: finding.note,
          })),
        }
      : null,
    unansweredQuestions: counts.get(room.id)?.openQuestions ?? 0,
    aiWork: jobs.map((job) => ({ kind: job.kind, status: job.status, error: job.error || null })),
  };
}

export function aiQuestion(
  question: DataRoomQuestion,
  guest?: { name: string; organization: string } | null,
) {
  return {
    id: question.id,
    roomId: question.roomId,
    guest: guest ? { name: guest.name, organization: guest.organization } : null,
    askedAboutDocumentId: question.documentId,
    question: question.body,
    status: question.status,
    answer: question.status === "answered" ? question.answer : null,
    citations: parseJsonArray<DataRoomCitation>(question.citationsJson),
    draft: question.draftAnswer
      ? {
          answer: question.draftAnswer,
          citations: parseJsonArray<DataRoomCitation>(question.draftCitationsJson),
          note: question.draftNote,
        }
      : null,
    askedAt: question.createdAt.toISOString(),
    answeredAt: question.answeredAt?.toISOString() ?? null,
  };
}

/** 50 questions by default, at most 200 a page. */
export const DATA_ROOM_QUESTION_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

/**
 * A room's questions, newest first, one page at a time
 * (`services/listPaging.ts`): every question is reachable by following
 * `nextCursor`, and one answered or closed between pages never makes a page
 * skip another. The room must be this company's.
 */
export async function aiQuestionPage(
  companyId: string,
  roomId: string,
  status: DataRoomQuestionStatus | undefined,
  page: PageRequest & { budgetChars?: number },
): Promise<Page<ReturnType<typeof aiQuestion>>> {
  // The room is this company's, and a question belongs to exactly one room,
  // so the page reads by room alone — through the `(roomId, …, createdAt, id)`
  // indexes, which a company filter would steer the planner away from.
  const room = await requireRoom(companyId, roomId);
  return keysetPage({
    query: () => {
      const qb = AppDataSource.getRepository(DataRoomQuestion)
        .createQueryBuilder("q")
        .where("q.roomId = :roomId", { roomId: room.id });
      if (status) qb.andWhere("q.status = :status", { status });
      return qb;
    },
    keys: [
      { column: "q.createdAt", direction: "DESC", type: "timestamp" },
      { column: "q.id", direction: "DESC", type: "string" },
    ],
    scope: "data_room.questions",
    fingerprint: filterFingerprint(companyId, { room: room.id, status }),
    noun: "questions",
    limits: DATA_ROOM_QUESTION_PAGE,
    page,
    present: async (questions) => {
      // Only the guests who asked the questions on this page.
      const guestIds = [...new Set(questions.map((question) => question.guestId))];
      const guests = guestIds.length
        ? await AppDataSource.getRepository(DataRoomGuest).find({
            where: { roomId: room.id, id: In(guestIds) },
            select: { id: true, name: true, organization: true },
          })
        : [];
      const byId = new Map(guests.map((guest) => [guest.id, guest]));
      return questions.map((question) => aiQuestion(question, byId.get(question.guestId)));
    },
  });
}

export async function requireQuestionInCompany(
  companyId: string,
  questionId: string,
): Promise<DataRoomQuestion> {
  const question = await AppDataSource.getRepository(DataRoomQuestion).findOneBy({
    id: questionId,
    companyId,
  });
  if (!question) throw new DataRoomNotFoundError("Question not found");
  return question;
}

export async function requireDocumentInCompany(
  companyId: string,
  documentId: string,
): Promise<DataRoomDocument> {
  const document = await AppDataSource.getRepository(DataRoomDocument).findOneBy({
    id: documentId,
    companyId,
  });
  if (!document) throw new DataRoomNotFoundError("Document not found");
  return document;
}

export async function aiActivity(companyId: string, roomId: string) {
  const room = await requireRoom(companyId, roomId);
  const activity = await roomActivity(room, { feedLimit: 30 });
  return {
    totals: {
      guestsInvited: activity.totals.guestsInvited,
      guestsWhoVisited: activity.totals.guestsVisited,
      visits: activity.totals.visits,
      minutesReading: minutes(activity.totals.totalSeconds),
      downloads: activity.totals.downloads,
      questions: activity.totals.questions,
    },
    guests: activity.guests.map((guest) => ({
      id: guest.guestId,
      name: guest.name,
      organization: guest.organization,
      status: guest.status,
      visits: guest.visits,
      minutesReading: minutes(guest.totalSeconds),
      documentsOpened: guest.documentsViewed,
      downloads: guest.downloads,
      questionsAsked: guest.questionsAsked,
      firstVisit: guest.firstViewedAt,
      lastVisit: guest.lastViewedAt,
      mostRead: guest.topDocuments.map((document) => ({
        documentId: document.documentId,
        title: document.title,
        minutes: minutes(document.seconds),
      })),
    })),
    documents: activity.documents.map((document) => ({
      id: document.documentId,
      title: document.title,
      opens: document.views,
      guests: document.guests,
      minutesReading: minutes(document.seconds),
      downloads: document.downloads,
    })),
    recent: activity.feed.map((item) => ({
      kind: item.kind,
      guest: item.guestName,
      document: item.documentTitle,
      at: item.createdAt,
    })),
  };
}

/** Folder ids for names or ids an AI Employee gave; an unknown one is refused with the list. */
export async function resolveFolderRefs(roomId: string, refs: string[]): Promise<string[]> {
  const folders = await listFolders(roomId);
  const ids: string[] = [];
  for (const ref of refs) {
    const wanted = ref.trim().toLowerCase();
    const folder = folders.find(
      (item) => item.id === ref || item.name.trim().toLowerCase() === wanted,
    );
    if (!folder) {
      throw new DataRoomValidationError(
        `No folder called "${ref}" in this room. Its folders are: ${folders.map((item) => item.name).join(", ") || "none"}.`,
      );
    }
    ids.push(folder.id);
  }
  return [...new Set(ids)];
}

/** The folder named `name`, created when the room has none by that name. */
export async function folderIdForName(
  companyId: string,
  roomId: string,
  name: string,
  actor: DataRoomActor,
): Promise<string> {
  const folders = await listFolders(roomId);
  const wanted = name.trim().toLowerCase();
  const existing = folders.find(
    (folder) => folder.id === name || folder.name.trim().toLowerCase() === wanted,
  );
  if (existing) return existing.id;
  return (await createFolder({ companyId, roomId, name, actor })).id;
}
