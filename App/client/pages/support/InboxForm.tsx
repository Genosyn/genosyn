import React from "react";
import { Plus } from "lucide-react";

import { ConnectMailboxDialog } from "@/components/mail/ConnectMailbox";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import type { Company, Employee } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { mailApi, type MailAccount } from "@/lib/mail";
import {
  splitAddresses,
  supportApi,
  type SupportInbox,
  type SupportInboxInput,
} from "@/lib/support";
import {
  DEFAULT_SUPPORT_ACKNOWLEDGEMENT,
  SUPPORT_AI_MODES,
  SUPPORT_AI_MODE_HINTS,
  SUPPORT_AI_MODE_LABELS,
  type SupportAiMode,
} from "../../../shared/support";

export type InboxFormValues = {
  accountId: string;
  name: string;
  scope: "all" | "addresses";
  addresses: string;
  aiMode: SupportAiMode;
  aiEmployeeId: string;
  importDays: number;
  fromAddress: string;
  fromName: string;
  signature: string;
  aiInstructions: string;
  acknowledge: boolean;
  acknowledgementBody: string;
  archiveOnSolve: boolean;
  autoReplyDailyLimit: number;
};

function initialValues(inbox: SupportInbox | null): InboxFormValues {
  return {
    accountId: inbox?.accountId ?? "",
    name: inbox?.name ?? "",
    scope: inbox && inbox.addresses.length === 0 ? "all" : "addresses",
    addresses: inbox?.addresses.join(", ") ?? "",
    aiMode: inbox?.aiMode ?? "draft",
    aiEmployeeId: inbox?.aiEmployeeId ?? "",
    importDays: 7,
    fromAddress: inbox?.fromAddress ?? "",
    fromName: inbox?.fromName ?? "",
    signature: inbox?.signature ?? "",
    aiInstructions: inbox?.aiInstructions ?? "",
    acknowledge: inbox?.acknowledge ?? false,
    acknowledgementBody: inbox?.acknowledgementBody ?? DEFAULT_SUPPORT_ACKNOWLEDGEMENT,
    archiveOnSolve: inbox?.archiveOnSolve ?? false,
    autoReplyDailyLimit: inbox?.autoReplyDailyLimit ?? 100,
  };
}

/**
 * A Support inbox: which mailbox, which addresses on it count, and how far its AI
 * Employee goes. The only three decisions that matter come first; what is rarely
 * changed waits behind one Advanced that says what is set inside.
 */
