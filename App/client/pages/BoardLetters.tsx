import React from "react";
import { AlertCircle, ChevronRight, Info, PenLine, ScrollText, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";

import { useLiveRefetch } from "@/components/CompanySocket";
import { LetterBadgePill } from "@/components/boardLetters/LetterBadgePill";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import {
  api,
  type BoardLetterListResponse,
  type BoardLetterSettings,
  type BoardLetterSummary,
  type Company,
  type Employee,
} from "@/lib/api";
import { letterStatusBadge, traceBadge } from "@/lib/boardLetters";
import { errorMessage } from "@/lib/errors";
import { canOpenSubpage, subpageAt } from "@/lib/subpages";
import type { TldrsOutletContext } from "@/pages/TldrsLayout";

/**
 * What happened → Letters: the monthly letter to the board, who writes it,
 * and who audits it. Owners and admins only, on the server and here: a letter
 * is addressed to them and carries the company's money figures.
 */
export default function BoardLettersPage() {
  const { company } = useOutletContext<TldrsOutletContext>();
  if (!canOpenSubpage(subpageAt("/tldrs/letters"), company)) return <LettersClosed />;
  return <BoardLetters company={company} />;
}

/** The note a Member sees instead of letters they cannot open. */
export function LettersClosed() {
  return (
    <div className="page-shell px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <EmptyState
        title="Only owners and admins read the letters"
        description="The monthly letter to the board goes to the company's owners and admins, with its money figures. Briefings and the Journal stay open to everyone."
      />
    </div>
  );
}

type Draft = {
  enabled: boolean;
  writerEmployeeId: string | null;
  auditorEmployeeId: string | null;
};

function toDraft(settings: BoardLetterSettings): Draft {
  return {
    enabled: settings.enabled,
    writerEmployeeId: settings.writer?.id ?? null,
    auditorEmployeeId: settings.auditor?.id ?? null,
  };
}

function BoardLetters({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [data, setData] = React.useState<BoardLetterListResponse | null>(null);
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [writing, setWriting] = React.useState(false);
  const [writeError, setWriteError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoadError(null);
    try {
      const [list, roster] = await Promise.all([
        api.get<BoardLetterListResponse>(`/api/companies/${company.id}/board-letters`),
        api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      ]);
      setData(list);
      setEmployees(roster);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the letters."));
    }
  }, [company.id]);

  React.useEffect(() => {
    setData(null);
    setEmployees(null);
    void reload();
  }, [reload]);

  useLiveRefetch(["board_letter", "employee"], reload);

  async function writeNow() {
    setWriting(true);
    setWriteError(null);
    try {
      const started = await api.post<BoardLetterSummary>(
        `/api/companies/${company.id}/board-letters/write`,
        {},
      );
      navigate(`/c/${company.slug}/tldrs/letters/${started.number}`);
    } catch (err) {
      setWriteError(errorMessage(err, "Could not start the letter."));
      setWriting(false);
    }
  }

  const settings = data?.settings ?? null;
  const lastMonth = settings?.lastMonth ?? null;

  return (
    <div className="page-shell px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
            <ScrollText size={19} />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">
              Letters to the board
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Once a month, the whole truth for the company&apos;s owners and admins: progress
              toward the Goal, what happened, what went wrong, and where the money went. Every
              number is checked against the books, and the auditor you appoint reads it first.
            </p>
          </div>
        </div>
        {lastMonth?.canWrite && (
          <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
            <Button onClick={() => void writeNow()} loading={writing}>
              {!writing && <PenLine size={15} />}
              {`Write ${lastMonth.label}'s letter`}
            </Button>
          </div>
        )}
      </header>

      <FormError message={writeError} className="mt-4" />

      {loadError && (
        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center dark:border-rose-500/25 dark:bg-rose-500/10">
          <AlertCircle size={18} className="shrink-0 text-rose-600 dark:text-rose-300" />
          <div className="min-w-0 flex-1 text-sm text-rose-800 dark:text-rose-200">{loadError}</div>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}

      {!data && !loadError ? (
        <div className="flex min-h-[45vh] items-center justify-center">
          <Spinner size={22} />
        </div>
      ) : data && settings && employees ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <section className="min-w-0 space-y-3 lg:order-1">
            {data.letters.length === 0 ? (
              <EmptyState title="No letters yet" description={emptyDescription(settings)} />
            ) : (
              data.letters.map((letter) => (
                <LetterRow key={letter.id} company={company} letter={letter} />
              ))
            )}
          </section>
          <aside className="lg:order-2">
            <LetterSettingsCard
              company={company}
              settings={settings}
              employees={employees}
              onSaved={(next) =>
                setData((current) => (current ? { ...current, settings: next } : current))
              }
            />
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function emptyDescription(settings: BoardLetterSettings): string {
  if (!settings.writer) {
    return "Choose who writes the letters and switch them on. The first one arrives on the first of next month, and you can ask for last month's at any time.";
  }
  if (settings.enabled && settings.nextLetter) {
    return `The first letter, for ${settings.nextLetter.label}, is written on ${formatDue(settings.nextLetter.dueAt)}.`;
  }
  return "Switch letters on to receive one on the first of every month.";
}

function formatDue(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function LetterRow({ company, letter }: { company: Company; letter: BoardLetterSummary }) {
  const status = letterStatusBadge(letter);
  const trace = traceBadge(letter);
  return (
    <Link
      to={`/c/${company.slug}/tldrs/letters/${letter.number}`}
      className="group flex items-start gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
    >
      <div className="w-14 shrink-0 text-center">
        <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
          No.
        </div>
        <div className="text-2xl font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-100">
          {letter.number}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {letter.monthLabel}
          </h2>
          <LetterBadgePill badge={status} />
          {trace && <LetterBadgePill badge={trace} />}
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {letter.status === "failed"
            ? letter.errorMessage || "The letter could not be written."
            : letter.summary || `${letter.writer.name || "The writer"} is writing this letter.`}
        </p>
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          {letter.writer.name || "A former AI Employee"}
          {letter.auditor ? ` · audited by ${letter.auditor.name}` : ""}
          {letter.writtenAt ? ` · ${new Date(letter.writtenAt).toLocaleDateString()}` : ""}
        </div>
      </div>
      <ChevronRight
        size={16}
        className="mt-1 shrink-0 text-slate-300 transition group-hover:text-slate-500 dark:text-slate-600"
      />
    </Link>
  );
}

function LetterSettingsCard({
  company,
  settings,
  employees,
  onSaved,
}: {
  company: Company;
  settings: BoardLetterSettings;
  employees: Employee[];
  onSaved: (settings: BoardLetterSettings) => void;
}) {
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(settings));
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const saved = toDraft(settings);
  const dirty =
    saved.enabled !== draft.enabled ||
    saved.writerEmployeeId !== draft.writerEmployeeId ||
    saved.auditorEmployeeId !== draft.auditorEmployeeId;

  // A save elsewhere (another tab, another admin) replaces an untouched form.
  const savedKey = `${saved.enabled}:${saved.writerEmployeeId}:${saved.auditorEmployeeId}`;
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  React.useEffect(() => {
    if (!dirtyRef.current) setDraft(toDraft(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.put<BoardLetterSettings>(
        `/api/companies/${company.id}/board-letters/settings`,
        draft,
      );
      onSaved(next);
      setDraft(toDraft(next));
    } catch (err) {
      setSaveError(errorMessage(err, "Could not save the letter settings."));
    } finally {
      setSaving(false);
    }
  }

  const connected = (employee: Employee) => employee.model?.status === "connected";
  const writer = employees.find((employee) => employee.id === draft.writerEmployeeId) ?? null;
  const auditor = employees.find((employee) => employee.id === draft.auditorEmployeeId) ?? null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3.5 dark:border-slate-800">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Every month</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Written at 06:00 on the first, for the month just ended.
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          label="Write a letter every month"
          onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
        />
      </div>

      <div className="space-y-5 p-4">
        <div>
          <Select
            id="board-letter-writer"
            label="Written by"
            value={draft.writerEmployeeId ?? ""}
            onChange={(event) => {
              const id = event.target.value || null;
              setDraft((current) => ({
                ...current,
                writerEmployeeId: id,
                // No one audits their own letter.
                auditorEmployeeId:
                  current.auditorEmployeeId === id ? null : current.auditorEmployeeId,
              }));
            }}
          >
            <option value="">Choose an AI Employee…</option>
            {employees.map((employee) => (
              <option
                key={employee.id}
                value={employee.id}
                disabled={!connected(employee) && employee.id !== saved.writerEmployeeId}
              >
                {employee.name}
                {employee.role ? ` — ${employee.role}` : ""}
                {!connected(employee) ? " — connect an AI Model first" : ""}
              </option>
            ))}
          </Select>
          {writer && <EmployeeChip company={company} employee={writer} />}
        </div>

        <div>
          <Select
            id="board-letter-auditor"
            label="Audited by"
            value={draft.auditorEmployeeId ?? ""}
            onChange={(event) =>
              setDraft((current) => ({ ...current, auditorEmployeeId: event.target.value || null }))
            }
          >
            <option value="">No auditor</option>
            {employees.map((employee) => (
              <option
                key={employee.id}
                value={employee.id}
                disabled={
                  employee.id === draft.writerEmployeeId ||
                  (!connected(employee) && employee.id !== saved.auditorEmployeeId)
                }
              >
                {employee.name}
                {employee.role ? ` — ${employee.role}` : ""}
                {employee.id === draft.writerEmployeeId
                  ? " — writes the letter"
                  : !connected(employee)
                    ? " — connect an AI Model first"
                    : ""}
              </option>
            ))}
          </Select>
          {auditor && <EmployeeChip company={company} employee={auditor} />}
          <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            <span>
              Only owners and admins appoint the auditor. It never audits its own letter, and no AI
              Employee can appoint or replace it.
              {settings.auditor && settings.auditorAppointedBy && settings.auditorAppointedAt
                ? ` ${settings.auditor.name} was appointed by ${settings.auditorAppointedBy.name} on ${new Date(settings.auditorAppointedAt).toLocaleDateString()}.`
                : ""}
            </span>
          </p>
        </div>

        <FormError message={saveError} />

        {dirty && (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={saving} onClick={() => setDraft(saved)}>
              Discard
            </Button>
            <Button
              size="sm"
              loading={saving}
              disabled={draft.enabled && !draft.writerEmployeeId}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        )}

        <StatusLines settings={settings} />
      </div>
    </section>
  );
}

function StatusLines({ settings }: { settings: BoardLetterSettings }) {
  const zone = settings.timeZone || "server time";
  return (
    <div className="space-y-2 border-t border-slate-100 pt-4 text-xs leading-5 dark:border-slate-800">
      {settings.waiting && (
        <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{settings.waiting}</span>
        </p>
      )}
      {settings.lastError && (
        <p className="flex items-start gap-1.5 text-rose-700 dark:text-rose-300">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{settings.lastError}</span>
        </p>
      )}
      <p className="text-slate-500 dark:text-slate-400">
        {settings.enabled && settings.nextLetter
          ? `Next: the letter for ${settings.nextLetter.label}, ${formatDue(settings.nextLetter.dueAt)} (${zone}).`
          : "Letters are off. A person can still ask for last month's."}
      </p>
    </div>
  );
}

function EmployeeChip({ company, employee }: { company: Company; employee: Employee }) {
  const ready = employee.model?.status === "connected";
  return (
    <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2 dark:border-slate-800 dark:bg-slate-900">
      <Avatar
        name={employee.name}
        src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
        kind="ai"
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-slate-900 dark:text-slate-100">
          {employee.name}
        </div>
        <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
          {employee.role || "AI Employee"}
        </div>
      </div>
      <span
        className={clsx(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          ready ? "bg-emerald-500" : "bg-amber-500",
        )}
        title={ready ? "AI Model connected" : "AI Model needed"}
      />
    </div>
  );
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-slate-950",
        checked ? "bg-indigo-600 dark:bg-indigo-500" : "bg-slate-300 dark:bg-slate-700",
      )}
    >
      <span
        className={clsx(
          "inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
