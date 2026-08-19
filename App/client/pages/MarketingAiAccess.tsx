import React from "react";
import { useOutletContext } from "react-router-dom";
import { Bot, Eye, ShieldCheck, Sparkles } from "lucide-react";

import { Select } from "@/components/ui/Select";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import type { MarketingGrantRow } from "../lib/marketing";
import type { MarketingOutletCtx } from "./MarketingLayout";
import { LoadingPage, PageHeader, cardClass, inputClass } from "./MarketingShared";

export function MarketingAiAccessPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<MarketingGrantRow[] | null>(null);

  const load = React.useCallback(async () => {
    const result = await api.get<{ rows: MarketingGrantRow[] }>(
      `/api/companies/${company.id}/marketing/ai-access`,
    );
    setRows(result.rows);
  }, [company.id]);

  React.useEffect(() => {
    load().catch((err: Error) => toast(err.message, "error"));
  }, [load, toast]);

  async function setAccess(row: MarketingGrantRow, accessLevel: string) {
    try {
      if (!accessLevel && row.grant) {
        await api.del(`/api/companies/${company.id}/marketing/ai-access/${row.grant.id}`);
      } else if (accessLevel) {
        await api.put(
          `/api/companies/${company.id}/marketing/ai-access/${row.employee.id}`,
          { accessLevel },
        );
      }
      await load();
      toast("Marketing access updated", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update access", "error");
    }
  }

  if (!rows) return <LoadingPage />;

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Delegation"
        title="AI access"
        description="Marketing access controls the internal agency workspace. External ad accounts still require separate Connection Grants."
      />

      <div className={`${cardClass} overflow-hidden`}>
        <div className="grid grid-cols-[1fr_10rem] gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950">
          <span>AI Employee</span>
          <span>Marketing access</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-500">
            Hire an AI Employee before delegating Marketing.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <div
                key={row.employee.id}
                className="grid grid-cols-[1fr_10rem] items-center gap-4 px-5 py-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar
                    src={employeeAvatarUrl(company.id, row.employee.id, row.employee.avatarKey)}
                    name={row.employee.name}
                    kind="ai"
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
                      {row.employee.name}
                    </div>
                    <div className="truncate text-xs text-slate-500">{row.employee.role}</div>
                  </div>
                </div>
                <Select
                  className={inputClass}
                  value={row.grant?.accessLevel ?? ""}
                  onChange={(event) => setAccess(row, event.target.value)}
                >
                  <option value="">No access</option>
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="operate">Operate</option>
                </Select>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {(
          [
            ["Read", "Inspect Campaigns, Creative, Experiments, and performance.", Eye],
            ["Write", "Build strategy, draft Creative, and design Experiments.", Sparkles],
            ["Operate", "Launch workspace states, decide tests, and record live results.", Bot],
          ] as Array<[string, string, React.ElementType]>
        ).map(([title, body, Icon]) => (
          <div key={String(title)} className={`${cardClass} p-4`}>
            <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
              {React.createElement(Icon as React.ElementType, { size: 15 })} {title}
            </div>
            <p className="mt-1 text-xs text-slate-500">{body}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
        <ShieldCheck size={18} className="mt-0.5 shrink-0" />
        <p>
          Operate access never bypasses platform controls. Grant the relevant ad Connection
          separately, then set its Approval threshold, per-change cap, rolling caps, and kill
          switch.
        </p>
      </div>
    </div>
  );
}
