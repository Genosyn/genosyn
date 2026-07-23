import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Bot,
  Clock,
  Mail,
  Plus,
  Save,
  Trash2,
  Zap,
} from "lucide-react";
import { api, Employee } from "../lib/api";
import { mailApi, MailAccount } from "../lib/mail";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { useDialog } from "../components/ui/Dialog";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";
import {
  ENROLLMENT_STATUS_LABEL,
  ENROLLMENT_STATUS_PILL,
  HydratedSequence,
  PILL_BASE,
  SEQUENCE_STATUSES,
  SEQUENCE_STATUS_LABEL,
  SEQUENCE_STATUS_PILL,
  SendWindow,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  SequenceStatus,
  parseSendWindow,
} from "./RevenueSequences";

/**
 * Revenue → Sequence detail. Three things live here: the settings, the step
 * ladder, and who is currently moving through it.
 *
 * `autoSend` is deliberately *not* part of the settings form. It is the one
 * switch that spends the company's sending reputation with nobody watching, so
 * it sits in its own panel, carries its own warning, and is confirmed on the
 * way on (never on the way off — making it harder to turn a dangerous thing off
 * is exactly backwards).
 */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Terminal enrolments never send again, so there is nothing left to stop. */
const TERMINAL_ENROLLMENT_STATUSES = [
  "completed",
  "stopped_replied",
  "stopped_bounced",
  "stopped_unsubscribed",
  "stopped_manual",
  "failed",
];

/**
 * A short list of zones rather than the full IANA set: `Intl.supportedValuesOf`
 * is not available everywhere we run, and the browser's own zone plus whatever
 * the sequence already stores are merged in below so nothing is ever unreachable.
 */
const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Warsaw",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

type SettingsForm = {
  name: string;
  status: SequenceStatus;
  mailAccountId: string;
  employeeId: string;
  brief: string;
  stopOnReply: boolean;
  dailyCap: number;
  sendWindow: SendWindow;
};

type StepDraft = {
  key: string;
  name: string;
  delayDays: number;
  delayHours: number;
  instruction: string;
  threadWithPrevious: boolean;
};

let stepKeySeq = 0;
function nextStepKey(): string {
  stepKeySeq += 1;
  return `step-${stepKeySeq}`;
}

function toForm(sequence: HydratedSequence): SettingsForm {
  return {
    name: sequence.name,
    status: sequence.status,
    mailAccountId: sequence.mailAccountId,
    employeeId: sequence.employeeId,
    brief: sequence.brief,
    stopOnReply: sequence.stopOnReply,
    dailyCap: sequence.dailyCap,
    sendWindow: parseSendWindow(sequence.sendWindowJson),
  };
}

