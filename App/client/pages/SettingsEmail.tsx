import React from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  AtSign,
  Check,
  CheckCircle2,
  Inbox,
  Mail,
  Mailbox,
  Plug,
  Send,
  Server,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  EmailProvider,
  EmailProviderCatalogEntry,
  EmailProviderField,
  EmailProviderKind,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { EmptyState } from "../components/ui/EmptyState";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Company-level **Email** settings. Two-pane layout:
 *   - left rail = sub-nav with "Providers" and "Logs"
 *   - right pane = the active sub-page (Outlet)
 *
 * Sub-pages share the parent `SettingsOutletCtx` via `useOutletContext`,
 * so they don't need to re-fetch the company / current user.
 */

const ICONS: Record<string, LucideIcon> = {
  Server,
  Send,
  Mail,
  AtSign,
  Mailbox,
  Plug,
};

function useCtx(): SettingsOutletCtx {
  return useOutletContext<SettingsOutletCtx>();
}

const SUB_NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "providers", label: "Providers", icon: Mail },
  { to: "logs", label: "Logs", icon: Inbox },
];

export function SettingsEmail() {
  const ctx = useCtx();
  return (
    <>
      <TopBar title="Email" />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <nav className="lg:w-48 lg:shrink-0">
          <ul className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900 lg:flex-col lg:gap-0.5 lg:p-2">
            {SUB_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition " +
                      (isActive
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100")
                    }
                  >
                    <Icon size={14} /> {item.label}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet context={ctx satisfies SettingsOutletCtx} />
        </div>
      </div>
    </>
  );
}

export function SettingsEmailProviders() {
  const { company, me } = useCtx();
  const { toast } = useToast();
  const dialog = useDialog();

  const [catalog, setCatalog] = React.useState<EmailProviderCatalogEntry[] | null>(
    null,
  );
  const [providers, setProviders] = React.useState<EmailProvider[] | null>(null);
  const [adding, setAdding] = React.useState<EmailProviderCatalogEntry | null>(
    null,
  );
  const [editing, setEditing] = React.useState<EmailProvider | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [testTarget, setTestTarget] = React.useState<EmailProvider | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const [cat, list] = await Promise.all([
        api.get<EmailProviderCatalogEntry[]>(
          `/api/companies/${company.id}/email/providers/catalog`,
        ),
        api.get<EmailProvider[]>(
          `/api/companies/${company.id}/email/providers`,
        ),
      ]);
      setCatalog(cat);
      setProviders(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setCatalog([]);
      setProviders([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function makeDefault(p: EmailProvider) {
    setBusyId(p.id);
    try {
      await api.post(
        `/api/companies/${company.id}/email/providers/${p.id}/default`,
      );
      toast(`${p.name} is now the default sender`, "success");
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: EmailProvider) {
    const ok = await dialog.confirm({
      title: `Delete "${p.name}"?`,
      message:
        "Notification emails (invites, password resets) will use the next available provider, then the platform fallback.",
      confirmLabel: "Delete provider",
      variant: "danger",
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      await api.del(`/api/companies/${company.id}/email/providers/${p.id}`);
      toast("Provider deleted", "success");
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="mb-6">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Configured providers</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Outgoing notification emails (invitations, alerts) use the
              default provider. Credentials are encrypted at rest.
            </p>
          </CardHeader>
          <CardBody>
            {providers === null ? (
              <Spinner />
            ) : providers.length === 0 ? (
              <EmptyState
                title="No email provider yet"
                description="Until you add one, Genosyn falls back to the platform SMTP block (or logs to the server console when neither is configured)."
              />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {providers.map((p) => {
                  const Icon =
                    ICONS[catalog?.find((c) => c.kind === p.kind)?.icon ?? "Plug"] ??
                    Plug;
                  return (
                    <li key={p.id} className="flex items-center gap-3 py-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        <Icon size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{p.name}</span>
                          <KindBadge kind={p.kind} />
                          {p.isDefault && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                              <Star size={10} /> Default
                            </span>
                          )}
                          {!p.enabled && (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              Disabled
                            </span>
                          )}
                          <TestBadge
                            status={p.lastTestStatus}
                            message={p.lastTestMessage}
                          />
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {p.fromAddress} · {summarizeConfig(p)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setTestTarget(p)}
                          disabled={busyId === p.id}
                        >
                          <Send size={12} /> Test
                        </Button>
                        {!p.isDefault && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => makeDefault(p)}
                            disabled={busyId === p.id}
                          >
                            <Star size={12} /> Make default
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(p)}
                          disabled={busyId === p.id}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => remove(p)}
                          disabled={busyId === p.id}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Add a provider</h2>
        {catalog === null ? (
          <Spinner />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {catalog.map((entry) => {
              const Icon = ICONS[entry.icon] ?? Plug;
              return (
                <button
                  key={entry.kind}
                  onClick={() => setAdding(entry)}
                  className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
                >
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700 group-hover:bg-indigo-100 group-hover:text-indigo-600 dark:bg-slate-800 dark:text-slate-200 dark:group-hover:bg-indigo-900 dark:group-hover:text-indigo-300">
                    <Icon size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {entry.name}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {entry.tagline}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <ProviderModal
        open={adding !== null}
        entry={adding}
        companyId={company.id}
        defaultTo={me.email}
        onClose={() => setAdding(null)}
        onSaved={async () => {
          setAdding(null);
          await reload();
        }}
      />
      <ProviderModal
        open={editing !== null}
        entry={catalog?.find((c) => c.kind === editing?.kind) ?? null}
        companyId={company.id}
        defaultTo={me.email}
        existing={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await reload();
        }}
      />
      <TestModal
        open={testTarget !== null}
        provider={testTarget}
        companyId={company.id}
        defaultTo={me.email}
        onClose={() => setTestTarget(null)}
        onTested={reload}
      />
    </>
  );
}

function KindBadge({ kind }: { kind: EmailProviderKind }) {
  const label =
    kind === "smtp"
      ? "SMTP"
      : kind === "sendgrid"
        ? "SendGrid"
        : kind === "mailgun"
          ? "Mailgun"
          : kind === "resend"
            ? "Resend"
            : "Postmark";
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      {label}
    </span>
  );
}

function TestBadge({
  status,
  message,
}: {
  status: EmailProvider["lastTestStatus"];
  message: string;
}) {
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 size={10} /> Tested
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        title={message}
        className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
      >
        <AlertCircle size={10} /> Test failed
      </span>
    );
  }
  return null;
}

function summarizeConfig(p: EmailProvider): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(p.configPreview)) {
    if (!value) continue;
    parts.push(`${key}: ${value}`);
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

type ProviderFormState = {
  name: string;
  fromAddress: string;
  replyTo: string;
  fields: Record<string, string | boolean>;
  isDefault: boolean;
  enabled: boolean;
};

function ProviderModal({
  open,
  entry,
  existing,
  companyId,
  defaultTo,
  onClose,
  onSaved,
}: {
  open: boolean;
  entry: EmailProviderCatalogEntry | null;
  existing?: EmailProvider;
  companyId: string;
  defaultTo: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const { toast } = useToast();
  const [state, setState] = React.useState<ProviderFormState>(() =>
    initialState(entry, existing),
  );
  const [busy, setBusy] = React.useState(false);
  const [testBusy, setTestBusy] = React.useState(false);
  const [testTo, setTestTo] = React.useState(defaultTo);
  const [testResult, setTestResult] = React.useState<
    | { ok: true; messageId: string }
    | { ok: false; error: string }
    | null
  >(null);

  React.useEffect(() => {
    if (open) {
      setState(initialState(entry, existing));
      setTestTo(defaultTo);
      setTestResult(null);
    }
  }, [open, entry, existing, defaultTo]);

  if (!entry) return null;

  function setField(key: string, value: string | boolean) {
    setState((prev) => ({ ...prev, fields: { ...prev.fields, [key]: value } }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!entry) return;
    setBusy(true);
    try {
      const rawConfig = serializeFields(entry.fields, state.fields);
      if (isEdit && existing) {
        await api.patch<EmailProvider>(
          `/api/companies/${companyId}/email/providers/${existing.id}`,
          {
            name: state.name.trim(),
            fromAddress: state.fromAddress.trim(),
            replyTo: state.replyTo.trim(),
            // Only send rawConfig if any field actually changed from the
            // masked default — re-sending the masked apiKey would corrupt
            // the saved key. We send config every time the user submits;
            // the form re-asks for credentials on edit.
            rawConfig,
            isDefault: state.isDefault,
            enabled: state.enabled,
          },
        );
        toast("Provider updated", "success");
      } else {
        await api.post<EmailProvider>(
          `/api/companies/${companyId}/email/providers`,
          {
            name: state.name.trim(),
            kind: entry.kind,
            fromAddress: state.fromAddress.trim(),
            replyTo: state.replyTo.trim(),
            rawConfig,
            isDefault: state.isDefault,
          },
        );
        toast(`${entry.name} added`, "success");
      }
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    if (!entry) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const rawConfig = serializeFields(entry.fields, state.fields);
      const resp = await fetch(
        `/api/companies/${companyId}/email/providers/test`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: entry.kind,
            fromAddress: state.fromAddress.trim(),
            replyTo: state.replyTo.trim() || undefined,
            rawConfig,
            to: testTo.trim(),
          }),
        },
      );
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (resp.ok && data?.ok) {
        setTestResult({ ok: true, messageId: data.messageId ?? "" });
      } else {
        setTestResult({
          ok: false,
          error:
            data?.error ?? data?.message ?? `Test failed (${resp.status})`,
        });
      }
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${existing?.name}` : `Connect ${entry.name}`}
      size="lg"
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {entry.description && (
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {entry.description}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Label"
            value={state.name}
            onChange={(e) => setState({ ...state, name: e.target.value })}
            placeholder={entry.name}
            required
          />
          <Input
            label="From address"
            value={state.fromAddress}
            onChange={(e) =>
              setState({ ...state, fromAddress: e.target.value })
            }
            placeholder='Acme <no-reply@acme.com>'
            required
          />
          <Input
            label="Reply-to (optional)"
            value={state.replyTo}
            onChange={(e) => setState({ ...state, replyTo: e.target.value })}
            placeholder="support@acme.com"
            type="email"
            className="sm:col-span-2"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {entry.fields.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={state.fields[f.key]}
              isEdit={isEdit}
              maskedHint={existing?.configPreview[f.key]}
              onChange={(v) => setField(f.key, v)}
            />
          ))}
        </div>

        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
            checked={state.isDefault}
            onChange={(e) =>
              setState({ ...state, isDefault: e.target.checked })
            }
          />
          <span>
            Use this provider for all outgoing notification emails
            {existing?.isDefault && (
              <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                (currently default)
              </span>
            )}
          </span>
        </label>

        <div className="rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-700">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
            Send a test email
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            Tests the credentials above without saving. The result is recorded
            in Email Logs.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Input
                label="Send test to"
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={runTest}
              disabled={
                testBusy ||
                !testTo.trim() ||
                !state.fromAddress.trim() ||
                missingRequiredField(entry.fields, state.fields)
              }
            >
              {testBusy ? "Sending…" : "Send test"}
            </Button>
          </div>
          {testResult && (
            <div
              className={
                "mt-2 rounded-md p-2 text-xs " +
                (testResult.ok
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300")
              }
            >
              {testResult.ok ? (
                <span className="inline-flex items-center gap-1">
                  <Check size={12} /> Sent
                  {testResult.messageId
                    ? ` · message id ${testResult.messageId}`
                    : ""}
                </span>
              ) : (
                <span className="inline-flex items-start gap-1">
                  <AlertCircle size={12} className="mt-0.5" />
                  <span>{testResult.error}</span>
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : isEdit ? "Save changes" : "Add provider"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function initialState(
  entry: EmailProviderCatalogEntry | null,
  existing?: EmailProvider,
): ProviderFormState {
  if (!entry) {
    return {
      name: "",
      fromAddress: "",
      replyTo: "",
      fields: {},
      isDefault: false,
      enabled: true,
    };
  }
  const fields: Record<string, string | boolean> = {};
  for (const f of entry.fields) {
    if (f.type === "checkbox") fields[f.key] = Boolean(f.defaultValue);
    else if (typeof f.defaultValue !== "undefined")
      fields[f.key] = String(f.defaultValue);
    else fields[f.key] = "";
  }
  if (existing) {
    return {
      name: existing.name,
      fromAddress: existing.fromAddress,
      replyTo: existing.replyTo ?? "",
      fields, // credentials always blank on edit; user must re-enter to rotate
      isDefault: existing.isDefault,
      enabled: existing.enabled,
    };
  }
  return {
    name: entry.name,
    fromAddress: "",
    replyTo: "",
    fields,
    isDefault: false,
    enabled: true,
  };
}

function serializeFields(
  schema: EmailProviderField[],
  values: Record<string, string | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of schema) {
    const v = values[f.key];
    if (f.type === "checkbox") out[f.key] = Boolean(v);
    else if (f.type === "number") {
      const s = String(v ?? "").trim();
      if (s !== "") out[f.key] = Number(s);
    } else {
      out[f.key] = String(v ?? "");
    }
  }
  return out;
}

function missingRequiredField(
  schema: EmailProviderField[],
  values: Record<string, string | boolean>,
): boolean {
  for (const f of schema) {
    if (!f.required) continue;
    const v = values[f.key];
    if (f.type === "checkbox") continue;
    if (v === undefined || v === null || String(v).trim() === "") return true;
  }
  return false;
}

function FieldInput({
  field,
  value,
  isEdit,
  maskedHint,
  onChange,
}: {
  field: EmailProviderField;
  value: string | boolean | undefined;
  isEdit: boolean;
  maskedHint?: string;
  onChange: (v: string | boolean) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <label className="mt-2 inline-flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.label}</span>
        {field.hint && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            — {field.hint}
          </span>
        )}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
          {field.label}
          {field.required && <span className="ml-1 text-red-500">*</span>}
        </label>
        <select
          required={field.required}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.hint && (
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            {field.hint}
          </p>
        )}
      </div>
    );
  }
  const placeholder = isEdit && maskedHint
    ? `current: ${maskedHint}`
    : field.placeholder;
  const inputType =
    field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
        {field.label}
        {field.required && !isEdit && <span className="ml-1 text-red-500">*</span>}
      </label>
      <input
        type={inputType}
        required={field.required && !isEdit && field.type !== "password"}
        placeholder={placeholder}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-mono shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
      />
      {field.hint && (
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          {field.hint}
        </p>
      )}
      {isEdit && field.type === "password" && (
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          Leave blank to keep the current value.
        </p>
      )}
    </div>
  );
}

function TestModal({
  open,
  provider,
  companyId,
  defaultTo,
  onClose,
  onTested,
}: {
  open: boolean;
  provider: EmailProvider | null;
  companyId: string;
  defaultTo: string;
  onClose: () => void;
  onTested: () => void;
}) {
  const { toast } = useToast();
  const [to, setTo] = React.useState(defaultTo);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTo(defaultTo);
    }
  }, [open, defaultTo]);

  if (!provider) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!provider) return;
    setBusy(true);
    try {
      const resp = await fetch(
        `/api/companies/${companyId}/email/providers/${provider.id}/test`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: to.trim() }),
        },
      );
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (resp.ok && data?.ok) {
        toast("Test email sent", "success");
        onTested();
        onClose();
      } else {
        toast(data?.error ?? "Test failed", "error");
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Send test via ${provider.name}`}
      size="md"
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Sends a one-line test email using the saved credentials. The result
          is recorded in Email Logs.
        </p>
        <Input
          label="Send to"
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !to.trim()}>
            {busy ? "Sending…" : "Send test"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
