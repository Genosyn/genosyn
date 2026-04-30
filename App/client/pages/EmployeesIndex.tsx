import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, Network, Pencil, Plus, Users } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Breadcrumbs } from "../components/AppShell";
import {
  Avatar,
  employeeAvatarUrl,
  memberAvatarUrl,
} from "../components/ui/Avatar";
import { Menu } from "../components/ui/Menu";
import { Spinner } from "../components/ui/Spinner";
import { FormError } from "../components/ui/FormError";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";
import { api, Company, Employee, Member, Team } from "../lib/api";
import { useEmployees } from "./employeesContext";

/**
 * The `/c/:slug` index pane. Shows the company roster as an interactive
 * org chart driven by `reportsToEmployeeId` / `reportsToUserId`. Each AI
 * card has an inline editor for Team and Reports-to that PATCHes the
 * employee, so members can both *see* and *define* the chart from one
 * screen.
 *
 * Humans (company members) and AI employees are rendered as the same
 * kind of node and share the same recursion. An AI can report to either
 * another AI (existing) or a human (new) — humans themselves don&apos;t
 * have a reports-to field yet, so they always sit as roots.
 */
export default function EmployeesIndex({ company }: { company: Company }) {
  const { employees } = useEmployees();
  const navigate = useNavigate();
  const [members, setMembers] = React.useState<Member[]>([]);

  React.useEffect(() => {
    api
      .get<Member[]>(`/api/companies/${company.id}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [company.id]);

  const crumbs = (
    <div className="mb-6">
      <Breadcrumbs items={[{ label: "Employees" }]} />
    </div>
  );

  if (employees.length === 0) {
    return (
      <>
        {crumbs}
        <div className="flex min-h-[50vh] items-center justify-center">
        <div className="max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <Users size={20} />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
            Hire your first AI employee
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Give them a name and a role, then write their Soul, define Skills, and
            schedule Routines.
          </p>
          <div className="mt-4 flex justify-center">
            <Button onClick={() => navigate(`/c/${company.slug}/employees/new`)}>
              <Plus size={14} /> New employee
            </Button>
          </div>
        </div>
        </div>
      </>
    );
  }

  return (
    <>
      {crumbs}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Employees
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Click a card to open. Use the pencil to set who someone reports
            to and which team they&apos;re on.
          </p>
        </div>
        <Button onClick={() => navigate(`/c/${company.slug}/employees/new`)}>
          <Plus size={14} /> New employee
        </Button>
      </div>
      <OrgChartView
        company={company}
        employees={employees}
        members={members}
      />
    </>
  );
}

type ChartNode =
  | { kind: "ai"; key: string; name: string; emp: Employee }
  | { kind: "human"; key: string; name: string; member: Member };

const aiKey = (id: string) => `ai:${id}`;
const humanKey = (userId: string) => `human:${userId}`;

function memberDisplayName(m: Member): string {
  return m.name || m.email || "Member";
}

function OrgChartView({
  company,
  employees,
  members,
}: {
  company: Company;
  employees: Employee[];
  members: Member[];
}) {
  const { reload } = useEmployees();
  const [teams, setTeams] = React.useState<Team[] | null>(null);

  React.useEffect(() => {
    api
      .get<Team[]>(`/api/companies/${company.id}/teams`)
      .then((list) => setTeams(list.filter((t) => !t.archivedAt)))
      .catch(() => setTeams([]));
  }, [company.id]);

  // Walk both AIs and humans into a single tree. An AI prefers its
  // human manager (`reportsToUserId`) over its AI one when both happen
  // to be set; the API enforces that only one is set at a time, but the
  // UI tolerates stale data by picking deterministically. Anyone whose
  // declared manager is no longer on the roster gets re-rooted.
  const { roots, byManager } = React.useMemo(() => {
    const aiIds = new Set(employees.map((e) => e.id));
    const memberIds = new Set(members.map((m) => m.userId));
    const byManager = new Map<string, ChartNode[]>();
    const roots: ChartNode[] = [];

    for (const m of members) {
      roots.push({
        kind: "human",
        key: humanKey(m.userId),
        name: memberDisplayName(m),
        member: m,
      });
    }
    for (const e of employees) {
      const node: ChartNode = {
        kind: "ai",
        key: aiKey(e.id),
        name: e.name,
        emp: e,
      };
      let parent: string | null = null;
      if (e.reportsToUserId && memberIds.has(e.reportsToUserId)) {
        parent = humanKey(e.reportsToUserId);
      } else if (
        e.reportsToEmployeeId &&
        aiIds.has(e.reportsToEmployeeId) &&
        e.reportsToEmployeeId !== e.id
      ) {
        parent = aiKey(e.reportsToEmployeeId);
      }
      if (parent) {
        const list = byManager.get(parent) ?? [];
        list.push(node);
        byManager.set(parent, list);
      } else {
        roots.push(node);
      }
    }
    const sortByName = (a: ChartNode, b: ChartNode) =>
      a.name.localeCompare(b.name);
    roots.sort(sortByName);
    for (const list of byManager.values()) list.sort(sortByName);
    return { roots, byManager };
  }, [employees, members]);

  const teamsById = React.useMemo(() => {
    const m = new Map<string, Team>();
    for (const t of teams ?? []) m.set(t.id, t);
    return m;
  }, [teams]);

  const hasHierarchy = byManager.size > 0;
  const nodeProps = {
    company,
    employees,
    members,
    teamsById,
    teams,
    onChanged: reload,
    byManager,
  };

  const totalCount = employees.length + members.length;
  const summary = hasHierarchy
    ? `${totalCount} ${totalCount === 1 ? "person" : "people"} · ${byManager.size} manager${byManager.size === 1 ? "" : "s"}`
    : `${totalCount} ${totalCount === 1 ? "person" : "people"}, no reporting lines yet`;

  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-b from-slate-50/50 to-white shadow-sm dark:border-slate-800 dark:from-slate-900/40 dark:to-slate-950">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 px-5 py-3 dark:border-slate-800/70">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            <Network size={14} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Reporting structure
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {summary}
            </span>
          </div>
        </div>
      </div>

      {hasHierarchy ? (
        <div className="overflow-x-auto px-6 py-8">
          <div className="flex min-w-fit items-start justify-center gap-10">
            {roots.map((r) => (
              <OrgNode
                key={r.key}
                node={r}
                visited={new Set([r.key])}
                {...nodeProps}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-3 rounded-lg bg-indigo-50/60 px-4 py-3 text-xs text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-200">
            <div className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
              i
            </div>
            <div>
              No reporting lines yet. Click <Pencil className="inline" size={11} />{" "}
              on any AI card to set who they report to — the chart will draw
              itself.
            </div>
          </div>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {roots.map((node) => (
              <li key={node.key}>
                <NodeCard node={node} reportCount={0} {...nodeProps} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

type SharedNodeProps = {
  byManager: Map<string, ChartNode[]>;
  company: Company;
  employees: Employee[];
  members: Member[];
  teamsById: Map<string, Team>;
  teams: Team[] | null;
  onChanged: () => Promise<void>;
};

function OrgNode({
  node,
  visited,
  ...shared
}: SharedNodeProps & { node: ChartNode; visited: Set<string> }) {
  const reports = (shared.byManager.get(node.key) ?? []).filter(
    (r) => !visited.has(r.key),
  );
  const nextVisited = new Set(visited);
  for (const r of reports) nextVisited.add(r.key);

  return (
    <div className="flex flex-col items-center">
      <NodeCard node={node} reportCount={reports.length} {...shared} />
      {reports.length > 0 && (
        <>
          <div className="h-5 w-0.5 bg-slate-300 dark:bg-slate-600" />
          <div className="flex items-start gap-8">
            {reports.map((r, i) => (
              <div
                key={r.key}
                className="relative flex flex-col items-center"
              >
                {reports.length > 1 && (
                  <div
                    className={clsx(
                      "absolute top-0 h-0.5 bg-slate-300 dark:bg-slate-600",
                      i === 0
                        ? "left-1/2 right-0"
                        : i === reports.length - 1
                          ? "left-0 right-1/2"
                          : "left-0 right-0",
                    )}
                  />
                )}
                <div className="h-5 w-0.5 bg-slate-300 dark:bg-slate-600" />
                <OrgNode node={r} visited={nextVisited} {...shared} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NodeCard({
  node,
  reportCount,
  ...shared
}: SharedNodeProps & { node: ChartNode; reportCount: number }) {
  if (node.kind === "ai") {
    return <AINodeCard emp={node.emp} reportCount={reportCount} {...shared} />;
  }
  return (
    <HumanNodeCard
      member={node.member}
      reportCount={reportCount}
      company={shared.company}
    />
  );
}

function AINodeCard({
  emp,
  reportCount,
  byManager: _byManager,
  company,
  employees,
  members,
  teamsById,
  teams,
  onChanged,
}: SharedNodeProps & { emp: Employee; reportCount: number }) {
  const team = emp.teamId ? teamsById.get(emp.teamId) : null;
  const isManager = reportCount > 0;
  return (
    <div
      className={clsx(
        "group relative w-56 rounded-xl border bg-white shadow-sm transition hover:border-slate-300 hover:shadow-md dark:bg-slate-900 dark:hover:border-slate-700",
        isManager
          ? "border-slate-200 ring-1 ring-indigo-100 dark:border-slate-800 dark:ring-indigo-500/20"
          : "border-slate-200 dark:border-slate-800",
      )}
    >
      <Link
        to={`/c/${company.slug}/employees/${emp.slug}`}
        className="flex flex-col gap-2.5 p-3.5"
      >
        <div className="flex items-center gap-2.5">
          <Avatar
            name={emp.name}
            kind="ai"
            size="md"
            src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {emp.name}
            </div>
            <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
              {emp.role || "No role set"}
            </div>
          </div>
        </div>
        {(team || isManager) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {team && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                {team.name}
              </span>
            )}
            {isManager && (
              <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                <ChevronDown size={10} />
                {reportCount} {reportCount === 1 ? "report" : "reports"}
              </span>
            )}
          </div>
        )}
      </Link>
      <OrgEditMenu
        emp={emp}
        company={company}
        employees={employees}
        members={members}
        teams={teams}
        onChanged={onChanged}
      />
    </div>
  );
}

function HumanNodeCard({
  company,
  member,
  reportCount,
}: {
  company: Company;
  member: Member;
  reportCount: number;
}) {
  const displayName = memberDisplayName(member);
  const isManager = reportCount > 0;
  return (
    <div
      className={clsx(
        "relative w-56 rounded-xl border bg-white shadow-sm transition hover:border-slate-300 hover:shadow-md dark:bg-slate-900 dark:hover:border-slate-700",
        isManager
          ? "border-slate-200 ring-1 ring-emerald-100 dark:border-slate-800 dark:ring-emerald-500/20"
          : "border-slate-200 dark:border-slate-800",
      )}
    >
      <div className="flex flex-col gap-2.5 p-3.5">
        <div className="flex items-center gap-2.5">
          <Avatar
            name={displayName}
            kind="human"
            size="md"
            src={memberAvatarUrl(company.id, member.userId, member.avatarKey)}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {displayName}
              </span>
            </div>
            <div className="truncate text-[11px] capitalize text-slate-500 dark:text-slate-400">
              {member.role}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            Human
          </span>
          {isManager && (
            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              <ChevronDown size={10} />
              {reportCount} {reportCount === 1 ? "report" : "reports"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function OrgEditMenu({
  emp,
  company,
  employees,
  members,
  teams,
  onChanged,
}: {
  emp: Employee;
  company: Company;
  employees: Employee[];
  members: Member[];
  teams: Team[] | null;
  onChanged: () => Promise<void>;
}) {
  return (
    <Menu
      align="right"
      width={260}
      trigger={({ ref, onClick }) => (
        <button
          ref={ref}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClick();
          }}
          title="Edit team & manager"
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white/80 text-slate-400 opacity-60 backdrop-blur transition hover:border-indigo-300 hover:bg-white hover:text-indigo-700 hover:opacity-100 group-hover:opacity-100 dark:border-slate-700 dark:bg-slate-900/80 dark:hover:border-indigo-500/40 dark:hover:bg-slate-900 dark:hover:text-indigo-300"
        >
          <Pencil size={11} />
        </button>
      )}
    >
      {(close) => (
        <OrgEditForm
          emp={emp}
          company={company}
          employees={employees}
          members={members}
          teams={teams}
          onSaved={async () => {
            await onChanged();
            close();
          }}
        />
      )}
    </Menu>
  );
}

// "Reports to" select value encodes both kinds in a single string so we
// can re-use one <select>. "" → no manager; "ai:<id>" → AI manager;
// "human:<userId>" → human manager.
function initialReportsTo(emp: Employee): string {
  if (emp.reportsToUserId) return humanKey(emp.reportsToUserId);
  if (emp.reportsToEmployeeId) return aiKey(emp.reportsToEmployeeId);
  return "";
}

function OrgEditForm({
  emp,
  company,
  employees,
  members,
  teams,
  onSaved,
}: {
  emp: Employee;
  company: Company;
  employees: Employee[];
  members: Member[];
  teams: Team[] | null;
  onSaved: () => Promise<void>;
}) {
  const [teamId, setTeamId] = React.useState<string>(emp.teamId ?? "");
  const [reportsTo, setReportsTo] = React.useState<string>(
    initialReportsTo(emp),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  const dirty =
    (teamId || null) !== (emp.teamId ?? null) ||
    reportsTo !== initialReportsTo(emp);

  const peers = employees.filter((e) => e.id !== emp.id);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
    setError(null);
    setSaving(true);
    try {
      const patch: {
        teamId: string | null;
        reportsToEmployeeId: string | null;
        reportsToUserId: string | null;
      } = {
        teamId: teamId || null,
        reportsToEmployeeId: null,
        reportsToUserId: null,
      };
      if (reportsTo.startsWith("ai:")) {
        patch.reportsToEmployeeId = reportsTo.slice(3);
      } else if (reportsTo.startsWith("human:")) {
        patch.reportsToUserId = reportsTo.slice(6);
      }
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        patch,
      );
      toast("Org chart updated", "success");
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selectClass =
    "rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900";

  return (
    <form className="flex flex-col gap-2.5 p-2.5" onSubmit={submit}>
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Edit org
        </span>
        <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">
          {emp.name}
        </span>
      </div>
      <FormError message={error} />
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-300">
          Team
        </span>
        <select
          className={selectClass}
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          disabled={teams === null}
        >
          <option value="">— No team —</option>
          {(teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {teams !== null && teams.length === 0 && (
          <span className="text-[10px] text-slate-400 dark:text-slate-500">
            No teams yet — create one in Settings → Teams.
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-300">
          Reports to
        </span>
        <select
          className={selectClass}
          value={reportsTo}
          onChange={(e) => setReportsTo(e.target.value)}
        >
          <option value="">— No manager —</option>
          {members.length > 0 && (
            <optgroup label="Humans">
              {members.map((m) => (
                <option key={m.userId} value={humanKey(m.userId)}>
                  {memberDisplayName(m)} ({m.role})
                </option>
              ))}
            </optgroup>
          )}
          {peers.length > 0 && (
            <optgroup label="AI employees">
              {peers.map((p) => (
                <option key={p.id} value={aiKey(p.id)}>
                  {p.name} ({p.role})
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <div className="flex justify-end pt-1">
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? <Spinner size={12} /> : "Save"}
        </Button>
      </div>
    </form>
  );
}
