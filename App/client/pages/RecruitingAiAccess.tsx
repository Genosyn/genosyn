import React from "react";
import { useOutletContext } from "react-router-dom";
import { Eye, ShieldCheck, UserCheck, Users } from "lucide-react";

import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useDialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Select";
import { errorMessage } from "../lib/errors";
import { recruitingApi, type RecruitingGrantRow } from "../lib/recruiting";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import {
  RECRUITING_ACCESS_HINTS,
  RECRUITING_ACCESS_LABELS,
  RECRUITING_ACCESS_LEVELS,
  type RecruitingAccessLevel,
} from "../../shared/recruiting";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import { ErrorPanel, LoadingPage, PageHeader, cardClass, pageClass, recruitingCrumbs } from "./RecruitingShared";

const LEVEL_ICONS: Record<RecruitingAccessLevel, React.ReactNode> = {
  read: <Eye size={15} />,
  screen: <Users size={15} />,
  hire: <UserCheck size={15} />,
};

export function RecruitingAiAccessPage() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  if (!canOpenSubpage(subpageAt("/recruiting/ai-access"), company)) {
    return (
      <div className={pageClass}>
        <PageHeader crumbs={recruitingCrumbs(`/c/${company.slug}/recruiting`, { label: "AI access" })} title="AI access" />
        <EmptyState title="Owners and admins decide AI access" description="Ask an owner or admin which AI Employees may work in Recruiting." />
      </div>
    );
  }
  return <AccessTable />;
}

function AccessTable() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const crumbs = recruitingCrumbs(`/c/${company.slug}/recruiting`, { label: "AI access" });
  const dialog = useDialog();
  const [rows, setRows] = React.useState<RecruitingGrantRow[] | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await recruitingApi(company.id).grants();
    setRows(result.rows);
  }, [company.id]);

  const firstLoad = React.useCallback(() => {
    setLoadError("");
    load().catch((err: unknown) => setLoadError(errorMessage(err, "Could not load AI access")));
  }, [load]);

  React.useEffect(() => {
    firstLoad();
  }, [firstLoad]);

  async function setAccess(row: RecruitingGrantRow, level: string) {
    setBusy(row.employee.id);
    try {
      if (!level && row.grant) await recruitingApi(company.id).removeGrant(row.grant.id);
      else if (level) await recruitingApi(company.id).setGrant(row.employee.id, level as RecruitingAccessLevel);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update Recruiting access" });
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className={pageClass}>
        <PageHeader crumbs={crumbs} title="AI access" />
        <ErrorPanel message={loadError} onRetry={firstLoad} />
      </div>
    );
  }
  if (!rows) return <LoadingPage />;

  return (
    <div className={pageClass}>
      <PageHeader
        crumbs={crumbs}
        title="AI access"
        description="Which AI Employees may work in Recruiting, and how far. This is separate from the AI screener at Recruiting → Settings, which only ever writes Scorecards."
      />

      <div className={`${cardClass} overflow-hidden`}>
        <div className="grid grid-cols-[1fr_11rem] gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-950 inline-block first-letter:uppercase">
          <span>AI Employee</span>
          <span>Recruiting access</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-500">Hire an AI Employee before delegating Recruiting.</div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <div key={row.employee.id} className="grid grid-cols-[1fr_11rem] items-center gap-4 px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar src={employeeAvatarUrl(company.id, row.employee.id, row.employee.avatarKey)} name={row.employee.name} kind="ai" size="sm" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-white">{row.employee.name}</div>
                    <div className="truncate text-xs text-slate-500">{row.employee.role}</div>
                  </div>
                </div>
                <Select
                  aria-label={`Recruiting access for ${row.employee.name}`}
                  value={row.grant?.accessLevel ?? ""}
                  disabled={busy === row.employee.id}
                  onChange={(event) => void setAccess(row, event.target.value)}
                >
                  <option value="">No access</option>
                  {RECRUITING_ACCESS_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {RECRUITING_ACCESS_LABELS[level]}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {RECRUITING_ACCESS_LEVELS.map((level) => (
          <div key={level} className={`${cardClass} p-4`}>
            <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
              {LEVEL_ICONS[level]} {RECRUITING_ACCESS_LABELS[level]}
            </div>
            <p className="mt-1 text-xs text-slate-500">{RECRUITING_ACCESS_HINTS[level]}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
        <ShieldCheck size={18} className="mt-0.5 shrink-0" />
        <p>
          Applications are written by strangers. An AI Employee that reads one is treated as having read outside content,
          so any email it tries to send in the same turn waits for a person. And no AI Employee can reject someone who has
          not been scored against the criteria first.
        </p>
      </div>
    </div>
  );
}
