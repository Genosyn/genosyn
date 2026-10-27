import React from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CalendarCheck,
  CalendarPlus,
  Check,
  Copy,
  ExternalLink,
  Sparkles,
  Video,
} from "lucide-react";
import {
  formatMeetingRange,
  meetingTitleFromSubject,
  MEETING_DURATIONS,
  supportedTimeZones,
  timeZoneCity,
  utcToZonedLocal,
} from "../../shared/meetingTime";
import { errorMessage } from "@/lib/errors";
import {
  durationLabel,
  inviteConfirmationText,
  isMeetingDuration,
  joinLocal,
  meetingApi,
  meetingInstants,
  type MeetingProposal,
  type MeetingProposalResult,
  overlapsBusy,
  proposalFromAnalysis,
  type ScheduledMeeting,
  type SchedulingCalendar,
  splitLocal,
  suggestedStart,
  timeZoneOptionLabel,
  viewerSlot,
  viewerTimeZone,
} from "@/lib/mailMeetings";
import type { MailAnalysisAction } from "@/lib/mail";
import { addMailRecipients, emptyMailRecipients } from "@/lib/mailRecipients";
import { parseRecipients, type Recipient, recipientKey } from "@/lib/recipientTokens";
import {
  mergeSuggestions,
  useMailAddressBook,
  useMailRecipientCheck,
} from "@/components/mail/MailRecipientFields";
import {
  RecipientInput,
  type RecipientFlag,
  type RecipientInputHandle,
} from "@/components/RecipientInput";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";

/**
 * Schedule a call from an email, without leaving it.
 *
 * The form is usable the moment it opens — guests from the thread, a title
 * from the subject, the next sensible slot — while the mailbox's AI Employee
 * reads the thread for the time people actually agreed, in the zone they
 * agreed it in (`POST /mail/threads/:tid/meeting-proposal`). What it finds
 * fills only what the Member has not touched yet; a time it finds after the
 * Member picked one is offered, not forced. The words it got the time from are
 * shown beside it, checked verbatim by the server, so nobody has to trust a
 * paraphrase.
 *
 * Send invite creates the event on a Google calendar with a Meet link and has
 * Google email the invitation to every guest (`POST /mail/accounts/:aid/meetings`).
 * Guests on the do-not-email list are flagged before anything is sent, and
 * the server refuses them again. Afterwards the details can go straight into
 * the reply, so the email and the invitation say the same thing.
 */

export type ScheduleMeetingPrefill = {
  analysisId: string;
  actionId: string;
  action: Pick<
    MailAnalysisAction,
    "title" | "start" | "timeZone" | "durationMinutes" | "attendees"
  >;
};

type Field = "title" | "when" | "duration" | "attendees" | "description";

type Form = {
  title: string;
  date: string;
  time: string;
  durationMinutes: number;
  timeZone: string;
  attendees: Recipient[];
  description: string;
  addMeet: boolean;
  sendInvites: boolean;
  calendarId: string;
};

export function ScheduleMeetingModal({
  open,
  onClose,
  companyId,
  companySlug,
  accountId,
  selfAddress,
  threadId,
  subject,
  participants,
  defaultAttendees,
  prefill,
  onAddToReply,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companySlug: string;
  accountId: string;
  selfAddress: string;
  threadId: string;
  subject: string;
  /** Everyone on the thread, offered while adding guests. */
  participants: Recipient[];
  /** Who the meeting starts with: the people a reply-all would reach. */
  defaultAttendees: Recipient[];
  /** A Schedule button the AI analysis attached to this email. */
  prefill?: ScheduleMeetingPrefill | null;
  /** Put the invitation's details into the reply composer. */
  onAddToReply: (text: string) => void;
}) {
  if (!open) return null;
  return (
    <ScheduleMeetingDialog
      onClose={onClose}
      companyId={companyId}
      companySlug={companySlug}
      accountId={accountId}
      selfAddress={selfAddress}
      threadId={threadId}
      subject={subject}
      participants={participants}
      defaultAttendees={defaultAttendees}
      prefill={prefill ?? null}
      onAddToReply={onAddToReply}
    />
  );
}

