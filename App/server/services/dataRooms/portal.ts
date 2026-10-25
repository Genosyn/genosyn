import crypto from "node:crypto";
import fs from "node:fs";

import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomDocument } from "../../db/entities/DataRoomDocument.js";
import { DataRoomEvent, type DataRoomEventKind } from "../../db/entities/DataRoomEvent.js";
import { DataRoomFolder } from "../../db/entities/DataRoomFolder.js";
import { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { DataRoomQuestion } from "../../db/entities/DataRoomQuestion.js";
import { Membership } from "../../db/entities/Membership.js";
import {
  DATA_ROOM_LIMITS,
  viewerKindFor,
  type DataRoomCitation,
  type DataRoomViewerKind,
} from "../../../shared/dataRooms.js";
import { createNotifications } from "../notifications.js";
import {
  documentsForGuest,
  guestCanSeeDocument,
  guestFolderIds,
  guestSeesEverything,
  parseJsonArray,
} from "./access.js";
import { readDocumentText, documentFile } from "./documents.js";
import { DataRoomConflictError, DataRoomNotFoundError, DataRoomValidationError } from "./errors.js";
import { enqueueDataRoomJob } from "./queue.js";
import { watermarkPdf } from "./storage.js";
import { GUEST_TOKEN_PATTERN, hashGuestToken } from "./tokens.js";

/**
 * The room as a guest meets it, through nothing but their private link.
 *
 * A guest is a stranger to the App: no session, no Member, no API key. The
 * token in their link finds exactly one guest row, and every read here goes
 * through it — the folders that guest was given, the documents in them, the
 * questions that guest asked. Nothing a guest sends changes their access;
 * what they do is recorded as `DataRoomEvent`s.
 */

/** A visit is a new one after this long away. */
const VISIT_GAP_MS = 30 * 60_000;
/** The most one heartbeat may add, and one document view in all. */
const MAX_HEARTBEAT_SECONDS = 60;
const MAX_VIEW_SECONDS = 6 * 60 * 60;
/** Unanswered questions one guest may have waiting at once. */
const MAX_OPEN_QUESTIONS = 25;

export type GuestContext = { company: Company; room: DataRoom; guest: DataRoomGuest };

/** Why a known link does not open the room right now. */
export type GuestBlock = "closed" | "revoked" | "expired";

export type GuestLookup =
  | { ok: true; context: GuestContext }
  | { ok: false; block: GuestBlock; companyName: string; roomName: string };

/** The guest a link belongs to, or null for a link that never was. */
export async function lookupGuest(token: string): Promise<GuestLookup | null> {
  if (!GUEST_TOKEN_PATTERN.test(token)) return null;
  const guest = await AppDataSource.getRepository(DataRoomGuest).findOneBy({
    tokenHash: hashGuestToken(token),
  });
  if (!guest) return null;
  const [room, company] = await Promise.all([
    AppDataSource.getRepository(DataRoom).findOneBy({
      id: guest.roomId,
      companyId: guest.companyId,
    }),
    AppDataSource.getRepository(Company).findOneBy({ id: guest.companyId }),
  ]);
  if (!room || !company) return null;
  const blocked = (block: GuestBlock): GuestLookup => ({
    ok: false,
    block,
    companyName: company.name,
    roomName: room.name,
  });
  if (room.status !== "open") return blocked("closed");
  if (guest.status !== "active") return blocked("revoked");
  if (guest.expiresAt && guest.expiresAt.getTime() <= Date.now()) return blocked("expired");
  return { ok: true, context: { company, room, guest } };
}

export function termsHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Whether the guest has accepted the room's current terms, or none are required. */
export function termsSatisfied(context: GuestContext): boolean {
  const { room, guest } = context;
  if (!room.requireTerms || !room.termsText.trim()) return true;
  return Boolean(guest.termsAcceptedAt) && guest.termsSha256 === termsHash(room.termsText);
}

function requireTerms(context: GuestContext): void {
  if (!termsSatisfied(context)) {
    throw new DataRoomConflictError("Accept the room's terms first.");
  }
}

export type Evidence = { ipAddress?: string; userAgent?: string };

function cleanEvidence(evidence: Evidence): { ipAddress: string; userAgent: string } {
  return {
    ipAddress: (evidence.ipAddress ?? "").replace(/[\r\n]/g, " ").slice(0, 64),
    userAgent: (evidence.userAgent ?? "").replace(/[\r\n]/g, " ").slice(0, 400),
  };
}

async function recordEvent(
  context: GuestContext,
  kind: DataRoomEventKind,
  evidence: Evidence,
  extra: { documentId?: string | null } = {},
): Promise<DataRoomEvent> {
  const repo = AppDataSource.getRepository(DataRoomEvent);
  return repo.save(
    repo.create({
      companyId: context.room.companyId,
      roomId: context.room.id,
      guestId: context.guest.id,
      documentId: extra.documentId ?? null,
      kind,
      seconds: 0,
      ...cleanEvidence(evidence),
    }),
  );
}

async function touchRoom(room: DataRoom): Promise<void> {
  // Once a minute is plenty for "last activity", and spares a write per heartbeat.
  if (room.lastGuestActivityAt && Date.now() - room.lastGuestActivityAt.getTime() < 60_000) return;
  await AppDataSource.getRepository(DataRoom).update(
    { id: room.id },
    { lastGuestActivityAt: new Date() },
  );
}

/** Who hears about a guest: the Member who made the room, or else its owners. */
async function roomRecipients(room: DataRoom): Promise<string[]> {
  const admins = await AppDataSource.getRepository(Membership).find({
    where: { companyId: room.companyId, role: In(["owner", "admin"]) },
    select: { userId: true, role: true },
  });
  if (room.createdByUserId && admins.some((member) => member.userId === room.createdByUserId)) {
    return [room.createdByUserId];
  }
  return admins.filter((member) => member.role === "owner").map((member) => member.userId);
}

async function notifyRoomTeam(
  room: DataRoom,
  input: {
    kind: "data_room_question" | "data_room_visit";
    title: string;
    body: string;
    tab: string;
  },
): Promise<void> {
  try {
    const recipients = await roomRecipients(room);
    await createNotifications(
      recipients.map((userId) => ({
        companyId: room.companyId,
        userId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        link: `/data-rooms/${room.id}${input.tab}`,
        actorKind: "system",
        entityKind: "data_room",
        entityId: room.id,
      })),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[data-rooms] could not notify the team of room ${room.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function guestLabel(guest: DataRoomGuest): string {
  return guest.organization ? `${guest.name} (${guest.organization})` : guest.name;
}

/** Record a visit: the first in half an hour counts as a new one. */
export async function recordVisit(context: GuestContext, evidence: Evidence): Promise<void> {
  const { guest, room } = context;
  const now = new Date();
  const repo = AppDataSource.getRepository(DataRoomGuest);
  const first = !guest.firstViewedAt;
  const newVisit =
    !guest.lastViewedAt || now.getTime() - guest.lastViewedAt.getTime() > VISIT_GAP_MS;
  await repo.update(
    { id: guest.id },
    {
      lastViewedAt: now,
      ...(first ? { firstViewedAt: now } : {}),
      ...(newVisit ? { visitCount: guest.visitCount + 1 } : {}),
    },
  );
  if (newVisit) await recordEvent(context, "room_opened", evidence);
  await touchRoom(room);
  if (first) {
    await notifyRoomTeam(room, {
      kind: "data_room_visit",
      title: `${guestLabel(guest)} opened ${room.name}`,
      body: "Their first visit to the data room.",
      tab: "?tab=activity",
    });
  }
}

export async function acceptTerms(
  context: GuestContext,
  args: { name: string } & Evidence,
): Promise<void> {
  const { room, guest } = context;
  if (!room.requireTerms || !room.termsText.trim()) return;
  const name = args.name.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 160) {
    throw new DataRoomValidationError("Type your full name to accept.");
  }
  await AppDataSource.getRepository(DataRoomGuest).update(
    { id: guest.id },
    {
      termsAcceptedAt: new Date(),
      termsAcceptedName: name,
      termsSha256: termsHash(room.termsText),
      termsAcceptedIp: cleanEvidence(args).ipAddress,
    },
  );
  await recordEvent(context, "terms_accepted", args);
}

export type GuestDocument = {
  id: string;
  folderId: string | null;
  title: string;
  filename: string;
  viewerKind: DataRoomViewerKind;
  sizeBytes: number;
  pageCount: number;
  updatedAt: string;
};

export type GuestQuestion = {
  id: string;
  body: string;
  documentId: string | null;
  status: "open" | "answered" | "closed";
  answer: string | null;
  citations: DataRoomCitation[];
  answeredAt: string | null;
  createdAt: string;
};

export type GuestRoomView = {
  company: { name: string };
  room: {
    name: string;
    purpose: string;
    welcomeMessage: string;
    allowDownloads: boolean;
    watermark: boolean;
    requireTerms: boolean;
    termsText: string;
  };
  guest: { name: string; email: string; organization: string; expiresAt: string | null };
  termsAccepted: boolean;
  folders: Array<{ id: string; name: string; number: number }>;
  documents: GuestDocument[];
  questions: GuestQuestion[];
};

function guestDocument(document: DataRoomDocument): GuestDocument {
  return {
    id: document.id,
    folderId: document.folderId,
    title: document.title,
    filename: document.filename,
    viewerKind: viewerKindFor(document.filename, document.mimeType),
    sizeBytes: document.sizeBytes,
    pageCount: document.pageCount,
    updatedAt: document.updatedAt.toISOString(),
  };
}

function guestQuestion(question: DataRoomQuestion, visible: Set<string>): GuestQuestion {
  const answered = question.status === "answered";
  return {
    id: question.id,
    body: question.body,
    documentId:
      question.documentId && visible.has(question.documentId) ? question.documentId : null,
    status: question.status,
    answer: answered ? question.answer : null,
    // A citation into a folder the guest has since lost is left out rather
    // than shown as a dead end.
    citations: answered
      ? parseJsonArray<DataRoomCitation>(question.citationsJson).filter((citation) =>
          visible.has(citation.documentId),
        )
      : [],
    answeredAt: answered ? (question.answeredAt?.toISOString() ?? null) : null,
    createdAt: question.createdAt.toISOString(),
  };
}

/** Everything the guest's page shows. Before the terms are accepted, only the terms. */
export async function guestRoomView(context: GuestContext): Promise<GuestRoomView> {
  const { company, room, guest } = context;
  const accepted = termsSatisfied(context);
  let folders: DataRoomFolder[] = [];
  let documents: DataRoomDocument[] = [];
  let questions: DataRoomQuestion[] = [];
  if (accepted) {
    [folders, documents, questions] = await Promise.all([
      AppDataSource.getRepository(DataRoomFolder).find({
        where: { roomId: room.id },
        order: { position: "ASC", createdAt: "ASC" },
      }),
      documentsForGuest(room.id, guest),
      AppDataSource.getRepository(DataRoomQuestion).find({
        where: { roomId: room.id, guestId: guest.id },
        order: { createdAt: "DESC" },
      }),
    ]);
  }
  // Numbers are the room's own index numbers, so "see 3.2" means the same to
  // every guest, whichever folders each was given.
  const numbers = new Map(folders.map((folder, index) => [folder.id, index + 1]));
  const allowed = new Set(guestFolderIds(guest));
  const shown = guestSeesEverything(guest)
    ? folders
    : folders.filter((folder) => allowed.has(folder.id));
  const visible = new Set(documents.map((document) => document.id));
  return {
    company: { name: company.name },
    room: {
      name: room.name,
      purpose: room.purpose,
      welcomeMessage: room.welcomeMessage,
      allowDownloads: room.allowDownloads,
      watermark: room.watermark,
      requireTerms: room.requireTerms && Boolean(room.termsText.trim()),
      termsText: room.requireTerms ? room.termsText : "",
    },
    guest: {
      name: guest.name,
      email: guest.email,
      organization: guest.organization,
      expiresAt: guest.expiresAt?.toISOString() ?? null,
    },
    termsAccepted: accepted,
    folders: shown.map((folder) => ({
      id: folder.id,
      name: folder.name,
      number: numbers.get(folder.id) ?? 0,
    })),
    documents: documents.map(guestDocument),
    questions: questions.map((question) => guestQuestion(question, visible)),
  };
}

async function guestDocumentOrThrow(
  context: GuestContext,
  documentId: string,
): Promise<DataRoomDocument> {
  requireTerms(context);
  const document = await AppDataSource.getRepository(DataRoomDocument).findOneBy({
    id: documentId,
    roomId: context.room.id,
  });
  // A document outside the guest's folders answers exactly like one that
  // does not exist: its title is not theirs to learn.
  if (!document || !guestCanSeeDocument(context.guest, document)) {
    throw new DataRoomNotFoundError("Document not found");
  }
  return document;
}

/** Start timing a document the guest opened. */
export async function openDocumentView(
  context: GuestContext,
  documentId: string,
  evidence: Evidence,
): Promise<{ viewId: string }> {
  const document = await guestDocumentOrThrow(context, documentId);
  const event = await recordEvent(context, "document_viewed", evidence, {
    documentId: document.id,
  });
  await AppDataSource.getRepository(DataRoomGuest).update(
    { id: context.guest.id },
    { lastViewedAt: new Date() },
  );
  await touchRoom(context.room);
  return { viewId: event.id };
}

/** Add reading time to an open view: at most a minute per beat, six hours per view. */
export async function recordHeartbeat(
  context: GuestContext,
  viewId: string,
  seconds: number,
): Promise<void> {
  const step = Math.max(0, Math.min(MAX_HEARTBEAT_SECONDS, Math.round(seconds)));
  if (step === 0) return;
  const repo = AppDataSource.getRepository(DataRoomEvent);
  const view = await repo.findOneBy({
    id: viewId,
    guestId: context.guest.id,
    kind: "document_viewed",
  });
  if (!view) throw new DataRoomNotFoundError("View not found");
  const added = Math.min(step, Math.max(0, MAX_VIEW_SECONDS - view.seconds));
  if (added === 0) return;
  await repo.update({ id: view.id }, { seconds: view.seconds + added });
  await AppDataSource.getRepository(DataRoomGuest).update(
    { id: context.guest.id },
    { totalSeconds: context.guest.totalSeconds + added, lastViewedAt: new Date() },
  );
  await touchRoom(context.room);
}

export type GuestFile =
  | { kind: "bytes"; bytes: Buffer; mimeType: string; filename: string; sha256: string }
  | {
      kind: "path";
      path: string;
      mimeType: string;
      filename: string;
      sha256: string;
      sizeBytes: number;
    };

/**
 * The document's bytes for the guest. A PDF in a room that watermarks is
 * stamped with the guest's email and today's date on the way out; the stored
 * file is never changed. Downloading is refused unless the room allows it.
 */
export async function guestDocumentFile(
  context: GuestContext,
  documentId: string,
  args: { download: boolean } & Evidence,
): Promise<GuestFile> {
  const document = await guestDocumentOrThrow(context, documentId);
  if (args.download && !context.room.allowDownloads) {
    throw new DataRoomConflictError("This room is view only.");
  }
  const file = documentFile(document);
  if (args.download)
    await recordEvent(context, "document_downloaded", args, { documentId: document.id });
  if (context.room.watermark && viewerKindFor(document.filename, document.mimeType) === "pdf") {
    const date = new Date().toISOString().slice(0, 10);
    const label = `${context.guest.email} - ${date} - Confidential`;
    const bytes = await watermarkPdf(
      await fs.promises.readFile(file.path),
      label,
      `${document.id}:${document.sha256}`,
    );
    return {
      kind: "bytes",
      bytes,
      mimeType: file.mimeType,
      filename: file.filename,
      sha256: file.sha256,
    };
  }
  return { kind: "path", ...file };
}

/** The readable text of a document a guest can open, for documents shown as text. */
export async function guestDocumentText(
  context: GuestContext,
  documentId: string,
): Promise<{ text: string; truncated: boolean }> {
  const document = await guestDocumentOrThrow(context, documentId);
  const read = await readDocumentText(document, { maxChars: 200_000 });
  return { text: read.text, truncated: read.truncated };
}

export async function askQuestion(
  context: GuestContext,
  args: { body: string; documentId?: string | null } & Evidence,
): Promise<GuestQuestion> {
  requireTerms(context);
  const { room, guest } = context;
  const body = args.body.trim();
  if (body.length < 3) throw new DataRoomValidationError("Write your question.");
  if (body.length > DATA_ROOM_LIMITS.questionChars) {
    throw new DataRoomValidationError(
      `Keep your question under ${DATA_ROOM_LIMITS.questionChars.toLocaleString("en-US")} characters.`,
    );
  }
  let documentId: string | null = null;
  if (args.documentId) documentId = (await guestDocumentOrThrow(context, args.documentId)).id;
  const repo = AppDataSource.getRepository(DataRoomQuestion);
  const waiting = await repo.countBy({ roomId: room.id, guestId: guest.id, status: "open" });
  if (waiting >= MAX_OPEN_QUESTIONS) {
    throw new DataRoomConflictError(
      "You have many questions waiting already. The company will answer them before you ask more.",
    );
  }
  const question = await repo.save(
    repo.create({
      companyId: room.companyId,
      roomId: room.id,
      guestId: guest.id,
      documentId,
      body,
      status: "open",
    }),
  );
  await recordEvent(context, "question_asked", args, { documentId });
  await touchRoom(room);
  if (room.aiEmployeeId && room.aiAnswerMode !== "off") {
    await enqueueDataRoomJob({
      companyId: room.companyId,
      roomId: room.id,
      kind: "answer",
      targetId: question.id,
    });
  }
  await notifyRoomTeam(room, {
    kind: "data_room_question",
    title: `${guestLabel(guest)} asked a question in ${room.name}`,
    body: body.slice(0, 200),
    tab: "?tab=questions",
  });
  return guestQuestion(question, new Set(documentId ? [documentId] : []));
}
