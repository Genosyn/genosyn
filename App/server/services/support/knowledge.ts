import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { SupportArticle } from "../../db/entities/SupportArticle.js";
import { SupportDraft } from "../../db/entities/SupportDraft.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { SUPPORT_LIMITS, type SupportArticleStatus } from "../../../shared/support.js";
import { tokenize } from "../dataRooms/retrieval.js";
import { type Page, type PageRequest, filterFingerprint, keysetPage } from "../listPaging.js";
import { andWhereTokens, tokenizeQuery } from "../likeSearch.js";
import { recordAudit } from "../audit.js";
import { emitResourceChange } from "../resourceEvents.js";
import type { SupportActor } from "./access.js";
import { SupportNotFoundError, SupportValidationError } from "./errors.js";
import { serializeArticle } from "./serialize.js";

/**
 * The Articles an AI Employee answers from. What it can tell a customer is
 * exactly what a person chose to publish here, and nothing else the company holds.
 */

export const SUPPORT_ARTICLE_PAGE = { defaultLimit: 50, maxLimit: 200 };
/** Published Articles one answer turn chooses passages from. */
const ARTICLES_FOR_ANSWER = 400;

function auditArticle(
  actor: SupportActor,
  article: Pick<SupportArticle, "id" | "companyId" | "title">,
  action: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  return recordAudit({
    companyId: article.companyId,
    actorKind: actor.kind === "user" ? "user" : actor.kind === "ai" ? "ai" : "system",
    actorUserId: actor.kind === "user" ? actor.userId : null,
    actorEmployeeId: actor.kind === "ai" ? actor.employeeId : null,
    action: `support_article.${action}`,
    targetType: "support_article",
    targetId: article.id,
    targetLabel: article.title.slice(0, 200),
    metadata,
  });
}

function announce(companyId: string, articleId?: string): void {
  emitResourceChange(companyId, "support_article", articleId, { trigger: false });
}

export async function listArticles(args: {
  companyId: string;
  status?: SupportArticleStatus;
  topicKey?: string;
  q?: string;
  page: PageRequest & { budgetChars?: number };
}): Promise<Page<ReturnType<typeof serializeArticle>>> {
  const { companyId, status, topicKey, q } = args;
  return keysetPage({
    query: () => {
      const qb = AppDataSource.getRepository(SupportArticle)
        .createQueryBuilder("a")
        .where("a.companyId = :companyId", { companyId });
      if (status) qb.andWhere("a.status = :status", { status });
      if (topicKey) qb.andWhere("a.topicKey = :topicKey", { topicKey });
      if (q?.trim()) andWhereTokens(qb, ["a.title", "a.body"], tokenizeQuery(q));
      return qb;
    },
    keys: [
      { column: "a.updatedAt", direction: "DESC", type: "timestamp" },
      { column: "a.id", direction: "DESC", type: "string" },
    ],
    scope: "support.articles",
    fingerprint: filterFingerprint(companyId, { status, topicKey, q }),
    noun: "articles",
    limits: SUPPORT_ARTICLE_PAGE,
    page: args.page,
    present: (articles) => articles.map((article) => serializeArticle(article, { body: false })),
  });
}

export async function requireArticle(
  companyId: string,
  articleId: string,
): Promise<SupportArticle> {
  const article = await AppDataSource.getRepository(SupportArticle).findOneBy({
    id: articleId,
    companyId,
  });
  if (!article) throw new SupportNotFoundError("Article not found");
  return article;
}

export async function createArticle(args: {
  companyId: string;
  title: string;
  body: string;
  topicKey?: string | null;
  status?: SupportArticleStatus;
  sourceTicketId?: string | null;
  actor: SupportActor;
}): Promise<SupportArticle> {
  const title = args.title.trim();
  if (!title) throw new SupportValidationError("An Article needs a title.");
  if (title.length > SUPPORT_LIMITS.articleTitleChars) {
    throw new SupportValidationError("That title is too long.");
  }
  const status = args.status ?? "draft";
  if (status === "published" && !args.body.trim()) {
    throw new SupportValidationError("Write the Article before publishing it.");
  }
  const repo = AppDataSource.getRepository(SupportArticle);
  const article = await repo.save(
    repo.create({
      companyId: args.companyId,
      title,
      body: args.body,
      topicKey: args.topicKey ?? null,
      status,
      sourceTicketId: args.sourceTicketId ?? null,
      createdByUserId: args.actor.kind === "user" ? args.actor.userId : null,
      createdByEmployeeId: args.actor.kind === "ai" ? args.actor.employeeId : null,
      publishedAt: status === "published" ? new Date() : null,
    }),
  );
  await auditArticle(args.actor, article, "create", { status });
  announce(args.companyId, article.id);
  return article;
}

