import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { SupportArticle } from "../../db/entities/SupportArticle.js";
import { SupportSettings } from "../../db/entities/SupportSettings.js";
import { andWhereTokens, tokenizeQuery, type Token } from "../likeSearch.js";
import {
  CURSOR_INVALID,
  ListCursorError,
  decodeCursor,
  filterFingerprint,
  finishPage,
  keysetPage,
  keysetRows,
  pageLimit,
  type CursorValue,
  type KeysetColumn,
  type PageLimits,
  type PageRequest,
} from "../listPaging.js";
import { getPublicUrl } from "../publicUrl.js";
import { escapeHtml, plainSnippet } from "../recruiting/pages.js";
import { topicsOf } from "./settings.js";

/**
 * The help center: a company's published Articles as a stranger reads them, once
 * an owner or admin has turned it on.
 *
 * Everything here reads through {@link published}, so a draft or an archived
 * Article cannot be listed, searched or opened, and every answer is built field
 * by field, so nothing an Article's row also holds (the Ticket it was written
 * from, who wrote it, how often replies quote it) can reach one by accident. A
 * Topic's name is all a stranger learns of it, and only once it has a published
 * Article: when it fits and who it goes to are the company's own.
 */

export const HELP_CENTER_ARTICLE_PAGE: PageLimits = { defaultLimit: 100, maxLimit: 200 };
export const HELP_CENTER_SEARCH_PAGE: PageLimits = { defaultLimit: 20, maxLimit: 50 };

/** How much of an Article a search result shows. */
const EXCERPT_CHARS = 200;
/** How much of an Article is read to write one, which keeps stripping its markup cheap. */
const EXCERPT_WINDOW_CHARS = 600;

/**
 * Title first, so a list reads like a table of contents, and because a title
 * changes only when someone rewrites it, so reading on never skips a row.
 */
