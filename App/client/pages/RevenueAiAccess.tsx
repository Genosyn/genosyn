import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  Check,
  ChevronDown,
  Eye,
  Info,
  MessageSquare,
  Pencil,
  Send,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { api } from "../lib/api";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useLiveRefetch } from "../components/CompanySocket";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Menu } from "../components/ui/Menu";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * Revenue → AI access. Company-wide grant surface deciding which AI employees
 * may work the revenue system — contacts, deals, activities, sequences, signals
 * and the revenue reports — and at what level (read &lt; write &lt; send).
 *
 * Mirrors the Finance AI-access page deliberately: same ladder layout, same
 * level picker, same optimistic-with-rollback mutations. The one difference that
 * matters is the top of the ladder. `send` is the only level anywhere in the
 * product that lets mail leave the building with nobody watching, so its blurb
 * says so plainly rather than describing itself as "full access".
 */

export type RevenueAccessLevel = "read" | "write" | "send";

export type RevenueGrant = {
  id: string;
  employeeId: string;
  accessLevel: RevenueAccessLevel;
  createdAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  } | null;
};

export type RevenueGrantCandidate = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  alreadyGranted: boolean;
};

type LevelMeta = {
  value: RevenueAccessLevel;
  label: string;
  tagline: string;
  hint: string;
  icon: React.ReactNode;
  /** Tint for the standalone icon (menu trigger, dropdown rows). */
  iconColor: string;
  /** Filled icon chip (legend + option rows). */
  iconWrap: string;
};

const LEVELS: LevelMeta[] = [
  {
    value: "read",
    label: "Read only",
    tagline: "See the pipeline",
    hint: "List and open contacts, deals, activity timelines, sequences and signals, and pull revenue reports. Changes nothing.",
    icon: <Eye size={15} />,
    iconColor: "text-slate-500 dark:text-slate-400",
    iconWrap: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  },
  {
    value: "write",
    label: "Write",
    tagline: "Work the pipeline",
    hint: "Everything in Read, plus create and update contacts and deals, log activities, move a deal between stages, and enrol somebody in a sequence.",
    icon: <Pencil size={15} />,
    iconColor: "text-indigo-500 dark:text-indigo-400",
    iconWrap: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300",
  },
  {
    value: "send",
    label: "Send",
    tagline: "Mail without a human",
    hint: "Everything in Write, plus its sequence drafts may go out with nobody pressing Send — only on auto-send sequences, and only where it also holds send on the mailbox.",
    icon: <Send size={15} />,
    iconColor: "text-rose-500 dark:text-rose-400",
    iconWrap: "bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300",
  },
];

const LEVEL_BY_VALUE = new Map(LEVELS.map((l) => [l.value, l]));
function meta(level: RevenueAccessLevel): LevelMeta {
  return LEVEL_BY_VALUE.get(level) ?? LEVELS[0];
}

