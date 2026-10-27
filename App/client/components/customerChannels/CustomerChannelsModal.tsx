import React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Hash, NotebookPen, Pencil, Plus, Trash2 } from "lucide-react";

import {
  api,
  type Company,
  type ConnectionGrantWithEmployee,
  type Customer,
  type IntegrationConnection,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import {
  CUSTOMER_CHANNEL_INSTRUCTIONS_LIMITS,
  CUSTOMER_CHANNEL_REPLY_MODES,
  CUSTOMER_CHANNEL_REPLY_MODE_COPY,
  DEFAULT_CUSTOMER_CHANNEL_REPLY_MODE,
  customerChannelInstructionsProblem,
  type CustomerChannelReplyMode,
} from "../../../shared/customerChannels";
import { formatRelative } from "../decisions/relative";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { clsx } from "../ui/clsx";
import { useDialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { FormError } from "../ui/FormError";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Textarea } from "../ui/Textarea";

/**
 * Customer channels on one Slack Connection: which Slack channels are linked
 * to which Customer, who works each one, and what that AI Employee may say
 * there.
 *
 * Linking a channel makes the employee read every message in it and write
 * notes onto the Customer's timeline, and — depending on the reply setting —
 * answer the people in it from the instructions written here. The people in a
 * shared channel include the customer, so those instructions are all the
 * employee has to go on in it: never its Soul, Memory or company tools.
 *
 * Owner/admin only, like the routes behind it.
 */

/** One row of `GET /customer-channels`. */
export type CustomerChannelRow = {
  id: string;
  provider: string;
  connectionId: string;
  externalChannelId: string;
  name: string;
  shared: boolean;
  customer: { id: string; name: string; slug: string } | null;
  employee: { id: string; name: string; slug: string; role: string } | null;
  replyMode: CustomerChannelReplyMode;
  instructions: string;
  lastMessageAt: string | null;
  lastNotedAt: string | null;
  notesError: string;
  pendingMessages: number;
  problem: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One row of `GET /customer-channels/slack-channels`. */
type LinkableChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isShared: boolean;
  isMember: boolean;
  isArchived: boolean;
  linkedCustomerChannelId: string | null;
};

type NotesOutcome =
  | { status: "written"; activityId: string | null; followUps: number; messages: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type GrantedEmployee = ConnectionGrantWithEmployee["employee"];

function channelTitle(row: { name: string; externalChannelId: string }): string {
  return `#${row.name || row.externalChannelId}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** What a notes run that wrote something changed, in one line. */
function notesNotice(outcome: NotesOutcome): string {
  if (outcome.status !== "written") return outcome.reason;
  if (!outcome.activityId) {
    return `Read ${plural(outcome.messages, "message")} — nothing worth noting on the record.`;
  }
  const followUps = outcome.followUps ? ` and ${plural(outcome.followUps, "follow-up")}` : "";
  return `Wrote a note${followUps} from ${plural(outcome.messages, "message")}.`;
}

export function CustomerChannelsModal({
  open,
  connection,
  company,
  onClose,
}: {
  open: boolean;
  connection: IntegrationConnection | null;
  company: Company;
  onClose: () => void;
}) {
  const dialog = useDialog();
  const [rows, setRows] = React.useState<CustomerChannelRow[] | null>(null);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [employees, setEmployees] = React.useState<GrantedEmployee[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<CustomerChannelRow | "new" | null>(null);
  const [busy, setBusy] = React.useState<{ id: string; action: "notes" | "unlink" } | null>(null);
  const [notices, setNotices] = React.useState<Record<string, string>>({});

  const connectionId = connection?.id ?? null;
  const base = `/api/companies/${company.id}/customer-channels`;

  React.useEffect(() => {
    if (!open || !connectionId) return;
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    setEditing(null);
    setNotices({});
    (async () => {
      try {
        const [list, allCustomers, grants] = await Promise.all([
          api.get<{ channels: CustomerChannelRow[] }>(
            `${base}?connectionId=${encodeURIComponent(connectionId)}`,
          ),
          api.get<Customer[]>(`/api/companies/${company.id}/customers`),
          api.get<ConnectionGrantWithEmployee[]>(
            `/api/companies/${company.id}/integrations/connections/${connectionId}/grants`,
          ),
        ]);
        if (cancelled) return;
        setRows(list.channels);
        setCustomers(allCustomers.filter((customer) => !customer.archivedAt));
        setEmployees(grants.map((grant) => grant.employee));
      } catch (err) {
        if (cancelled) return;
        setLoadError(errorMessage(err, "Could not load the customer channels"));
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, company.id, base]);

  function replaceRow(next: CustomerChannelRow) {
    setRows((prev) => {
      if (!prev) return [next];
      return prev.some((row) => row.id === next.id)
        ? prev.map((row) => (row.id === next.id ? next : row))
        : [...prev, next];
    });
  }

  async function writeNotes(row: CustomerChannelRow) {
    setBusy({ id: row.id, action: "notes" });
    setNotices((prev) => ({ ...prev, [row.id]: "" }));
    try {
      const res = await api.post<{ result: NotesOutcome; channel: CustomerChannelRow }>(
        `${base}/${row.id}/notes`,
      );
      replaceRow(res.channel);
      setNotices((prev) => ({ ...prev, [row.id]: notesNotice(res.result) }));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t write the notes" });
    } finally {
      setBusy(null);
    }
  }

  async function unlink(row: CustomerChannelRow) {
    const ok = await dialog.confirm({
      title: `Unlink ${channelTitle(row)}?`,
      message: `${row.employee?.name ?? "The AI Employee"} stops reading and answering in this channel. Notes already on ${row.customer?.name ?? "the Customer"}'s record stay; messages not written up yet are discarded.`,
      confirmLabel: "Unlink",
      variant: "danger",
    });
    if (!ok) return;
    setBusy({ id: row.id, action: "unlink" });
    try {
      await api.del(`${base}/${row.id}`);
      setRows((prev) => prev?.filter((item) => item.id !== row.id) ?? prev);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t unlink the channel" });
    } finally {
      setBusy(null);
    }
  }

  if (!connection) return null;

  const ready = rows !== null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Customer channels · ${connection.label}`}
      description="Slack channels linked to a Customer, where an AI Employee keeps notes and answers."
      size="lg"
    >
      {editing ? (
        <CustomerChannelForm
          base={base}
          connectionId={connection.id}
          row={editing === "new" ? null : editing}
          customers={customers}
          employees={employees}
          onSaved={(saved) => {
            replaceRow(saved);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">
            In a linked channel the AI Employee reads every message, not just the ones that
            @-mention it. Once the conversation goes quiet it writes notes onto the Customer&apos;s
            timeline and files what your side promised as Follow-ups. Replies there are written for
            the customer, from the instructions you give each channel.
          </p>

          <FormError message={loadError} />

          {!ready ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Hash size={18} />}
              title="No customer channels yet"
              description="Invite the Slack app to a channel you share with a customer, then link it here."
              action={
                <Button size="sm" onClick={() => setEditing("new")}>
                  <Plus size={12} /> Link a channel
                </Button>
              }
            />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <CustomerChannelItem
                    key={row.id}
                    row={row}
                    companySlug={company.slug}
                    notice={notices[row.id] ?? ""}
                    busy={busy?.id === row.id ? busy.action : null}
                    anyBusy={busy !== null}
                    onEdit={() => setEditing(row)}
                    onWriteNotes={() => writeNotes(row)}
                    onUnlink={() => unlink(row)}
                  />
                ))}
              </ul>
              <div>
                <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                  <Plus size={12} /> Link a channel
                </Button>
              </div>
            </>
          )}

          <div className="flex justify-end pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CustomerChannelItem({
  row,
  companySlug,
  notice,
  busy,
  anyBusy,
  onEdit,
  onWriteNotes,
  onUnlink,
}: {
  row: CustomerChannelRow;
  companySlug: string;
  notice: string;
  busy: "notes" | "unlink" | null;
  anyBusy: boolean;
  onEdit: () => void;
  onWriteNotes: () => void;
  onUnlink: () => void;
}) {
  const warning = row.problem ?? (row.notesError ? `Last notes failed: ${row.notesError}` : null);
  const status = [
    row.lastNotedAt ? `Notes written ${formatRelative(row.lastNotedAt)}` : "No notes yet",
    row.pendingMessages > 0
      ? `${plural(row.pendingMessages, "message")} ${row.lastNotedAt ? "since" : "waiting"}`
      : null,
    row.lastMessageAt ? `last message ${formatRelative(row.lastMessageAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <Hash size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {channelTitle(row)}
              </span>
              {row.shared && <Badge tone="info">Slack Connect</Badge>}
              <Badge>{CUSTOMER_CHANNEL_REPLY_MODE_COPY[row.replyMode].title}</Badge>
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {row.customer ? (
                <Link
                  to={`/c/${companySlug}/revenue/accounts/${row.customer.id}`}
                  className="font-medium text-slate-700 hover:underline dark:text-slate-200"
                >
                  {row.customer.name}
                </Link>
              ) : (
                "Customer removed"
              )}
              {" · "}
              {row.employee ? row.employee.name : "Nobody works it"}
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{status}</p>
            {warning && (
              <p className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
                <AlertCircle size={12} className="mt-1 shrink-0" />
                <span>{warning}</span>
              </p>
            )}
            {!row.lastMessageAt && (
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                Nothing heard here yet. The Slack app needs the <code>message.channels</code> and{" "}
                <code>message.groups</code> events to read a whole channel.
              </p>
            )}
            {/* A run stopped by the warning above would only repeat it. */}
            {notice && notice !== row.problem && (
              <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{notice}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onWriteNotes}
            loading={busy === "notes"}
            disabled={anyBusy && busy !== "notes"}
            title="Write notes on what was said since the last ones, without waiting for the channel to go quiet"
          >
            <NotebookPen size={12} /> Write notes now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={anyBusy}
            title="Change the Customer, AI Employee, replies or instructions"
            aria-label={`Edit ${channelTitle(row)}`}
          >
            <Pencil size={12} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onUnlink}
            loading={busy === "unlink"}
            disabled={anyBusy && busy !== "unlink"}
            title="Unlink this channel"
            aria-label={`Unlink ${channelTitle(row)}`}
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
    </li>
  );
}

