import React from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Mail,
  MapPin,
  Mic,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { clsx } from "../components/ui/clsx";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useLiveRefetch } from "../components/CompanySocket";
import { Panel, ProviderChip, StatusChip } from "../components/meetings/MeetingChips";
import {
  AttendeeList,
  AttendeeStack,
  CopyAddressesButton,
  EmailAttendeesButton,
  RsvpSummary,
  type AttendeePerson,
} from "../components/meetings/Attendees";
import { useComposeEmail } from "../components/mail/ComposeEmailModal";
import { api, type Employee } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  AUDIENCE_LABELS,
  agendaDateParam,
  attendeeEmailDraft,
  attendeeName,
  attendeeRecipients,
  formatClock,
  formatDayLabel,
  formatDuration,
  formatTimeRange,
  meetingsApi,
  parseEmailList,
  type AttendeeAudience,
  type CalendarAccount,
  type CalendarEvent,
} from "../lib/meetings";
import type { MeetingsOutletCtx } from "./MeetingsLayout";

/**
 * The agenda: what is coming up, grouped by day.
 *
 * A list rather than a month grid, deliberately. The question this page has to
 * answer is "what is next, who is coming, and is it being recorded", and a
 * month grid answers "what does October look like" — which is what Google
 * Calendar is for, and it is one click away on every event.
 *
 * Each row opens in place to everyone on the invite: their address, how they
 * answered, and their Contact when they are one. From there one press writes
 * to all of them — or only to who is coming, or only to who hasn't replied —
 * with attachments, from the company's own mailbox, without leaving the page.
 *
 * The open event and the week shown live in the address (`?event=`, `?date=`),
 * so a meeting's page can link straight to its event here.
 */

/** Days shown per page of the agenda. */
const WINDOW_DAYS = 7;

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** The first day shown: `?date=` when it is a real date, else today. */
function windowStart(param: string | null): Date {
  const match = param ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(param) : null;
  if (match) {
    const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isNaN(at.getTime())) return at;
  }
  return startOfDay(new Date());
}

/** Events bucketed by local calendar day, in order. */
function groupByDay(events: CalendarEvent[]): Array<{ day: Date; events: CalendarEvent[] }> {
  const buckets = new Map<string, { day: Date; events: CalendarEvent[] }>();
  for (const event of events) {
    const day = startOfDay(new Date(event.startAt));
    const key = day.toISOString();
    const bucket = buckets.get(key) ?? { day, events: [] };
    bucket.events.push(event);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.day.getTime() - b.day.getTime());
}

/** An event's invite list, in the shape the attendee components draw. */
function peopleOf(event: CalendarEvent): AttendeePerson[] {
  return event.attendees.map((attendee) => ({
    email: attendee.email,
    name: attendeeName(attendee),
    responseStatus: attendee.responseStatus,
    organizer: attendee.organizer,
    optional: attendee.optional,
    contactId: attendee.contactId,
  }));
}