function initialForm(
  subject: string,
  defaultAttendees: Recipient[],
  prefill: ScheduleMeetingPrefill | null,
): { form: Form; proposal: MeetingProposal } {
  const zone = viewerTimeZone();
  const base: MeetingProposal = {
    title: meetingTitleFromSubject(subject) || "Call",
    attendees: defaultAttendees.map((person) => ({ email: person.email, name: person.name })),
    start: suggestedStart(new Date(), zone),
    timeZone: zone,
    durationMinutes: 30,
    description: "",
    evidence: null,
    alternatives: [],
    confidence: "none",
  };
  const proposal = prefill ? proposalFromAnalysis(prefill.action, base) : base;
  const { date, time } = splitLocal(proposal.start);
  return {
    proposal,
    form: {
      title: proposal.title,
      date,
      time,
      durationMinutes: proposal.durationMinutes,
      timeZone: proposal.timeZone,
      attendees: proposal.attendees.map((person) => ({ ...person, valid: true })),
      description: proposal.description,
      addMeet: true,
      sendInvites: true,
      calendarId: "",
    },
  };
}

function ScheduleMeetingDialog({
  onClose,
  companyId,
  companySlug,
  accountId,
  selfAddress,
  threadId,
  subject,
  participants,
  defaultAttendees,
  prefill,
  onAddToReply,
}: {
  onClose: () => void;
  companyId: string;
  companySlug: string;
  accountId: string;
  selfAddress: string;
  threadId: string;
  subject: string;
  participants: Recipient[];
  defaultAttendees: Recipient[];
  prefill: ScheduleMeetingPrefill | null;
  onAddToReply: (text: string) => void;
}) {
  const viewerZone = React.useMemo(() => viewerTimeZone(), []);
  const [form, setForm] = React.useState<Form>(
    () => initialForm(subject, defaultAttendees, prefill).form,
  );
  const touched = React.useRef(new Set<Field>());
  const [attendeeText, setAttendeeText] = React.useState("");
  const attendeeInput = React.useRef<RecipientInputHandle>(null);

  const [calendars, setCalendars] = React.useState<SchedulingCalendar[] | null>(null);
  const [setupHint, setSetupHint] = React.useState<string | null>(null);
  const [calendarError, setCalendarError] = React.useState<string | null>(null);

  const [ai, setAi] = React.useState<
    | { status: "skipped" }
    | { status: "loading" }
    | { status: "done"; result: MeetingProposalResult }
    | { status: "failed"; message: string }
  >(prefill ? { status: "skipped" } : { status: "loading" });
  /** A time the AI found after the Member had already picked one. */
  const [offeredTime, setOfferedTime] = React.useState<{ start: string; timeZone: string } | null>(
    null,
  );

  const [busy, setBusy] = React.useState<{ key: string; overlaps: boolean } | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [scheduled, setScheduled] = React.useState<ScheduledMeeting | null>(null);

  const update = (field: Field | null, patch: Partial<Form>) => {
    if (field) touched.current.add(field);
    setForm((current) => ({ ...current, ...patch }));
  };

  // Calendars to put the event on.
  React.useEffect(() => {
    let cancelled = false;
    meetingApi
      .calendars(companyId, accountId)
      .then((result) => {
        if (cancelled) return;
        setCalendars(result.calendars);
        setSetupHint(result.setupHint);
        const chosen = result.calendars.find((item) => item.isDefault) ?? result.calendars[0];
        if (chosen)
          setForm((current) =>
            current.calendarId ? current : { ...current, calendarId: chosen.id },
          );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCalendars([]);
          setCalendarError(errorMessage(err, "Couldn’t load your calendars"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, accountId]);

  // The AI Employee's read of the thread. Fills only what is still untouched.
  React.useEffect(() => {
    if (prefill) return;
    let cancelled = false;
    meetingApi
      .proposal(companyId, threadId, viewerZone)
      .then((result) => {
        if (cancelled) return;
        setAi({ status: "done", result });
        const proposal = result.proposal;
        setForm((current) => {
          const next = { ...current };
          if (!touched.current.has("title") && proposal.title) next.title = proposal.title;
          if (!touched.current.has("attendees") && proposal.attendees.length > 0) {
            next.attendees = proposal.attendees.map((person) => ({ ...person, valid: true }));
          }
          if (!touched.current.has("duration") && isMeetingDuration(proposal.durationMinutes)) {
            next.durationMinutes = proposal.durationMinutes;
          }
          if (!touched.current.has("description") && proposal.description) {
            next.description = proposal.description;
          }
          if (proposal.start) {
            if (!touched.current.has("when")) {
              const { date, time } = splitLocal(proposal.start);
              next.date = date;
              next.time = time;
              next.timeZone = proposal.timeZone;
            } else {
              setOfferedTime({ start: proposal.start, timeZone: proposal.timeZone });
            }
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setAi({ status: "failed", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, threadId, viewerZone, prefill]);

  const local = joinLocal(form.date, form.time);
  const instants = meetingInstants(local, form.durationMinutes, form.timeZone);
  const isPast = instants ? instants.start.getTime() < Date.now() : false;
  const mine = instants ? viewerSlot(instants, form.timeZone, viewerZone) : null;

  // Conflicts on the chosen calendar, re-checked as the slot changes.
  const busyKey =
    instants && form.calendarId
      ? `${form.calendarId}|${instants.start.toISOString()}|${instants.end.toISOString()}`
      : "";
  React.useEffect(() => {
    if (!busyKey || !instants) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      meetingApi
        .availability(companyId, accountId, {
          calendarId: form.calendarId,
          start: instants.start.toISOString(),
          end: instants.end.toISOString(),
        })
        .then((result) => {
          if (!cancelled) setBusy({ key: busyKey, overlaps: overlapsBusy(result.busy, instants) });
        })
        .catch(() => {
          // Availability is advice; an unreadable calendar just says nothing.
          if (!cancelled) setBusy(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // instants is derived from busyKey's parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey, companyId, accountId]);
  const conflict = busy !== null && busy.key === busyKey && busy.overlaps;

  // Guests: the thread's people first, then the address book.
  const addressBook = useMailAddressBook(companyId, accountId, attendeeText);
  const taken = React.useMemo(
    () =>
      new Set([
        recipientKey(selfAddress),
        ...form.attendees.map((item) => recipientKey(item.email)),
      ]),
    [selfAddress, form.attendees],
  );
  const { suggestions, detail } = React.useMemo(
    () => mergeSuggestions(participants, addressBook, taken),
    [participants, addressBook, taken],
  );
  const checkFields = React.useMemo(
    () => ({ ...emptyMailRecipients(), to: form.attendees }),
    [form.attendees],
  );
  const blocked = useMailRecipientCheck(companyId, accountId, checkFields);
  const flags = React.useMemo(() => {
    const map = new Map<string, RecipientFlag>();
    for (const item of blocked) map.set(recipientKey(item.email), { reason: item.detail });
    return map;
  }, [blocked]);

  const zones = React.useMemo(() => supportedTimeZones(), []);
  const suggestedZones = React.useMemo(() => {
    const calendarZone = calendars?.find((item) => item.id === form.calendarId)?.timeZone ?? "";
    const aiZone = ai.status === "done" ? ai.result.proposal.timeZone : "";
    const list = [form.timeZone, viewerZone, aiZone, calendarZone, "UTC"].filter(
      (zone, index, all) => zone && all.indexOf(zone) === index,
    );
    return list;
  }, [ai, calendars, form.calendarId, form.timeZone, viewerZone]);

  const calendar = calendars?.find((item) => item.id === form.calendarId) ?? null;

  const problemFor = (attendees: Recipient[]): string | null => {
    const invalid = attendees.filter((item) => !item.valid);
    if (!form.title.trim()) return "Give the meeting a title.";
    if (!local) return "Pick a date and a start time.";
    if (!instants) return "Pick a time zone.";
    if (isPast) return "That time has already passed. Pick a later one.";
    if (invalid.length > 0)
      return `“${invalid[0].email}” isn’t a valid email address. Fix or remove it.`;
    if (attendees.length === 0) return "Add at least one guest.";
    if (blocked.length > 0) return "Remove the guests who can’t be emailed first.";
    if (!calendar) return "Choose a calendar to put the event on.";
    return null;
  };
  const problem = problemFor(form.attendees);

  const submit = async () => {
    // Whatever is still typed in the guest box is a guest too.
    let attendees = form.attendees;
    if (attendeeText.trim()) {
      attendees = addMailRecipients(
        { ...emptyMailRecipients(), to: attendees },
        "to",
        parseRecipients(attendeeText).filter(
          (item) => recipientKey(item.email) !== recipientKey(selfAddress),
        ),
      ).to;
      touched.current.add("attendees");
      setForm((current) => ({ ...current, attendees }));
      setAttendeeText("");
    }
    const blocker = problemFor(attendees);
    if (blocker || !local || !calendar) {
      setError(blocker);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await meetingApi.schedule(companyId, accountId, {
        calendarId: calendar.id,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        start: local,
        timeZone: form.timeZone,
        durationMinutes: form.durationMinutes,
        attendees: attendees.map((item) => ({ email: item.email.trim(), name: item.name.trim() })),
        addMeet: form.addMeet,
        sendInvites: form.sendInvites,
        threadId,
        analysisAction: prefill
          ? { analysisId: prefill.analysisId, actionId: prefill.actionId }
          : undefined,
      });
      setScheduled(result.meeting);
    } catch (err) {
      setError(errorMessage(err, "Couldn’t schedule the meeting"));
    } finally {
      setSubmitting(false);
    }
  };

  if (scheduled) {
    return (
      <ScheduledView
        meeting={scheduled}
        onClose={onClose}
        onAddToReply={() => {
          onAddToReply(inviteConfirmationText(scheduled));
          onClose();
        }}
      />
    );
  }

  const noCalendars = calendars !== null && calendars.length === 0;

  return (
    <Modal
      open
      onClose={onClose}
      onEscape={() => attendeeInput.current?.closeMenu() ?? false}
      title="Schedule a meeting"
      description="Creates the event on Google Calendar and emails the invitation to every guest."
      size="lg"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        noCalendars ? (
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={calendars === null}>
              <CalendarPlus size={14} className="mr-1.5" />
              {form.sendInvites ? "Send invite" : "Create event"}
            </Button>
          </>
        )
      }
    >
      {noCalendars ? (
        <NoCalendar
          companySlug={companySlug}
          hint={calendarError ?? setupHint}
          onNavigate={onClose}
        />
      ) : (
        <div className="space-y-4">
          <AiBanner
            ai={ai}
            offeredTime={offeredTime}
            onUseTime={(option) => {
              const { date, time } = splitLocal(option.start);
              update("when", { date, time, timeZone: option.timeZone });
              setOfferedTime(null);
            }}
          />

          <Input
            label="Title"
            value={form.title}
            onChange={(event) => update("title", { title: event.target.value })}
            maxLength={300}
            required
          />

          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
              When
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.2fr_1fr_1fr]">
              <Input
                type="date"
                aria-label="Date"
                value={form.date}
                min={utcToZonedLocal(new Date(), form.timeZone).slice(0, 10)}
                onChange={(event) => update("when", { date: event.target.value })}
                className="col-span-2 sm:col-span-1"
              />
              <Input
                type="time"
                aria-label="Start time"
                step={300}
                value={form.time}
                onChange={(event) => update("when", { time: event.target.value })}
              />
              <Select
                aria-label="Duration"
                value={String(form.durationMinutes)}
                onChange={(event) =>
                  update("duration", { durationMinutes: Number(event.target.value) })
                }
              >
                {durationOptions(form.durationMinutes).map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {durationLabel(minutes)}
                  </option>
                ))}
              </Select>
            </div>
            <Select
              aria-label="Time zone"
              value={form.timeZone}
              onChange={(event) => update("when", { timeZone: event.target.value })}
            >
              <optgroup label="Suggested">
                {suggestedZones.map((zone) => (
                  <option key={`s-${zone}`} value={zone}>
                    {timeZoneOptionLabel(zone, instants?.start ?? new Date())}
                    {zone === viewerZone ? " · your time zone" : ""}
                  </option>
                ))}
              </optgroup>
              <optgroup label="All time zones">
                {zones
                  .filter((zone) => !suggestedZones.includes(zone))
                  .map((zone) => (
                    <option key={zone} value={zone}>
                      {zone.replace(/_/g, " ")}
                    </option>
                  ))}
              </optgroup>
            </Select>
            <SlotSummary
              instants={instants}
              timeZone={form.timeZone}
              mine={mine}
              isPast={isPast}
              conflict={conflict}
              calendarLabel={calendar?.address || calendar?.label || ""}
            />
          </fieldset>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Guests</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                You’re the organizer
              </span>
            </div>
            <RecipientInput
              ref={attendeeInput}
              label="Guests"
              inputLabel="Guests"
              recipients={form.attendees}
              text={attendeeText}
              onTextChange={setAttendeeText}
              onAdd={(incoming) =>
                update("attendees", {
                  attendees: addMailRecipients(
                    { ...emptyMailRecipients(), to: form.attendees },
                    "to",
                    incoming.filter(
                      (item) => recipientKey(item.email) !== recipientKey(selfAddress),
                    ),
                  ).to,
                })
              }
              onRemove={(email) =>
                update("attendees", {
                  attendees: form.attendees.filter(
                    (item) => recipientKey(item.email) !== recipientKey(email),
                  ),
                })
              }
              suggestions={suggestions}
              describeSuggestion={(suggestion) => detail.get(recipientKey(suggestion.email)) ?? ""}
              flags={flags}
              placeholder="Add guests by name or email"
            />
            {blocked.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm text-red-700 dark:text-red-300">
                {blocked.map((item) => (
                  <li key={item.email} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium break-all">{item.email}</span>
                    <span>{item.detail}</span>
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2"
                      onClick={() =>
                        update("attendees", {
                          attendees: form.attendees.filter(
                            (person) => recipientKey(person.email) !== recipientKey(item.email),
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300">
              <Checkbox
                label="Add a Google Meet link"
                checked={form.addMeet}
                onChange={(event) => update(null, { addMeet: event.target.checked })}
              />
              <Video size={14} className="text-slate-400" aria-hidden />
              Add a Google Meet link
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300">
              <Checkbox
                label="Email the invitation to guests"
                checked={form.sendInvites}
                onChange={(event) => update(null, { sendInvites: event.target.checked })}
              />
              <CalendarCheck size={14} className="text-slate-400" aria-hidden />
              Email the invitation to guests
            </label>
          </div>

          {calendars && calendars.length > 1 && (
            <Select
              label="Calendar"
              value={form.calendarId}
              onChange={(event) => update(null, { calendarId: event.target.value })}
            >
              {calendars.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {item.address && item.address !== item.label ? ` — ${item.address}` : ""}
                </option>
              ))}
            </Select>
          )}

          <Textarea
            label="Agenda"
            rows={3}
            value={form.description}
            placeholder="What the call is for — goes into the invitation."
            onChange={(event) => update("description", { description: event.target.value })}
            maxLength={8000}
          />

          {problem && !error && calendars !== null && (
            <p className="text-xs text-slate-500 dark:text-slate-400">{problem}</p>
          )}
          <FormError message={error} />
        </div>
      )}
    </Modal>
  );
}

/** The standard durations, plus whatever odd one the email asked for. */
function durationOptions(current: number): number[] {
  const list: number[] = [...MEETING_DURATIONS];
  if (isMeetingDuration(current) && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

function SlotSummary({
  instants,
  timeZone,
  mine,
  isPast,
  conflict,
  calendarLabel,
}: {
  instants: { start: Date; end: Date } | null;
  timeZone: string;
  mine: string | null;
  isPast: boolean;
  conflict: boolean;
  calendarLabel: string;
}) {
  if (!instants) return null;
  return (
    <div className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
      <div className="font-medium text-slate-800 dark:text-slate-100">
        {formatMeetingRange(instants.start, instants.end, timeZone)}
      </div>
      {mine && <div className="text-xs text-slate-500 dark:text-slate-400">{mine} for you</div>}
      {isPast && (
        <div className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300">
          <AlertTriangle size={12} aria-hidden /> That time has already passed.
        </div>
      )}
      {!isPast && conflict && (
        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle size={12} aria-hidden />
          {calendarLabel
            ? `${calendarLabel} already has something at this time.`
            : "Your calendar already has something at this time."}
        </div>
      )}
    </div>
  );
}

function AiBanner({
  ai,
  offeredTime,
  onUseTime,
}: {
  ai:
    | { status: "skipped" }
    | { status: "loading" }
    | { status: "done"; result: MeetingProposalResult }
    | { status: "failed"; message: string };
  offeredTime: { start: string; timeZone: string } | null;
  onUseTime: (option: { start: string; timeZone: string }) => void;
}) {
  if (ai.status === "skipped") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100">
        <Sparkles size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>Filled in from the AI read of this email. Check the time with your guests.</span>
      </div>
    );
  }
  if (ai.status === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300">
        <Spinner size={13} />
        Reading the thread for the agreed time and guests…
      </div>
    );
  }
  if (ai.status === "failed") {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The thread couldn’t be read for a time ({ai.message}). Pick one below.
      </p>
    );
  }
  const { result } = ai;
  const proposal = result.proposal;
  const describe = (option: { start: string; timeZone: string }) => {
    const slot = meetingInstants(option.start, proposal.durationMinutes, option.timeZone);
    return slot ? formatMeetingRange(slot.start, slot.end, option.timeZone) : option.start;
  };
  return (
    <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-950 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100">
      <div className="flex flex-wrap items-center gap-2">
        {result.source === "ai" ? (
          <Badge tone="ai" icon={<Sparkles />}>
            {result.employee ? `Read by ${result.employee.name}` : "AI"}
          </Badge>
        ) : (
          <Badge tone="neutral">From the thread’s headers</Badge>
        )}
        <span className="min-w-0 flex-1">
          {proposal.confidence === "agreed"
            ? "This time was agreed in the thread."
            : proposal.confidence === "proposed"
              ? "This time was suggested in the thread — check it with your guests."
              : result.source === "ai"
                ? "No time was settled in the thread, so a free slot is suggested."
                : (result.note ?? "Pick a time below.")}
        </span>
      </div>
      {proposal.evidence && (
        <blockquote className="border-l-2 border-violet-300 pl-2 text-xs italic text-violet-900 dark:border-violet-500/50 dark:text-violet-200">
          “{proposal.evidence}”
        </blockquote>
      )}
      {result.source === "ai" && result.note && (
        <p className="text-xs text-violet-900/80 dark:text-violet-200/80">{result.note}</p>
      )}
      {offeredTime && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>The thread suggests {describe(offeredTime)}.</span>
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => onUseTime(offeredTime)}
          >
            Use it
          </button>
        </div>
      )}
      {proposal.alternatives.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span>Also mentioned:</span>
          {proposal.alternatives.map((option) => (
            <button
              key={`${option.start}-${option.timeZone}`}
              type="button"
              title={option.evidence ? `“${option.evidence}”` : undefined}
              onClick={() => onUseTime(option)}
              className="rounded-md border border-violet-200 bg-white px-2 py-0.5 font-medium text-violet-800 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-slate-900 dark:text-violet-200 dark:hover:bg-violet-500/20"
            >
              {describe(option)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NoCalendar({
  companySlug,
  hint,
  onNavigate,
}: {
  companySlug: string;
  hint: string | null;
  onNavigate: () => void;
}) {
  return (
    <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <CalendarPlus size={18} aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-slate-800 dark:text-slate-100">
            No calendar to schedule on yet
          </p>
          <p>
            {hint ??
              "Connect a Google calendar under Meetings → Calendars, or reconnect this mailbox's Google account with Calendar access."}
          </p>
        </div>
      </div>
      <Link
        to={`/c/${companySlug}/meetings/calendars`}
        onClick={onNavigate}
        className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        Open Meetings → Calendars
      </Link>
    </div>
  );
}

function ScheduledView({
  meeting,
  onClose,
  onAddToReply,
}: {
  meeting: ScheduledMeeting;
  onClose: () => void;
  onAddToReply: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const when = formatMeetingRange(new Date(meeting.start), new Date(meeting.end), meeting.timeZone);
  return (
    <Modal
      open
      onClose={onClose}
      title={meeting.invitesSent ? "Invite sent" : "Event created"}
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button type="button" onClick={onAddToReply}>
            Add details to reply
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <Check size={18} aria-hidden />
          </div>
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-slate-900 dark:text-slate-100">{meeting.title}</p>
            <p className="text-slate-600 dark:text-slate-300">{when}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {meeting.invitesSent
                ? `Google emailed the invitation to ${guestCount(meeting.attendees.length)}.`
                : `On the calendar with ${guestCount(meeting.attendees.length)}; no invitation was emailed.`}{" "}
              Times show in each guest’s own zone ({timeZoneCity(meeting.timeZone)} for this one).
            </p>
          </div>
        </div>
        {meeting.meetLink && (
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <Video size={14} className="shrink-0 text-slate-400" aria-hidden />
            <a
              href={meeting.meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {meeting.meetLink.replace(/^https?:\/\//, "")}
            </a>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(meeting.meetLink ?? "").then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
              className="touch-target relative flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        {!meeting.meetLink && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No Meet link was added. Google may still be creating it — open the event to check.
          </p>
        )}
        {meeting.htmlLink && (
          <a
            href={meeting.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Open in Google Calendar <ExternalLink size={12} aria-hidden />
          </a>
        )}
      </div>
    </Modal>
  );
}

function guestCount(count: number): string {
  return count === 1 ? "1 guest" : `${count} guests`;
}
