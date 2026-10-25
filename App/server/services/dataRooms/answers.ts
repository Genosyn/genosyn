import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import type { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { DataRoomQuestion } from "../../db/entities/DataRoomQuestion.js";
import { DATA_ROOM_LIMITS, type DataRoomCitation } from "../../../shared/dataRooms.js";
import { sendEmail } from "../email.js";
import {
  type DataRoomActor,
  actorColumns,
  auditRoom,
  documentsWithText,
  guestCanSeeDocument,
} from "./access.js";
import { buildAnswerEmail } from "./emails.js";
import { DataRoomConflictError, DataRoomValidationError } from "./errors.js";
import { verifyQuote } from "./retrieval.js";
import { guestLink } from "./tokens.js";

/**
 * Publishing an answer to a guest — the one door every answer goes through,
 * whether a Member wrote it, a Member published an AI draft, an AI Employee
 * with `share` access answered through its tools, or the room answered on its
 * own. Each citation is checked against the document's own text and against
 * what the asking guest may open, so an answer can never point a guest at a
 * document outside their folders.
 */

export type CitationInput = { documentId: string; quote: string };

/**
 * The citations that hold: the document is in the room and open to this
 * guest, and the quote is in its text. `strict` refuses the whole set on the
 * first one that does not; otherwise the rest are kept and the count dropped
 * is reported.
 */
export async function checkCitations(args: {
  room: Pick<DataRoom, "id">;
  guest: Pick<DataRoomGuest, "folderIdsJson">;
  citations: CitationInput[];
  strict: boolean;
}): Promise<{ citations: DataRoomCitation[]; dropped: number }> {
  if (args.citations.length > DATA_ROOM_LIMITS.citationsPerAnswer) {
    throw new DataRoomValidationError(
      `An answer can cite at most ${DATA_ROOM_LIMITS.citationsPerAnswer} passages.`,
    );
  }
  if (args.citations.length === 0) return { citations: [], dropped: 0 };
  const ids = [...new Set(args.citations.map((citation) => citation.documentId))];
  const documents = await documentsWithText(args.room.id, ids);
  const byId = new Map(documents.map((document) => [document.id, document]));
  const kept: DataRoomCitation[] = [];
  let dropped = 0;
  for (const citation of args.citations) {
    const document = byId.get(citation.documentId);
    const quote = citation.quote.trim().slice(0, DATA_ROOM_LIMITS.quoteChars);
    let problem: string | null = null;
    if (!document) problem = "That document is not in this room.";
    else if (!guestCanSeeDocument(args.guest, document)) {
      problem = `"${document.title}" is outside the folders this guest can open.`;
    } else if (!verifyQuote(quote, [document.text])) {
      problem = `That quote is not in "${document.title}" word for word.`;
    }
    if (problem) {
      if (args.strict) throw new DataRoomValidationError(problem);
      dropped += 1;
      continue;
    }
    if (kept.some((item) => item.documentId === document!.id && item.quote === quote)) continue;
    kept.push({ documentId: document!.id, title: document!.title, quote });
  }
  return { citations: kept, dropped };
}

/** Publish `answer` to the guest who asked, and email them that it is there. */
export async function publishAnswer(args: {
  room: DataRoom;
  question: DataRoomQuestion;
  answer: string;
  citations: DataRoomCitation[];
  actor: DataRoomActor;
}): Promise<DataRoomQuestion> {
  const answer = args.answer.trim();
  if (!answer) throw new DataRoomValidationError("Write an answer first.");
  if (answer.length > DATA_ROOM_LIMITS.answerChars) {
    throw new DataRoomValidationError(
      `Keep the answer under ${DATA_ROOM_LIMITS.answerChars.toLocaleString("en-US")} characters.`,
    );
  }
  if (args.question.status === "closed") {
    throw new DataRoomConflictError("This question is closed. Reopen it to answer.");
  }
  const repo = AppDataSource.getRepository(DataRoomQuestion);
  const who = actorColumns(args.actor);
  const wasAnswered = args.question.status === "answered";
  await repo.update(
    { id: args.question.id },
    {
      status: "answered",
      answer,
      citationsJson: JSON.stringify(args.citations),
      answeredByUserId: who.userId,
      answeredByEmployeeId: who.employeeId,
      answeredAt: new Date(),
      draftAnswer: "",
      draftCitationsJson: "[]",
      draftNote: "",
      draftByEmployeeId: null,
      draftAt: null,
    },
  );
  const updated = await repo.findOneByOrFail({ id: args.question.id });
  await auditRoom(args.actor, args.room, wasAnswered ? "answer_updated" : "question_answered", {
    questionId: updated.id,
    citations: args.citations.length,
  });
  await notifyGuestOfAnswer(args.room, updated, args.actor);
  return updated;
}

/** Best-effort: a failed email never un-publishes an answer the guest can already read. */
async function notifyGuestOfAnswer(
  room: DataRoom,
  question: DataRoomQuestion,
  actor: DataRoomActor,
): Promise<void> {
  try {
    const [guest, company] = await Promise.all([
      AppDataSource.getRepository(DataRoomGuest).findOneBy({ id: question.guestId }),
      AppDataSource.getRepository(Company).findOneBy({ id: room.companyId }),
    ]);
    if (!guest || guest.status !== "active" || !company || room.status !== "open") return;
    const link = guestLink(guest);
    if (!link) return;
    await sendEmail({
      ...buildAnswerEmail({ company, room, guest, link, question: question.body }),
      companyId: room.companyId,
      triggeredByUserId: actor.kind === "user" ? actor.userId : null,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[data-rooms] could not email the answer to question ${question.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
