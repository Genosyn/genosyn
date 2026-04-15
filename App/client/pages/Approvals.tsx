import React from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import { api, Approval, ApprovalStatus, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";

/**
 * Company-wide approvals inbox. Cron ticks for routines marked
 * `requiresApproval` land here as `pending`. Humans approve (the routine
 * runs now) or reject (nothing runs; a system journal entry is written).
 *
 * Rejected/approved rows stick around so the inbox doubles as a recent
 * history of what was gated and what the human decided.
 */

const STATUS_STYLE: Record<ApprovalStatus, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
  expired: "bg-slate-50 text-slate-600 border-slate-200",
};

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

  async function decide(id: string, action: "approve" | "reject") {
    try {
      await api.post(`${base}/${id}/${action}`);
      toast(action === "approve" ? "Approved — running now" : "Rejected", "success");
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
          description="When a routine with 'Require approval' fires on its schedule, it shows up here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              Pending ({pending.length})
            </div>
            {pending.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                Nothing waiting.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {pending.map((a) => (
                  <li key={a.id}>
                    <Card>
                      <CardBody className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                            <ShieldCheck size={14} className="text-amber-600" />
                            {a.routine?.name ?? "(deleted routine)"}
                          </div>
                          <div className="text-xs text-slate-500">
                            {a.employee?.name ?? "(deleted employee)"} · requested{" "}
                            {new Date(a.requestedAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Button size="sm" onClick={() => decide(a.id, "approve")}>
                            <Check size={14} /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => decide(a.id, "reject")}
                          >
                            <X size={14} /> Reject
                          </Button>
                        </div>
                      </CardBody>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {history.length > 0 && (
            <section>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                History
              </div>
              <ul className="flex flex-col gap-1">
                {history.map((a) => (
                  <li key={a.id}>
                    <div className="flex items-center gap-2 rounded-md border border-slate-100 bg-white px-3 py-2 text-xs">
                      <span
                        className={
                          "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                          STATUS_STYLE[a.status]
                        }
                      >
                        {a.status}
                      </span>
                      <span className="truncate text-slate-700">
                        {a.routine?.name ?? "(deleted routine)"}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="truncate text-slate-500">
                        {a.employee?.name ?? "(deleted employee)"}
                      </span>
                      <span className="ml-auto text-slate-400">
                        {a.decidedAt
                          ? new Date(a.decidedAt).toLocaleString()
                          : new Date(a.requestedAt).toLocaleString()}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