export async function updateArticle(args: {
  companyId: string;
  articleId: string;
  patch: {
    title?: string;
    body?: string;
    topicKey?: string | null;
    status?: SupportArticleStatus;
  };
  actor: SupportActor;
}): Promise<SupportArticle> {
  const article = await requireArticle(args.companyId, args.articleId);
  const fields: Partial<SupportArticle> = {};
  if (args.patch.title !== undefined) {
    const title = args.patch.title.trim();
    if (!title) throw new SupportValidationError("An Article needs a title.");
    fields.title = title;
  }
  if (args.patch.body !== undefined) fields.body = args.patch.body;
  if (args.patch.topicKey !== undefined) fields.topicKey = args.patch.topicKey;
  if (args.patch.status !== undefined && args.patch.status !== article.status) {
    fields.status = args.patch.status;
    if (args.patch.status === "published") {
      if (!(args.patch.body ?? article.body).trim()) {
        throw new SupportValidationError("Write the Article before publishing it.");
      }
      fields.publishedAt = new Date();
    }
  }
  if (Object.keys(fields).length === 0) return article;
  await AppDataSource.getRepository(SupportArticle).update({ id: article.id }, fields);
  await auditArticle(args.actor, article, fields.status ? `status_${fields.status}` : "update", {
    fields: Object.keys(fields),
  });
  announce(args.companyId, article.id);
  return requireArticle(args.companyId, article.id);
}

export async function deleteArticle(args: {
  companyId: string;
  articleId: string;
  actor: SupportActor;
}): Promise<void> {
  const article = await requireArticle(args.companyId, args.articleId);
  await AppDataSource.getRepository(SupportArticle).delete({ id: article.id });
  await auditArticle(args.actor, article, "delete");
  announce(args.companyId, article.id);
}

/** Published Articles with their words, for an answer turn. Never a draft. */
export async function publishedArticles(companyId: string): Promise<SupportArticle[]> {
  return AppDataSource.getRepository(SupportArticle).find({
    where: { companyId, status: "published" },
    order: { updatedAt: "DESC" },
    take: ARTICLES_FOR_ANSWER,
  });
}

export type KnowledgeGap = {
  question: string;
  count: number;
  topicKey: string | null;
  lastAskedAt: string;
  tickets: Array<{ id: string; number: number; subject: string }>;
};

/**
 * What customers asked that the Articles could not answer, most-asked first: the
 * shortest list of what to write next. Questions are grouped by the words they
 * share, so "How do I export my data?" and "Can I export data to CSV?" count
 * together. Counted here; only the wording of each question came from a model.
 */
export async function knowledgeGaps(companyId: string, days = 30): Promise<KnowledgeGap[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const drafts = await AppDataSource.getRepository(SupportDraft)
    .createQueryBuilder("d")
    .select(["d.id", "d.ticketId", "d.gapQuestion", "d.topicKey", "d.createdAt"])
    .where("d.companyId = :companyId", { companyId })
    .andWhere("d.createdAt >= :since", { since })
    .andWhere("d.answerable = :no", { no: false })
    .andWhere("d.gapQuestion > ''")
    .orderBy("d.createdAt", "DESC")
    .limit(2_000)
    .getMany();
  const groups: Array<{
    tokens: Set<string>;
    question: string;
    topicKey: string | null;
    last: Date;
    ticketIds: Set<string>;
  }> = [];
  for (const draft of drafts) {
    const tokens = new Set(tokenize(draft.gapQuestion));
    if (tokens.size === 0) continue;
    const group = groups.find((candidate) => {
      let shared = 0;
      for (const token of tokens) if (candidate.tokens.has(token)) shared += 1;
      return shared / Math.max(tokens.size, candidate.tokens.size) >= 0.5;
    });
    if (group) {
      group.ticketIds.add(draft.ticketId);
      if (draft.createdAt > group.last) group.last = draft.createdAt;
    } else {
      groups.push({
        tokens,
        question: draft.gapQuestion,
        topicKey: draft.topicKey,
        last: draft.createdAt,
        ticketIds: new Set([draft.ticketId]),
      });
    }
  }
  groups.sort((a, b) => b.ticketIds.size - a.ticketIds.size || b.last.getTime() - a.last.getTime());
  const top = groups.slice(0, 25);
  const ticketIds = [...new Set(top.flatMap((group) => [...group.ticketIds].slice(0, 5)))];
  const tickets = ticketIds.length
    ? await AppDataSource.getRepository(SupportTicket).find({
        where: { id: In(ticketIds), companyId },
        select: { id: true, number: true, subject: true },
      })
    : [];
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return top.map((group) => ({
    question: group.question,
    count: group.ticketIds.size,
    topicKey: group.topicKey,
    lastAskedAt: group.last.toISOString(),
    tickets: [...group.ticketIds]
      .slice(0, 5)
      .map((id) => byId.get(id))
      .filter((ticket): ticket is SupportTicket => Boolean(ticket))
      .map((ticket) => ({ id: ticket.id, number: ticket.number, subject: ticket.subject })),
  }));
}