function ReplyChoice({
  value,
  current,
  onPick,
}: {
  value: CustomerChannelReplyMode;
  current: CustomerChannelReplyMode;
  onPick: (value: CustomerChannelReplyMode) => void;
}) {
  const active = value === current;
  const copy = CUSTOMER_CHANNEL_REPLY_MODE_COPY[value];
  return (
    <label
      className={clsx(
        "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        active
          ? "border-indigo-400 bg-indigo-50/60 dark:border-indigo-500 dark:bg-indigo-950/30"
          : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60",
      )}
    >
      <input
        type="radio"
        name="customer-channel-replies"
        value={value}
        className="mt-0.5"
        checked={active}
        onChange={() => onPick(value)}
      />
      <span>
        <span className="block font-medium text-slate-900 dark:text-slate-100">{copy.title}</span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">{copy.detail}</span>
      </span>
    </label>
  );
}

type Draft = {
  externalChannelId: string;
  customerId: string;
  employeeId: string;
  replyMode: CustomerChannelReplyMode;
  instructions: string;
};

function CustomerChannelForm({
  base,
  connectionId,
  row,
  customers,
  employees,
  onSaved,
  onCancel,
}: {
  base: string;
  connectionId: string;
  row: CustomerChannelRow | null;
  customers: Customer[];
  employees: GrantedEmployee[];
  onSaved: (row: CustomerChannelRow) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<Draft>(() => ({
    externalChannelId: row?.externalChannelId ?? "",
    customerId: row?.customer?.id ?? "",
    employeeId: row?.employee?.id ?? (employees.length === 1 ? employees[0].id : ""),
    replyMode: row?.replyMode ?? DEFAULT_CUSTOMER_CHANNEL_REPLY_MODE,
    instructions: row?.instructions ?? "",
  }));
  const [slackChannels, setSlackChannels] = React.useState<LinkableChannel[] | null>(null);
  const [slackError, setSlackError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  React.useEffect(() => {
    if (row) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ channels: LinkableChannel[] }>(
          `${base}/slack-channels?connectionId=${encodeURIComponent(connectionId)}`,
        );
        if (!cancelled) setSlackChannels(res.channels);
      } catch (err) {
        if (cancelled) return;
        setSlackError(errorMessage(err, "Could not list the Slack app's channels"));
        setSlackChannels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row, base, connectionId]);

  // A customer whose row is gone, or an employee no longer granted the
  // Connection, still shows as the current choice rather than a blank.
  const employeeOptions = React.useMemo(() => {
    const list = [...employees];
    if (row?.employee && !list.some((e) => e.id === row.employee!.id)) {
      list.push({ ...row.employee, avatarKey: null });
    }
    return list;
  }, [employees, row]);

  const available = (slackChannels ?? []).filter((channel) => !channel.linkedCustomerChannelId);

  const problem = (): string | null => {
    if (!row && !draft.externalChannelId) return "Pick the Slack channel to link.";
    if (!draft.customerId) return "Pick the Customer this channel is with.";
    if (!draft.employeeId) return "Pick the AI Employee who works this channel.";
    return customerChannelInstructionsProblem(draft.instructions);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const invalid = problem();
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = row
        ? await api.patch<CustomerChannelRow>(`${base}/${row.id}`, {
            customerId: draft.customerId,
            employeeId: draft.employeeId,
            replyMode: draft.replyMode,
            instructions: draft.instructions,
          })
        : await api.post<CustomerChannelRow>(base, {
            connectionId,
            externalChannelId: draft.externalChannelId,
            customerId: draft.customerId,
            employeeId: draft.employeeId,
            replyMode: draft.replyMode,
            instructions: draft.instructions,
          });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err, "Could not save the customer channel"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={save}>
      <section className="grid gap-3 sm:grid-cols-2">
        {row ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Slack channel
            </span>
            <span className="flex h-9 items-center gap-1.5 text-sm text-slate-900 dark:text-slate-100">
              {channelTitle(row)}
              {row.shared && <Badge tone="info">Slack Connect</Badge>}
            </span>
          </div>
        ) : slackChannels === null ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Spinner /> Asking Slack which channels the app is in…
          </div>
        ) : (
          <Select
            label="Slack channel"
            value={draft.externalChannelId}
            onChange={(e) => set("externalChannelId", e.target.value)}
            emptyMessage="No channels"
          >
            <option value="">Pick a channel</option>
            {available.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {`#${channel.name || channel.id}${channel.isShared ? " (Slack Connect)" : channel.isPrivate ? " (private)" : ""}`}
              </option>
            ))}
          </Select>
        )}
        <Select
          label="Customer"
          value={draft.customerId}
          onChange={(e) => set("customerId", e.target.value)}
          emptyMessage="No Customers"
        >
          <option value="">Pick a Customer</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </Select>
      </section>

      {!row && slackChannels !== null && (
        <div className="-mt-3 flex flex-col gap-2">
          <FormError message={slackError} />
          {!slackError && (
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              {available.length === 0
                ? "The Slack app is not in any channel that is free to link. "
                : "Only channels the Slack app is in are listed. "}
              Invite it to the channel in Slack with <code>/invite @your-app</code>, then reopen
              this form. In a Slack Connect channel, someone on your side does the inviting.
            </p>
          )}
        </div>
      )}

      <section className="flex flex-col gap-2">
        <Select
          label="AI Employee"
          value={draft.employeeId}
          onChange={(e) => set("employeeId", e.target.value)}
          emptyMessage="No AI Employees"
        >
          <option value="">Pick an AI Employee</option>
          {employeeOptions.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name} — {employee.role}
            </option>
          ))}
        </Select>
        {employees.length === 0 && (
          <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
            No AI Employee is granted this Slack Connection yet. Grant it under Access first — the
            employee posts in the channel as this Slack app.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Replies</h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {CUSTOMER_CHANNEL_REPLY_MODES.map((mode) => (
            <ReplyChoice
              key={mode}
              value={mode}
              current={draft.replyMode}
              onPick={(value) => set("replyMode", value)}
            />
          ))}
        </div>
      </section>

      <section>
        <Textarea
          label="Instructions for this channel"
          value={draft.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          rows={7}
          className="min-h-[140px]"
          maxLength={CUSTOMER_CHANNEL_INSTRUCTIONS_LIMITS.maxLength}
          placeholder={
            "You support Acme on our Widget API.\nAnswer setup, rate-limit and status questions from docs.example.com.\nFor billing, outages or anything you are unsure of, say a colleague will follow up."
          }
          hint="Everything the AI Employee may say in this channel. People outside your company read it, so it never uses its Soul, Memory or company tools here — only this. Notes are written either way."
        />
      </section>

      <FormError message={error} />
      <div className="flex items-center gap-2">
        <Button type="submit" loading={saving}>
          {row ? "Save" : "Link channel"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
