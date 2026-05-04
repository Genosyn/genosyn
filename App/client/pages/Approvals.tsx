import React from "react";
import { Check, Globe, ShieldCheck, X, Zap } from "lucide-react";
import { api, Approval, ApprovalKind, ApprovalStatus, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";

/**
 * Company-wide approvals inbox. Today the inbox holds two flavors:
 *
 *   - **Routine approvals** — cron tick for a routine marked
 *     `requiresApproval`. Approve runs the routine; reject writes a
 *     system journal entry.
 *   - **Payment approvals** — Lightning payments above a Connection's
 *     `requireApprovalAboveSats` threshold. Approve replays the original
 *     `pay_invoice` / `pay_keysend` call against the same Connection;
 *     reject writes a journal entry on the requesting employee's diary.
 *
 * Decided rows stick around so the inbox doubles as a recent history of
 * what was gated and what the human decided.
 */

const STATUS_STYLE: Record<ApprovalStatus, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
  expired: "bg-slate-50 text-slate-600 border-slate-200",
};

type ApprovalCopy = {
  title: string;
  subtitle: string;
  Icon: typeof ShieldCheck;
  iconClass: string;
  approvedToast: string;
};

function copyFor(a: Approval): ApprovalCopy {
  switch (a.kind as ApprovalKind) {
    case "lightning_payment":
      return {
        title: a.title ?? "Lightning payment",
        subtitle: a.summary ?? "Send a Lightning payment",
        Icon: Zap,
        iconClass: "text-amber-500",
        approvedToast: "Approved — sending payment",
      };
    case "browser_action":
      return {
        title: a.title ?? "Browser submit",
        subtitle: a.summary ?? "AI employee wants to submit a form",
        Icon: Globe,
        iconClass: "text-indigo-500",
        // Browser actions don't run server-side — the model retries via
        // browser_resume once it sees the row flip to approved.
        approvedToast: "Approved — the AI will retry the submission",
      };
    case "routine":
    default:
      return {
        title: a.routine?.name ?? "(deleted routine)",
        subtitle: "Run scheduled routine",
        Icon: ShieldCheck,
        iconClass: "text-amber-600",
        approvedToast: "Approved — running now",
      };
  }
}

export default function Approvals({ company }: { company: Company }) {
  const [rows, setRows] = React.useState<Approval[] | null>(null);
  const { toast } = useToast();
  const base = `/api/companies/${company.id}/approvals`;

  async function reload() {
    try {
      const list = await api.get<Approval[]>(base);
      setRows(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setRows([]);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  async function decide(row: Approval, action: "approve" | "reject") {
    try {
      const updated = await api.post<Approval & { executeError?: string }>(
        `${base}/${row.id}/${action}`,
      );
      if (action === "approve" && updated.executeError) {
        toast(`Approved, but execute failed: ${updated.executeError}`, "error");
      } else {
        toast(action === "approve" ? copyFor(row).approvedToast : "Rejected", "success");
      }
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const pending = rows?.filter((r) => r.status === "pending") ?? [];
  const history = rows?.filter((r) => r.status !== "pending") ?? [];

  return (
    <div className="mx-auto max-w-5xl p-8">
      <TopBar title="Approvals" />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No approvals yet"
          description="Routines that require approval and Lightning payments above their Connection's safety threshold show up here for a human to decide."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Pending ({pending.length})
            </div>
            {pending.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Nothing waiting.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {pending.map((a) => {
                  const c = copyFor(a);
                  return (
                    <li key={a.id}>
                      <Card>
                        <CardBody className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                              <c.Icon size={14} className={c.iconClass} />
                              {c.title}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {a.employee?.name ?? "(deleted employee)"} · {c.subtitle} ·
                              requested {new Date(a.requestedAt).toLocaleString()}
                            </div>
                          </div>
                          <div className="flex gap-1">
                            <Button size="sm" onClick={() => decide(a, "approve")}>
                              <Check size={14} /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => decide(a, "reject")}
                            >
                              <X size={14} /> Reject
                            </Button>
                          </div>
                        </CardBody>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {history.length > 0 && (
            <section>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                History
              </div>
              <ul className="flex flex-col gap-1">
                {history.map((a) => {
                  const c = copyFor(a);
                  return (
                    <li key={a.id}>
                      <div className="flex items-center gap-2 rounded-md border border-slate-100 bg-white px-3 py-2 text-xs dark:bg-slate-900 dark:border-slate-800">
                        <span
                          className={
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                            STATUS_STYLE[a.status]
                          }
                        >
                          {a.status}
                        </span>
                        <c.Icon size={12} className={c.iconClass} />
                        <span className="truncate text-slate-700 dark:text-slate-200">
                          {c.title}
                        </span>
                        <span className="text-slate-400 dark:text-slate-500">·</span>
                        <span className="truncate text-slate-500 dark:text-slate-400">
                          {a.employee?.name ?? "(deleted employee)"}
                        </span>
                        {a.errorMessage ? (
                          <span className="truncate text-rose-600 dark:text-rose-400">
                            · {a.errorMessage}
                          </span>
                        ) : null}
                        <span className="ml-auto text-slate-400 dark:text-slate-500">
                          {a.decidedAt
                            ? new Date(a.decidedAt).toLocaleString()
                            : new Date(a.requestedAt).toLocaleString()}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
