import React from "react";
import { Link } from "react-router-dom";
import {
  BookText,
  ChevronLeft,
  ChevronRight,
  Play,
} from "lucide-react";
import { api, Company, JournalKind } from "../lib/api";
import { Card, CardBody } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { TopBar } from "../components/AppShell";

type InboxEmployee = {
  id: string;
  slug: string;
  name: string;
  role: string;
  avatarKey: string | null;
};

type InboxEntry = {
  id: string;
  kind: JournalKind;
  title: string;
  body: string;
  runId: string | null;
  routineId: string | null;
  createdAt: string;
};

type InboxResponse = {
  date: string;
  employees: { employee: InboxEmployee; entries: InboxEntry[] }[];
  totalEntries: number;
};

function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function entryIcon(kind: JournalKind) {
  if (kind === "run") {
    return <Play size={12} className="text-violet-500" />;
  }
  if (kind === "note") {
    return <BookText size={12} className="text-amber-500" />;
  }
  return (
    <span className="block h-2 w-2 rounded-full bg-slate-400 dark:bg-slate-500" />
  );
}

export default function Inbox({ company }: { company: Company }) {
  const [date, setDate] = React.useState(isoDate(new Date()));
  const [data, setData] = React.useState<InboxResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<InboxResponse>(
        `/api/companies/${company.id}/inbox?date=${encodeURIComponent(date)}`,
      );
      setData(res);
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [company.id, date]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const today = isoDate(new Date());
  const isToday = date === today;

  return (
    <div className="mx-auto max-w-4xl p-8">
      <TopBar title="Journal" />
      <div className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Everything every AI employee did on {date}
        {isToday ? " (today)" : ""}.
      </div>
      <Card className="mt-4">
        <CardBody>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDate(shiftDate(date, -1))}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Previous day"
              >
                <ChevronLeft size={16} />
              </button>
              <input
                type="date"
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setDate(shiftDate(date, 1))}
                disabled={isToday}
                className="rounded-md p-1 text-slate-500 enabled:hover:bg-slate-100 disabled:opacity-30 dark:enabled:hover:bg-slate-800"
                aria-label="Next day"
              >
                <ChevronRight size={16} />
              </button>
              {!isToday && (
                <button
                  type="button"
                  onClick={() => setDate(today)}
                  className="ml-2 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Today
                </button>
              )}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {data
                ? `${data.totalEntries} entr${data.totalEntries === 1 ? "y" : "ies"} · ${data.employees.length} employee${data.employees.length === 1 ? "" : "s"}`
                : ""}
            </div>
          </div>
        </CardBody>
      </Card>

      {error && (
        <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4">
        {loading && !data ? (
          <Card>
            <CardBody>
              <Spinner />
            </CardBody>
          </Card>
        ) : data && data.employees.length === 0 ? (
          <Card>
            <CardBody>
              <EmptyState
                title={
                  isToday
                    ? "Nothing yet today"
                    : `Nothing on ${date}`
                }
                description={
                  isToday
                    ? "Routine runs, AI-authored notes, handoffs, and other journal entries will land here as the day unfolds."
                    : "Pick a different date or check back when an employee runs a routine or writes a note."
                }
              />
            </CardBody>
          </Card>
        ) : (
          data?.employees.map((g) => (
            <Card key={g.employee.id}>
              <CardBody className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <Avatar
                    name={g.employee.name}
                    kind="ai"
                    size="md"
                    src={employeeAvatarUrl(
                      company.id,
                      g.employee.id,
                      g.employee.avatarKey,
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/c/${company.slug}/employees/${g.employee.slug}/journal`}
                      className="truncate font-medium text-slate-900 hover:underline dark:text-slate-100"
                    >
                      {g.employee.name}
                    </Link>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {g.employee.role}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {g.entries.length} entr
                    {g.entries.length === 1 ? "y" : "ies"}
                  </div>
                </div>
                <ul className="flex flex-col gap-2">
                  {g.entries.map((e) => (
                    <li
                      key={e.id}
                      className="rounded-md border border-slate-100 bg-slate-50 p-2 text-sm dark:border-slate-800 dark:bg-slate-800/30"
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-1">{entryIcon(e.kind)}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                              {e.title}
                            </div>
                            <div className="shrink-0 text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                              {new Date(e.createdAt).toLocaleTimeString([], {
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </div>
                          </div>
                          {e.body && (
                            <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-400">
                              {e.body}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
