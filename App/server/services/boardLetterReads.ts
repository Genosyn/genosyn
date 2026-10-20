import { In, IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { BoardLetter } from "../db/entities/BoardLetter.js";
import type { Role } from "../db/entities/Membership.js";
import { Notification, type NotificationKind } from "../db/entities/Notification.js";
import {
  BOARD_LETTER_SUMMARY_SELECT,
  BoardLetterNotFoundError,
  type BoardLetterSummaryDTO,
  serializeBoardLetterSummary,
} from "./boardLetters.js";
import { markEntityNotificationsRead } from "./notifications.js";

/**
 * Whether an owner or admin has read a letter to the board.
 *
 * It is their bell notification for that letter and nothing else. Delivering a
 * letter gives each owner and admin exactly one (`boardLetterNotice.ts`), so a
 * second read state of its own would only be a way for the bell and Home to
 * disagree. A letter stays unread while that notification does. Opening the
 * letter reads it, wherever the person came from: Home, the bell, the email or
 * the list. So does dismissing it on Home, or marking it read in the bell.
 *
 * Home therefore shows the letters that were sent to someone, not every letter
 * the company has. An owner or admin who joined the board after a letter went
 * out was not sent it, and finds it under What happened → Letters. A Member is
 * never shown one, not even a former admin whose old notification remains.
 */

/** The bell notification that carries a letter. Only owners and admins may see one. */
export const BOARD_LETTER_NOTIFICATION_KIND: NotificationKind = "board_letter_ready";

/** The board in Genosyn today: a company's owners and admins. */
export function canReadBoardLetters(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export type UnreadBoardLetters = {
  /** The newest letter this person has not read, or null when there is none. */
  letter: BoardLetterSummaryDTO | null;
  /** How many letters this person has not read, the one shown included. */
  unreadCount: number;
};

/** The letters sent to this owner or admin that they have not read yet, newest first. */
export async function listUnreadBoardLetters(params: {
  companyId: string;
  userId: string;
  role: Role;
}): Promise<UnreadBoardLetters> {
  if (!canReadBoardLetters(params.role)) return { letter: null, unreadCount: 0 };
  // Bounded by the (userId, readAt) index to this person's unread bell rows.
  const unread = await AppDataSource.getRepository(Notification).find({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      kind: BOARD_LETTER_NOTIFICATION_KIND,
      entityKind: "board_letter",
      readAt: IsNull(),
    },
    select: { id: true, entityId: true },
  });
  const ids = [...new Set(unread.flatMap((row) => (row.entityId ? [row.entityId] : [])))];
  if (ids.length === 0) return { letter: null, unreadCount: 0 };
  // One letter a month, so never many.
  const letters = await AppDataSource.getRepository(BoardLetter).find({
    where: { companyId: params.companyId, id: In(ids) },
    order: { number: "DESC" },
    select: BOARD_LETTER_SUMMARY_SELECT,
  });
  return {
    letter: letters.length > 0 ? serializeBoardLetterSummary(letters[0]) : null,
    unreadCount: letters.length,
  };
}

/**
 * This person has read letter `number`: mark their own notification for it
 * read, which takes it off their Home and their bell, and nobody else's. Doing
 * it twice changes nothing.
 */
export async function markBoardLetterRead(params: {
  companyId: string;
  userId: string;
  number: number;
}): Promise<void> {
  const letter = await AppDataSource.getRepository(BoardLetter).findOne({
    where: { companyId: params.companyId, number: params.number },
    select: { id: true },
  });
  if (!letter) throw new BoardLetterNotFoundError("No such letter.");
  await markEntityNotificationsRead({
    companyId: params.companyId,
    entityKind: "board_letter",
    entityId: letter.id,
    userId: params.userId,
  });
}
