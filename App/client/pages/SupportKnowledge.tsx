import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { BookOpen, HelpCircle, Plus, Search, Sparkles, Trash2 } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import { errorMessage } from "@/lib/errors";
import { agoText, supportApi, type SupportArticle, type SupportKnowledgeGap } from "@/lib/support";
import {
  SUPPORT_ARTICLE_STATUSES,
  SUPPORT_ARTICLE_STATUS_LABELS,
  type SupportArticleStatus,
} from "../../shared/support";
import type { SupportOutletContext } from "./SupportLayout";

const STATUS_TONE: Record<SupportArticleStatus, "success" | "neutral" | "warning"> = {
  published: "success",
  draft: "warning",
  archived: "neutral",
};

/**
 * What an AI Employee can tell a customer is exactly what is published here, so
 * this page leads with what customers asked that it could not answer: the shortest
 * list of what to write next.
 */
export function SupportKnowledge() {
  const { company, topics, helpCenterUrl } = useOutletContext<SupportOutletContext>();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);
  const [articles, setArticles] = React.useState<SupportArticle[] | null>(null);
  const [gaps, setGaps] = React.useState<SupportKnowledgeGap[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<SupportArticleStatus | "">("");
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [error, setError] = React.useState("");
  const [loadingMore, setLoadingMore] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [page, gapResult] = await Promise.all([
        api.articles({ status: status || undefined, q: q || undefined }),
        api.knowledgeGaps(),
      ]);
      setArticles(page.rows);
      setCursor(page.nextCursor);
      setGaps(gapResult.gaps);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load Articles"));
      setArticles((current) => current ?? []);
    }
  }, [api, status, q]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch("support_article", () => void load());

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.articles(
        { status: status || undefined, q: q || undefined },
        { cursor },
      );
      setArticles((current) => [...(current ?? []), ...page.rows]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err, "Could not load more Articles"));
    } finally {
      setLoadingMore(false);
    }
  }

  const topicName = (key: string | null) => topics.find((topic) => topic.key === key)?.name ?? null;

  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        title="Knowledge"
        description="The Articles your AI Employee answers from. It quotes them word for word and says nothing else about the company, so what is published here is what customers can be told."
        actions={
          <Link to={`/c/${company.slug}/support/knowledge/new`}>
            <Button>
              <Plus size={14} /> New Article
            </Button>
          </Link>
        }
      />

      {helpCenterUrl && <HelpCenterNote url={helpCenterUrl} className="mb-4" />}

      {gaps.length > 0 && (
        <Card className="mb-6 p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <HelpCircle
              size={15}
              className="text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            Asked, and no Article answers it
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            From the last 30 days, most-asked first. Each one you write is answered from then on.
          </p>
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {gaps.slice(0, 8).map((gap) => (
              <li key={gap.question} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-slate-800 dark:text-slate-200">{gap.question}</div>
                  <div className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {gap.count} {gap.count === 1 ? "ticket" : "tickets"}, last{" "}
                    {agoText(gap.lastAskedAt)}
                    {gap.tickets[0] && (
                      <>
                        {" · "}
                        <Link
                          to={`/c/${company.slug}/support/tickets/${gap.tickets[0].id}`}
                          className="underline"
                        >
                          #{gap.tickets[0].number}
                        </Link>
                      </>
                    )}
                  </div>
                </div>
                <Link
                  to={`/c/${company.slug}/support/knowledge/new?title=${encodeURIComponent(gap.question)}${gap.topicKey ? `&topic=${encodeURIComponent(gap.topicKey)}` : ""}`}
                  className="shrink-0"
                >
                  <Button size="sm" variant="secondary">
                    Write it
                  </Button>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          className="relative min-w-48 flex-1"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(search.trim());
          }}
        >
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <Input
            aria-label="Search Articles"
            placeholder="Search Articles"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </form>
        <div className="w-36">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as SupportArticleStatus | "")}
          >
            <option value="">Any status</option>
            {SUPPORT_ARTICLE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {SUPPORT_ARTICLE_STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <FormError message={error} className="mb-3" />
      {articles === null ? (
        <SkeletonList rows={4} />
      ) : articles.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={q || status ? "No Articles match" : "No Articles yet"}
          description={
            q || status
              ? "Try other words or another status."
              : "Your AI Employee has nothing to answer from until you publish something. Start with the questions you get most."
          }
          action={
            q || status ? undefined : (
              <Link to={`/c/${company.slug}/support/knowledge/new`}>
                <Button>
                  <Plus size={14} /> Write the first Article
                </Button>
              </Link>
            )
          }
        />
      ) : (
        <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
          {articles.map((article) => (
            <Link
              key={article.id}
              to={`/c/${company.slug}/support/knowledge/${article.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {article.title}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {[
                    topicName(article.topicKey),
                    article.citedCount
                      ? `Quoted in ${article.citedCount} ${article.citedCount === 1 ? "reply" : "replies"}`
                      : null,
                    `Edited ${agoText(article.updatedAt)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {article.createdByEmployeeId && article.status === "draft" && (
                  <Badge tone="ai" icon={<Sparkles />}>
                    Written by AI
                  </Badge>
                )}
                <Badge tone={STATUS_TONE[article.status]}>
                  {SUPPORT_ARTICLE_STATUS_LABELS[article.status]}
                </Badge>
              </div>
            </Link>
          ))}
        </Card>
      )}
      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={loadingMore} onClick={() => void more()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

/** With the help center on, publishing is publishing to anyone. Say so where it happens. */
function HelpCenterNote({ url, className }: { url: string; className?: string }) {
  return (
    <p className={clsx("text-xs text-slate-500 dark:text-slate-400", className)}>
      Your help center is on, so anyone can read a published Article at{" "}
      <a href={url} target="_blank" rel="noreferrer" className="break-all underline">
        {url}
      </a>
      .
    </p>
  );
}

/** Write or change one Article. Publishing is what lets replies quote it. */
export function SupportArticleEditor() {
  const { company, topics, helpCenterUrl } = useOutletContext<SupportOutletContext>();
  const { articleId } = useParams<{ articleId: string }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);
  const isNew = !articleId;
  const [article, setArticle] = React.useState<SupportArticle | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [topicKey, setTopicKey] = React.useState("");
  const [busy, setBusy] = React.useState<"save" | "publish" | "unpublish" | "delete" | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(!isNew);

  React.useEffect(() => {
    if (isNew) {
      const params = new URLSearchParams(window.location.search);
      setTitle(params.get("title") ?? "");
      setTopicKey(params.get("topic") ?? "");
      return;
    }
    let live = true;
    api
      .article(articleId)
      .then(({ article: loaded }) => {
        if (!live) return;
        setArticle(loaded);
        setTitle(loaded.title);
        setBody(loaded.body ?? "");
        setTopicKey(loaded.topicKey ?? "");
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err, "This Article could not be loaded"));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, articleId, isNew]);

  const list = `/c/${company.slug}/support/knowledge`;

  async function save(status?: SupportArticleStatus) {
    setBusy(status === "published" ? "publish" : status === "draft" ? "unpublish" : "save");
    setError("");
    try {
      if (isNew) {
        const { article: created } = await api.createArticle({
          title: title.trim(),
          body,
          topicKey: topicKey || null,
          status: status ?? "draft",
        });
        navigate(`${list}/${created.id}`, { replace: true });
      } else if (article) {
        const { article: updated } = await api.updateArticle(article.id, {
          title: title.trim(),
          body,
          topicKey: topicKey || null,
          ...(status ? { status } : {}),
        });
        setArticle(updated);
      }
    } catch (err) {
      setError(errorMessage(err, "Could not save this Article"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!article) return;
    const yes = await dialog.confirm({
      title: "Delete this Article?",
      message:
        "Replies your AI Employee writes will stop quoting it. Replies already sent stay as they are.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!yes) return;
    setBusy("delete");
    try {
      await api.deleteArticle(article.id);
      navigate(list);
    } catch (err) {
      setError(errorMessage(err, "Could not delete this Article"));
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <SkeletonList rows={3} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <PageHeader
        breadcrumbs={[
          { label: "Support", to: `/c/${company.slug}/support` },
          { label: "Knowledge", to: list },
          { label: isNew ? "New Article" : article?.title || "Article" },
        ]}
        title={isNew ? "New Article" : "Edit Article"}
        aside={
          article ? (
            <Badge tone={STATUS_TONE[article.status]}>
              {SUPPORT_ARTICLE_STATUS_LABELS[article.status]}
            </Badge>
          ) : undefined
        }
      />
      {article?.createdByEmployeeId && article.status === "draft" && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">
          <Sparkles size={15} className="mt-0.5 shrink-0" />
          <span>
            An AI Employee wrote this from a solved ticket
            {article.sourceTicketId ? (
              <>
                {" ("}
                <Link
                  className="underline"
                  to={`/c/${company.slug}/support/tickets/${article.sourceTicketId}`}
                >
                  open it
                </Link>
                {")"}
              </>
            ) : null}
            . Check it says nothing about one customer, then publish it.
          </span>
        </div>
      )}
      <div className="space-y-4">
        <Input
          label="Title"
          placeholder="The question a customer would ask"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Select
          label="Topic"
          value={topicKey}
          onChange={(event) => setTopicKey(event.target.value)}
        >
          <option value="">No topic</option>
          {topics.map((topic) => (
            <option key={topic.key} value={topic.key}>
              {topic.name}
            </option>
          ))}
        </Select>
        <Textarea
          label="Answer"
          rows={16}
          hint="Write what a customer can be told. Markdown is fine. Be specific: your AI Employee can only say what is written here."
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        {helpCenterUrl && <HelpCenterNote url={helpCenterUrl} />}
        <FormError message={error} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {article && (
              <Button variant="ghost" loading={busy === "delete"} onClick={() => void remove()}>
                <Trash2 size={14} /> Delete
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {article?.status === "published" && (
              <Button
                variant="secondary"
                loading={busy === "unpublish"}
                disabled={busy !== null}
                onClick={() => void save("draft")}
              >
                Unpublish
              </Button>
            )}
            <Button
              variant="secondary"
              loading={busy === "save"}
              disabled={busy !== null || !title.trim()}
              onClick={() => void save()}
            >
              {article?.status === "published" ? "Save changes" : "Save draft"}
            </Button>
            {article?.status !== "published" && (
              <Button
                loading={busy === "publish"}
                disabled={busy !== null || !title.trim() || !body.trim()}
                onClick={() => void save("published")}
              >
                Publish
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
