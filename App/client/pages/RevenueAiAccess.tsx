import React from "react";
import { useOutletContext } from "react-router-dom";
import { Bot, Eye, Pencil, Send } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  AiAccessGrantsCard,
  AiAccessLevelLadder,
  type AiAccessLevel,
} from "../components/AiAccessGrants";
import { useLiveRefetch } from "../components/CompanySocket";
import { Breadcrumbs } from "../components/AppShell";
import { useBackgroundAction } from "../components/ui/Dialog";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * Revenue → AI access. Company-wide grant surface deciding which AI employees
 * may work the revenue system — contacts, deals, activities, sequences, signals
 * and the revenue reports — and at what level (read &lt; write &lt; send).
 *
 * Mirrors the Finance AI-access page deliberately: both draw the same ladder,
 * level picker and grants card from `components/AiAccessGrants.tsx`, with the
 * same optimistic-with-rollback mutations. The one difference that matters is
 * the top of the ladder. `send` is the only level anywhere in the product that
 * lets mail leave the building with nobody watching, so its blurb says so
 * plainly rather than describing itself as "full access".
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

const LEVELS: AiAccessLevel<RevenueAccessLevel>[] = [
  {
    value: "read",
    label: "Read only",
    tagline: "See deals",
    hint: "Inspect CRM records, import reports, documents, activity history, Deal Stages, sequences, signals, and revenue reports. Changes nothing.",
    icon: <Eye size={15} />,
    iconColor: "text-slate-500 dark:text-slate-400",
    iconWrap: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  },
  {
    value: "write",
    label: "Write",
    tagline: "Work deals",
    hint: "Everything in Read, plus administer CRM fields and classifications, own and work records, correct manual activity, manage Deal Stages, sequences, signals, documents, and linked Base migrations.",
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

export default function RevenueAiAccess() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const background = useBackgroundAction();
  const [grants, setGrants] = React.useState<RevenueGrant[] | null>(null);
  const [candidates, setCandidates] = React.useState<RevenueGrantCandidate[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  // The server enforces this on every mutation; leaving the controls out here
  // just stops a member from composing a change that is going to be refused.
  const canManage = company.role !== "member";

  const reload = React.useCallback(async () => {
    try {
      const res = await api.get<{
        grants: RevenueGrant[];
        candidates: RevenueGrantCandidate[];
      }>(`${base}/ai-access`);
      setGrants(res.grants);
      setCandidates(res.candidates);
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

  async function addGrant(employeeId: string, accessLevel: RevenueAccessLevel) {
    // PUT keyed by employee — one grant row per employee, so the caller states
    // the level it should hold rather than asking whether one exists first.
    await api.put(`${base}/ai-access/${employeeId}`, { accessLevel });
    await reload();
  }

  function changeLevel(grant: RevenueGrant, level: RevenueAccessLevel) {
    setGrants(
      (current) =>
        current?.map((item) => (item.id === grant.id ? { ...item, accessLevel: level } : item)) ??
        current,
    );
    background(() => api.put(`${base}/ai-access/${grant.employeeId}`, { accessLevel: level }), {
      title: "Couldn’t update access",
      error: (error) => `${errorMessage(error)} The change was undone.`,
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
      <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "AI access" }]} />

      <div className="mt-5 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Bot size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI access
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Choose which AI Employees may work the company&apos;s revenue system, and how far they
            can go. Members reach Revenue through the app as usual &mdash; this only governs what AI
            Employees can do through their tools.
          </p>
        </div>
      </div>

      <div className="mt-8">
        <AiAccessGrantsCard
          company={company}
          section="revenue"
          levels={LEVELS}
          grants={grants}
          candidates={candidates}
          loadError={loadError}
          onRetry={reload}
          canManage={canManage}
          readOnlyNote="Only owners and admins can change these grants. Everyone else can see who has been given what, which is the point of showing it here rather than hiding it."
          emptyHint="Start with Read only, then promote to Write when you want an employee to keep deals up to date on its own."
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
