import React from "react";
import { useOutletContext } from "react-router-dom";
import { Eye, FilePenLine, Send, ShieldCheck } from "lucide-react";

import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { SkeletonList } from "@/components/ui/Skeleton";
import { errorMessage } from "@/lib/errors";
import { canOpenSubpage, subpageAt } from "@/lib/subpages";
import { supportApi, type SupportGrantRow } from "@/lib/support";
import {
  SUPPORT_ACCESS_HINTS,
  SUPPORT_ACCESS_LABELS,
  SUPPORT_ACCESS_LEVELS,
  type SupportAccessLevel,
} from "../../shared/support";
import type { SupportOutletContext } from "./SupportLayout";

const LEVEL_ICONS: Record<SupportAccessLevel, React.ReactNode> = {
  read: <Eye size={15} />,
  prepare: <FilePenLine size={15} />,
  reply: <Send size={15} />,
};

export default function SupportAiAccess() {
  const { company } = useOutletContext<SupportOutletContext>();
  if (!canOpenSubpage(subpageAt("/support/ai-access"), company)) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <EmptyState
          title="Owners and admins only"
          description="Ask an owner or admin to change which AI Employees can work with Support."
        />
      </div>
    );
  }
  return <AccessTable />;
}

function AccessTable() {
  const { company } = useOutletContext<SupportOutletContext>();
  const dialog = useDialog();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);
  const [rows, setRows] = React.useState<SupportGrantRow[] | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setRows((await api.grants()).rows);
  }, [api]);

  const firstLoad = React.useCallback(() => {
    setLoadError("");
    load().catch((err: unknown) => setLoadError(errorMessage(err, "Could not load AI access")));
  }, [load]);

  React.useEffect(() => {
    firstLoad();
  }, [firstLoad]);

  async function setAccess(row: SupportGrantRow, level: string) {
    setBusy(row.employee.id);
    try {
      if (!level) await api.removeGrant(row.employee.id);
      else await api.setGrant(row.employee.id, level as SupportAccessLevel);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update Support access" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        breadcrumbs={[
          { label: "Support", to: `/c/${company.slug}/support` },
          { label: "AI access" },
        ]}
        title="AI access"
        description="Which AI Employees may work with tickets through their own tools, and how far. The AI Employee working an inbox needs none of this to triage and draft there."
      />
      {loadError ? (
        <EmptyState
          title="AI access could not be loaded"
          description={loadError}
          action={<Button onClick={firstLoad}>Try again</Button>}
        />
      ) : rows === null ? (
        <SkeletonList rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No AI Employees yet"
          description="Hire an AI Employee before giving it Support access."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_11rem] gap-4 border-b border-slate-100 bg-slate-50/80 px-5 py-2.5 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
            <span>AI Employee</span>
            <span>Support access</span>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <div
                key={row.employee.id}
                className="grid grid-cols-[minmax(0,1fr)_11rem] items-center gap-4 px-5 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar
                    src={employeeAvatarUrl(company.id, row.employee.id, row.employee.avatarKey)}
                    name={row.employee.name}
                    kind="ai"
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {row.employee.name}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {row.employee.role}
                    </div>
                  </div>
                </div>
                <Select
                  aria-label={`Support access for ${row.employee.name}`}
                  value={row.grant?.accessLevel ?? ""}
                  disabled={busy === row.employee.id}
                  onChange={(event) => void setAccess(row, event.target.value)}
                >
                  <option value="">No access</option>
                  {SUPPORT_ACCESS_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {SUPPORT_ACCESS_LABELS[level]}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {SUPPORT_ACCESS_LEVELS.map((level) => (
          <Card key={level} className="p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              {LEVEL_ICONS[level]} {SUPPORT_ACCESS_LABELS[level]}
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {SUPPORT_ACCESS_HINTS[level]}
            </p>
          </Card>
        ))}
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
        <ShieldCheck size={18} className="mt-0.5 shrink-0" />
        <p>
          A ticket holds what a stranger wrote. An AI Employee that reads one is treated as having
          read outside content, so a reply it tries to send in the same turn waits for a person.
          Replies that go out on their own come only from the inbox&apos;s restricted turn, which
          has no tools and reads nothing but the ticket and your published Articles.
        </p>
      </div>
    </div>
  );
}