const ARTICLE_ORDER: KeysetColumn[] = [
  { column: "a.title", direction: "ASC", type: "string" },
  { column: "a.id", direction: "ASC", type: "string" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A company whose help center is on, and the names of its Topics, in the owners' order. */
export type HelpCenter = {
  companyId: string;
  companyName: string;
  topics: Array<{ key: string; name: string }>;
};

/** The help center for a company slug, or null when it is off or there is no such company. */
export async function findHelpCenter(companySlug: string): Promise<HelpCenter | null> {
  const company = await AppDataSource.getRepository(Company).findOne({
    where: { slug: companySlug },
    select: { id: true, name: true },
  });
  if (!company) return null;
  // Not `getSupportSettings`, which makes the row: a stranger's request writes
  // nothing to a company, and a company with no row has not opted in.
  const settings = await AppDataSource.getRepository(SupportSettings).findOne({
    where: { companyId: company.id, helpCenterEnabled: true },
    select: { id: true, topicsJson: true },
  });
  if (!settings) return null;
  return {
    companyId: company.id,
    companyName: company.name,
    topics: topicsOf(settings).map(({ key, name }) => ({ key, name })),
  };
}

/** Where a company's help center lives, whether or not it is on yet. */
export async function helpCenterUrl(companyId: string): Promise<string> {
  const company = await AppDataSource.getRepository(Company).findOneOrFail({
    where: { id: companyId },
    select: { id: true, slug: true },
  });
  return `${getPublicUrl()}/help/${encodeURIComponent(company.slug)}`;
}

/** The one door to Articles here: this company's, and only the published ones. */
function published(companyId: string) {
  return AppDataSource.getRepository(SupportArticle)
    .createQueryBuilder("a")
    .where("a.companyId = :companyId", { companyId })
    .andWhere("a.status = :status", { status: "published" });
}

/** A Topic that no longer exists is no Topic: its old key is not the public's to read. */
function publicTopic(center: HelpCenter, key: string | null): { key: string; name: string } | null {
  return center.topics.find((topic) => topic.key === key) ?? null;
}

/**
 * The sort key a cursor continues after. A cursor is not signed, so whoever holds
 * one can rewrite it, and its values go into the query as a title and a uuid. On
 * Postgres anything else in `a.id` raises 22P02, and a NUL in `a.title` raises
 * 22021, each a 500 anyone could ask for. Tests on SQLite see neither.
 */
function cursorAfter(
  scope: string,
  fingerprint: string,
  cursor: string | undefined,
): CursorValue[] | null {
  if (!cursor) return null;
  const after = decodeCursor(scope, fingerprint, cursor);
  const [title, id] = after;
  const readable =
    after.length === ARTICLE_ORDER.length &&
    typeof title === "string" &&
    !title.includes("\u0000") &&
    typeof id === "string" &&
    UUID.test(id);
  if (!readable) throw new ListCursorError(CURSOR_INVALID);
  return after;
}

/** One line per Topic with a published Article, in the owners' order. */
async function topicsWithArticles(center: HelpCenter) {
  const rows = await published(center.companyId)
    .select("a.topicKey", "topicKey")
    .addSelect("COUNT(*)", "articleCount")
    .groupBy("a.topicKey")
    .getRawMany<{ topicKey: string | null; articleCount: string | number }>();
  const counts = new Map(rows.map((row) => [row.topicKey, Number(row.articleCount)]));
  return center.topics.flatMap((topic) => {
    const articleCount = counts.get(topic.key);
    return articleCount ? [{ ...topic, articleCount }] : [];
  });
}

/** A page of published Articles, by title. The titles a visitor browses. */
export async function listHelpCenterArticles(center: HelpCenter, page: PageRequest) {
  const scope = "help_center.articles";
  const fingerprint = filterFingerprint(center.companyId, {});
  cursorAfter(scope, fingerprint, page.cursor);
  return keysetPage({
    query: () => published(center.companyId).select(["a.id", "a.title", "a.topicKey"]),
    keys: ARTICLE_ORDER,
    scope,
    fingerprint,
    noun: "articles",
    limits: HELP_CENTER_ARTICLE_PAGE,
    page,
    present: (articles) =>
      articles.map((article) => ({
        id: article.id,
        title: article.title,
        topic: publicTopic(center, article.topicKey),
      })),
  });
}

/** The front page: who this is, the Topics to file Articles under, and the first Articles. */
export async function helpCenterHome(center: HelpCenter) {
  return {
    companyName: center.companyName,
    topics: await topicsWithArticles(center),
    articles: await listHelpCenterArticles(center, {}),
  };
}

/**
 * The passage a search result shows: around the first word it matched, or the
 * start when only the title did. Found in the raw text and stripped afterwards,
 * so an Article's length never multiplies the cost of cleaning up its markup.
 */
function excerptOf(body: string, tokens: Token[]): string {
  const lower = body.toLowerCase();
  const hits = tokens.map((token) => lower.indexOf(token.lo)).filter((at) => at >= 0);
  const at = hits.length > 0 ? Math.min(...hits) : 0;
  const start = at < EXCERPT_CHARS / 2 ? 0 : body.indexOf(" ", at - EXCERPT_CHARS / 4) + 1;
  const passage = body.slice(start, start + EXCERPT_WINDOW_CHARS).replace(/<[^>]*>/g, " ");
  const excerpt = plainSnippet(passage, EXCERPT_CHARS);
  return start > 0 ? `…${excerpt}` : excerpt;
}

/**
 * Search anyone may call, so it costs what one read of the rows costs and no more:
 * words must all appear in a title or body, tokens are capped, and it answers no
 * `total`, which would read every published Article's words again on every page.
 * The caller throttles it.
 */
export async function searchHelpCenter(center: HelpCenter, q: string, page: PageRequest) {
  // Postgres cannot hold a NUL in text at all, so one in a query can match nothing.
  const tokens = tokenizeQuery(q.replaceAll("\u0000", ""));
  const scope = "help_center.search";
  const fingerprint = filterFingerprint(center.companyId, {
    q: tokens.map((token) => token.raw).join(" "),
  });
  const after = cursorAfter(scope, fingerprint, page.cursor);
  const limit = pageLimit(page.limit, HELP_CENTER_SEARCH_PAGE);
  const fetched =
    tokens.length === 0
      ? []
      : await keysetRows(
          andWhereTokens(
            published(center.companyId).select(["a.id", "a.title", "a.topicKey", "a.body"]),
            ["a.title", "a.body"],
            tokens,
          ),
          { keys: ARTICLE_ORDER, after, limit, prefix: "page" },
        );
  return {
    companyName: center.companyName,
    ...finishPage({
      fetched,
      limit,
      noun: "articles",
      scope,
      fingerprint,
      present: (article) => ({
        id: article.id,
        title: article.title,
        topic: publicTopic(center, article.topicKey),
        excerpt: excerptOf(article.body, tokens),
      }),
    }),
  };
}

/** One published Article in full, or null when a stranger may not read it. */
export async function readHelpCenterArticle(center: HelpCenter, articleId: string) {
  const article = await AppDataSource.getRepository(SupportArticle).findOne({
    where: { id: articleId, companyId: center.companyId, status: "published" },
    select: { id: true, title: true, topicKey: true, body: true, updatedAt: true },
  });
  if (!article) return null;
  return {
    id: article.id,
    title: article.title,
    topic: publicTopic(center, article.topicKey),
    body: article.body,
    updatedAt: article.updatedAt.toISOString(),
  };
}

export type HelpCenterHead = { title: string; description: string };

/** What a page's address shows wherever it is pasted, since link previews run no JavaScript. */
export function helpCenterHomeHead(center: HelpCenter): HelpCenterHead {
  return {
    title: `${center.companyName} help center`,
    description: `Answers from ${center.companyName}.`,
  };
}

export function helpCenterArticleHead(
  center: HelpCenter,
  article: { title: string; body: string },
): HelpCenterHead {
  return {
    title: `${article.title} · ${center.companyName} help center`,
    description: plainSnippet(article.body.slice(0, EXCERPT_WINDOW_CHARS)),
  };
}

/** Says nothing about what was asked for, so a page that never existed reads the same. */
export const HELP_CENTER_MISSING_HEAD: HelpCenterHead = {
  title: "Page not available",
  description: "This page is not available.",
};

/**
 * The App's shell with this page's head written in, and search engines asked to
 * stay away. Replacer functions, never strings: in a replacement string `$'` and
 * `` $` `` splice in the rest of the template, and a title may hold them.
 */
export function fillHelpCenterShell(template: string, head: HelpCenterHead): string {
  return template
    .replace(
      /<title>[\s\S]*?<\/title>/,
      () =>
        `<title>${escapeHtml(head.title)}</title>\n    <meta name="robots" content="noindex, nofollow" />`,
    )
    .replace(
      /<meta\s+name="description"[\s\S]*?\/>/,
      () => `<meta name="description" content="${escapeHtml(head.description)}" />`,
    );
}
