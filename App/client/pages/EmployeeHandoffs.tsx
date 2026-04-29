import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  CheckCircle2,
  Clock,
  Inbox,
  Send,
  XCircle,
  Undo2,
} from "lucide-react";
import {
  api,
  Company,
  Employee,
  Handoff,
  HandoffStatus,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";

type EmpCtx = { company: Company; emp: Employee };

function statusBadge(status: HandoffStatus) {
  switch (status) {
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          <Clock size={10} /> Pending
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
          <CheckCircle2 size={10} /> Completed
        </span>
      );
    case "declined":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
          <XCircle size={10} /> Declined
        </span>
      );
    case "cancelled":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          <Undo2 size={10} /> Cancelled
        </span>
      );
  }
}

export function HandoffsPage() {
  const { company, emp } = useOutletContext<EmpCtx>();
  const [direction, setDirection] = React.useState<"incoming" | "outgoing">(
    "incoming",
  );
  const [statusFilter, setStatusFilter] = React.useState<HandoffStatus | "all">(
    "all",
  );
  const [rows, setRows] = React.useState<Handoff[] | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [transitioning, setTransitioning] = React.useState<Handoff | null>(
    null,
  );
  const [transitionAction, setTransitionAction] = React.useState<
    "complete" | "decline" | "cancel" | null
  >(null);
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    const params = new URLSearchParams({
      employeeId: emp.id,
      direction,
    });
    if (statusFilter !== "all") params.set("status", statusFilter);
    try {
      const list = await api.get<Handoff[]>(
        `/api/companies/${company.id}/handoffs?${params.toString()}`,
      );
      setRows(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setRows([]);
    }
  }, [company.id, emp.id, direction, statusFilter, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return (
    <>
      <TopBar
        title="Handoffs"
        right={
          <Button onClick={() => setCreating(true)}>
            <Send size={14} /> New handoff
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700">
              <button
                type="button"
                className={`flex items-center gap-1 px-3 py-1.5 text-xs ${
                  direction === "incoming"
                    ? "bg-slate-100 font-medium dark:bg-slate-800"
                    : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                }`}
                onClick={() => setDirection("incoming")}
              >
                <Inbox size={12} /> Inbox
              </button>
              <button
                type="button"
                className={`flex items-center gap-1 border-l border-slate-200 px-3 py-1.5 text-xs dark:border-slate-700 ${
                  direction === "outgoing"
                    ? "bg-slate-100 font-medium dark:bg-slate-800"
                    : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                }`}
                onClick={() => setDirection("outgoing")}
              >
                <Send size={12} /> Sent
              </button>
            </div>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as HandoffStatus | "all")
              }
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="declined">Declined</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </CardHeader>
        <CardBody>
          {rows === null ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title={
                direction === "incoming"
                  ? "Nothing in your inbox"
                  : "Nothing sent"
              }
              description={
                direction === "incoming"
                  ? "Handoffs delegated to this employee show up here."
                  : "Work this employee has delegated to others appears here."
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((h) => {
                const counterparty =
                  direction === "incoming" ? h.from : h.to;
                return (
                  <li
                    key={h.id}
                    className="flex flex-col gap-2 py-3 text-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {statusBadge(h.status)}
                          <span className="truncate font-medium">
                            {h.title}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {direction === "incoming" ? "From " : "To "}
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            {counterparty?.name ?? "(unknown)"}
                          </span>
                          {" · "}
                          {new Date(h.createdAt).toLocaleString()}
                          {h.dueAt
                            ? ` · due ${new Date(h.dueAt).toLocaleString()}`
                            : ""}
                        </div>
                        {h.body && (
                          <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-xs text-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
                            {h.body}
                          </pre>
                        )}
                        {h.resolutionNote && (
                          <div className="mt-2 rounded border border-slate-200 bg-white p-2 text-xs dark:border-slate-700 dark:bg-slate-900">
                            <div className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                              Resolution
                            </div>
                            <div className="mt-1 whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                              {h.resolutionNote}
                            </div>
                          </div>
                        )}
                      </div>
                      {h.status === "pending" && (
                        <div className="flex shrink-0 gap-1">
                          {direction === "incoming" ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setTransitioning(h);
                                  setTransitionAction("complete");
                                }}
                              >
                                Complete
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setTransitioning(h);
                                  setTransitionAction("decline");
                                }}
                              >
                                Decline
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setTransitioning(h);
                                setTransitionAction("cancel");
                              }}
                            >
                              Cancel
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {creating && (
        <NewHandoffModal
          company={company}
          fromEmployee={emp}
          onClose={(saved) => {
            setCreating(false);
            if (saved) reload();
          }}
        />
      )}
      {transitioning && transitionAction && (
        <TransitionHandoffModal
          companyId={company.id}
          handoff={transitioning}
          action={transitionAction}
          onClose={(saved) => {
            setTransitioning(null);
            setTransitionAction(null);
            if (saved) reload();
          }}
        />
      )}
    </>
  );
}

function NewHandoffModal({
  company,
  fromEmployee,
  onClose,
}: {
  company: Company;
  fromEmployee: Employee;
  onClose: (saved: boolean) => void;
}) {
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [toEmployeeId, setToEmployeeId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        const filtered = list.filter((e) => e.id !== fromEmployee.id);
        setEmployees(filtered);
        if (filtered[0]) setToEmployeeId(filtered[0].id);
      })
      .catch((err) => setError((err as Error).message));
  }, [company.id, fromEmployee.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!toEmployeeId || !title.trim() || saving) return;
    setError(null);
    setSaving(true);
    try {
      await api.post(`/api/companies/${company.id}/handoffs`, {
        fromEmployeeId: fromEmployee.id,
        toEmployeeId,
        title: title.trim(),
        body: body.trim() || undefined,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
      toast("Handoff created", "success");
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title={`Hand off from ${fromEmployee.name}`}
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <FormError message={error} />
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-slate-700 dark:text-slate-300">
            To
          </span>
          <select
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={toEmployeeId}
            onChange={(e) => setToEmployeeId(e.target.value)}
            disabled={!employees}
            required
          >
            {employees === null ? (
              <option>Loading…</option>
            ) : employees.length === 0 ? (
              <option value="">No other employees</option>
            ) : (
              employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.role})
                </option>
              ))
            )}
          </select>
        </label>
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Investigate Stripe webhook 500s"
          required
        />
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-slate-700 dark:text-slate-300">
            Brief (markdown)
          </span>
          <textarea
            className="min-h-[120px] rounded-md border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Context, what's already tried, what success looks like."
          />
        </label>
        <Input
          label="Due (optional)"
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!toEmployeeId || !title.trim() || saving}
          >
            {saving ? "Sending…" : "Send handoff"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TransitionHandoffModal({
  companyId,
  handoff,
  action,
  onClose,
}: {
  companyId: string;
  handoff: Handoff;
  action: "complete" | "decline" | "cancel";
  onClose: (saved: boolean) => void;
}) {
  const [note, setNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();
  const labels = {
    complete: { title: "Mark as completed", verb: "Complete" },
    decline: { title: "Decline this handoff", verb: "Decline" },
    cancel: { title: "Cancel this handoff", verb: "Cancel" },
  } as const;
  const label = labels[action];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(
        `/api/companies/${companyId}/handoffs/${handoff.id}/${action === "complete" ? "complete" : action}`,
        { resolutionNote: note.trim() || undefined },
      );
      toast(`Handoff ${action}d`, "success");
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={() => onClose(false)} title={label.title}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <FormError message={error} />
        <div className="text-sm">
          <div className="font-medium">{handoff.title}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            From {handoff.from?.name ?? "(unknown)"} → {handoff.to?.name ?? "(unknown)"}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-slate-700 dark:text-slate-300">
            Resolution note (optional)
          </span>
          <textarea
            className="min-h-[100px] rounded-md border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              action === "complete"
                ? "What you did. Both sides see this in their journal."
                : action === "decline"
                  ? "Why you can't take this. Suggest who should."
                  : "Why you're cancelling."
            }
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Back
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : label.verb}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
