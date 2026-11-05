import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import {
  AlarmClock,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Inbox,
  MessageCircle,
  Plus,
  Search,
  ShieldOff,
  Sparkles,
  X,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "@/components/ui/Avatar";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { SkeletonList } from "@/components/ui/Skeleton";
import { clsx } from "@/components/ui/clsx";
import { errorMessage } from "@/lib/errors";
import { agoText, requesterLabel, slaState, supportApi, type SupportTicket } from "@/lib/support";
import {
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_SORTS,
  SUPPORT_SORT_LABELS,
  SUPPORT_SOURCE_LABELS,
  SUPPORT_TICKET_SOURCES,
  SUPPORT_VIEWS,
  SUPPORT_VIEW_LABELS,
  type SupportPriority,
  type SupportSort,
  type SupportTicketSource,
  type SupportView,
} from "../../shared/support";
import type { SupportOutletContext } from "./SupportLayout";
import { NewTicketModal } from "./support/NewTicketModal";
import { SupportSetupGuide } from "./support/SupportSetupGuide";

export const PRIORITY_TONE: Record<SupportPriority, BadgeTone> = {
  urgent: "danger",
  high: "warning",
  normal: "neutral",
  low: "neutral",
};

const PRIORITY_DOT: Record<SupportPriority, string> = {
  urgent: "bg-rose-500",
  high: "bg-amber-500",
  normal: "bg-slate-300 dark:bg-slate-600",
  low: "bg-transparent ring-1 ring-inset ring-slate-300 dark:ring-slate-600",
};

const EMPTY_COPY: Partial<Record<SupportView, { title: string; description: string }>> = {
  inbox: {
    title: "Nothing is waiting",
    description:
      "Every customer has an answer. New email and chats to your Support inboxes land here.",
  },
  mine: {
    title: "Nothing assigned to you",
    description: "Tickets you hold show here, whether they are waiting on you or on the customer.",
  },
  unassigned: {
    title: "Every open ticket has an owner",
    description: "Tickets nobody holds yet show here.",
  },
  review: {
    title: "No drafts to review",
    description:
      "Replies your AI Employee drafted wait here for someone to send, change or discard.",
  },
  ai: {
    title: "Nothing answered by AI yet",
    description: "Replies that went out on their own show here, so you can read what was said.",
  },
  at_risk: {
    title: "No targets at risk",
    description: "Tickets within an hour of missing a target, or already past one, show here.",
  },
  spam: {
    title: "No spam",
    description:
      "Newsletters and unsolicited mail land here, with the reason, in case one is real.",
  },
};

function isView(value: string | null): value is SupportView {
  return Boolean(value) && SUPPORT_VIEWS.includes(value as SupportView);
}

function TicketRow({
  ticket,
  companyId,
  slug,
  topicName,
  selected,
  focused,
  selecting,
  onToggle,
}: {
  ticket: SupportTicket;
  companyId: string;
  slug: string;
  topicName: string | null;
  selected: boolean;
  focused: boolean;
  selecting: boolean;
  onToggle: () => void;
}) {
  const sla = slaState(ticket);
  const unread = ticket.status === "new";
  return (
    <div
      className={clsx(
        "group relative flex items-start gap-3 px-4 py-3 transition-colors",
        focused
          ? "bg-indigo-50/70 dark:bg-indigo-500/10"
          : "hover:bg-slate-50 dark:hover:bg-slate-800/50",
      )}
      data-focused={focused || undefined}
    >
      <div
        className={clsx(
          "flex h-5 items-center",
          !selecting &&
            !selected &&
            "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100",
        )}
      >
        <Checkbox checked={selected} onChange={onToggle} label={`Select ticket ${ticket.number}`} />
      </div>
      <span
        aria-label={`${SUPPORT_PRIORITY_LABELS[ticket.priority]} priority`}
        title={`${SUPPORT_PRIORITY_LABELS[ticket.priority]} priority`}
        className={clsx("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", PRIORITY_DOT[ticket.priority])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <Link
            to={`/c/${slug}/support/tickets/${ticket.id}`}
            className={clsx(
              "min-w-0 truncate text-sm after:absolute after:inset-0 focus-visible:outline-none",
              unread
                ? "font-semibold text-slate-900 dark:text-slate-100"
                : "font-medium text-slate-800 dark:text-slate-200",
            )}
          >
            {ticket.subject || "(no subject)"}
          </Link>
          <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {agoText(ticket.lastActivityAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <span className="truncate">{requesterLabel(ticket)}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">#{ticket.number}</span>
          {ticket.source === "chat" && (
            <Badge tone="info" icon={<MessageCircle />}>
              Chat
            </Badge>
          )}
          {topicName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 truncate">{topicName}</span>
            </>
          )}
        </div>
        {ticket.aiSummary && (
          <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-600 dark:text-slate-300">
            {ticket.aiSummary}
          </p>
        )}
        {(ticket.draftReady ||
          ticket.needsHuman ||
          ticket.aiHandled ||
          sla ||
          ticket.sentiment === "angry" ||
          ticket.status === "spam") && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {ticket.draftReady && (
              <Badge tone="ai" icon={<Sparkles />}>
                Draft ready
              </Badge>
            )}
            {ticket.needsHuman && (
              <Badge tone="warning" icon={<AlertTriangle />}>
                Needs a person
              </Badge>
            )}
            {ticket.aiHandled && (
              <Badge tone="ai" icon={<Bot />}>
                Answered by AI
              </Badge>
            )}
            {ticket.sentiment === "angry" && <Badge tone="danger">Angry</Badge>}
            {sla && (
              <Badge tone={sla.tone} icon={<AlarmClock />}>
                {sla.label}
              </Badge>
            )}
            {ticket.status === "spam" && ticket.spamReason && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {ticket.spamReason}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex h-5 shrink-0 items-center">
        {ticket.assigneeUser ? (
          <Avatar
            name={ticket.assigneeUser.name}
            src={memberAvatarUrl(companyId, ticket.assigneeUser.id, ticket.assigneeUser.avatarKey)}
            size="xs"
          />
        ) : ticket.assigneeEmployee ? (
          <Avatar
            name={ticket.assigneeEmployee.name}
            src={employeeAvatarUrl(
              companyId,
              ticket.assigneeEmployee.id,
              ticket.assigneeEmployee.avatarKey,
            )}
            kind="ai"
            size="xs"
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The queue. One list and a set of server-owned views, read a page at a time by
 * cursor. J and K move, Enter opens, X selects, and E solves what is selected, so
 * someone clearing a queue never reaches for the mouse.
 */
export default function SupportQueue() {
  const { company, inboxes, topics, reload } = useOutletContext<SupportOutletContext>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const dialog = useDialog();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);

  const viewParam = params.get("view");
  const view: SupportView = isView(viewParam) ? viewParam : "inbox";
  const inboxId = params.get("inbox") ?? undefined;
  const priority = (params.get("priority") ?? undefined) as SupportPriority | undefined;
  const topicKey = params.get("topic") ?? undefined;
  const source = (params.get("source") ?? undefined) as SupportTicketSource | undefined;
  const sort = (params.get("sort") ?? undefined) as SupportSort | undefined;
  const q = params.get("q") ?? undefined;
  const filters = React.useMemo(
    () => ({ view: inboxId ? undefined : view, inboxId, priority, topicKey, source, sort, q }),
    [inboxId, view, priority, topicKey, source, sort, q],
  );

  const [rows, setRows] = React.useState<SupportTicket[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [focus, setFocus] = React.useState(0);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [search, setSearch] = React.useState(q ?? "");

  const load = React.useCallback(async () => {
    try {
      const page = await api.tickets(filters);
      setRows(page.rows);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load tickets"));
      setRows((current) => current ?? []);
    }
  }, [api, filters]);

  React.useEffect(() => {
    setRows(null);
    setSelected(new Set());
    setFocus(0);
    void load();
  }, [load]);
  useLiveRefetch("support_ticket", () => void load());

  React.useEffect(() => {
    setSearch(q ?? "");
  }, [q]);

  function setParam(name: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.tickets(filters, { cursor });
      setRows((current) => [...(current ?? []), ...page.rows]);
      setCursor(page.nextCursor);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t load more tickets" });
    } finally {
      setLoadingMore(false);
    }
  }

  async function bulk(patch: Parameters<typeof api.bulkUpdate>[1]) {
    setBulkBusy(true);
    try {
      const ids = [...selected];
      const result = await api.bulkUpdate(ids, patch);
      if (result.skipped.length > 0) {
        void dialog.error(null, {
          title: `${result.skipped.length} of ${ids.length} tickets could not be changed`,
          message: result.skipped[0].reason,
        });
      }
      setSelected(new Set());
      await Promise.all([load(), reload()]);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t change those tickets" });
    } finally {
      setBulkBusy(false);
    }
  }

  const toggle = React.useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const list = rows ?? [];
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setFocus((current) => Math.min(current + 1, Math.max(0, list.length - 1)));
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setFocus((current) => Math.max(current - 1, 0));
      } else if (event.key === "Enter" && list[focus]) {
        event.preventDefault();
        navigate(`/c/${company.slug}/support/tickets/${list[focus].id}`);
      } else if (event.key === "x" && list[focus]) {
        event.preventDefault();
        toggle(list[focus].id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, focus, navigate, company.slug, toggle]);

  const topicName = React.useCallback(
    (key: string | null) => topics.find((topic) => topic.key === key)?.name ?? null,
    [topics],
  );
  const inbox = inboxes?.find((item) => item.id === inboxId) ?? null;
  const noInboxes = inboxes !== null && inboxes.length === 0;
  const title = inbox ? inbox.name : SUPPORT_VIEW_LABELS[view];
  const filtered = Boolean(priority || topicKey || source || q);
  const empty = EMPTY_COPY[view] ?? {
    title: "Nothing here",
    description: "Tickets in this state show here.",
  };

  if (noInboxes) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <SupportSetupGuide company={company} onCreated={() => void reload()} />
      </div>
    );
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        title={title}
        aside={
          rows !== null ? (
            <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">{total}</span>
          ) : undefined
        }
        actions={
          inboxes && inboxes.length > 0 ? (
            <Button onClick={() => setCreating(true)}>
              <Plus size={14} /> New ticket
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          className="relative min-w-48 flex-1"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setParam("q", search.trim() || undefined);
          }}
        >
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <Input
            aria-label="Search tickets"
            placeholder="Search by subject, customer or #number"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </form>
        <div className="w-36">
          <Select
            aria-label="Filter by priority"
            value={priority ?? ""}
            onChange={(event) => setParam("priority", event.target.value || undefined)}
          >
            <option value="">Any priority</option>
            {[...SUPPORT_PRIORITIES].reverse().map((value) => (
              <option key={value} value={value}>
                {SUPPORT_PRIORITY_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select
            aria-label="Filter by topic"
            value={topicKey ?? ""}
            onChange={(event) => setParam("topic", event.target.value || undefined)}
          >
            <option value="">Any topic</option>
            {topics.map((topic) => (
              <option key={topic.key} value={topic.key}>
                {topic.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select
            aria-label="Filter by where it came from"
            value={source ?? ""}
            onChange={(event) => setParam("source", event.target.value || undefined)}
          >
            <option value="">Any source</option>
            {SUPPORT_TICKET_SOURCES.map((value) => (
              <option key={value} value={value}>
                {SUPPORT_SOURCE_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        {view !== "at_risk" && (
          <div className="w-40">
            <Select
              aria-label="Sort tickets"
              value={sort ?? "recent"}
              onChange={(event) =>
                setParam("sort", event.target.value === "recent" ? undefined : event.target.value)
              }
            >
              {SUPPORT_SORTS.map((value) => (
                <option key={value} value={value}>
                  {SUPPORT_SORT_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
        )}
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("priority");
              next.delete("topic");
              next.delete("source");
              next.delete("q");
              setParams(next, { replace: true });
            }}
          >
            <X size={13} /> Clear
          </Button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 shadow-sm dark:border-indigo-500/30 dark:bg-indigo-950">
          <span className="text-sm font-medium tabular-nums text-indigo-900 dark:text-indigo-100">
            {selected.size} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={bulkBusy}
              onClick={() => void bulk({ status: "solved" })}
            >
              <CheckCircle2 size={13} /> Solve
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={bulkBusy}
              onClick={() => void bulk({ status: "spam" })}
            >
              <ShieldOff size={13} /> Spam
            </Button>
            <div className="w-36">
              <Select
                aria-label="Set priority of selected tickets"
                disabled={bulkBusy}
                value=""
                onChange={(event) => {
                  if (event.target.value) {
                    void bulk({ priority: event.target.value as SupportPriority });
                  }
                }}
              >
                <option value="">Set priority</option>
                {[...SUPPORT_PRIORITIES].reverse().map((value) => (
                  <option key={value} value={value}>
                    {SUPPORT_PRIORITY_LABELS[value]}
                  </option>
                ))}
              </Select>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {error && <FormError message={error} className="mb-3" />}

      {rows === null ? (
        <SkeletonList rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filtered ? <Search /> : <Inbox />}
          title={filtered ? "No tickets match" : empty.title}
          description={filtered ? "Try fewer filters or other words." : empty.description}
        />
      ) : (
        <Card className="divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
          {rows.map((ticket, index) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              companyId={company.id}
              slug={company.slug}
              topicName={topicName(ticket.topicKey)}
              selected={selected.has(ticket.id)}
              focused={index === focus}
              selecting={selected.size > 0}
              onToggle={() => toggle(ticket.id)}
            />
          ))}
        </Card>
      )}

      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            <ChevronDown size={14} /> Load more
          </Button>
        </div>
      )}

      {inboxes && inboxes.length > 0 && (
        <NewTicketModal
          open={creating}
          onClose={() => setCreating(false)}
          company={company}
          inboxes={inboxes}
          onCreated={(ticketId) => {
            setCreating(false);
            navigate(`/c/${company.slug}/support/tickets/${ticketId}`);
          }}
        />
      )}
    </div>
  );
}
