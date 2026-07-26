import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, CalendarCheck, Check, Clock3, Plus, User, X } from "lucide-react";
import { api, type Employee, type Member } from "../lib/api";
import type { FollowUpItem } from "../lib/revenue";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";

type QueueState = "all" | "overdue" | "today" | "upcoming";

function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function itemUrl(companySlug: string, item: FollowUpItem): string | null {
  if (item.dealId) return `/c/${companySlug}/revenue/deals/${item.dealId}`;
  if (item.partnershipId) {
    return `/c/${companySlug}/revenue/partnerships/${item.partnershipId}`;
  }
  if (item.contactId) return `/c/${companySlug}/revenue/contacts/${item.contactId}`;
  return null;
}

export default function RevenueFollowUps() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { toast } = useToast();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [state, setState] = React.useState<QueueState>("all");
  const [source, setSource] = React.useState("");
  const [assignee, setAssignee] = React.useState("");
  const [priorityFilter, setPriorityFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("open");
  const [closedDeals, setClosedDeals] = React.useState("exclude");
  const [linkedType, setLinkedType] = React.useState("");
  const [linkedId, setLinkedId] = React.useState("");
  const [dueFrom, setDueFrom] = React.useState("");
  const [dueTo, setDueTo] = React.useState("");
  const [staleBefore, setStaleBefore] = React.useState("");
  const [createdBefore, setCreatedBefore] = React.useState("");
  const [dealStatus, setDealStatus] = React.useState("");
  const [dealStageId, setDealStageId] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = React.useState("complete");
  const [bulkValue, setBulkValue] = React.useState("");
  const [bulkPreview, setBulkPreview] = React.useState<{
    matched: number;
    valid: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [rows, setRows] = React.useState<FollowUpItem[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const reload = React.useCallback(async () => {
    const params = new URLSearchParams({ state, limit: "500" });
    if (source) params.set("source", source);
    if (assignee === "unassigned") params.set("unassigned", "true");
    else if (assignee.startsWith("user:")) params.set("assignedUserId", assignee.slice(5));
    else if (assignee.startsWith("employee:")) {
      params.set("assignedEmployeeId", assignee.slice(9));
    }
    if (priorityFilter) params.set("priority", priorityFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (closedDeals) params.set("closedDeals", closedDeals);
    if (linkedType && linkedId) {
      params.set("linkedResourceType", linkedType);
      params.set("linkedResourceId", linkedId);
    }
    if (dueFrom) params.set("dueFrom", new Date(dueFrom).toISOString());
    if (dueTo) params.set("dueTo", new Date(dueTo).toISOString());
    if (staleBefore) params.set("staleBefore", new Date(staleBefore).toISOString());
    if (createdBefore) params.set("createdBefore", new Date(createdBefore).toISOString());
    if (dealStatus) params.set("dealStatus", dealStatus);
    if (dealStageId) params.set("dealStageId", dealStageId);
    const result = await api.get<{ rows: FollowUpItem[] }>(
      `${base}/follow-ups?${params.toString()}`,
    );
    setRows(result.rows);
    setSelected(new Set());
    setLoadError(null);
  }, [
    assignee,
    base,
    closedDeals,
    createdBefore,
    dealStageId,
    dealStatus,
    dueFrom,
    dueTo,
    linkedId,
    linkedType,
    priorityFilter,
    source,
    staleBefore,
    state,
    statusFilter,
  ]);

  React.useEffect(() => {
    reload().catch((error) => {
      setRows([]);
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [reload]);

  React.useEffect(() => {
    void Promise.all([
      api.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => []),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`).catch(() => []),
    ]).then(([memberRows, employeeRows]) => {
      setMembers(memberRows);
      setEmployees(employeeRows);
    });
  }, [company.id]);

  useLiveRefetch(["activity", "deal", "partnership"], reload);

  async function complete(item: FollowUpItem) {
    if (item.source !== "task") return;
    try {
      await api.patch(`${base}/follow-ups/${item.id}`, { taskStatus: "completed" });
      setRows((current) => current?.filter((row) => row.id !== item.id) ?? current);
      toast(item.recurrenceRule ? "Completed and scheduled the next follow-up" : "Follow-up completed", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  function selectedKey(item: FollowUpItem): string {
    return `${item.source}:${item.id}`;
  }

  function toggleSelected(item: FollowUpItem) {
    const key = selectedKey(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setBulkPreview(null);
      return next;
    });
  }

  async function applyBulk(dryRun: boolean) {
    if (selected.size === 0) return;
    const action =
      bulkAction === "complete" || bulkAction === "cancel"
        ? {
            type: "update_follow_up",
            taskStatus: bulkAction === "complete" ? "completed" : "cancelled",
          }
        : bulkAction === "priority"
          ? { type: "update_follow_up", priority: bulkValue }
          : bulkAction === "reschedule"
            ? { type: "update_follow_up", dueAt: new Date(bulkValue).toISOString() }
            : {
                type: "update_follow_up",
                assignedUserId: bulkValue.startsWith("user:") ? bulkValue.slice(5) : null,
                assignedEmployeeId: bulkValue.startsWith("employee:")
                  ? bulkValue.slice(9)
                  : null,
              };
    try {
      const result = await api.post<{
        matched: number;
        valid: number;
        applied: number;
        skipped: number;
        failed: number;
      }>(`${base}/bulk`, {
        resourceType: "follow_up",
        target: {
          followUpIds: [...selected].map((key) => {
            const separator = key.indexOf(":");
            return { source: key.slice(0, separator), id: key.slice(separator + 1) };
          }),
        },
        action,
        dryRun,
        ...(dryRun ? {} : { idempotencyKey: crypto.randomUUID() }),
      });
      if (dryRun) {
        setBulkPreview(result);
        toast(
          `Previewed ${result.matched} follow-ups; ${result.failed} failed validation.`,
          result.failed ? "error" : "success",
        );
      } else {
        toast(`Updated ${result.applied} follow-ups; ${result.failed} failed.`, "success");
        setBulkPreview(null);
        await reload();
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Follow-ups" }]} />
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Follow-ups
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            One queue for due work across tasks, deals, and partnerships.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={15} /> New follow-up
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {(["all", "overdue", "today", "upcoming"] as QueueState[]).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={state === value ? "primary" : "secondary"}
            onClick={() => setState(value)}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </Button>
        ))}
      </div>

      <div className="mb-4 grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-5 dark:border-slate-800 dark:bg-slate-900">
        <Select value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="">All sources</option>
          <option value="task">Tasks</option>
          <option value="deal">Deals</option>
          <option value="partnership">Partnerships</option>
        </Select>
        <Select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
          <option value="">Any assignee</option>
          <option value="unassigned">Unassigned</option>
          {members.map((member) => (
            <option key={member.userId} value={`user:${member.userId}`}>
              {member.name || member.email || "Member"}
            </option>
          ))}
          {employees.map((employee) => (
            <option key={employee.id} value={`employee:${employee.id}`}>
              {employee.name}
            </option>
          ))}
        </Select>
        <Select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
          <option value="">Any priority</option>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </Select>
        <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="open">Open</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <Select value={closedDeals} onChange={(event) => setClosedDeals(event.target.value)}>
          <option value="exclude">Exclude closed Deals</option>
          <option value="include">Include closed Deals</option>
          <option value="only">Closed Deals only</option>
        </Select>
        <Select value={linkedType} onChange={(event) => setLinkedType(event.target.value)}>
          <option value="">Any linked resource</option>
          <option value="account">Account</option>
          <option value="contact">Contact</option>
          <option value="deal">Deal</option>
          <option value="partnership">Partnership</option>
        </Select>
        <Input
          value={linkedId}
          onChange={(event) => setLinkedId(event.target.value)}
          placeholder="Linked resource ID"
        />
        <Input
          type="datetime-local"
          value={dueFrom}
          onChange={(event) => setDueFrom(event.target.value)}
          aria-label="Due from"
        />
        <Input
          type="datetime-local"
          value={dueTo}
          onChange={(event) => setDueTo(event.target.value)}
          aria-label="Due to"
        />
        <Input
          type="datetime-local"
          value={staleBefore}
          onChange={(event) => setStaleBefore(event.target.value)}
          aria-label="Stale due before"
        />
        <Input
          type="datetime-local"
          value={createdBefore}
          onChange={(event) => setCreatedBefore(event.target.value)}
          aria-label="Created before"
        />
        <Select value={dealStatus} onChange={(event) => setDealStatus(event.target.value)}>
          <option value="">Any Deal status</option>
          <option value="open">Open Deals</option>
          <option value="won">Won Deals</option>
          <option value="lost">Lost Deals</option>
        </Select>
        <Input
          value={dealStageId}
          onChange={(event) => setDealStageId(event.target.value)}
          placeholder="Deal Stage ID"
        />
        <Button
          variant="ghost"
          onClick={() => {
            setSource("");
            setAssignee("");
            setPriorityFilter("");
            setStatusFilter("open");
            setClosedDeals("exclude");
            setLinkedType("");
            setLinkedId("");
            setDueFrom("");
            setDueTo("");
            setStaleBefore("");
            setCreatedBefore("");
            setDealStatus("");
            setDealStageId("");
          }}
        >
          <X size={14} /> Clear filters
        </Button>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Select value={bulkAction} onChange={(event) => setBulkAction(event.target.value)}>
            <option value="complete">Complete</option>
            <option value="cancel">Cancel</option>
            <option value="priority">Reprioritize</option>
            <option value="reschedule">Reschedule</option>
            <option value="reassign">Reassign</option>
          </Select>
          {bulkAction === "priority" && (
            <Select value={bulkValue} onChange={(event) => setBulkValue(event.target.value)}>
              <option value="">Choose priority</option>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </Select>
          )}
          {bulkAction === "reschedule" && (
            <Input
              type="datetime-local"
              value={bulkValue}
              onChange={(event) => setBulkValue(event.target.value)}
            />
          )}
          {bulkAction === "reassign" && (
            <Select value={bulkValue} onChange={(event) => setBulkValue(event.target.value)}>
              <option value="">Unassigned</option>
              {members.map((member) => (
                <option key={member.userId} value={`user:${member.userId}`}>
                  {member.name || member.email || "Member"}
                </option>
              ))}
              {employees.map((employee) => (
                <option key={employee.id} value={`employee:${employee.id}`}>
                  {employee.name}
                </option>
              ))}
            </Select>
          )}
          <Button
            size="sm"
            disabled={
              (bulkAction === "priority" || bulkAction === "reschedule") && !bulkValue
            }
            onClick={() => void applyBulk(true)}
          >
            Preview
          </Button>
          <Button
            size="sm"
            disabled={
              (bulkAction === "priority" || bulkAction === "reschedule") && !bulkValue
            }
            onClick={() => void applyBulk(false)}
          >
            Apply
          </Button>
          {bulkPreview && (
            <span className="text-xs text-slate-600 dark:text-slate-300">
              Preview: {bulkPreview.valid} valid, {bulkPreview.skipped} skipped,{" "}
              {bulkPreview.failed} failed
            </span>
          )}
        </div>
      )}

      {loadError && <FormError message={loadError} />}
      {rows === null ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center dark:border-slate-700">
          <CalendarCheck className="mx-auto mb-3 text-slate-400" size={28} />
          <p className="font-medium text-slate-800 dark:text-slate-200">Nothing due here</p>
          <p className="mt-1 text-sm text-slate-500">Your queue is clear for this view.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          {rows.map((item) => {
            const to = itemUrl(company.slug, item);
            return (
              <div
                key={`${item.source}-${item.id}`}
                className="flex flex-wrap items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-0 dark:border-slate-800"
              >
                <input
                  type="checkbox"
                  checked={selected.has(selectedKey(item))}
                  onChange={() => toggleSelected(item)}
                  aria-label={`Select ${item.title}`}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                {item.source === "task" ? (
                  <button
                    type="button"
                    onClick={() => void complete(item)}
                    className="rounded-full border border-slate-300 p-1.5 text-slate-400 hover:border-emerald-500 hover:text-emerald-600 dark:border-slate-600"
                    aria-label={`Complete ${item.title}`}
                  >
                    <Check size={14} />
                  </button>
                ) : (
                  <Clock3 size={17} className={item.overdue ? "text-rose-500" : "text-slate-400"} />
                )}
                <div className="min-w-0 flex-1">
                  {to ? (
                    <Link
                      to={to}
                      className="font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100"
                    >
                      {item.title}
                    </Link>
                  ) : (
                    <p className="font-medium text-slate-900 dark:text-slate-100">{item.title}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    <span className={item.overdue ? "font-medium text-rose-600" : ""}>
                      {item.overdue ? "Overdue · " : ""}
                      {localDateTime(item.dueAt)}
                    </span>
                    <span className="capitalize">{item.source}</span>
                    {item.priority !== "normal" && (
                      <span className="font-medium capitalize">{item.priority}</span>
                    )}
                    {item.assigneeName && (
                      <span className="inline-flex items-center gap-1">
                        {item.assignedEmployeeId ? <Bot size={12} /> : <User size={12} />}
                        {item.assigneeName}
                      </span>
                    )}
                    {item.recurrenceRule && <span>Recurring</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <NewFollowUpModal
        open={creating}
        onClose={() => setCreating(false)}
        base={base}
        members={members}
        employees={employees}
        onCreated={() => {
          setCreating(false);
          void reload();
        }}
      />
    </div>
  );
}

function NewFollowUpModal({
  open,
  onClose,
  base,
  members,
  employees,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  members: Member[];
  employees: Employee[];
  onCreated: () => void;
}) {
  const [subject, setSubject] = React.useState("");
  const [bodyText, setBodyText] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [reminderAt, setReminderAt] = React.useState("");
  const [priority, setPriority] = React.useState("normal");
  const [assignee, setAssignee] = React.useState("");
  const [recurrence, setRecurrence] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const isEmployee = assignee.startsWith("employee:");
      await api.post(`${base}/follow-ups`, {
        subject,
        bodyText,
        dueAt: dueAt || null,
        reminderAt: reminderAt || null,
        priority,
        assignedUserId: assignee.startsWith("user:") ? assignee.slice(5) : null,
        assignedEmployeeId: isEmployee ? assignee.slice(9) : null,
        recurrenceRule: recurrence || null,
      });
      setSubject("");
      setBodyText("");
      setDueAt("");
      setReminderAt("");
      setAssignee("");
      setRecurrence("");
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New follow-up" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <Input label="What needs doing?" value={subject} onChange={(e) => setSubject(e.target.value)} required />
        <Textarea label="Context" value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={3} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required />
          <Input label="Reminder" type="datetime-local" value={reminderAt} onChange={(e) => setReminderAt(e.target.value)} />
          <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
          <Select label="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.userId} value={`user:${member.userId}`}>
                {member.name || member.email || "Member"}
              </option>
            ))}
            {employees.map((employee) => (
              <option key={employee.id} value={`employee:${employee.id}`}>
                {employee.name} · AI Employee
              </option>
            ))}
          </Select>
          <Select label="Repeat" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="">Does not repeat</option>
            <option value="FREQ=DAILY;INTERVAL=1">Daily</option>
            <option value="FREQ=WEEKLY;INTERVAL=1">Weekly</option>
            <option value="FREQ=MONTHLY;INTERVAL=1">Monthly</option>
          </Select>
        </div>
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create follow-up"}</Button>
        </div>
      </form>
    </Modal>
  );
}
