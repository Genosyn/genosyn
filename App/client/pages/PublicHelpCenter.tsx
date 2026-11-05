import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ArrowLeft, BookOpen, ChevronRight, Search, SearchX } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { SkeletonList } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  helpCenterApi,
  type HelpCenterArticle,
  type HelpCenterCard,
  type HelpCenterHome,
  type HelpCenterMatch,
} from "@/lib/support";
import { SUPPORT_LIMITS } from "../../shared/support";

/**
 * A company's help center: its published Articles for anyone to read, with no
 * sign-in, once its owners have turned it on. The address is all there is to go
 * on, so a help center that is off, a company that never existed and an Article
 * nobody may read all show the same page.
 */

const NOT_AVAILABLE = "This page is not available.";

function helpCenterPath(slug: string): string {
  return `/help/${encodeURIComponent(slug)}`;
}

/**
 * Markdown on a public page that shares the App's origin. An Article can carry a
 * stranger's words, when an AI Employee drafted it from a Ticket and the person
 * publishing it missed them. So beyond scripts, it keeps to text: no forms to
 * collect anything, and no classes or styles to draw over the page with.
 */
function articleHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "option", "label"],
    FORBID_ATTR: ["style", "class", "id"],
  });
}

type Failure = { kind: "missing" } | { kind: "error"; message: string };

function failureFrom(error: unknown): Failure {
  if (error instanceof ApiError && error.status === 404) return { kind: "missing" };
  return { kind: "error", message: errorMessage(error, "This page could not be loaded.") };
}

