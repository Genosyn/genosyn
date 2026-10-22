import React from "react";
import { useOutletContext } from "react-router-dom";
import { Bot, Eye, FileText, ShieldCheck } from "lucide-react";
import {
  AiAccessGrantsCard,
  AiAccessLevelLadder,
  type AiAccessLevel,
} from "../components/AiAccessGrants";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { useBackgroundAction } from "../components/ui/Dialog";
import {
  api,
  FinanceAccessLevel,
  FinanceGrant,
  FinanceGrantCandidate,
  FinanceGrantsResponse,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Finance → AI access. Company-wide grant surface deciding which AI Employees
 * may work the finance system (invoices, customers, payments, the books) and
 * at what level (read < invoice < full). Revenue → AI access is the same page
 * on purpose: both draw it from `components/AiAccessGrants.tsx`, and each
 * level is colour-coded so a long roster stays scannable at a glance.
 */

const LEVELS: AiAccessLevel<FinanceAccessLevel>[] = [
  {
    value: "read",
    label: "Read only",
    tagline: "View the books",
    hint: "List and open estimates, invoices, customers, statements, reports, and posted transactions. Changes nothing.",
    icon: <Eye size={15} />,
    iconColor: "text-slate-500 dark:text-slate-400",
    iconWrap: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  },
  {
    value: "invoice",
    label: "Invoicing",
    tagline: "Run accounts receivable",
    hint: "Everything in Read, plus create, issue, and email estimates; manage recurring invoice schedules; issue, email, and void invoices; manage customers; and record payments.",
    icon: <FileText size={15} />,
    iconColor: "text-indigo-500 dark:text-indigo-400",
    iconWrap: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300",
  },
  {
    value: "full",
    label: "Full accounting",
    tagline: "Books + ledger review",
    hint: "Everything in Invoicing, plus staging ledger re-categorizations for a human to approve. Final approval always stays with a human.",
    icon: <ShieldCheck size={15} />,
    iconColor: "text-emerald-500 dark:text-emerald-400",
    iconWrap: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
];

export default function FinanceAiAccess() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  // Only owners and admins may grant, change, or revoke an employee's finance
  // access — the server refuses anyone else, whatever their own Finance
  // access. Everyone else sees who holds which level, read-only.
  const canManage = company.role === "owner" || company.role === "admin";
  const background = useBackgroundAction();
  const [grants, setGrants] = React.useState<FinanceGrant[] | null>(null);
  const [candidates, setCandidates] = React.useState<FinanceGrantCandidate[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const base = `/api/companies/${company.id}/finance`;

  const reload = React.useCallback(async () => {
    try {
      const [grantRows, candidateRows] = await Promise.all([
        api.get<FinanceGrantsResponse>(`${base}/grants`),
        api.get<FinanceGrantCandidate[]>(`${base}/grant-candidates`),
      ]);
      setGrants(grantRows.direct);
      setCandidates(candidateRows);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the grants"));
      setGrants([]);
    }
  }, [base]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("grant", reload);

  async function addGrant(employeeId: string, accessLevel: FinanceAccessLevel) {
    await api.post(`${base}/grants`, { employeeId, accessLevel });
    await reload();
  }

  function changeLevel(grant: FinanceGrant, level: FinanceAccessLevel) {
    setGrants(
      (current) =>
        current?.map((item) => (item.id === grant.id ? { ...item, accessLevel: level } : item)) ??
        current,
    );
    background(() => api.patch(`${base}/grants/${grant.id}`, { accessLevel: level }), {
      title: "Couldn’t update access",
      error: (error) => `${errorMessage(error)} The change was undone.`,
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
      title: "Couldn’t revoke access",
      error: (error) => `${errorMessage(error)} The grant has been restored.`,
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
    <div className="page-shell p-4 sm:p-8">
      <Breadcrumbs
        items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "AI access" }]}
      />

      <div className="mt-5 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Bot size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI access
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Choose which AI Employees may work the company&apos;s finance system, and how far they
            can go. Members reach Finance through the app as usual &mdash; this only governs what AI
            Employees can do through their tools.
          </p>
        </div>
      </div>

      <div className="mt-8">
        <AiAccessGrantsCard
          company={company}
          section="finance"
          levels={LEVELS}
          grants={grants}
          candidates={candidates}
          loadError={loadError}
          onRetry={reload}
          canManage={canManage}
          readOnlyNote="Only owners and admins can change AI Employees' finance access."
          emptyHint="Start with Read only, then promote to Invoicing when you want an employee to bill customers on its own."
          onAdd={addGrant}
          onChangeLevel={changeLevel}
          onRevoke={revoke}
        />
      </div>

      <div className="mt-10">
        <AiAccessLevelLadder levels={LEVELS} />
      </div>
    </div>
  );
}
