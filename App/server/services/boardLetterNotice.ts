import { In, IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { BoardLetter } from "../db/entities/BoardLetter.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { AuditFinding } from "./boardLetterAudit.js";
import type { LetterFigures } from "./boardLetterFigures.js";
import { monthLabel } from "./boardLetterPeriods.js";
import type { TraceToken } from "./boardLetterTrace.js";
import { sendEmail } from "./email.js";
import { createNotifications } from "./notifications.js";
import { getPublicUrl } from "./publicUrl.js";

/**
 * Putting a finished letter in front of the board.
 *
 * The board in Genosyn today is a company's owners and admins: they write
 * its Goals, place its Standdowns and choose its writer and auditor, so the
 * letter is addressed to them and to nobody else. Each gets one bell
 * notification and one email carrying the whole letter — the figures, the
 * prose, the trace and the audit — so it can be read without opening the
 * app. `deliveredAt` is claimed with a conditional update first, so however
 * many processes reach a finished letter, the board hears about it once.
 */

export type BoardLetterEmailInput = {
  companyName: string;
  companySlug: string;
  publicUrl: string;
  letter: Pick<
    BoardLetter,
    | "number"
    | "month"
    | "summary"
    | "body"
    | "writerName"
    | "writerRole"
    | "auditStatus"
    | "auditorName"
    | "auditNote"
  >;
  figures: LetterFigures | null;
  findings: readonly AuditFinding[];
  untraced: readonly TraceToken[];
};

/** What the audit concluded, in the words the letter page uses. */
export function auditLine(letter: Pick<BoardLetter, "auditStatus" | "auditorName">): string {
  const auditor = letter.auditorName || "the board's auditor";
  switch (letter.auditStatus) {
    case "clean":
      return `Audited by ${auditor}: no exceptions.`;
    case "exceptions":
      return `Audited by ${auditor}: exceptions reported.`;
    case "unverified":
      return `Not audited: ${auditor} could not give an opinion.`;
    case "not_appointed":
      return "Not audited: the board has not appointed an auditor.";
    default:
      return "The audit has not finished yet.";
  }
}

function goalLines(figures: LetterFigures): string[] {
  return figures.goals.map((goal) => {
    const current = figures.figures.find((figure) => figure.key === `goal.${goal.id}.current`);
    const target = figures.figures.find((figure) => figure.key === `goal.${goal.id}.target`);
    const state =
      goal.status === "achieved"
        ? "achieved"
        : goal.status === "missed"
          ? "missed"
          : current
            ? `${current.display} of ${target?.display ?? goal.target}`
            : "no value reported yet";
    const note = current?.note ? ` (${current.note})` : "";
    return `- ${goal.title}: ${state}${note}`;
  });
}

/** The subject and plain-text body of the email that carries a letter. */
export function boardLetterEmail(input: BoardLetterEmailInput): { subject: string; text: string } {
  const { letter, figures } = input;
  const label = monthLabel(letter.month);
  const link = `${input.publicUrl}/c/${input.companySlug}/tldrs/letters/${letter.number}`;
  const otherFigures = (figures?.figures ?? []).filter((figure) => figure.group !== "goals");
  const sections = [
    `Letter No. ${letter.number} to the board of ${input.companyName} · ${label}`,
    letter.summary,
    ...(figures && figures.goals.length > 0
      ? [`Toward the Goal\n${goalLines(figures).join("\n")}`]
      : []),
    ...(otherFigures.length > 0
      ? [
          `Figures\n${otherFigures.map((figure) => `- ${figure.label}: ${figure.display}`).join("\n")}`,
        ]
      : []),
    `To the board of ${input.companyName},`,
    letter.body,
    [
      letter.writerName || "The writer",
      letter.writerRole ? `${letter.writerRole}, ${input.companyName}` : input.companyName,
    ].join("\n"),
    [
      auditLine(letter),
      ...(letter.auditNote ? [letter.auditNote] : []),
      ...input.findings.map((finding) => `- "${finding.quote}": ${finding.problem}`),
    ].join("\n"),
    input.untraced.length > 0
      ? `Numbers in this letter that match none of its figures: ${input.untraced.map((token) => `"${token.text}"`).join(", ")}.`
      : "Every number in this letter matches one of its figures.",
    `Read it with the source of every figure: ${link}`,
    `This letter goes to the owners and admins of ${input.companyName}.`,
  ].filter((section) => section.trim().length > 0);
  return {
    subject: `Letter No. ${letter.number} to the board · ${label} — ${input.companyName}`,
    text: sections.join("\n\n"),
  };
}

/** Owners' and admins' user ids, and each distinct address once. */
async function boardMembers(
  companyId: string,
): Promise<{ userIds: string[]; addresses: string[] }> {
  const memberships = await AppDataSource.getRepository(Membership).find({
    where: { companyId, role: In(["owner", "admin"]) },
  });
  const userIds = [...new Set(memberships.map((membership) => membership.userId))];
  if (userIds.length === 0) return { userIds: [], addresses: [] };
  const users = await AppDataSource.getRepository(User).find({
    where: { id: In(userIds) },
    select: { id: true, email: true },
  });
  const seen = new Set<string>();
  const addresses = users.flatMap((user) => {
    const address = user.email?.trim() ?? "";
    const key = address.toLowerCase();
    if (!address || seen.has(key)) return [];
    seen.add(key);
    return [address];
  });
  return { userIds, addresses };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Tell the board a letter is ready, once. Never throws: a notice that could
 * not be sent must not undo the letter that was written.
 */
export async function deliverBoardLetter(
  letterId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const claimed = await AppDataSource.getRepository(BoardLetter).update(
      { id: letterId, status: "ready", deliveredAt: IsNull() },
      { deliveredAt: now },
    );
    if (claimed.affected !== 1) return false;
    const letter = await AppDataSource.getRepository(BoardLetter).findOneBy({ id: letterId });
    if (!letter) return false;
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: letter.companyId });
    if (!company) return false;
    const { userIds, addresses } = await boardMembers(letter.companyId);
    const label = monthLabel(letter.month);
    await createNotifications(
      userIds.map((userId) => ({
        companyId: letter.companyId,
        userId,
        kind: "board_letter_ready" as const,
        title: `Letter No. ${letter.number} to the board · ${label}`,
        body: letter.summary,
        link: `/tldrs/letters/${letter.number}`,
        actorKind: letter.writerEmployeeId ? ("ai" as const) : ("system" as const),
        actorId: letter.writerEmployeeId,
        entityKind: "board_letter" as const,
        entityId: letter.id,
      })),
    );
    const trace = parseJson<{
      summary?: { untraced?: TraceToken[] };
      body?: { untraced?: TraceToken[] };
    }>(letter.traceJson, {});
    const { subject, text } = boardLetterEmail({
      companyName: company.name,
      companySlug: company.slug,
      publicUrl: getPublicUrl(),
      letter,
      figures: parseJson<LetterFigures | null>(letter.figuresJson, null),
      findings: parseJson<AuditFinding[]>(letter.auditFindingsJson, []),
      untraced: [...(trace.summary?.untraced ?? []), ...(trace.body?.untraced ?? [])],
    });
    await Promise.all(
      addresses.map((to) =>
        sendEmail({ to, subject, text, companyId: letter.companyId, purpose: "other" }),
      ),
    );
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[board-letters] could not deliver letter ${letterId}:`, error);
    return false;
  }
}