/** A page's first answer, read again when its address changes or someone tries again. */
function useFirstAnswer<T>(load: () => Promise<T>) {
  const [answer, setAnswer] = React.useState<T | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => {
    let live = true;
    setFailure(null);
    loadRef
      .current()
      .then((loaded) => {
        if (live) setAnswer(loaded);
      })
      .catch((error: unknown) => {
        if (live) setFailure(failureFrom(error));
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  return { answer, failure, retry: () => setAttempt((count) => count + 1) };
}

/** Reads on from a page's cursor, keeping what is already on screen if that fails. */
function useMoreRows<T>(read: (cursor: string) => Promise<{ rows: T[]; nextCursor: string | null }>) {
  const [rows, setRows] = React.useState<T[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const start = React.useCallback((page: { rows: T[]; nextCursor: string | null }) => {
    setRows(page.rows);
    setCursor(page.nextCursor);
    setError("");
  }, []);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    setError("");
    try {
      const page = await read(cursor);
      setRows((current) => [...current, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err, "Could not load more."));
    } finally {
      setLoading(false);
    }
  }

  return { rows, cursor, loading, error, start, more };
}

function NotAvailable({ backTo }: { backTo?: string }) {
  React.useEffect(() => {
    document.title = "Page not available";
  }, []);
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <Card className="w-full max-w-md p-6">
        <p className="text-sm text-slate-600 dark:text-slate-300">{NOT_AVAILABLE}</p>
        {backTo && (
          <Link
            to={backTo}
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to the help center
          </Link>
        )}
      </Card>
    </main>
  );
}

function CouldNotLoad({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <Card className="w-full max-w-md p-6">
        <FormError message={message} />
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      </Card>
    </main>
  );
}

/** The header every page shares: whose help center this is, and the search box. */
function Frame({
  slug,
  companyName,
  query = "",
  children,
}: {
  slug: string;
  /** Null until the first answer says whose this is; "" when none will. */
  companyName: string | null;
  query?: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [text, setText] = React.useState(query);
  React.useEffect(() => setText(query), [query]);
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
          <Link
            to={helpCenterPath(slug)}
            className="block min-h-8 break-words text-xl font-semibold tracking-tight text-slate-900 hover:underline dark:text-slate-100 sm:text-2xl"
          >
            {companyName === null
              ? "\u00a0"
              : companyName
                ? `${companyName} help center`
                : "Help center"}
          </Link>
          <form
            role="search"
            className="mt-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const words = text.trim();
              navigate(
                words
                  ? `${helpCenterPath(slug)}?q=${encodeURIComponent(words)}`
                  : helpCenterPath(slug),
              );
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <Input
                aria-label="Search articles"
                placeholder="Search articles"
                className="pl-8"
                maxLength={SUPPORT_LIMITS.helpCenterQueryChars}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}

function ArticleLink({ slug, article }: { slug: string; article: HelpCenterCard }) {
  return (
    <Link
      to={`${helpCenterPath(slug)}/articles/${article.id}`}
      className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-slate-800 hover:bg-slate-50 focus-visible:-outline-offset-2 dark:text-slate-200 dark:hover:bg-slate-800/60"
    >
      <span className="min-w-0 break-words">{article.title}</span>
      <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-slate-400" />
    </Link>
  );
}

function ShowMore({
  label,
  loading,
  error,
  onClick,
}: {
  label: string;
  loading: boolean;
  error: string;
  onClick: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <FormError message={error} />
      <Button variant="secondary" loading={loading} onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}

/**
 * Sections in the owners' order of Topics, then whatever has no Topic. Rows come
 * by title, so each section is by title too, whichever page a row arrived on.
 */
function sectionsOf(home: HelpCenterHome, rows: HelpCenterCard[]) {
  const sections = home.topics.map((topic) => ({
    key: topic.key as string | null,
    name: topic.name,
    articleCount: topic.articleCount as number | null,
    rows: rows.filter((row) => row.topic?.key === topic.key),
  }));
  sections.push({
    key: null,
    // With no Topics to tell it from, the list needs no heading of its own.
    name: home.topics.length > 0 ? "More articles" : "Articles",
    articleCount: null,
    rows: rows.filter((row) => !row.topic),
  });
  return sections.filter((section) => section.rows.length > 0);
}

function Browse({ slug }: { slug: string }) {
  const list = useMoreRows<HelpCenterCard>((cursor) => helpCenterApi.articles(slug, cursor));
  const { start } = list;
  const { answer, failure, retry } = useFirstAnswer(() =>
    helpCenterApi.home(slug).then((home) => {
      start(home.articles);
      return home;
    }),
  );
  React.useEffect(() => {
    if (answer) document.title = `${answer.companyName} help center`;
  }, [answer]);

  if (failure?.kind === "missing") return <NotAvailable />;
  if (failure) return <CouldNotLoad message={failure.message} onRetry={retry} />;
  return (
    <Frame slug={slug} companyName={answer?.companyName ?? null}>
      {answer && <h1 className="sr-only">{answer.companyName} help center</h1>}
      {!answer ? (
        <SkeletonList rows={5} />
      ) : list.rows.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title="Nothing here yet"
          description={`${answer.companyName} has not published any articles.`}
        />
      ) : (
        <>
          <div className="space-y-6">
            {sectionsOf(answer, list.rows).map((section) => (
              <section key={section.key ?? "none"} aria-label={section.name}>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h2 className="min-w-0 break-words text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {section.name}
                  </h2>
                  {section.articleCount !== null && (
                    <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {section.articleCount} {section.articleCount === 1 ? "article" : "articles"}
                    </span>
                  )}
                </div>
                <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
                  {section.rows.map((row) => (
                    <ArticleLink key={row.id} slug={slug} article={row} />
                  ))}
                </Card>
              </section>
            ))}
          </div>
          {list.cursor && (
            <ShowMore
              label="Show more articles"
              loading={list.loading}
              error={list.error}
              onClick={() => void list.more()}
            />
          )}
        </>
      )}
    </Frame>
  );
}

function Results({ slug, q }: { slug: string; q: string }) {
  const list = useMoreRows<HelpCenterMatch>((cursor) => helpCenterApi.search(slug, q, cursor));
  const { start } = list;
  const { answer, failure, retry } = useFirstAnswer(() =>
    helpCenterApi.search(slug, q).then((page) => {
      start(page);
      return page;
    }),
  );
  React.useEffect(() => {
    if (answer) document.title = `Search · ${answer.companyName} help center`;
  }, [answer]);

  if (failure?.kind === "missing") return <NotAvailable />;
  // A refused search never learns the company's name, and its frame does without.
  return (
    <Frame slug={slug} companyName={answer?.companyName ?? (failure ? "" : null)} query={q}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="min-w-0 break-words text-sm font-semibold text-slate-900 dark:text-slate-100">
          Results for &ldquo;{q}&rdquo;
        </h1>
        <Link
          to={helpCenterPath(slug)}
          className="touch-target relative text-xs text-slate-500 hover:underline dark:text-slate-400"
        >
          Clear search
        </Link>
      </div>
      {failure ? (
        <CouldNotSearch message={failure.message} onRetry={retry} />
      ) : !answer ? (
        <SkeletonList rows={4} />
      ) : list.rows.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title="No articles match"
          description="Try fewer words, or different ones."
        />
      ) : (
        <>
          <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
            {list.rows.map((row) => (
              <Link
                key={row.id}
                to={`${helpCenterPath(slug)}/articles/${row.id}`}
                className="block px-4 py-3 hover:bg-slate-50 focus-visible:-outline-offset-2 dark:hover:bg-slate-800/60"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-words text-sm font-medium text-slate-900 dark:text-slate-100">
                    {row.title}
                  </span>
                  {row.topic && <Badge tone="neutral">{row.topic.name}</Badge>}
                </div>
                {row.excerpt && (
                  <p className="mt-1 break-words text-sm text-slate-500 dark:text-slate-400">
                    {row.excerpt}
                  </p>
                )}
              </Link>
            ))}
          </Card>
          {list.cursor && (
            <ShowMore
              label="Show more results"
              loading={list.loading}
              error={list.error}
              onClick={() => void list.more()}
            />
          )}
        </>
      )}
    </Frame>
  );
}

function CouldNotSearch({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div>
      <FormError message={message} />
      <Button variant="secondary" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** `/help/<company slug>`: every Article by Topic, or what a search found. */
export function PublicHelpCenter() {
  const { companySlug = "" } = useParams<{ companySlug: string }>();
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim().slice(0, SUPPORT_LIMITS.helpCenterQueryChars).trim();
  return q ? (
    <Results key={`${companySlug}:${q}`} slug={companySlug} q={q} />
  ) : (
    <Browse key={companySlug} slug={companySlug} />
  );
}

function ArticleBody({ article }: { article: HelpCenterArticle }) {
  const html = React.useMemo(() => articleHtml(article.body), [article.body]);
  return (
    <article>
      <h1 className="break-words text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-2xl">
        {article.title}
      </h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {article.topic && <Badge tone="neutral">{article.topic.name}</Badge>}
        <span>
          Updated{" "}
          {new Date(article.updatedAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </span>
      </div>
      <Card className="mt-4 p-4 sm:p-6">
        <div
          className="chat-md break-words text-sm [&_img]:h-auto [&_img]:max-w-full [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </Card>
    </article>
  );
}

/** `/help/<company slug>/articles/<id>`: one published Article. */
export function PublicHelpCenterArticle() {
  const { companySlug = "", articleId = "" } = useParams<{
    companySlug: string;
    articleId: string;
  }>();
  const { answer, failure, retry } = useFirstAnswer(() =>
    helpCenterApi.article(companySlug, articleId),
  );
  React.useEffect(() => {
    if (answer) {
      document.title = `${answer.article.title} · ${answer.companyName} help center`;
      window.scrollTo(0, 0);
    }
  }, [answer]);

  if (failure?.kind === "missing") return <NotAvailable backTo={helpCenterPath(companySlug)} />;
  if (failure) return <CouldNotLoad message={failure.message} onRetry={retry} />;
  return (
    <Frame slug={companySlug} companyName={answer?.companyName ?? null}>
      {!answer ? (
        <SkeletonList rows={6} />
      ) : (
        <>
          <Link
            to={helpCenterPath(companySlug)}
            className="touch-target relative mb-4 inline-flex items-center gap-1 text-xs text-slate-500 hover:underline dark:text-slate-400"
          >
            <ArrowLeft size={12} aria-hidden="true" /> All articles
          </Link>
          <ArticleBody article={answer.article} />
        </>
      )}
    </Frame>
  );
}

/** Any other address under `/help`. */
export function PublicHelpCenterMissing() {
  return <NotAvailable />;
}