/** Does the search box's text match this event — its title, people or place? */
function matchesSearch(event: CalendarEvent, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    event.summary,
    event.location,
    event.organizerEmail,
    event.organizerName,
    ...event.attendees.flatMap((a) => [a.email, a.displayName, a.contactName]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Re-render once a minute, so "Now" and "In 5 min" stay true while the page is open. */
function useMinuteClock(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export default function MeetingsAgenda() {
  const { company } = useOutletContext<MeetingsOutletCtx>();
  const dialog = useDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const openEventId = searchParams.get("event");
  const dateParam = searchParams.get("date");
  const now = useMinuteClock();

  const [events, setEvents] = React.useState<CalendarEvent[] | null>(null);
  const [calendars, setCalendars] = React.useState<CalendarAccount[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const email = useComposeEmail(company);

  const from = React.useMemo(() => windowStart(dateParam), [dateParam]);
  const to = React.useMemo(() => {
    const at = new Date(from);
    at.setDate(at.getDate() + WINDOW_DAYS);
    return at;
  }, [from]);
  const isThisWeek = from.getTime() === startOfDay(new Date()).getTime();

  const reload = React.useCallback(() => {
    setError(null);
    Promise.all([
      meetingsApi.events(company.id, { from: from.toISOString(), to: to.toISOString() }),
      meetingsApi.calendars(company.id),
    ])
      .then(([eventsResult, calendarsResult]) => {
        setEvents(eventsResult.events);
        setCalendars(calendarsResult.calendars);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [company.id, from, to]);

  React.useEffect(() => {
    setEvents(null);
    reload();
  }, [reload]);

  useLiveRefetch(["calendar", "meeting"], reload);

  /** Change the address's `?date=` / `?event=` without stacking history entries. */
  const updateParams = React.useCallback(
    (change: (next: URLSearchParams) => void) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          change(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const shiftWeek = (days: number) => {
    const at = new Date(from);
    at.setDate(at.getDate() + days);
    updateParams((next) => {
      next.set("date", agendaDateParam(at));
      next.delete("event");
    });
  };

  const toggleEvent = (id: string) => {
    updateParams((next) => {
      if (next.get("event") === id) next.delete("event");
      else next.set("event", id);
    });
  };

  const syncAll = async () => {
    if (!calendars || calendars.length === 0) return;
    setSyncing(true);
    try {
      await Promise.all(calendars.map((row) => meetingsApi.syncCalendar(company.id, row.id)));
      reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t sync the calendars" });
    } finally {
      setSyncing(false);
    }
  };

  const needle = search.trim().toLowerCase();
  const visible = React.useMemo(
    () => (events ?? []).filter((event) => matchesSearch(event, needle)),
    [events, needle],
  );
  const grouped = React.useMemo(() => groupByDay(visible), [visible]);
  const calendarsById = React.useMemo(
    () => new Map((calendars ?? []).map((row) => [row.id, row] as const)),
    [calendars],
  );
  // The calendars' own addresses: never a recipient of "Email attendees".
  const ownAddresses = React.useMemo(
    () => (calendars ?? []).map((row) => row.address),
    [calendars],
  );
  const base = `/c/${company.slug}/meetings`;

  // Bring an event opened from a link into view once it has loaded.
  const scrolledTo = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!openEventId || !events || scrolledTo.current === openEventId) return;
    const row = document.getElementById(`agenda-event-${openEventId}`);
    if (!row) return;
    scrolledTo.current = openEventId;
    row.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [openEventId, events]);

  const composeTo = (event: CalendarEvent, recipients: string[], audience: AttendeeAudience) => {
    const draft = attendeeEmailDraft({
      title: event.summary,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay: event.allDay,
      conferenceUrl: event.conferenceUrl,
      location: event.location,
    });
    email.compose(
      { to: recipients.join(", "), ...draft },
      `${event.summary || "Untitled event"} · ${
        audience === "everyone" ? "everyone invited" : AUDIENCE_LABELS[audience].toLowerCase()
      }`,
    );
  };

  const composeToOne = (event: CalendarEvent, person: AttendeePerson) => {
    const draft = attendeeEmailDraft({
      title: event.summary,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay: event.allDay,
      conferenceUrl: event.conferenceUrl,
      location: event.location,
    });
    const first = person.name.includes("@") ? "" : person.name.split(/\s+/)[0];
    email.compose(
      {
        to: person.email,
        subject: draft.subject,
        bodyText: draft.bodyText.replace(/^Hi all,/, first ? `Hi ${first},` : "Hi,"),
      },
      `${event.summary || "Untitled event"} · ${person.name}`,
    );
  };

  const hasCalendars = calendars !== null && calendars.length > 0;

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Meetings" }]} />
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">
            Agenda
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {WINDOW_DAYS} days across every connected calendar. Open an event to see who is coming
            and email them.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={syncAll}
            loading={syncing}
            disabled={!hasCalendars}
          >
            <RefreshCw size={14} />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> New meeting
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center justify-between rounded-xl border border-slate-200 bg-white px-2 py-1.5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => shiftWeek(-WINDOW_DAYS)}
            aria-label="Previous week"
          >
            <ChevronLeft size={14} />
          </Button>
          <div className="text-sm font-medium tabular-nums text-slate-600 dark:text-slate-300">
            {from.toLocaleDateString(undefined, { month: "short", day: "numeric" })} –{" "}
            {new Date(to.getTime() - 1).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </div>
          <div className="flex items-center gap-1">
            {!isThisWeek && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  updateParams((next) => {
                    next.delete("date");
                    next.delete("event");
                  })
                }
              >
                Today
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => shiftWeek(WINDOW_DAYS)}
              aria-label="Next week"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
        <div className="relative sm:w-72">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <Input
            aria-label="Search the agenda"
            placeholder="Search events or people"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      {email.notice && <div className="mb-4">{email.notice}</div>}

      {error && (
        <Panel
          title="Could not load the agenda"
          body={error}
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      )}

      {!error && events === null && (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      )}

      {!error && events !== null && calendars !== null && calendars.length === 0 && (
        <Panel
          title="No calendar connected"
          body="Connect a Google calendar to see your agenda here, and to let an AI Employee record and write up your calls."
          action={
            <Link to={`${base}/calendars`}>
              <Button size="sm">Connect a calendar</Button>
            </Link>
          }
        />
      )}

      {!error && events !== null && hasCalendars && grouped.length === 0 && (
        <Panel
          title={needle ? "No events match" : "Nothing scheduled"}
          body={
            needle
              ? `Nothing this week matches “${search.trim()}”. Search looks at titles, attendees and places.`
              : "No events on any connected calendar in this window."
          }
          action={
            needle ? (
              <Button size="sm" variant="secondary" onClick={() => setSearch("")}>
                Clear search
              </Button>
            ) : undefined
          }
        />
      )}

      {!error && grouped.length > 0 && (
        <div className="space-y-6">
          {grouped.map((bucket) => (
            <section key={bucket.day.toISOString()} aria-label={formatDayLabel(bucket.day)}>
              <h2 className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                {formatDayLabel(bucket.day)}
                <span className="ml-2 tabular-nums text-slate-400 dark:text-slate-500">
                  {bucket.events.length} event{bucket.events.length === 1 ? "" : "s"}
                </span>
              </h2>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {bucket.events.map((event) => (
                    <AgendaEventRow
                      key={event.id}
                      event={event}
                      now={now}
                      expanded={openEventId === event.id}
                      onToggle={() => toggleEvent(event.id)}
                      calendar={calendarsById.get(event.accountId) ?? null}
                      showCalendar={(calendars?.length ?? 0) > 1}
                      ownAddresses={ownAddresses}
                      companySlug={company.slug}
                      meetingsBase={base}
                      onCompose={(recipients, audience) => composeTo(event, recipients, audience)}
                      onEmailPerson={(person) => composeToOne(event, person)}
                    />
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      {email.element}

      <NewMeetingModal
        open={creating}
        companyId={company.id}
        onClose={() => setCreating(false)}
        onCreated={reload}
      />
    </div>
  );
}

/** "Now", "In 12 min", or nothing — how soon an event is, while it matters. */
function startsSoon(event: CalendarEvent, now: number): { label: string; live: boolean } | null {
  if (event.allDay) return null;
  const start = new Date(event.startAt).getTime();
  const end = new Date(event.endAt).getTime();
  if (start <= now && now < end) return { label: "Now", live: true };
  const minutes = Math.ceil((start - now) / 60_000);
  if (minutes > 0 && minutes <= 60) return { label: `In ${minutes} min`, live: false };
  return null;
}

function AgendaEventRow({
  event,
  now,
  expanded,
  onToggle,
  calendar,
  showCalendar,
  ownAddresses,
  companySlug,
  meetingsBase,
  onCompose,
  onEmailPerson,
}: {
  event: CalendarEvent;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  calendar: CalendarAccount | null;
  showCalendar: boolean;
  ownAddresses: string[];
  companySlug: string;
  meetingsBase: string;
  onCompose: (recipients: string[], audience: AttendeeAudience) => void;
  onEmailPerson: (person: AttendeePerson) => void;
}) {
  const people = React.useMemo(() => peopleOf(event), [event]);
  const exclude = calendar ? [calendar.address, ...ownAddresses] : ownAddresses;
  const everyone = attendeeRecipients(people, "everyone", exclude);
  const soon = startsSoon(event, now);
  const past = !event.allDay && new Date(event.endAt).getTime() <= now;
  const span = event.allDay
    ? ""
    : formatDuration(new Date(event.endAt).getTime() - new Date(event.startAt).getTime());
  const panelId = `agenda-event-panel-${event.id}`;
  const meetingUrl = event.meeting ? `${meetingsBase}/${event.meeting.id}` : null;

  return (
    <div
      id={`agenda-event-${event.id}`}
      className={clsx("scroll-mt-4", expanded && "bg-slate-50/60 dark:bg-slate-800/30")}
    >
      <div className="flex items-start gap-2 px-2 py-1.5 sm:gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
        >
          <span
            className={clsx(
              "w-16 shrink-0 pt-0.5 text-xs font-medium tabular-nums sm:w-20",
              past ? "text-slate-400 dark:text-slate-500" : "text-slate-600 dark:text-slate-300",
            )}
          >
            <span className="block">{event.allDay ? "All day" : formatClock(event.startAt)}</span>
            {span && (
              <span className="block font-normal text-slate-400 dark:text-slate-500">{span}</span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={clsx(
                  "line-clamp-2 min-w-0 break-words text-sm font-medium",
                  past
                    ? "text-slate-500 dark:text-slate-400"
                    : "text-slate-900 dark:text-slate-100",
                )}
              >
                {event.summary || "(no title)"}
              </span>
              {soon && (
                <Badge tone={soon.live ? "danger" : "info"} dot={soon.live}>
                  {soon.label}
                </Badge>
              )}
              {event.status === "tentative" && <Badge tone="warning">Tentative</Badge>}
              {event.meeting && event.meeting.status !== "scheduled" && (
                <StatusChip status={event.meeting.status} />
              )}
              {event.meeting?.status === "scheduled" && (
                <Badge tone="ai" icon={<Mic />}>
                  Notetaker on
                </Badge>
              )}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <ProviderChip provider={event.conferenceProvider} />
              {event.recurring && (
                <span className="inline-flex items-center gap-1">
                  <Repeat size={12} aria-hidden="true" /> Repeats
                </span>
              )}
              {people.length > 0 ? (
                <>
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Users size={12} aria-hidden="true" />
                    {people.length} invited
                  </span>
                  <RsvpSummary people={people} />
                </>
              ) : (
                event.location && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <MapPin size={12} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{event.location}</span>
                  </span>
                )
              )}
            </span>
          </span>
          <span className="hidden shrink-0 self-center md:block">
            <AttendeeStack people={people} />
          </span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={clsx(
              "mt-0.5 shrink-0 text-slate-400 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <div className="flex shrink-0 items-center gap-1 pt-1">
          {everyone.length > 0 && (
            <button
              type="button"
              onClick={() => onCompose(everyone, "everyone")}
              className="touch-target relative rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label={`Email everyone invited to ${event.summary || "this event"}`}
              title="Email attendees"
            >
              <Mail size={14} />
            </button>
          )}
          {event.conferenceUrl && !past && (
            <a
              href={event.conferenceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="touch-target relative rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
            >
              Join
            </a>
          )}
        </div>
      </div>

      {expanded && (
        <div
          id={panelId}
          className="grid gap-4 border-t border-slate-100 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_18rem] dark:border-slate-800"
        >
          <section
            aria-label="Attendees"
            className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Users size={14} aria-hidden="true" /> Attendees
                <span className="font-normal tabular-nums text-slate-500 dark:text-slate-400">
                  {people.length}
                </span>
              </h3>
              {people.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <CopyAddressesButton emails={everyone} iconOnly />
                  <EmailAttendeesButton people={people} exclude={exclude} onCompose={onCompose} />
                </div>
              )}
            </header>
            <AttendeeList
              people={people}
              companySlug={companySlug}
              onEmail={onEmailPerson}
              emptyText="Nobody else is on this invite — it’s a block on your own calendar."
            />
          </section>

          <aside className="space-y-3 text-sm">
            <dl className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <DetailRow icon={<Clock size={14} />} label="When">
                {new Date(event.startAt).toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}{" "}
                · <span className="tabular-nums">{formatTimeRange(event)}</span>
                {span && <span className="text-slate-500 dark:text-slate-400"> ({span})</span>}
              </DetailRow>
              {(event.organizerName || event.organizerEmail) && (
                <DetailRow icon={<UserRound size={14} />} label="Organizer">
                  <span className="break-words">{event.organizerName || event.organizerEmail}</span>
                </DetailRow>
              )}
              {event.location && (
                <DetailRow icon={<MapPin size={14} />} label="Where">
                  <span className="break-words">{event.location}</span>
                </DetailRow>
              )}
              {event.conferenceProvider !== "none" && (
                <DetailRow icon={<Video size={14} />} label="Call">
                  <ProviderChip provider={event.conferenceProvider} />
                </DetailRow>
              )}
              {showCalendar && calendar && (
                <DetailRow icon={<CalendarDays size={14} />} label="Calendar">
                  <span className="break-all">{calendar.displayName || calendar.address}</span>
                </DetailRow>
              )}
            </dl>

            <div className="flex flex-col gap-2">
              {meetingUrl && (
                <Link to={meetingUrl}>
                  <Button variant="secondary" size="sm" className="w-full justify-start">
                    <FileText size={14} />
                    {event.meeting?.status === "ready" ? "Notes and transcript" : "Open meeting"}
                  </Button>
                </Link>
              )}
              {event.conferenceUrl && (
                <a href={event.conferenceUrl} target="_blank" rel="noreferrer noopener">
                  <Button variant="secondary" size="sm" className="w-full justify-start">
                    <Video size={14} /> Join call
                  </Button>
                </a>
              )}
              {event.htmlLink && (
                <a href={event.htmlLink} target="_blank" rel="noreferrer noopener">
                  <Button variant="secondary" size="sm" className="w-full justify-start">
                    <ExternalLink size={14} /> Open in Google Calendar
                  </Button>
                </a>
              )}
            </div>

            {event.description.trim() && <EventDescription text={event.description} />}
          </aside>
        </div>
      )}
    </div>
  );
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <dt className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500">
        <span aria-hidden="true">{icon}</span>
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">{children}</dd>
    </div>
  );
}

/**
 * The invite's own notes. Google sends them as HTML more often than not, so
 * the tags come off before they are shown — as text, never as markup.
 */
function EventDescription({ text }: { text: string }) {
  const [full, setFull] = React.useState(false);
  const plain = React.useMemo(() => descriptionText(text), [text]);
  if (!plain) return null;
  const long = plain.length > 280;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h3 className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">Notes</h3>
      <p
        className={clsx(
          "whitespace-pre-line break-words text-sm text-slate-700 dark:text-slate-200",
          long && !full && "line-clamp-5",
        )}
      >
        {plain}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setFull((current) => !current)}
          className="mt-1.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {full ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** HTML from a calendar invite as readable text: breaks kept, tags and entities gone. */
function descriptionText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Create a meeting that was never on a calendar.
 *
 * The path that makes this feature work on day one: a call already happened,
 * somebody has the recording or the transcript, and they want it written up
 * and on the customer's timeline.
 *
 * It is also the only way to point the notetaker at a call with no calendar
 * behind it — which is why the Meet link is here. Without it this modal could
 * only ever produce a meeting with nothing to join, so the meeting page hid
 * its "Start notetaker" button and the ad-hoc half of the feature could not
 * record anything at all.
 */
function NewMeetingModal({
  open,
  companyId,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [attendees, setAttendees] = React.useState("");
  const [conferenceUrl, setConferenceUrl] = React.useState("");
  const [notetakerEmployeeId, setNotetakerEmployeeId] = React.useState("");
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setTitle("");
      setAttendees("");
      setConferenceUrl("");
      setNotetakerEmployeeId("");
      setError(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    api
      .get<Employee[]>(`/api/companies/${companyId}/employees`)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [open, companyId]);

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await meetingsApi.createMeeting(companyId, {
        title: title.trim(),
        conferenceUrl: conferenceUrl.trim(),
        notetakerEmployeeId: notetakerEmployeeId || null,
        attendeeEmails: parseEmailList(attendees),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New meeting">
      <div className="space-y-4">
        <Input
          label="Title"
          value={title}
          autoFocus
          placeholder="Quarterly review with Acme"
          onChange={(e) => setTitle(e.target.value)}
        />
        <Input
          label="Attendees"
          value={attendees}
          placeholder="sam@northwind.test, priya@acme.test"
          onChange={(e) => setAttendees(e.target.value)}
        />
        <Input
          label="Google Meet link (optional)"
          value={conferenceUrl}
          placeholder="https://meet.google.com/abc-defg-hij"
          onChange={(e) => setConferenceUrl(e.target.value)}
        />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Notetaker
          </span>
          <Select
            value={notetakerEmployeeId}
            onChange={(e) => setNotetakerEmployeeId(e.target.value)}
          >
            <option value="">Nobody</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Paste a Meet link and the meeting page offers <strong>Start notetaker</strong>, which
          sends the disclosed guest to join it. Leave it empty and you can still upload the
          recording or paste a transcript afterwards. The notetaker is also the employee whose AI
          Model transcribes the audio and writes the meeting up, so a recording with nobody assigned
          stays a recording. Attendees from outside the company link the meeting to their Customer,
          which Genosyn creates if you don&apos;t have one yet, and attendees who are already
          Contacts get the call on their timeline. You can add attendees later too.
        </p>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={saving} disabled={!title.trim()}>
            <CalendarDays size={14} /> {saving ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
