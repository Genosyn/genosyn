import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { BookOpen, FileText, MessageSquare, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import {
  api,
  FinanceAccessLevel,
  FinanceGrant,
  FinanceGrantCandidate,
  FinanceGrantsResponse,
} from "../lib/api";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Finance → AI access. Company-wide grant surface deciding which AI employees
 * may work the finance system (invoices, customers, payments, the books) and
 * at what level. Mirrors the Code repo / Email AI-access pattern.
 */

const LEVELS: { value: FinanceAccessLevel; label: string; hint: string }[] = [
  { value: "read", label: "Read only", hint: "View invoices, customers, and reports" },
  {
    value: "invoice",
    label: "Invoicing",
    hint: "Create, send & void invoices; manage customers; record payments",
  },
  { value: "full", label: "Full accounting", hint: "Invoicing + stage ledger reviews" },
];

function levelLabel(level: FinanceAccessLevel): string {
  return LEVELS.find((l) => l.value === level)?.label ?? level;
}

export default function FinanceAiAccess() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast, background } = useToast();
  const [grants, setGrants] = React.useState<FinanceGrant[] | null>(null);
  const [candidates, setCandidates] = React.useState<FinanceGrantCandidate[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [pickEmployee, setPickEmployee] = React.useState("");
  const [pickLevel, setPickLevel] = React.useState<FinanceAccessLevel>("read");

  const base = `/api/companies/${company.id}/finance`;

  const reload = React.useCallback(async () => {
    try {
      const [grantRows, candidateRows] = await Promise.all([
        api.get<FinanceGrantsResponse>(`${base}/grants`),
        api.get<FinanceGrantCandidate[]>(`${base}/grant-candidates`),
      ]);
      setGrants(grantRows.direct);
      setCandidates(candidateRows);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setGrants([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const ungranted = candidates.filter((candidate) => !candidate.alreadyGranted);

  async function addGrant() {
    if (!pickEmployee) return;
    setAdding(true);
    try {
      await api.post(`${base}/grants`, { employeeId: pickEmployee, accessLevel: pickLevel });
      setPickEmployee("");
      setPickLevel("read");
      await reload();
      toast("Finance access granted", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setAdding(false);
    }
  }

  function changeLevel(grant: FinanceGrant, level: FinanceAccessLevel) {
    setGrants(
      (current) =>
        current?.map((item) => (item.id === grant.id ? { ...item, accessLevel: level } : item)) ??
        current,
    );
    background(() => api.patch(`${base}/grants/${grant.id}`, { accessLevel: level }), {
      loading: "Updating finance access…",
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

  function revoke(grant: FinanceGrant) {
    const originalIndex = grants?.findIndex((item) => item.id === grant.id) ?? -1;
    setGrants((current) => current?.filter((item) => item.id !== grant.id) ?? current);
    background(() => api.del(`${base}/grants/${grant.id}`), {
      loading: "Revoking finance access…",
      success: "Finance access revoked",
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
    <div className="pb-12">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200/70 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
          <Users size={19} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI access
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Choose which AI employees may work the company&apos;s finance system, and how far they
            can go. Members reach Finance through the app as usual &mdash; this only governs what AI
            employees can do through their tools.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <LevelCard
          icon={<BookOpen size={17} />}
          title="Read only"
          detail="See invoices, customers, statements, reports, and the books. No changes."
        />
        <LevelCard
          icon={<FileText size={17} />}
          title="Invoicing"
          detail="Create, issue, send & void invoices, manage customers, and record payments to mark invoices paid."
        />
        <LevelCard
          icon={<ShieldCheck size={17} />}
          title="Full accounting"
          detail="Everything in Invoicing, plus staging ledger re-categorizations for a human to approve."
        />
      </div>

      <div className="mt-8 rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-end dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <Select
              label="Grant access to"
              value={pickEmployee}
              onChange={(event) => setPickEmployee(event.target.value)}
              disabled={ungranted.length === 0}
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
          <div className="w-full sm:w-52">
            <Select
              label="Finance access"
              value={pickLevel}
              onChange={(event) => setPickLevel(event.target.value as FinanceAccessLevel)}
              disabled={ungranted.length === 0}
            >
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={addGrant} disabled={adding || !pickEmployee} className="shrink-0">
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
              No AI employees have finance access
            </div>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500 dark:text-slate-400">
              Add one above. Start with Read only, then promote to Invoicing when you want an
              employee to bill customers on its own.
            </p>
          </div>
        ) : (
          <ul>
            {grants.map((grant, index) => (
              <li
                key={grant.id}
                className={
                  "flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center " +
                  (index > 0 ? "border-t border-slate-100 dark:border-slate-800" : "")
                }
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar
                    name={grant.employee?.name ?? "?"}
                    src={
                      grant.employee
                        ? employeeAvatarUrl(company.id, grant.employee.id, grant.employee.avatarKey)
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

                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {levelLabel(grant.accessLevel)}
                  </span>
                  <Select
                    value={grant.accessLevel}
                    onChange={(event) =>
                      changeLevel(grant, event.target.value as FinanceAccessLevel)
                    }
                    className="h-9 w-44"
                    aria-label="Finance access level"
                  >
                    {LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </Select>
                  {grant.employee && (
                    <Link
                      to={`/c/${company.slug}/employees/${grant.employee.slug}/chat`}
                      className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                      aria-label={`Chat with ${grant.employee.name}`}
                      title={`Chat with ${grant.employee.name}`}
                    >
                      <MessageSquare size={15} />
                    </Link>
                  )}
                  <button
                    onClick={() => revoke(grant)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                    aria-label="Revoke finance access"
                    title="Revoke finance access"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LevelCard({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
        <span className="text-indigo-600 dark:text-indigo-300">{icon}</span>
        {title}
      </div>
      <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail}</p>
    </div>
  );
}