export function InboxForm({
  company,
  inbox,
  employees,
  defaultEmployeeId,
  onSaved,
  beforeCreate,
  onCancel,
  submitLabel,
}: {
  company: Company;
  inbox: SupportInbox | null;
  employees: Employee[];
  /** The AI Employee Support's settings name, shown as what "Default" means. */
  defaultEmployeeId: string | null;
  onSaved: (inbox: SupportInbox) => void;
  /** Runs before the inbox is created, for what its first tickets depend on. */
  beforeCreate?: () => Promise<unknown>;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [values, setValues] = React.useState<InboxFormValues>(() => initialValues(inbox));
  const [accounts, setAccounts] = React.useState<MailAccount[] | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const set = <K extends keyof InboxFormValues>(key: K, value: InboxFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const loadAccounts = React.useCallback(async () => {
    const result = await mailApi.accounts(company.id);
    setAccounts(result.accounts);
    return result.accounts;
  }, [company.id]);

  React.useEffect(() => {
    loadAccounts()
      .then((list) => {
        setValues((current) =>
          current.accountId || list.length === 0
            ? current
            : {
                ...current,
                accountId: list[0].id,
                name: current.name || "Support",
                addresses: current.addresses || "",
              },
        );
      })
      .catch((err: unknown) => setError(errorMessage(err, "Could not load your mailboxes")));
  }, [loadAccounts]);

  const account = accounts?.find((item) => item.id === values.accountId) ?? null;
  const advancedSummary = [
    values.fromAddress ? `From ${values.fromAddress}` : "",
    values.signature ? "Signature" : "",
    values.aiInstructions ? "AI instructions" : "",
    values.acknowledge ? "Acknowledges new tickets" : "",
    values.archiveOnSolve ? "Archives when solved" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const addresses = values.scope === "all" ? [] : splitAddresses(values.addresses);
      if (values.scope === "addresses" && addresses.length === 0) {
        setError("Name at least one address, or watch everything sent to this mailbox.");
        return;
      }
      const common: SupportInboxInput = {
        name: values.name.trim() || "Support",
        addresses,
        aiMode: values.aiMode,
        aiEmployeeId: values.aiEmployeeId || null,
        fromAddress: values.fromAddress.trim(),
        fromName: values.fromName.trim(),
        signature: values.signature,
        aiInstructions: values.aiInstructions,
        acknowledge: values.acknowledge,
        acknowledgementBody: values.acknowledge ? values.acknowledgementBody : null,
        archiveOnSolve: values.archiveOnSolve,
        autoReplyDailyLimit: values.autoReplyDailyLimit,
      };
      const api = supportApi(company.id);
      if (!inbox) await beforeCreate?.();
      const saved = inbox
        ? await api.updateInbox(inbox.id, { ...common, accountId: values.accountId })
        : await api.createInbox({
            ...common,
            accountId: values.accountId,
            name: common.name as string,
            addresses,
            importDays: values.importDays,
          });
      onSaved(saved.inbox);
    } catch (err) {
      setError(errorMessage(err, "Could not save this inbox"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Select
              label="Mailbox"
              value={values.accountId}
              disabled={accounts === null}
              onChange={(event) => set("accountId", event.target.value)}
            >
              {accounts === null && <option value="">Loading…</option>}
              {accounts?.length === 0 && <option value="">No mailbox connected yet</option>}
              {accounts?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.address}
                </option>
              ))}
            </Select>
          </div>
          <Button type="button" variant="secondary" onClick={() => setConnecting(true)}>
            <Plus size={14} /> Connect a mailbox
          </Button>
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
            Which mail becomes a ticket?
          </legend>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
            <input
              type="radio"
              name="scope"
              aria-label="Only mail sent to certain addresses"
              className="mt-0.5"
              checked={values.scope === "addresses"}
              onChange={() => set("scope", "addresses")}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-slate-900 dark:text-slate-100">
                Only mail sent to certain addresses
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Watch a mailbox for support@ and leave the rest of it alone. Works for aliases,
                Google Groups and forwarding addresses.
              </span>
              {values.scope === "addresses" && (
                <span className="mt-2 block">
                  <Input
                    aria-label="Addresses to watch"
                    placeholder="support@yourcompany.com, help@yourcompany.com"
                    value={values.addresses}
                    onChange={(event) => set("addresses", event.target.value)}
                  />
                </span>
              )}
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
            <input
              type="radio"
              name="scope"
              aria-label="Everything sent to this mailbox"
              className="mt-0.5"
              checked={values.scope === "all"}
              onChange={() => set("scope", "all")}
            />
            <span>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                Everything sent to {account?.address ?? "this mailbox"}
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                For a mailbox used only for support.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="AI Employee"
            value={values.aiEmployeeId}
            onChange={(event) => set("aiEmployeeId", event.target.value)}
          >
            <option value="">
              {defaultEmployeeId
                ? `Default (${employees.find((employee) => employee.id === defaultEmployeeId)?.name ?? "from settings"})`
                : "Choose under Support settings"}
            </option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </Select>
          <Select
            label="How far it goes"
            value={values.aiMode}
            onChange={(event) => set("aiMode", event.target.value as SupportAiMode)}
          >
            {SUPPORT_AI_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {SUPPORT_AI_MODE_LABELS[mode]}
              </option>
            ))}
          </Select>
        </div>
        <p className="-mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {SUPPORT_AI_MODE_HINTS[values.aiMode]}
        </p>

        {!inbox && (
          <Select
            label="Bring in existing mail"
            value={String(values.importDays)}
            onChange={(event) => set("importDays", Number(event.target.value))}
          >
            <option value="0">Start from new mail only</option>
            <option value="7">The last 7 days</option>
            <option value="30">The last 30 days</option>
            <option value="90">The last 90 days</option>
          </Select>
        )}

        <Disclosure title="Advanced" summary={advancedSummary || undefined} variant="card">
          <div className="space-y-4">
            <Input
              label="Name"
              value={values.name}
              onChange={(event) => set("name", event.target.value)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Reply from"
                placeholder="The address the customer wrote to"
                value={values.fromAddress}
                onChange={(event) => set("fromAddress", event.target.value)}
              />
              <Input
                label="Sender name"
                placeholder="Acme Support"
                value={values.fromName}
                onChange={(event) => set("fromName", event.target.value)}
              />
            </div>
            <p className="-mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
              On Gmail, an alias must be set up under Send mail as. An SMTP server may refuse an
              address it does not know.
            </p>
            <Textarea
              label="Signature"
              rows={3}
              hint="Added under every reply, whoever wrote it."
              value={values.signature}
              onChange={(event) => set("signature", event.target.value)}
            />
            <Textarea
              label="What the AI Employee should know about this inbox"
              rows={3}
              hint="Added to Support's instructions. It shapes tone and judgement; what it can tell a customer still comes only from your published Articles."
              value={values.aiInstructions}
              onChange={(event) => set("aiInstructions", event.target.value)}
            />
            {values.aiMode === "auto" && (
              <Input
                label="Most automatic replies a day"
                type="number"
                min={0}
                max={10_000}
                value={values.autoReplyDailyLimit}
                onChange={(event) => set("autoReplyDailyLimit", Number(event.target.value))}
              />
            )}
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <Checkbox
                label="Acknowledge new tickets"
                checked={values.acknowledge}
                onChange={(event) => set("acknowledge", event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Acknowledge new tickets
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Sends the customer one automatic note when a ticket opens.
                </span>
              </span>
            </label>
            {values.acknowledge && (
              <Textarea
                aria-label="Acknowledgement text"
                rows={3}
                value={values.acknowledgementBody}
                onChange={(event) => set("acknowledgementBody", event.target.value)}
              />
            )}
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <Checkbox
                label="Archive in the mailbox when solved"
                checked={values.archiveOnSolve}
                onChange={(event) => set("archiveOnSolve", event.target.checked)}
                className="mt-0.5"
              />
              <span>Archive the conversation in the mailbox when its ticket is solved</span>
            </label>
          </div>
        </Disclosure>

        <FormError message={error} />
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={busy} disabled={!values.accountId}>
            {submitLabel ?? (inbox ? "Save" : "Create Support inbox")}
          </Button>
        </div>
      </form>
      {/* Beside the form, not in it: React sends a submit through a portal to its parents. */}
      <ConnectMailboxDialog
        open={connecting}
        onClose={() => setConnecting(false)}
        companyId={company.id}
        onConnected={async (connected) => {
          const list = await loadAccounts();
          setConnecting(false);
          const chosen = connected?.id ?? list[list.length - 1]?.id;
          if (chosen) set("accountId", chosen);
        }}
        canConnect={company.role === "owner" || company.role === "admin"}
      />
    </>
  );
}
