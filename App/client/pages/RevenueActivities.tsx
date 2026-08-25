import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Download, Pencil, Search, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  activityKindLabel,
  type RevenueActivity,
  type RevenueActivityKind,
} from "../components/revenue/ActivityTimeline";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { RevenueOutletCtx } from "./RevenueLayout";

type ActivityRow = RevenueActivity & {
  partnershipId: string | null;
};

const ACTIVITY_KINDS: RevenueActivityKind[] = [
  "email_in",
  "email_out",
  "call",
  "meeting",
  "note",
  "task",
  "deal_created",
  "stage_change",
  "deal_won",
  "deal_lost",
  "enrollment",
  "sequence_step",
  "unsubscribe",
  "bounce",
  "signal",
];
const MANUAL_KINDS = new Set<RevenueActivityKind>(["note", "call", "meeting", "task"]);

function localDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function RevenueActivities() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const baseUrl = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const dialog = useDialog();
  const [rows, setRows] = React.useState<ActivityRow[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [filters, setFilters] = React.useState({ query: "", kind: "", from: "", to: "" });
  const [selected, setSelected] = React.useState<ActivityRow | null>(null);
  const [edit, setEdit] = React.useState<ActivityRow | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const params = React.useMemo(() => {
    const next = new URLSearchParams({ limit: "200" });
    if (filters.query) next.set("q", filters.query);
    if (filters.kind) next.set("kinds", filters.kind);
    if (filters.from) next.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
    if (filters.to) next.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
    return next;
  }, [filters]);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      const result = await api.get<{ rows: ActivityRow[]; total: number }>(
        `${baseUrl}/activities?${params}`,
      );
      setRows(result.rows);
      setTotal(result.total);
    } catch (cause) {
      setRows([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [baseUrl, params]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  async function openActivity(id: string) {
    setError(null);
    setDeleteError(null);
    try {
      setSelected(await api.get<ActivityRow>(`${baseUrl}/activities/${id}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function removeActivity(activity: ActivityRow) {
    setDeleteError(null);
    const confirmed = await dialog.confirm({
      title: "Delete this activity?",
      message:
        "This removes the manually logged item and recalculates the linked record’s latest activity date.",
      confirmLabel: "Delete activity",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(`${baseUrl}/activities/${activity.id}`);
      setSelected(null);
      await reload();
    } catch (cause) {
      setDeleteError(errorMessage(cause));
    }
  }

  const exportUrl = `${baseUrl}/activities/export?${params}`;

  return (
    <div className="page-shell p-8">
      <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Activities" }]} />
      <div className="mt-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Activity audit
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            Search the company-wide Revenue history, inspect an activity by ID, and export the
            filtered result. Machine-recorded evidence stays immutable.
          </p>
        </div>
        <a
          href={exportUrl}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
        >
          <Download size={14} /> Export CSV
        </a>
      </div>

      {error && (
        <div className="mt-4">
          <FormError message={error} />
        </div>
      )}

      <form
        className="mt-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end dark:border-slate-700 dark:bg-slate-900"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ query: query.trim(), kind, from, to });
        }}
      >
        <Input
          label="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Subject or body"
        />
        <Select label="Kind" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">All kinds</option>
          {ACTIVITY_KINDS.map((value) => (
            <option key={value} value={value}>
              {activityKindLabel(value)}
            </option>
          ))}
        </Select>
        <Input
          label="From"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Input label="To" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <Button type="submit">
          <Search size={14} /> Search
        </Button>
      </form>

      <section className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-4 py-3 text-xs text-slate-500 dark:border-slate-800">
          Showing {rows?.length ?? 0} of {total.toLocaleString()} activities
        </div>
        {rows === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-500">
            No activities match these filters.
          </div>
        ) : (
          rows.map((activity) => (
            <button
              key={activity.id}
              type="button"
              onClick={() => void openActivity(activity.id)}
              className="flex w-full flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
            >
              <span className="w-32 shrink-0 text-xs font-medium text-slate-500">
                {activityKindLabel(activity.kind)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-200">
                {activity.subject || activity.bodyText || "Untitled activity"}
              </span>
              <span className="text-xs text-slate-500">
                {new Date(activity.occurredAt).toLocaleString()}
              </span>
              <span className="font-mono text-[11px] text-slate-400">{activity.id}</span>
            </button>
          ))
        )}
      </section>

      <Modal
        open={Boolean(selected)}
        onClose={() => {
          setSelected(null);
          setDeleteError(null);
        }}
        title={selected ? activityKindLabel(selected.kind) : "Activity"}
        size="lg"
      >
        {selected && (
          <div className="space-y-4">
            <div>
              <p className="text-lg font-medium text-slate-900 dark:text-slate-100">
                {selected.subject || "Untitled activity"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {new Date(selected.occurredAt).toLocaleString()} · {selected.id}
              </p>
            </div>
            {selected.bodyText && (
              <p className="whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">
                {selected.bodyText}
              </p>
            )}
            <div className="flex flex-wrap gap-2 text-xs">
              {selected.contactId && (
                <Link
                  to={`${sectionUrl}/contacts/${selected.contactId}`}
                  className="rounded bg-slate-100 px-2 py-1 text-indigo-600 dark:bg-slate-800 dark:text-indigo-300"
                >
                  Contact
                </Link>
              )}
              {selected.dealId && (
                <Link
                  to={`${sectionUrl}/deals/${selected.dealId}`}
                  className="rounded bg-slate-100 px-2 py-1 text-indigo-600 dark:bg-slate-800 dark:text-indigo-300"
                >
                  Deal
                </Link>
              )}
              {selected.customerId && (
                <Link
                  to={`${sectionUrl}/accounts/${selected.customerId}`}
                  className="rounded bg-slate-100 px-2 py-1 text-indigo-600 dark:bg-slate-800 dark:text-indigo-300"
                >
                  Account
                </Link>
              )}
              {selected.partnershipId && (
                <Link
                  to={`${sectionUrl}/partnerships/${selected.partnershipId}`}
                  className="rounded bg-slate-100 px-2 py-1 text-indigo-600 dark:bg-slate-800 dark:text-indigo-300"
                >
                  Partnership
                </Link>
              )}
            </div>
            <FormError message={deleteError} />
            {MANUAL_KINDS.has(selected.kind) ? (
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEdit(selected);
                    setSelected(null);
                  }}
                >
                  <Pencil size={14} /> Edit
                </Button>
                <Button variant="danger" onClick={() => void removeActivity(selected)}>
                  <Trash2 size={14} /> Delete
                </Button>
              </div>
            ) : (
              <p className="border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800">
                This activity was recorded by a system action and is immutable audit evidence.
              </p>
            )}
          </div>
        )}
      </Modal>

      <EditActivityModal
        activity={edit}
        onClose={() => setEdit(null)}
        onSaved={async () => {
          setEdit(null);
          await reload();
        }}
        baseUrl={baseUrl}
      />
    </div>
  );
}

function EditActivityModal({
  activity,
  onClose,
  onSaved,
  baseUrl,
}: {
  activity: ActivityRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  baseUrl: string;
}) {
  const [subject, setSubject] = React.useState("");
  const [bodyText, setBodyText] = React.useState("");
  const [occurredAt, setOccurredAt] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSubject(activity?.subject ?? "");
    setBodyText(activity?.bodyText ?? "");
    setOccurredAt(activity ? localDateTime(activity.occurredAt) : "");
    setError(null);
  }, [activity]);

  async function save() {
    if (!activity) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${baseUrl}/activities/${activity.id}`, {
        subject,
        bodyText,
        occurredAt: new Date(occurredAt).toISOString(),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={Boolean(activity)} onClose={onClose} title="Edit activity">
      <div className="space-y-4">
        {error && <FormError message={error} />}
        <Input
          label="Subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <Textarea
          label="Details"
          value={bodyText}
          onChange={(event) => setBodyText(event.target.value)}
        />
        <Input
          label="Occurred at"
          type="datetime-local"
          value={occurredAt}
          onChange={(event) => setOccurredAt(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !occurredAt}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
