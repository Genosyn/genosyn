import React from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, CornerDownLeft, Hourglass, Inbox, Sparkles } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { formatRelative } from "@/components/decisions/relative";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { api, type Company, type Employee, type Project } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { TasksHome as Home, TasksHomeItem, TasksHomeSection } from "../../../shared/tasksHome";
import { TODO_WAIT_LABEL } from "../../../shared/todoPickups";

const LAST_USED_KEY = "genosyn.tasks.oneLine";

type LastUsed = { projectSlug?: string; employeeId?: string };

function readLastUsed(companyId: string): LastUsed {
  try {
    const stored = JSON.parse(window.localStorage.getItem(`${LAST_USED_KEY}.${companyId}`) ?? "{}");
    return typeof stored === "object" && stored ? (stored as LastUsed) : {};
  } catch {
    return {};
  }
}

function writeLastUsed(companyId: string, value: LastUsed): void {
  try {
    window.localStorage.setItem(`${LAST_USED_KEY}.${companyId}`, JSON.stringify(value));
  } catch {
    // Remembering this is a convenience. The defaults are fine without it.
  }
}

/**
 * Hand work to an AI Employee in one sentence: type it and press enter. It files the Todo
 * and starts them on it, and the details can go on the Todo afterwards.
 */
function OneLineStart({
  company,
  projects,
  onStarted,
}: {
  company: Company;
  projects: Project[];
  onStarted: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = React.useState("");
  const [projectSlug, setProjectSlug] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const editable = React.useMemo(
    () => projects.filter((project) => project.myAccessLevel !== "read"),
    [projects],
  );

  React.useEffect(() => {
    let cancelled = false;
    void api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((found) => {
        if (!cancelled) setEmployees(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  // The last ones used, while they still exist.
  React.useEffect(() => {
    const last = readLastUsed(company.id);
    setProjectSlug((current) => {
      if (current && editable.some((project) => project.slug === current)) return current;
      return editable.find((project) => project.slug === last.projectSlug)?.slug ?? editable[0]?.slug ?? "";
    });
    setEmployeeId((current) => {
      if (current && employees.some((employee) => employee.id === current)) return current;
      return employees.find((employee) => employee.id === last.employeeId)?.id ?? employees[0]?.id ?? "";
    });
  }, [company.id, editable, employees]);

  if (editable.length === 0 || employees.length === 0) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const words = title.trim();
    if (!words || !projectSlug || !employeeId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/projects/${projectSlug}/todos`, {
        title: words.slice(0, 200),
        assigneeEmployeeId: employeeId,
        assigneeUserId: null,
      });
      writeLastUsed(company.id, { projectSlug, employeeId });
      setTitle("");
      onStarted();
    } catch (err) {
      setError(errorMessage(err, "Could not start that."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          placeholder="What needs doing?"
          aria-label="What needs doing?"
          className="min-w-[14rem] flex-1 rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:text-slate-100"
        />
        <Select
          aria-label="Who does it"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Project"
          value={projectSlug}
          onChange={(event) => setProjectSlug(event.target.value)}
        >
          {editable.map((project) => (
            <option key={project.id} value={project.slug}>
              {project.name}
            </option>
          ))}
        </Select>
        <Button type="submit" loading={busy} disabled={!title.trim()}>
          <CornerDownLeft size={14} className="mr-1.5" /> Start
        </Button>
      </div>
      <FormError message={error} className="mt-2" />
    </form>
  );
}

function when(item: TasksHomeItem, section: keyof Home): string | null {
  if (section === "waiting" && item.checkAt) {
    return `Checks back ${formatRelative(item.checkAt)}`;
  }
  if (!item.since) return null;
  const relative = formatRelative(item.since);
  return section === "working" ? `Started ${relative}` : relative;
}

function HomeSection({
  company,
  title,
  icon,
  name,
  section,
  note,
}: {
  company: Company;
  title: string;
  icon: React.ReactNode;
  name: keyof Home;
  section: TasksHomeSection;
  note?: string;
}) {
  if (section.count === 0 && !note) return null;
  const hidden = section.count - section.items.length;
  return (
    <section aria-label={title}>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
        {icon}
        {title}
        {section.count > 0 && (
          <span className="text-xs font-normal tabular-nums text-slate-500 dark:text-slate-400">
            {section.count}
          </span>
        )}
      </h2>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm empty:hidden dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
        {section.items.map((item) => (
          <li key={item.todoId}>
            <Link
              to={`/c/${company.slug}/tasks/p/${item.projectSlug}/t/${item.number}`}
              className="block px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60"
            >
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  {item.ref}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-900 dark:text-slate-100">
                  {item.title}
                </span>
                {when(item, name) && (
                  <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                    {when(item, name)}
                  </span>
                )}
              </div>
              {(item.detail || item.waitingOn) && (
                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                  {item.waitingOn && name !== "needsYou" ? `${TODO_WAIT_LABEL[item.waitingOn]}. ` : ""}
                  {item.detail}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          And {hidden} more, in their Projects.
        </p>
      )}
      {note && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{note}</p>}
    </section>
  );
}

/**
 * What's happening across Tasks, for whoever's looking: tell at a glance what needs you
 * and what AI is doing, and start something in one line. Comes from one read, limited by
 * the server to the Projects this person can open.
 */
export function TasksHome({ company, projects }: { company: Company; projects: Project[] }) {
  const [home, setHome] = React.useState<Home | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setHome(await api.get<Home>(`/api/companies/${company.id}/tasks-home`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load what's happening."));
    }
  }, [company.id]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch("todo", () => void load());

  const quiet =
    home !== null &&
    home.needsYou.count + home.working.count + home.working.queuedCount + home.waiting.count + home.doneToday.count === 0;
  const queued = home?.working.queuedCount ?? 0;

  return (
    <div className="space-y-5">
      <OneLineStart company={company} projects={projects} onStarted={() => void load()} />
      <FormError message={error} />
      {quiet && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Nothing is moving right now. Say what needs doing above, or assign a todo to an AI
          Employee: assigning it starts them on it, and their report comes back on the todo.
        </p>
      )}
      {home && (
        <>
          <HomeSection
            company={company}
            title="Needs you"
            icon={<Inbox size={14} aria-hidden className="text-amber-600 dark:text-amber-300" />}
            name="needsYou"
            section={home.needsYou}
          />
          <HomeSection
            company={company}
            title="AI working now"
            icon={<Sparkles size={14} aria-hidden className="text-indigo-500 dark:text-indigo-300" />}
            name="working"
            section={home.working}
            note={queued > 0 ? `${queued} more queued to start.` : undefined}
          />
          <HomeSection
            company={company}
            title="Waiting"
            icon={<Hourglass size={14} aria-hidden className="text-slate-400 dark:text-slate-500" />}
            name="waiting"
            section={home.waiting}
          />
          <HomeSection
            company={company}
            title="Done in the last day"
            icon={
              <CheckCircle2 size={14} aria-hidden className="text-emerald-600 dark:text-emerald-300" />
            }
            name="doneToday"
            section={home.doneToday}
          />
        </>
      )}
    </div>
  );
}
