import { AppDataSource } from "../../db/datasource.js";
import { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { DataRoomQuestion } from "../../db/entities/DataRoomQuestion.js";
import {
  DATA_ROOM_LIMITS,
  type DataRoomCitation,
  type DataRoomQuestionStatus,
} from "../../../shared/dataRooms.js";
import { type DataRoomActor, auditRoom, parseJsonArray, requireRoom } from "./access.js";
import { type CitationInput, checkCitations, publishAnswer } from "./answers.js";
import { DataRoomConflictError, DataRoomNotFoundError, DataRoomValidationError } from "./errors.js";
import { enqueueDataRoomJob } from "./queue.js";

/**
 * Guests' questions, from the company's side: answering one, publishing the
 * AI Employee's draft, closing one that needs no answer, and asking the AI
 * Employee for a fresh draft.
 */

export async function listQuestions(
  roomId: string,
  filters: { status?: DataRoomQuestionStatus } = {},
): Promise<DataRoomQuestion[]> {
  return AppDataSource.getRepository(DataRoomQuestion).find({
    where: { roomId, ...(filters.status ? { status: filters.status } : {}) },
    order: { createdAt: "DESC" },
  });
}

export async function requireQuestion(
  roomId: string,
  questionId: string,
): Promise<DataRoomQuestion> {
  const question = await AppDataSource.getRepository(DataRoomQuestion).findOneBy({
    id: questionId,
    roomId,
  });
  if (!question) throw new DataRoomNotFoundError("Question not found");
  return question;
}

async function guestOf(question: DataRoomQuestion): Promise<DataRoomGuest> {
  const guest = await AppDataSource.getRepository(DataRoomGuest).findOneBy({
    id: question.guestId,
  });
  if (!guest) throw new DataRoomNotFoundError("The guest who asked is gone.");
  return guest;
}

/**
 * Publish an answer. Every quote must be in its document word for word and
 * inside what the asking guest can open; one that is not refuses the answer,
 * so a Member never sends a guest a citation they cannot follow.
 */
export async function answerQuestion(args: {
  companyId: string;
  roomId: string;
  questionId: string;
  answer: string;
  citations?: CitationInput[];
  actor: DataRoomActor;
}): Promise<DataRoomQuestion> {
  const room = await requireRoom(args.companyId, args.roomId);
  const question = await requireQuestion(room.id, args.questionId);
  const guest = await guestOf(question);
  const { citations } = await checkCitations({
    room,
    guest,
    citations: args.citations ?? [],
    strict: true,
  });
  return publishAnswer({ room, question, answer: args.answer, citations, actor: args.actor });
}

/**
 * Publish the waiting draft as it stands. Its quotes were checked when it was
 * written; they are checked again, since a folder may have been taken from the
 * guest since, and any that no longer hold are left out.
 */
export async function publishDraft(args: {
  companyId: string;
  roomId: string;
  questionId: string;
  actor: DataRoomActor;
}): Promise<DataRoomQuestion> {
  const room = await requireRoom(args.companyId, args.roomId);
  const question = await requireQuestion(room.id, args.questionId);
  if (!question.draftAnswer.trim())
    throw new DataRoomConflictError("There is no draft to publish.");
  const guest = await guestOf(question);
  const drafted = parseJsonArray<DataRoomCitation>(question.draftCitationsJson).map((citation) => ({
    documentId: String(citation.documentId ?? ""),
    quote: String(citation.quote ?? ""),
  }));
  const { citations } = await checkCitations({ room, guest, citations: drafted, strict: false });
  return publishAnswer({
    room,
    question,
    answer: question.draftAnswer,
    citations,
    actor: args.actor,
  });
}

/**
 * Hold an AI Employee's draft for a Member. Quotes that do not check out are
 * dropped and counted, never stored.
 */
export async function saveDraft(args: {
  companyId: string;
  roomId: string;
  questionId: string;
  answer: string;
  citations: CitationInput[];
  note?: string;
  employeeId: string;
}): Promise<{ question: DataRoomQuestion; dropped: number }> {
  const room = await requireRoom(args.companyId, args.roomId);
  const question = await requireQuestion(room.id, args.questionId);
  if (question.status !== "open") {
    throw new DataRoomConflictError("This question is already answered or closed.");
  }
  const answer = args.answer.trim();
  if (!answer) throw new DataRoomValidationError("Write the draft answer.");
  if (answer.length > DATA_ROOM_LIMITS.answerChars) {
    throw new DataRoomValidationError("The draft is too long.");
  }
  const guest = await guestOf(question);
  const { citations, dropped } = await checkCitations({
    room,
    guest,
    citations: args.citations,
    strict: false,
  });
  const note = [
    (args.note ?? "").trim().slice(0, 600),
    dropped ? `${dropped} quote${dropped === 1 ? " was" : "s were"} not found and removed.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  await AppDataSource.getRepository(DataRoomQuestion).update(
    { id: question.id },
    {
      draftAnswer: answer,
      draftCitationsJson: JSON.stringify(citations),
      draftNote: note,
      draftByEmployeeId: args.employeeId,
      draftAt: new Date(),
    },
  );
  await auditRoom({ kind: "ai", employeeId: args.employeeId }, room, "answer_drafted", {
    questionId: question.id,
  });
  return { question: await requireQuestion(room.id, question.id), dropped };
}

export async function setQuestionStatus(args: {
  companyId: string;
  roomId: string;
  questionId: string;
  status: "open" | "closed";
  actor: DataRoomActor;
}): Promise<DataRoomQuestion> {
  const room = await requireRoom(args.companyId, args.roomId);
  const question = await requireQuestion(room.id, args.questionId);
  if (args.status === "closed" && question.status !== "open") {
    throw new DataRoomConflictError("Only an unanswered question can be closed.");
  }
  if (args.status === "open" && question.status !== "closed") {
    throw new DataRoomConflictError("Only a closed question can be reopened.");
  }
  await AppDataSource.getRepository(DataRoomQuestion).update(
    { id: question.id },
    { status: args.status },
  );
  await auditRoom(
    args.actor,
    room,
    args.status === "closed" ? "question_closed" : "question_reopened",
    {
      questionId: question.id,
    },
  );
  return requireQuestion(room.id, question.id);
}

/** Ask the room's AI Employee for a draft now. */
export async function requestDraft(args: {
  companyId: string;
  roomId: string;
  questionId: string;
}): Promise<void> {
  const room = await requireRoom(args.companyId, args.roomId);
  const question = await requireQuestion(room.id, args.questionId);
  if (!room.aiEmployeeId) {
    throw new DataRoomConflictError("Choose the room's AI Employee in its settings first.");
  }
  if (question.status !== "open")
    throw new DataRoomConflictError("This question is already answered or closed.");
  await enqueueDataRoomJob({
    companyId: room.companyId,
    roomId: room.id,
    kind: "answer",
    targetId: question.id,
  });
}

/** Queue the readiness review, or a reading of the activity. */
export async function requestRoomReview(args: {
  companyId: string;
  roomId: string;
  kind: "readiness" | "insights";
}): Promise<void> {
  const room = await requireRoom(args.companyId, args.roomId);
  if (!room.aiEmployeeId) {
    throw new DataRoomConflictError("Choose the room's AI Employee in its settings first.");
  }
  await enqueueDataRoomJob({
    companyId: room.companyId,
    roomId: room.id,
    kind: args.kind,
    targetId: room.id,
  });
}
