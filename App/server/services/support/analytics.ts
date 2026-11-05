import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { SupportDraft } from "../../db/entities/SupportDraft.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { getSupportSettings, topicsOf } from "./settings.js";

/**
 * Support's figures, counted from the rows and never estimated by a model. Medians
 * rather than averages, because one ticket left open over a holiday should not move
 * the number a team judges itself by.
 */

const MAX_TICKETS = 20_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function supportAnalytics(companyId: string, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const rows = await AppDataSource.getRepository(SupportTicket)
    .createQueryBuilder("t")
    .select([
      "t.id",
      "t.status",
      "t.topicKey",
      "t.priority",
      "t.createdAt",
      "t.firstRespondedAt",
      "t.firstResponseDueAt",
      "t.solvedAt",
      "t.resolutionDueAt",
      "t.slaBreachedAt",
      "t.aiHandled",
      "t.aiReplyCount",
      "t.ratingScore",
      "t.sentiment",
      "t.source",
      "t.mergedIntoId",
    ])
    .where("t.companyId = :companyId", { companyId })
    .andWhere("t.createdAt >= :since", { since })
    .orderBy("t.createdAt", "DESC")
    .limit(MAX_TICKETS)
    .getMany();
  const tickets = rows.filter((ticket) => ticket.status !== "spam" && !ticket.mergedIntoId);
  const live = tickets.filter((ticket) => ticket.source !== "import");

  const [drafts, backlog, spam] = await Promise.all([
    AppDataSource.getRepository(SupportDraft)
      .createQueryBuilder("d")
      .select(["d.id", "d.status", "d.editedBeforeSend", "d.topicKey", "d.answerable"])
      .where("d.companyId = :companyId", { companyId })
      .andWhere("d.createdAt >= :since", { since })
      .andWhere("d.status IN (:...statuses)", { statuses: ["sent", "discarded"] })
      .limit(MAX_TICKETS)
      .getMany(),
    AppDataSource.getRepository(SupportTicket).count({
      where: { companyId, status: In(["new", "open"]) },
    }),
    rows.filter((ticket) => ticket.status === "spam").length,
  ]);

  const firstResponseMinutes = live
    .filter((ticket) => ticket.firstRespondedAt)
    .map((ticket) => (ticket.firstRespondedAt!.getTime() - ticket.createdAt.getTime()) / 60_000)
    .filter((minutes) => minutes >= 0);
  const resolutionMinutes = live
    .filter((ticket) => ticket.solvedAt)
    .map((ticket) => (ticket.solvedAt!.getTime() - ticket.createdAt.getTime()) / 60_000)
    .filter((minutes) => minutes >= 0);
  const withTarget = live.filter((ticket) => ticket.firstResponseDueAt);
  const metTarget = withTarget.filter(
    (ticket) =>
      !ticket.slaBreachedAt ||
      (ticket.firstRespondedAt && ticket.firstRespondedAt <= ticket.firstResponseDueAt!),
  );
  const rated = tickets.filter((ticket) => ticket.ratingScore !== null);
  const solved = tickets.filter(
    (ticket) => ticket.status === "solved" || ticket.status === "closed",
  );
  const solvedByAi = solved.filter((ticket) => ticket.aiHandled);

  const sentDrafts = drafts.filter((draft) => draft.status === "sent");
  const untouched = sentDrafts.filter((draft) => !draft.editedBeforeSend);
  const discarded = drafts.filter((draft) => draft.status === "discarded");

  const settings = await getSupportSettings(companyId);
  const topicNames = new Map(topicsOf(settings).map((topic) => [topic.key, topic.name]));
  const byTopic = new Map<
    string,
    {
      tickets: number;
      solvedByAi: number;
      draftsSent: number;
      draftsUntouched: number;
      draftsDiscarded: number;
    }
  >();
  const topicRow = (key: string) => {
    const row = byTopic.get(key) ?? {
      tickets: 0,
      solvedByAi: 0,
      draftsSent: 0,
      draftsUntouched: 0,
      draftsDiscarded: 0,
    };
    byTopic.set(key, row);
    return row;
  };
  for (const ticket of tickets) {
    const row = topicRow(ticket.topicKey ?? "");
    row.tickets += 1;
    if ((ticket.status === "solved" || ticket.status === "closed") && ticket.aiHandled) {
      row.solvedByAi += 1;
    }
  }
  for (const draft of drafts) {
    const row = topicRow(draft.topicKey ?? "");
    if (draft.status === "sent") {
      row.draftsSent += 1;
      if (!draft.editedBeforeSend) row.draftsUntouched += 1;
    } else {
      row.draftsDiscarded += 1;
    }
  }

  const volume = new Map<string, { created: number; solved: number }>();
  for (let offset = days - 1; offset >= 0; offset--) {
    volume.set(dayKey(new Date(Date.now() - offset * 24 * 60 * 60_000)), { created: 0, solved: 0 });
  }
  for (const ticket of tickets) {
    const created = volume.get(dayKey(ticket.createdAt));
    if (created) created.created += 1;
    if (ticket.solvedAt) {
      const solvedDay = volume.get(dayKey(ticket.solvedAt));
      if (solvedDay) solvedDay.solved += 1;
    }
  }

  const sentiment = { positive: 0, neutral: 0, frustrated: 0, angry: 0 };
  for (const ticket of tickets) {
    if (ticket.sentiment) sentiment[ticket.sentiment] += 1;
  }

  return {
    windowDays: days,
    truncated: rows.length >= MAX_TICKETS,
    tickets: tickets.length,
    backlog,
    spam,
    solved: solved.length,
    medianFirstResponseMinutes: median(firstResponseMinutes),
    medianResolutionMinutes: median(resolutionMinutes),
    slaAttainment: ratio(metTarget.length, withTarget.length),
    ratingCount: rated.length,
    ratingAverage: rated.length
      ? rated.reduce((sum, ticket) => sum + (ticket.ratingScore ?? 0), 0) / rated.length
      : null,
    ai: {
      solved: solvedByAi.length,
      resolutionRate: ratio(solvedByAi.length, solved.length),
      draftsSent: sentDrafts.length,
      draftsUntouched: untouched.length,
      draftsDiscarded: discarded.length,
      draftAcceptance: ratio(untouched.length, drafts.length),
    },
    sentiment,
    topics: [...byTopic.entries()]
      .map(([key, row]) => ({
        key: key || null,
        name: topicNames.get(key) ?? (key ? key : "Not yet read"),
        ...row,
        draftAcceptance: ratio(row.draftsUntouched, row.draftsSent + row.draftsDiscarded),
      }))
      .sort((a, b) => b.tickets - a.tickets),
    volume: [...volume.entries()].map(([date, counts]) => ({ date, ...counts })),
  };
}