export default function RevenueAiAccess() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { toast, background } = useToast();
  const [grants, setGrants] = React.useState<RevenueGrant[] | null>(null);
  const [candidates, setCandidates] = React.useState<RevenueGrantCandidate[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [pickEmployee, setPickEmployee] = React.useState("");
  const [pickLevel, setPickLevel] = React.useState<RevenueAccessLevel>("read");

  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  // The server enforces this on every mutation; disabling here just stops a
  // member from composing a change that is going to be refused anyway.
  const canManage = company.role !== "member";

  const reload = React.useCallback(async () => {
    try {
      const res = await api.get<{
        grants: RevenueGrant[];
        candidates: RevenueGrantCandidate[];
      }>(`${base}/ai-access`);
      setGrants(res.grants);
      setCandidates(res.candidates);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setGrants([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("grant", reload);

  const ungranted = candidates.filter((candidate) => !candidate.alreadyGranted);
  const grantedCount = grants?.length ?? 0;
  const totalEmployees = candidates.length;

  async function addGrant() {
    if (!pickEmployee) return;
    setAdding(true);
    try {
      // PUT keyed by employee — one grant row per employee, so the caller states
      // the level it should hold rather than asking whether one exists first.
      await api.put(`${base}/ai-access/${pickEmployee}`, { accessLevel: pickLevel });
      setPickEmployee("");
      setPickLevel("read");
      await reload();
      toast("Revenue access granted", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setAdding(false);
    }
  }

  function changeLevel(grant: RevenueGrant, level: RevenueAccessLevel) {
    setGrants(
      (current) =>
        current?.map((item) => (item.id === grant.id ? { ...item, accessLevel: level } : item)) ??
        current,
    );
    background(() => api.put(`${base}/ai-access/${grant.employeeId}`, { accessLevel: level }), {
      loading: "Updating revenue access…",
      error: (error) =>
        `Couldn’t update access: ${
          error instanceof Error ? error.message : String(error)
        }. The change was undone.`,
      onError: () => {
        setGrants(
          (current) => current?.map((item) => (item.id === grant.id ? grant : item)) ?? current,
        );
      },
    });
  }

  function revoke(grant: RevenueGrant) {
    const originalIndex = grants?.findIndex((item) => item.id === grant.id) ?? -1;
    setGrants((current) => current?.filter((item) => item.id !== grant.id) ?? current);
    // DELETE is keyed by the grant id, not the employee id — the two mutations
    // on this path deliberately take different keys.
    background(() => api.del(`${base}/ai-access/${grant.id}`), {
      loading: "Revoking revenue access…",
      success: "Revenue access revoked",
      error: (error) =>
        `Couldn’t revoke access: ${
          error instanceof Error ? error.message : String(error)
        }. The grant has been restored.`,
      onError: () => {
        setGrants((current) => {
          if (!current || current.some((item) => item.id === grant.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, grant);
          return next;
        });
      },
    });
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "AI access" }]} />
      </div>

      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
          <Users size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI access
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Choose which AI employees may work the company&apos;s revenue system, and how far they
            can go. Members reach Revenue through the app as usual &mdash; this only governs what AI
            employees can do through their tools.
          </p>
        </div>
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
        <Info size={13} className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" />
        <span>
          Only owners and admins can change these grants. Everyone else can see who has been given
          what, which is the point of showing it here rather than hiding it.
        </span>
      </p>

      {/* Access ladder — read < write < send, each includes the one before it. */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {LEVELS.map((l, i) => (
          <div
            key={l.value}
            className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-center gap-2.5">
              <span
                className={
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg " + l.iconWrap
                }
              >
                {l.icon}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {l.label}
                </div>
                <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {l.tagline}
                </div>
              </div>
            </div>
            <p className="mt-2.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{l.hint}</p>
            {i > 0 && (
              <div className="mt-2.5 inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                <Check size={11} /> Includes {LEVELS[i - 1].label}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        {/* Add a grant */}
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-end dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <Select
              label="Grant access to"
              value={pickEmployee}
              onChange={(event) => setPickEmployee(event.target.value)}
              disabled={!canManage || ungranted.length === 0}
            >
              <option value="">
                {ungranted.length === 0
                  ? "All employees already have access"
                  : "Choose an AI employee…"}
              </option>
              {ungranted.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} &mdash; {candidate.role}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Access level
            </label>
            <LevelPicker
              level={pickLevel}
              align="left"
              disabled={!canManage || ungranted.length === 0}
              onChange={setPickLevel}
            />
          </div>
          <Button
            onClick={addGrant}
            disabled={!canManage || adding || !pickEmployee}
            className="shrink-0"
          >
            {adding ? <Spinner size={14} /> : <UserPlus size={14} />}
            Add
          </Button>
        </div>

        {grants === null ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : grants.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Users size={22} className="mx-auto text-slate-300 dark:text-slate-600" />
            <div className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              No AI employees have revenue access
            </div>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500 dark:text-slate-400">
              Add one above. Start with Read only, then promote to Write when you want an employee
              to keep the pipeline up to date on its own.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <span>With access</span>
              <span className="tabular-nums">
                {grantedCount} of {totalEmployees}
              </span>
            </div>
            <ul className="border-t border-slate-100 dark:border-slate-800">
              {grants.map((grant, index) => {
                const m = meta(grant.accessLevel);
                return (
                  <li
                    key={grant.id}
                    className={
                      "flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-center " +
                      (index > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
                    }
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Avatar
                        name={grant.employee?.name ?? "?"}
                        kind="ai"
                        src={
                          grant.employee
                            ? employeeAvatarUrl(
                                company.id,
                                grant.employee.id,
                                grant.employee.avatarKey,
                              )
                            : null
                        }
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                          {grant.employee?.name ?? "Unknown employee"}
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {grant.employee?.role}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 lg:justify-end">
                      <span className="mr-1 hidden text-[11px] text-slate-400 sm:inline dark:text-slate-500">
                        {m.tagline}
                      </span>
                      <LevelPicker
                        level={grant.accessLevel}
                        align="right"
                        disabled={!canManage}
                        onChange={(level) => changeLevel(grant, level)}
                      />
                      {grant.employee && (
                        <Link
                          to={`/c/${company.slug}/employees/${grant.employee.slug}/chat`}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                          aria-label={`Chat with ${grant.employee.name}`}
                          title={`Chat with ${grant.employee.name}`}
                        >
                          <MessageSquare size={15} />
                        </Link>
                      )}
                      <button
                        onClick={() => revoke(grant)}
                        disabled={!canManage}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                        aria-label="Revoke revenue access"
                        title="Revoke revenue access"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Compact level control: a button showing the current level (tinted icon +
 * label) that opens a rich menu of the three levels with their descriptions.
 */
function LevelPicker({
  level,
  onChange,
  align = "right",
  disabled = false,
}: {
  level: RevenueAccessLevel;
  onChange: (level: RevenueAccessLevel) => void;
  align?: "left" | "right";
  disabled?: boolean;
}) {
  const current = meta(level);
  return (
    <Menu
      align={align}
      width={280}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label="Revenue access level"
          className={
            "inline-flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-indigo-300 disabled:opacity-50 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700 " +
            (open
              ? "border-indigo-300 dark:border-indigo-700"
              : "border-slate-200 dark:border-slate-700")
          }
        >
          <span className={"flex h-4 w-4 items-center justify-center " + current.iconColor}>
            {current.icon}
          </span>
          {current.label}
          <ChevronDown size={12} className="text-slate-400 dark:text-slate-500" />
        </button>
      )}
    >
      {(close) => (
        <div className="py-0.5">
          {LEVELS.map((l) => {
            const active = l.value === level;
            return (
              <button
                key={l.value}
                type="button"
                onClick={() => {
                  close();
                  if (l.value !== level) onChange(l.value);
                }}
                className={
                  "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left " +
                  (active
                    ? "bg-indigo-50 dark:bg-indigo-500/10"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800")
                }
              >
                <span
                  className={
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md " +
                    l.iconWrap
                  }
                >
                  {l.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={
                      "flex items-center gap-1 text-sm font-medium " +
                      (active
                        ? "text-indigo-700 dark:text-indigo-300"
                        : "text-slate-800 dark:text-slate-100")
                    }
                  >
                    {l.label}
                    {active && <Check size={12} />}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                    {l.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Menu>
  );
}
