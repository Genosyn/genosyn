import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useLiveRefetch } from "../components/CompanySocket";
import { Panel, ProviderChip } from "../components/meetings/MeetingChips";
import { api, type Employee } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  formatClock,
  formatDayLabel,
  meetingsApi,
  parseEmailList,
  type CalendarAccount,
  type CalendarEvent,
} from "../lib/meetings";
import type { MeetingsOutletCtx } from "./MeetingsLayout";

/**
 * The agenda: what is coming up, grouped by day.
 *
 * A list rather than a month grid, deliberately. The question this page has to
 * answer is "what is next and is it being recorded", and a month grid answers
 * "what does October look like" — which is what Google Calendar is for, and it
 * is one click away on every row.
 */

/** Days shown per page of the agenda. */
const WINDOW_DAYS = 7;

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
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

export default function MeetingsAgenda() {
  const { company } = useOutletContext<MeetingsOutletCtx>();
  const dialog = useDialog();

  const [offsetDays, setOffsetDays] = React.useState(0);
  const [events, setEvents] = React.useState<CalendarEvent[] | null>(null);
  const [calendars, setCalendars] = React.useState<CalendarAccount[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const from = React.useMemo(() => {
    const at = startOfDay(new Date());
    at.setDate(at.getDate() + offsetDays);
    return at;
  }, [offsetDays]);
  const to = React.useMemo(() => {
    const at = new Date(from);
    at.setDate(at.getDate() + WINDOW_DAYS);
    return at;
  }, [from]);

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
      .catch((err) => setError((err as Error).message));
  }, [company.id, from, to]);

  React.useEffect(() => {
    setEvents(null);
    reload();
  }, [reload]);

  useLiveRefetch(["calendar", "meeting"], reload);

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

  const grouped = React.useMemo(() => groupByDay(events ?? []), [events]);
  const base = `/c/${company.slug}/meetings`;

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Meetings" }]} />
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Agenda</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            The next {WINDOW_DAYS} days across every connected calendar.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={syncAll}
            disabled={syncing || !calendars || calendars.length === 0}
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : undefined} />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> New meeting
          </Button>
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOffsetDays((prev) => prev - WINDOW_DAYS)}
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
          {offsetDays !== 0 && (
            <Button variant="ghost" size="sm" onClick={() => setOffsetDays(0)}>
              Today
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOffsetDays((prev) => prev + WINDOW_DAYS)}
            aria-label="Next week"
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>

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

      {!error && events !== null && calendars !== null && calendars.length > 0 && grouped.length === 0 && (
        <Panel
          title="Nothing scheduled"
          body="No events on any connected calendar in this window."
        />
      )}

      {!error && grouped.length > 0 && (
        <div className="space-y-6">
          {grouped.map((bucket) => (
            <section key={bucket.day.toISOString()}>
              <h2 className="sticky top-0 z-10 mb-2 bg-slate-50/80 py-1 text-xs font-semibold uppercase tracking-wider text-slate-500 backdrop-blur dark:bg-slate-900/70 dark:text-slate-400">
                {formatDayLabel(bucket.day)}
              </h2>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {bucket.events.map((event) => (
                    <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                      <div className="w-16 shrink-0 pt-0.5 text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">
                        {event.allDay ? "All day" : formatClock(event.startAt)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                            {event.summary || "(no title)"}
                          </span>
                          <ProviderChip provider={event.conferenceProvider} />
                          {event.status === "tentative" && (
                            <span className="text-xs text-amber-600 dark:text-amber-400">
                              tentative
                            </span>
                          )}
                        </div>
                        {event.attendees.length > 0 && (
                          <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                            {event.attendees.length} attendee
                            {event.attendees.length === 1 ? "" : "s"} ·{" "}
                            {event.attendees
                              .slice(0, 3)
                              .map((a) => a.displayName || a.email)
                              .join(", ")}
                            {event.attendees.length > 3 ? "…" : ""}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {event.conferenceUrl && (
                          <a
                            href={event.conferenceUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
                          >
                            Join
                          </a>
                        )}
                        {event.htmlLink && (
                          <a
                            href={event.htmlLink}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                            aria-label="Open in Google Calendar"
                          >
                            <ExternalLink size={13} />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      <NewMeetingModal
        open={creating}
        companyId={company.id}
        onClose={() => setCreating(false)}
        onCreated={reload}
      />
    </div>
  );
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
          Model transcribes the audio and writes the meeting up, so a recording with nobody
          assigned stays a recording. Attendees who are already Contacts get the call on their
          timeline. You can add attendees later too.
        </p>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || !title.trim()}>
            <CalendarDays size={14} /> {saving ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
