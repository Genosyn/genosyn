import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
  Building2,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  Link2,
  ListChecks,
  Mic,
  RefreshCw,
  Square,
  Upload,
  UserPlus,
  Users,
  Video,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { ButtonSpinner, Spinner } from "../components/ui/Spinner";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { useDialog } from "../components/ui/Dialog";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { useLiveRefetch } from "../components/CompanySocket";
import { RecordHistory } from "../components/RecordHistory";
import { Panel, ProviderChip, StatusChip } from "../components/meetings/MeetingChips";
import { api, type Company, type Customer } from "../lib/api";
import { ACCOUNT_STATUS_LABEL } from "../lib/customerLabel";
import { errorMessage } from "../lib/errors";
import {
  formatDuration,
  formatOffset,
  meetingsApi,
  parseEmailList,
  type Meeting,
  type MeetingCustomer,
  type MeetingDetail as MeetingDetailPayload,
} from "../lib/meetings";
import { effectiveFinanceAccess } from "../lib/subpages";
import type { MeetingsOutletCtx } from "./MeetingsLayout";

/**
 * One meeting: who was there, what the AI made of it, what got promised, and
 * the transcript underneath.
 *
 * Ordered by what a human actually wants at each moment — the summary first
 * because it answers "what happened", the action items next because they are
 * what someone has to do, attendees beside them because "who said that" is the
 * follow-up question, and the transcript last because it is the evidence you
 * open only when the summary is not enough. Which Customer the meeting is with
 * sits in the header as well as its own card, so it is one press away on a
 * phone, where the side column comes after the transcript.
 */