function toDrafts(steps: SequenceStep[]): StepDraft[] {
  return steps.map((s) => ({
    key: nextStepKey(),
    name: s.name,
    delayDays: s.delayDays,
    delayHours: s.delayHours,
    instruction: s.instruction,
    threadWithPrevious: s.threadWithPrevious,
  }));
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export default function RevenueSequenceDetail() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { id } = useParams();
  const { background } = useToast();
  const dialog = useDialog();

  const [sequence, setSequence] = React.useState<HydratedSequence | null>(null);
  const [enrollments, setEnrollments] = React.useState<SequenceEnrollment[] | null>(null);
  const [form, setForm] = React.useState<SettingsForm | null>(null);
  const [drafts, setDrafts] = React.useState<StepDraft[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [savingSettings, setSavingSettings] = React.useState(false);
  const [savingSteps, setSavingSteps] = React.useState(false);

  // Live refetches must not throw away half-typed edits. Refs (not state) so
  // `reload` stays referentially stable and the socket subscription never churns.
  const formDirty = React.useRef(false);
  const stepsDirty = React.useRef(false);

  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;

  const reload = React.useCallback(async () => {
    const [detail, enrolled] = await Promise.all([
      api.get<{ sequence: HydratedSequence; steps: SequenceStep[] }>(`${base}/sequences/${id}`),
      api.get<{ rows: SequenceEnrollment[]; total: number }>(
        `${base}/sequences/${id}/enrollments?limit=100`,
      ),
    ]);
    setSequence(detail.sequence);
    setEnrollments(enrolled.rows);
    if (!formDirty.current) setForm(toForm(detail.sequence));
    if (!stepsDirty.current) setDrafts(toDrafts(detail.steps));
    setLoadError(null);
  }, [base, id]);

  React.useEffect(() => {
    reload().catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : String(err));
    });
  }, [reload]);

  React.useEffect(() => {
    let live = true;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((rows) => {
        if (live) setEmployees(rows);
      })
      .catch(() => undefined);
    mailApi
      .accounts(company.id)
      .then((res) => {
        if (live) setAccounts(res.accounts);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [company.id]);

  useLiveRefetch(["sequence", "enrollment"], reload);

  function patchForm(patch: Partial<SettingsForm>) {
    formDirty.current = true;
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  function patchWindow(patch: Partial<SendWindow>) {
    formDirty.current = true;
    setForm((current) =>
      current ? { ...current, sendWindow: { ...current.sendWindow, ...patch } } : current,
    );
  }

  function patchDrafts(next: StepDraft[]) {
    stepsDirty.current = true;
    setDrafts(next);
  }

  function saveSettings() {
    if (!form || !sequence) return;
    const previous = sequence;
    const body = {
      name: form.name.trim(),
      status: form.status,
      mailAccountId: form.mailAccountId,
      employeeId: form.employeeId,
      brief: form.brief,
      stopOnReply: form.stopOnReply,
      dailyCap: form.dailyCap,
      sendWindow: form.sendWindow,
    };
    setSavingSettings(true);
    setSequence({
      ...sequence,
      ...body,
      sendWindowJson: JSON.stringify(form.sendWindow),
    });
    background(() => api.patch<Sequence>(`${base}/sequences/${sequence.id}`, body), {
      loading: "Saving sequence…",
      success: "Sequence saved",
      error: (error) =>
        `Couldn’t save the sequence: ${
          error instanceof Error ? error.message : String(error)
        }. Your changes were kept in the form.`,
      onSuccess: () => {
        formDirty.current = false;
        setSavingSettings(false);
        void reload();
      },
      onError: () => {
        setSequence(previous);
        setSavingSettings(false);
      },
    });
  }

  async function toggleAutoSend(next: boolean) {
    if (!sequence) return;
    if (next) {
      const confirmed = await dialog.confirm({
        title: "Turn auto-send on?",
        message: (
          <>
            Every touch this sequence drafts will be sent with{" "}
            <strong>no human pressing Send</strong>. It also needs two grants to actually go out:
            the AI employee&apos;s revenue grant at <code>send</code>, and the mailbox grant at{" "}
            <code>send</code>. Suppression, the send window and the daily cap still apply.
          </>
        ),
        variant: "danger",
        confirmLabel: "Turn auto-send on",
      });
      if (!confirmed) return;
    }
    const previous = sequence;
    setSequence({ ...sequence, autoSend: next });
    background(
      () => api.patch<Sequence>(`${base}/sequences/${sequence.id}`, { autoSend: next }),
      {
        loading: next ? "Turning auto-send on…" : "Turning auto-send off…",
        success: next ? "Auto-send is on" : "Auto-send is off",
        error: (error) =>
          `Couldn’t change auto-send: ${
            error instanceof Error ? error.message : String(error)
          }. The switch was put back.`,
        onSuccess: () => void reload(),
        onError: () => setSequence(previous),
      },
    );
  }

  function saveSteps() {
    if (!drafts || !sequence) return;
    setSavingSteps(true);
    background(
      () =>
        api.put<SequenceStep[]>(`${base}/sequences/${sequence.id}/steps`, {
          steps: drafts.map((d) => ({
            name: d.name,
            delayDays: d.delayDays,
            delayHours: d.delayHours,
            instruction: d.instruction,
            threadWithPrevious: d.threadWithPrevious,
          })),
        }),
      {
        loading: "Saving steps…",
        success: "Step ladder saved",
        error: (error) =>
          `Couldn’t save the steps: ${
            error instanceof Error ? error.message : String(error)
          }. Your ladder was kept in the editor.`,
        onSuccess: () => {
          stepsDirty.current = false;
          setSavingSteps(false);
          void reload();
        },
        onError: () => setSavingSteps(false),
      },
    );
  }

  async function stopEnrollment(row: SequenceEnrollment) {
    const who = row.contact?.name ?? row.contact?.email ?? "this contact";
    const confirmed = await dialog.confirm({
      title: `Stop the sequence for ${who}?`,
      message:
        "No further touches will be drafted or sent for them. Re-enrolling later starts the ladder again from the top.",
      variant: "danger",
      confirmLabel: "Stop sending",
    });
    if (!confirmed) return;
    const previous = enrollments;
    setEnrollments(
      (current) =>
        current?.map((item) =>
          item.id === row.id
            ? { ...item, status: "stopped_manual" as const, nextRunAt: null }
            : item,
        ) ?? current,
    );
    background(() => api.post(`${base}/enrollments/${row.id}/stop`, {}), {
      loading: "Stopping…",
      success: "Enrolment stopped",
      error: (error) =>
        `Couldn’t stop the enrolment: ${
          error instanceof Error ? error.message : String(error)
        }. It is still running.`,
      onSuccess: () => void reload(),
      onError: () => setEnrollments(previous),
    });
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <div className="mb-6">
          <Breadcrumbs
            items={[
              { label: "Revenue", to: sectionUrl },
              { label: "Sequences", to: `${sectionUrl}/sequences` },
              { label: "Sequence" },
            ]}
          />
        </div>
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load this sequence
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{loadError}</p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() =>
              reload().catch((err: unknown) =>
                setLoadError(err instanceof Error ? err.message : String(err)),
              )
            }
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!sequence || !form || !drafts) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  const timezones = [
    ...new Set([
      ...COMMON_TIMEZONES,
      form.sendWindow.timezone,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ]),
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Revenue", to: sectionUrl },
            { label: "Sequences", to: `${sectionUrl}/sequences` },
            { label: sequence.name },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {sequence.name}
            <span className={PILL_BASE + " " + SEQUENCE_STATUS_PILL[sequence.status]}>
              {SEQUENCE_STATUS_LABEL[sequence.status]}
            </span>
            {sequence.autoSend && (
              <span
                className={
                  PILL_BASE + " bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                }
              >
                <Zap size={10} /> Auto-send
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {sequence.stepCount} step{sequence.stepCount === 1 ? "" : "s"} ·{" "}
            {sequence.totalEnrolled} enrolled · {sequence.activeCount} active
          </p>
        </div>
      </div>

      {/* ── Settings ───────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <header className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Settings</h2>
        </header>
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Name"
              value={form.name}
              maxLength={120}
              onChange={(e) => patchForm({ name: e.target.value })}
            />
            <Select
              label="Status"
              value={form.status}
              onChange={(e) => patchForm({ status: e.target.value as SequenceStatus })}
            >
              {SEQUENCE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SEQUENCE_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
            <Select
              label="Send from"
              value={form.mailAccountId}
              onChange={(e) => patchForm({ mailAccountId: e.target.value })}
            >
              {accounts.length === 0 && <option value={form.mailAccountId}>Loading…</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.address}
                </option>
              ))}
            </Select>
            <Select
              label="Written by"
              value={form.employeeId}
              onChange={(e) => patchForm({ employeeId: e.target.value })}
            >
              {employees.length === 0 && <option value={form.employeeId}>Loading…</option>}
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.role}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Textarea
              label="Brief"
              value={form.brief}
              maxLength={20000}
              onChange={(e) => patchForm({ brief: e.target.value })}
              placeholder="Who this is for, what we sell, what good looks like, what never to say. Markdown."
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Handed to the employee on every step. Markdown — the highest-leverage field here.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <Checkbox
                label="Stop on reply"
                checked={form.stopOnReply}
                onChange={(e) => patchForm({ stopOnReply: e.target.checked })}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  Stop on reply
                </div>
                <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  End the enrolment the moment they answer. Turning this off is almost always
                  wrong.
                </p>
              </div>
            </div>
            <div>
              <Input
                label="Daily cap"
                type="number"
                min={0}
                max={10000}
                value={form.dailyCap}
                onChange={(e) => patchForm({ dailyCap: Number(e.target.value) || 0 })}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Most touches this sequence may send in a day. 0 means no sequence-level cap.
              </p>
            </div>
          </div>

          {/* Send window */}
          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
              <Clock size={14} className="text-slate-400 dark:text-slate-500" /> Send window
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              When touches may go out, in the timezone below. No days selected means the sequence
              never sends, which is a legitimate way to freeze it without pausing.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {DAY_LABELS.map((label, day) => {
                const on = form.sendWindow.days.includes(day);
                return (
                  <label
                    key={label}
                    className={
                      "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors " +
                      (on
                        ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800")
                    }
                  >
                    <Checkbox
                      label={label}
                      checked={on}
                      onChange={(e) => {
                        const days = e.target.checked
                          ? [...form.sendWindow.days, day].sort((a, b) => a - b)
                          : form.sendWindow.days.filter((d) => d !== day);
                        patchWindow({ days });
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Select
                label="From"
                value={String(form.sendWindow.startHour)}
                onChange={(e) => patchWindow({ startHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
              <Select
                label="To"
                value={String(form.sendWindow.endHour)}
                onChange={(e) => patchWindow({ endHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
              <Select
                label="Timezone"
                value={form.sendWindow.timezone}
                onChange={(e) => patchWindow({ timezone: e.target.value })}
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </div>
            {form.sendWindow.startHour === form.sendWindow.endHour && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Start and end are the same hour, which is treated as never sending — not as
                sending around the clock.
              </p>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={saveSettings} disabled={savingSettings || !form.name.trim()}>
              {savingSettings ? <Spinner size={14} /> : <Save size={14} />}
              Save settings
            </Button>
          </div>
        </div>
      </section>

      {/* ── Auto-send ──────────────────────────────────────────────────── */}
      <section
        className={
          "mt-6 rounded-xl border-2 p-5 shadow-sm " +
          (sequence.autoSend
            ? "border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/40"
            : "border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20")
        }
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " +
                (sequence.autoSend
                  ? "bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300")
              }
            >
              <Zap size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Auto-send {sequence.autoSend ? "is on" : "is off"}
              </h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-700 dark:text-slate-300">
                {sequence.autoSend ? (
                  <>
                    Touches from this sequence go out with{" "}
                    <strong className="text-rose-700 dark:text-rose-300">
                      no human pressing Send
                    </strong>
                    . They still require the AI employee&apos;s revenue grant at{" "}
                    <code className="rounded bg-white/70 px-1 dark:bg-slate-900/60">send</code> and
                    the mailbox grant at{" "}
                    <code className="rounded bg-white/70 px-1 dark:bg-slate-900/60">send</code> —
                    both are re-checked at send time, not just when you saved. The suppression
                    list, the send window and the daily cap are never bypassed.
                  </>
                ) : (
                  <>
                    Every drafted touch lands in the draft review queue and a human presses Send.
                    Turning this on lets mail leave the building unattended, and needs the AI
                    employee&apos;s revenue grant at{" "}
                    <code className="rounded bg-white/70 px-1 dark:bg-slate-900/60">send</code> plus
                    the mailbox grant at{" "}
                    <code className="rounded bg-white/70 px-1 dark:bg-slate-900/60">send</code>.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="shrink-0">
            {sequence.autoSend ? (
              <Button variant="secondary" onClick={() => toggleAutoSend(false)}>
                Turn auto-send off
              </Button>
            ) : (
              <Button variant="danger" onClick={() => toggleAutoSend(true)}>
                <Zap size={14} /> Turn auto-send on
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* ── Steps ──────────────────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Step ladder
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Delays are measured from the previous touch, not from enrolment. The whole ladder is
              saved at once.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                patchDrafts([
                  ...drafts,
                  {
                    key: nextStepKey(),
                    name: "",
                    delayDays: drafts.length === 0 ? 0 : 3,
                    delayHours: 0,
                    instruction: "",
                    threadWithPrevious: drafts.length > 0,
                  },
                ])
              }
              disabled={drafts.length >= 50}
            >
              <Plus size={14} /> Add step
            </Button>
            <Button size="sm" onClick={saveSteps} disabled={savingSteps}>
              {savingSteps ? <Spinner size={14} /> : <Save size={14} />}
              Save ladder
            </Button>
          </div>
        </header>

        {drafts.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No steps yet. Add the opening touch, then the follow-ups.
            </p>
          </div>
        ) : (
          <ol className="divide-y divide-slate-100 dark:divide-slate-800">
            {drafts.map((step, index) => (
              <li key={step.key} className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {index + 1}
                    </span>
                    <input
                      value={step.name}
                      maxLength={120}
                      placeholder={`Step ${index + 1}`}
                      aria-label={`Step ${index + 1} name`}
                      onChange={(e) =>
                        patchDrafts(
                          drafts.map((d, i) =>
                            i === index ? { ...d, name: e.target.value } : d,
                          ),
                        )
                      }
                      className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm font-medium text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <IconButton
                      label="Move step up"
                      disabled={index === 0}
                      onClick={() => patchDrafts(move(drafts, index, index - 1))}
                    >
                      <ArrowUp size={14} />
                    </IconButton>
                    <IconButton
                      label="Move step down"
                      disabled={index === drafts.length - 1}
                      onClick={() => patchDrafts(move(drafts, index, index + 1))}
                    >
                      <ArrowDown size={14} />
                    </IconButton>
                    <IconButton
                      label="Remove step"
                      danger
                      onClick={() => patchDrafts(drafts.filter((_, i) => i !== index))}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Input
                    label="Wait (days)"
                    type="number"
                    min={0}
                    max={365}
                    value={step.delayDays}
                    onChange={(e) =>
                      patchDrafts(
                        drafts.map((d, i) =>
                          i === index ? { ...d, delayDays: Number(e.target.value) || 0 } : d,
                        ),
                      )
                    }
                  />
                  <Input
                    label="Wait (hours)"
                    type="number"
                    min={0}
                    max={23}
                    value={step.delayHours}
                    onChange={(e) =>
                      patchDrafts(
                        drafts.map((d, i) =>
                          i === index ? { ...d, delayHours: Number(e.target.value) || 0 } : d,
                        ),
                      )
                    }
                  />
                  <label className="flex items-center gap-2 self-end rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
                    <Checkbox
                      label={`Thread step ${index + 1} with the previous touch`}
                      checked={step.threadWithPrevious}
                      onChange={(e) =>
                        patchDrafts(
                          drafts.map((d, i) =>
                            i === index ? { ...d, threadWithPrevious: e.target.checked } : d,
                          ),
                        )
                      }
                    />
                    Reply in the previous thread
                  </label>
                </div>

                <div className="mt-3">
                  <Textarea
                    label="Instruction"
                    value={step.instruction}
                    maxLength={20000}
                    onChange={(e) =>
                      patchDrafts(
                        drafts.map((d, i) =>
                          i === index ? { ...d, instruction: e.target.value } : d,
                        ),
                      )
                    }
                    placeholder="What this touch should accomplish — the employee writes the actual email from this plus the contact's live context."
                    className="min-h-[110px]"
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── Enrolments ─────────────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Enrolments</h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {sequence.totalEnrolled} total
          </span>
        </header>

        {enrollments === null ? (
          <div className="flex justify-center p-16">
            <Spinner size={20} />
          </div>
        ) : enrollments.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Nobody is enrolled yet. Enrol contacts from the contact list.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Contact</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Step</th>
                  <th className="px-4 py-2 text-left font-medium">Next run</th>
                  <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {enrollments.map((row) => {
                  const terminal = TERMINAL_ENROLLMENT_STATUSES.includes(row.status);
                  return (
                    <tr key={row.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {row.contact?.name ?? "Unknown contact"}
                        </div>
                        {row.contact?.email && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {row.contact.email}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={PILL_BASE + " " + ENROLLMENT_STATUS_PILL[row.status]}>
                          {ENROLLMENT_STATUS_LABEL[row.status]}
                        </span>
                        {row.stoppedReason && (
                          <div className="mt-0.5 max-w-xs truncate text-xs text-slate-500 dark:text-slate-400">
                            {row.stoppedReason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-slate-600 dark:text-slate-300">
                        {Math.min(row.currentStepOrder + 1, Math.max(sequence.stepCount, 1))} of{" "}
                        {sequence.stepCount}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                        {fmtDateTime(row.nextRunAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={terminal}
                          onClick={() => stopEnrollment(row)}
                        >
                          <Ban size={14} /> Stop
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-6 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
        <Bot size={12} />
        <span>
          Touches are drafted by{" "}
          <Link
            to={`${sectionUrl}/ai-access`}
            className="underline hover:text-slate-600 dark:hover:text-slate-300"
          >
            an AI employee with revenue access
          </Link>
          .
        </span>
        <Mail size={12} className="ml-2" />
        <span>Suppressed addresses are never mailed, whatever this sequence says.</span>
      </p>
    </div>
  );
}

function move<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={
        "flex h-8 w-8 items-center justify-center rounded-md text-slate-400 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-500 " +
        (danger
          ? "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
          : "hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200")
      }
    >
      {children}
    </button>
  );
}
