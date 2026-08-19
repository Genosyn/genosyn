import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  Link2,
  ListChecks,
  Mic,
  RefreshCw,
  Upload,
  UserPlus,
  Users,
  Video,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { Panel, ProviderChip, StatusChip } from "../components/meetings/MeetingChips";
import {
  formatDuration,
  formatOffset,
  meetingsApi,
  parseEmailList,
  type MeetingDetail as MeetingDetailPayload,
} from "../lib/meetings";
import type { MeetingsOutletCtx } from "./MeetingsLayout";

/**
 * One meeting: who was there, what the AI made of it, what got promised, and
 * the transcript underneath.
 *
 * Ordered by what a human actually wants at each moment — the summary first
 * because it answers "what happened", the action items next because they are
 * what someone has to do, attendees beside them because "who said that" is the
 * follow-up question, and the transcript last because it is the evidence you
 * open only when the summary is not enough.
 */
export default function MeetingDetail() {
  const { company } = useOutletContext<MeetingsOutletCtx>();
  const { meetingId } = useParams<{ meetingId: string }>();
  const { toast } = useToast();

  const [data, setData] = React.useState<MeetingDetailPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pasting, setPasting] = React.useState(false);
  const [addingAttendees, setAddingAttendees] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const reload = React.useCallback(() => {
    if (!meetingId) return;
    setError(null);
    meetingsApi
      .meeting(company.id, meetingId)
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, [company.id, meetingId]);

  React.useEffect(() => {
    setData(null);
    reload();
  }, [reload]);

  useLiveRefetch("meeting", reload, meetingId ?? null);

  const base = `/c/${company.slug}/meetings`;

  const upload = async (file: File) => {
    if (!meetingId) return;
    setBusy(true);
    try {
      await meetingsApi.uploadRecording(company.id, meetingId, file);
      toast("Recording uploaded — transcribing now.", "success");
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const rerun = async () => {
    if (!meetingId) return;
    setBusy(true);
    try {
      await meetingsApi.process(company.id, meetingId);
      toast("Reprocessed.", "success");
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const relink = async () => {
    if (!meetingId) return;
    setBusy(true);
    try {
      const { result } = await meetingsApi.link(company.id, meetingId);
      toast(
        result.matched > 0
          ? `Linked to ${result.matched} contact${result.matched === 1 ? "" : "s"}.`
          : "No attendee matched an existing Contact.",
        result.matched > 0 ? "success" : "info",
      );
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
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

  const { meeting, participants, transcript } = data;
  const when = meeting.scheduledStartAt ?? meeting.startedAt ?? meeting.createdAt;
  const knownContacts = participants.filter((row) => row.contactId);

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
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
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
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={14} /> Recording
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setPasting(true)}>
            <FileText size={14} /> Transcript
          </Button>
          {meeting.transcriptState === "ready" && (
            <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={relink}>
                <Link2 size={14} /> Re-link
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={rerun}>
                <RefreshCw size={14} className={busy ? "animate-spin" : undefined} /> Re-run
              </Button>
            </>
          )}
        </div>
      </div>

      {meeting.statusMessage && meeting.status === "failed" && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {meeting.statusMessage}
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
                Nobody recorded on this meeting. Add who was on the call and Genosyn puts it on
                their timeline if they are already a Contact.
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
                        !row.isInternal && (
                          <span className="shrink-0 italic">not a Contact</span>
                        )
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
  const { toast } = useToast();
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) setText("");
  }, [open]);

  const submit = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await meetingsApi.pasteTranscript(companyId, meetingId, text);
      toast("Transcript saved — writing it up now.", "success");
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
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
          placeholder={"Priya: Thanks for making the time.\nSam: Of course — where did we land on pricing?"}
          hint={"Lines shaped “Speaker: words” keep their speaker. Anything else becomes an unattributed line."}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || !text.trim()}>
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
 * immediately rather than at the next pass.
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
  const { toast } = useToast();
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) setValue("");
  }, [open]);

  const emails = parseEmailList(value);

  const submit = async () => {
    if (emails.length === 0) return;
    setSaving(true);
    try {
      const result = await meetingsApi.addAttendees(companyId, meetingId, emails);
      toast(
        result.added > 0
          ? `Added ${result.added} attendee${result.added === 1 ? "" : "s"}.`
          : "Everyone on that list was already here.",
        result.added > 0 ? "success" : "info",
      );
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
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
          Separate with commas, semicolons, or new lines. Anyone who is already a Contact gets this
          call on their timeline; anyone who is not is simply recorded as having been here — Genosyn
          never creates a Contact on its own.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || emails.length === 0}>
            {saving ? "Adding…" : `Add ${emails.length || ""}`.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