export default function MeetingDetail() {
  const { company } = useOutletContext<MeetingsOutletCtx>();
  const { meetingId } = useParams<{ meetingId: string }>();
  const dialog = useDialog();

  const [data, setData] = React.useState<MeetingDetailPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<null | "upload" | "rerun" | "relink">(null);
  const [startingNotetaker, setStartingNotetaker] = React.useState(false);
  const [stoppingNotetaker, setStoppingNotetaker] = React.useState(false);
  const [pasting, setPasting] = React.useState(false);
  const [addingAttendees, setAddingAttendees] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const reload = React.useCallback(() => {
    if (!meetingId) return;
    setError(null);
    meetingsApi
      .meeting(company.id, meetingId)
      .then(setData)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [company.id, meetingId]);

  React.useEffect(() => {
    setData(null);
    reload();
  }, [reload]);

  const liveMeetingStatus = data?.meeting.status;
  React.useEffect(() => {
    if (
      liveMeetingStatus !== "joining" &&
      liveMeetingStatus !== "recording" &&
      liveMeetingStatus !== "processing"
    ) {
      setStoppingNotetaker(false);
      return;
    }
    // Recorder lifecycle writes are intentionally conditional database
    // updates, which do not always carry enough entity data for the shared
    // resource-change socket. Poll only while work is live so Joining, Stop,
    // transcription, and write-up transitions still settle without a refresh.
    const timer = window.setInterval(reload, 3_000);
    return () => window.clearInterval(timer);
  }, [liveMeetingStatus, reload]);

  useLiveRefetch("meeting", reload, meetingId ?? null);

  const base = `/c/${company.slug}/meetings`;

  const upload = async (file: File) => {
    if (!meetingId) return;
    setBusy("upload");
    setNotice(null);
    try {
      await meetingsApi.uploadRecording(company.id, meetingId, file);
      reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t upload the recording" });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const rerun = async () => {
    if (!meetingId) return;
    setBusy("rerun");
    setNotice(null);
    try {
      await meetingsApi.process(company.id, meetingId);
      reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t re-run the write-up" });
    } finally {
      setBusy(null);
    }
  };

  const relink = async () => {
    if (!meetingId) return;
    setBusy("relink");
    setNotice(null);
    try {
      const { result } = await meetingsApi.link(company.id, meetingId);
      // A match rewrites the attendee list in place; a miss leaves the page
      // exactly as it was, so that is the one outcome worth saying out loud.
      if (result.matched === 0 && !result.customerId) {
        setNotice("No attendee matched an existing Contact or Customer.");
      }
      reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t re-link the attendees" });
    } finally {
      setBusy(null);
    }
  };

  const startNotetaker = async () => {
    if (!meetingId) return;
    setStartingNotetaker(true);
    setNotice(null);
    setData((current) =>
      current
        ? {
            ...current,
            meeting: { ...current.meeting, status: "joining", statusMessage: "" },
          }
        : current,
    );
    try {
      await meetingsApi.startNotetaker(company.id, meetingId);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start the notetaker" });
    } finally {
      setStartingNotetaker(false);
      reload();
    }
  };

  const stopNotetaker = async () => {
    if (!meetingId) return;
    setStoppingNotetaker(true);
    setNotice(null);
    try {
      await meetingsApi.stopNotetaker(company.id, meetingId);
      reload();
    } catch (err) {
      setStoppingNotetaker(false);
      void dialog.error(err, { title: "Couldn’t stop the notetaker" });
      reload();
    }
  };

  if (error) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <Panel
          title="Could not load this meeting"
          body={error}
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const { meeting, customer, customerWithheld, participants, transcript } = data;
  const when = meeting.scheduledStartAt ?? meeting.startedAt ?? meeting.createdAt;
  const knownContacts = participants.filter((row) => row.contactId);
  // `skipped` belongs here with `scheduled` and `failed`: the automatic pass
  // declining a call at T-30s says nothing about whether a person, having read
  // the reason and fixed it, may record the same call at T+5 while it is still
  // running. The server makes the same allowance for an explicit human retry.
  const canStartNotetaker =
    meeting.conferenceProvider === "meet" &&
    Boolean(meeting.conferenceUrl) &&
    !meeting.hasRecording &&
    (meeting.status === "scheduled" ||
      meeting.status === "failed" ||
      meeting.status === "skipped" ||
      startingNotetaker);
  const canStopNotetaker = meeting.status === "joining" || meeting.status === "recording";

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Meetings", to: base },
            { label: "Recorded", to: `${base}/recorded` },
            { label: meeting.title || "Meeting" },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600 ring-1 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20">
            <Video size={20} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">
                {meeting.title || "Untitled meeting"}
              </h1>
              <StatusChip status={meeting.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              <span className="tabular-nums">
                {new Date(when).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {meeting.durationMs > 0 && (
                <span className="tabular-nums">{formatDuration(meeting.durationMs)}</span>
              )}
              <ProviderChip provider={meeting.conferenceProvider} />
              {customer && (
                <Link
                  to={`/c/${company.slug}/customers/${customer.slug}`}
                  className="inline-flex min-w-0 items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <Building2 size={14} className="shrink-0" />
                  <span className="truncate">{customer.name}</span>
                </Link>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canStartNotetaker && (
            <Button
              size="sm"
              loading={startingNotetaker}
              disabled={busy !== null}
              onClick={startNotetaker}
            >
              <Mic size={14} />
              {startingNotetaker ? "Joining…" : "Start notetaker"}
            </Button>
          )}
          {canStopNotetaker && (
            <Button size="sm" variant="danger" loading={stoppingNotetaker} onClick={stopNotetaker}>
              <Square size={14} />
              {stoppingNotetaker ? "Stopping…" : "Stop notetaker"}
            </Button>
          )}
          {meeting.conferenceUrl && (
            <a href={meeting.conferenceUrl} target="_blank" rel="noreferrer noopener">
              <Button variant="secondary" size="sm">
                <ExternalLink size={14} /> Join
              </Button>
            </a>
          )}
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="audio/*,video/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={busy === "upload"}
            disabled={busy !== null}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={14} /> Recording
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => setPasting(true)}
          >
            <FileText size={14} /> Transcript
          </Button>
          {meeting.transcriptState === "ready" && (
            <>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === "relink"}
                disabled={busy !== null}
                onClick={relink}
              >
                <Link2 size={14} /> Re-link
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === "rerun"}
                disabled={busy !== null}
                onClick={rerun}
              >
                <RefreshCw size={14} /> Re-run
              </Button>
            </>
          )}
        </div>
      </div>

      <FormSuccess message={notice} className="mb-4" />
      {meeting.statusMessage && meeting.status === "failed" && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {meeting.statusMessage}
        </div>
      )}
      {/* A skip is a decision the notetaker made and wrote down, and until now
          it wrote it down where nobody could read it: `statusMessage` was
          rendered for `failed` alone. "The assigned AI Employee does not have
          Record access to this calendar" is the difference between a fixable
          setup mistake and a product that mysteriously never turns up. The
          same goes for a deferral parked back on `scheduled`. */}
      {meeting.statusMessage && (meeting.status === "skipped" || meeting.status === "scheduled") && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {meeting.status === "skipped" ? "The notetaker did not join. " : ""}
          {meeting.statusMessage}
        </div>
      )}
      {meeting.status === "joining" && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
          <Spinner size={14} /> The notetaker is joining Google Meet as a guest. The host may need
          to admit it.
        </div>
      )}
      {meeting.transcriptError && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Transcription: {meeting.transcriptError}
        </div>
      )}
      {(meeting.transcriptState === "queued" || meeting.transcriptState === "running") && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
          <Spinner size={14} /> Transcribing this recording. This page updates when it finishes.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <header className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Summary</h2>
            </header>
            <div className="px-4 py-4">
              {meeting.summaryText ? (
                <div className="doc-md whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
                  {meeting.summaryText}
                </div>
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  No summary yet. It is written by the assigned AI Employee once a transcript
                  exists.
                </p>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Mic size={14} /> Transcript
              </h2>
              {meeting.hasRecording && (
                <a
                  href={meetingsApi.recordingUrl(company.id, meeting.id)}
                  className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Download audio
                </a>
              )}
            </header>
            {transcript.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                No transcript yet. Upload a recording, or paste one you already have.
              </div>
            ) : (
              <div className="max-h-[32rem] divide-y divide-slate-50 overflow-y-auto dark:divide-slate-800/60">
                {transcript.map((segment) => (
                  <div key={segment.id} className="flex gap-3 px-4 py-2">
                    {(segment.startMs > 0 || segment.speaker) && (
                      <div className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                        {segment.startMs > 0 ? formatOffset(segment.startMs) : ""}
                      </div>
                    )}
                    <div className="min-w-0 flex-1 text-sm">
                      {segment.speaker && (
                        <span className="mr-2 font-medium text-slate-900 dark:text-slate-100">
                          {segment.speaker}
                        </span>
                      )}
                      <span className="text-slate-700 dark:text-slate-300">{segment.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <MeetingCustomerCard
            company={company}
            meeting={meeting}
            customer={customer}
            withheld={customerWithheld}
            onChanged={reload}
          />

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <header className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <ListChecks size={14} /> Action items
              </h2>
            </header>
            {meeting.actionItems.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
                Nothing was committed to on this call, or it has not been written up yet.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {meeting.actionItems.map((item, index) => (
                  <li key={`${item.title}-${index}`} className="flex gap-2 px-4 py-3">
                    <CheckCircle2
                      size={14}
                      className="mt-0.5 shrink-0 text-emerald-500 dark:text-emerald-400"
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-slate-800 dark:text-slate-200">{item.title}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-slate-500 dark:text-slate-400">
                        {item.owner && <span>{item.owner}</span>}
                        {item.dueAt && (
                          <span className="tabular-nums">
                            due {new Date(item.dueAt).toLocaleDateString()}
                          </span>
                        )}
                        {!item.activityId && <span className="italic">not filed</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Users size={14} /> Attendees
              </h2>
              <Button variant="ghost" size="sm" onClick={() => setAddingAttendees(true)}>
                <UserPlus size={14} /> Add
              </Button>
            </header>
            {participants.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
                Nobody recorded on this meeting. Add who was on the call and Genosyn links it to
                their Customer, and puts it on their timeline if they are already a Contact.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {participants.map((row) => (
                  <li key={row.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm text-slate-800 dark:text-slate-200">
                        {row.displayName || row.email}
                      </span>
                      {row.isOrganizer && (
                        <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                          organizer
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="truncate">{row.email}</span>
                      {row.contactId ? (
                        <Link
                          to={`/c/${company.slug}/revenue/contacts/${row.contactId}`}
                          className="shrink-0 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          Contact
                        </Link>
                      ) : (
                        !row.isInternal && <span className="shrink-0 italic">not a Contact</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {knownContacts.length > 0 && (
              <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                On {knownContacts.length} Contact timeline
                {knownContacts.length === 1 ? "" : "s"}.
              </div>
            )}
          </section>

          <RecordHistory
            companyId={company.id}
            companySlug={company.slug}
            targetType="meeting"
            targetId={meeting.id}
            noun="this meeting"
            milestones={[{ label: "Meeting added", at: meeting.createdAt, covers: ["create"] }]}
          />
        </div>
      </div>

      <AddAttendeesModal
        open={addingAttendees}
        companyId={company.id}
        meetingId={meeting.id}
        onClose={() => setAddingAttendees(false)}
        onSaved={reload}
      />

      <PasteTranscriptModal
        open={pasting}
        companyId={company.id}
        meetingId={meeting.id}
        onClose={() => setPasting(false)}
        onSaved={reload}
      />
    </div>
  );
}

/**
 * Which Customer this meeting is with, and the way to it. A link grants nothing,
 * so a Member whose Finance access doesn't reach Customers is told one exists and
 * not which, and isn't offered a picker that could only answer 403.
 */
export function MeetingCustomerCard({
  company,
  meeting,
  customer,
  withheld,
  onChanged,
}: {
  company: Company;
  meeting: Meeting;
  customer: MeetingCustomer | null;
  withheld: boolean;
  onChanged: () => void;
}) {
  const [picking, setPicking] = React.useState(false);
  const canChoose = effectiveFinanceAccess(company) !== "none";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Building2 size={14} /> Customer
        </h2>
        {canChoose && (
          <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
            {customer ? "Change" : "Link"}
          </Button>
        )}
      </header>
      <div className="px-4 py-3">
        {customer ? (
          <>
            <Link
              to={`/c/${company.slug}/customers/${customer.slug}`}
              className="text-sm font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
            >
              {customer.name}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Badge>{ACCOUNT_STATUS_LABEL[customer.accountStatus]}</Badge>
              {customer.archived && <Badge tone="warning">Archived</Badge>}
              {customer.domain && <span className="min-w-0 truncate">{customer.domain}</span>}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {meeting.customerChosen ? "Chosen by a Member." : "Linked from the attendees."}
            </p>
          </>
        ) : withheld ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This meeting is linked to a customer. Your finance access doesn&apos;t include
            Customers.
          </p>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {meeting.customerChosen
              ? "A Member removed the link, so Genosyn leaves this meeting alone."
              : "Nobody on this meeting is from outside the company yet. Add them as attendees and Genosyn links their Customer, creating it if you don’t have one."}
          </p>
        )}
      </div>
      {canChoose && (
        <LinkCustomerModal
          open={picking}
          companyId={company.id}
          meetingId={meeting.id}
          currentId={customer?.id ?? null}
          onClose={() => setPicking(false)}
          onSaved={onChanged}
        />
      )}
    </section>
  );
}

/**
 * Choose this meeting's customer by hand, or remove the link. Either is final:
 * Genosyn stops working it out from the attendees, so the choice sticks.
 */
function LinkCustomerModal({
  open,
  companyId,
  meetingId,
  currentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  companyId: string;
  meetingId: string;
  currentId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Customer[] | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setError(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const q = query.trim();
    const timer = window.setTimeout(() => {
      api
        .get<{ customers: Customer[] }>(
          `/api/companies/${companyId}/customers?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`,
        )
        .then((page) => {
          if (cancelled) return;
          setResults(page.customers);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setResults([]);
          setError(errorMessage(err));
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, companyId]);

  const choose = async (customerId: string | null) => {
    setSaving(customerId ?? "none");
    setError(null);
    try {
      await meetingsApi.setCustomer(companyId, meetingId, customerId);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link a customer"
      description="Your choice sticks: Genosyn stops working this meeting's customer out from its attendees."
      footer={
        <>
          {currentId && (
            <Button
              variant="secondary"
              type="button"
              loading={saving === "none"}
              disabled={saving !== null}
              onClick={() => void choose(null)}
            >
              Remove link
            </Button>
          )}
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="Search customers"
          value={query}
          autoFocus
          placeholder="Name or domain"
          onChange={(e) => setQuery(e.target.value)}
        />
        <FormError message={error} />
        {results === null ? (
          <div className="flex justify-center p-6">
            <Spinner size={18} />
          </div>
        ) : results.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
            No customers match that.
          </p>
        ) : (
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {results.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  disabled={saving !== null}
                  onClick={() => void choose(row.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 disabled:opacity-60 dark:hover:bg-slate-800/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-900 dark:text-slate-100">
                      {row.name}
                    </span>
                    {row.domain && (
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        {row.domain}
                      </span>
                    )}
                  </span>
                  {saving === row.id ? (
                    <ButtonSpinner />
                  ) : (
                    row.id === currentId && (
                      <Check size={14} className="shrink-0 text-indigo-600 dark:text-indigo-400" />
                    )
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function PasteTranscriptModal({
  open,
  companyId,
  meetingId,
  onClose,
  onSaved,
}: {
  open: boolean;
  companyId: string;
  meetingId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await meetingsApi.pasteTranscript(companyId, meetingId, text);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Paste a transcript" size="lg">
      <div className="space-y-4">
        <Textarea
          value={text}
          rows={14}
          autoFocus
          placeholder={
            "Priya: Thanks for making the time.\nSam: Of course — where did we land on pricing?"
          }
          hint={
            "Lines shaped “Speaker: words” keep their speaker. Anything else becomes an unattributed line."
          }
          onChange={(e) => setText(e.target.value)}
        />
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={saving} disabled={!text.trim()}>
            {saving ? "Saving…" : "Save transcript"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Add people to a meeting after the fact.
 *
 * The path that makes an uploaded recording as useful as a synced one: a call
 * with no attendees can never reach a customer's timeline, however good its
 * transcript is. Saving re-runs the linker, so a Contact match takes effect
 * immediately rather than at the next pass, and the meeting finds its Customer.
 */
function AddAttendeesModal({
  open,
  companyId,
  meetingId,
  onClose,
  onSaved,
}: {
  open: boolean;
  companyId: string;
  meetingId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
      setNotice(null);
    }
  }, [open]);

  const emails = parseEmailList(value);

  const submit = async () => {
    if (emails.length === 0) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await meetingsApi.addAttendees(companyId, meetingId, emails);
      onSaved();
      if (result.added === 0) {
        // Nobody new, so the attendee list behind this modal looks identical.
        // Stay open and say why rather than closing onto an unchanged page.
        setNotice("Everyone on that list was already here.");
        return;
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add attendees">
      <div className="space-y-4">
        <Input
          label="Email addresses"
          value={value}
          autoFocus
          placeholder="sam@northwind.test, priya@acme.test"
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Separate with commas, semicolons, or new lines. People from outside the company link this
          meeting to their Customer, which Genosyn creates if you don&apos;t have one yet. Anyone
          who is already a Contact gets this call on their timeline; Genosyn never creates a Contact
          on its own.
        </p>
        <FormError message={error} />
        <FormSuccess message={notice} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={saving} disabled={emails.length === 0}>
            {saving ? "Adding…" : `Add ${emails.length || ""}`.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
