import React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { api, CompanyPolicy } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { clsx } from "../components/ui/clsx";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Company policies (M53b) — the rules every AI employee is bound by. A
 * policy's prose is injected into every employee's system prompt above the
 * Soul; its blocked recipient domains are enforced at the mail-send choke
 * for every sender; its forbidden tools are refused at AI tool dispatch
 * with an audit row. Reads are member-level — everyone is bound by them —
 * and mutations admin-gated; this page just declines to offer them to
 * plain members.
 */

/** Non-empty lines of a newline-separated list field. */
function listLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** "2 blocked domains · 1 forbidden tool" — omitted entirely at zero. */
function countsLine(policy: CompanyPolicy): string {
  const domains = listLines(policy.blockedRecipientDomains).length;
  const tools = listLines(policy.forbiddenTools).length;
  const parts: string[] = [];
  if (domains > 0) parts.push(`${domains} blocked domain${domains === 1 ? "" : "s"}`);
  if (tools > 0) parts.push(`${tools} forbidden tool${tools === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function CompanyPolicies() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [rows, setRows] = React.useState<CompanyPolicy[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // `policy: null` is the create modal; a policy is the edit modal.
  const [modal, setModal] = React.useState<{ policy: CompanyPolicy | null } | null>(null);
  const dialog = useDialog();

  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      setRows(await api.get<CompanyPolicy[]>(`/api/companies/${company.id}/company-policies`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the policies"));
      setRows([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("policy", reload);

  async function remove(policy: CompanyPolicy) {
    const ok = await dialog.confirm({
      title: `Delete “${policy.title}”?`,
      message:
        "Its prose leaves every employee's prompt, and its blocked domains and forbidden tools stop being enforced.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/company-policies/${policy.id}`);
      await reload();
    } catch (err) {
      void dialog.error(err, { title: "Could not delete the policy" });
    }
  }

  const newPolicyButton = (
    <Button onClick={() => setModal({ policy: null })}>
      <Plus size={14} /> New policy
    </Button>
  );

  return (
    <>
      <TopBar
        title="Policies"
        right={canManage ? newPolicyButton : undefined}
      />

      {loadError ? (
        <FormError message={loadError} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No policies yet"
          description="Company policies bind every AI employee: prose is injected into each prompt above the Soul, blocked recipient domains are enforced on every send, and forbidden tools are refused at dispatch."
          action={canManage ? newPolicyButton : undefined}
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {rows.map((policy) => {
            const bodyLine = policy.body.split("\n")[0]?.trim() ?? "";
            const counts = countsLine(policy);
            return (
              <li key={policy.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={clsx(
                        "truncate text-sm font-medium",
                        policy.enabled
                          ? "text-slate-900 dark:text-slate-100"
                          : "text-slate-400 dark:text-slate-500",
                      )}
                    >
                      {policy.title}
                    </span>
                    <span
                      className={clsx(
                        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        policy.enabled
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                      )}
                    >
                      {policy.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  {bodyLine && (
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {bodyLine}
                    </div>
                  )}
                  {counts && (
                    <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                      {counts}
                    </div>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setModal({ policy })}
                      aria-label={`Edit ${policy.title}`}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void remove(policy)}
                      aria-label={`Delete ${policy.title}`}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {modal && (
        <PolicyModal
          key={modal.policy?.id ?? "new"}
          companyId={company.id}
          policy={modal.policy}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

// ───────────────────────── create / edit modal ───────────────────────────

function PolicyModal({
  companyId,
  policy,
  onClose,
  onSaved,
}: {
  companyId: string;
  /** Null creates; a policy edits it. */
  policy: CompanyPolicy | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = React.useState(policy?.title ?? "");
  const [body, setBody] = React.useState(policy?.body ?? "");
  const [blockedRecipientDomains, setBlockedRecipientDomains] = React.useState(
    policy?.blockedRecipientDomains ?? "",
  );
  const [forbiddenTools, setForbiddenTools] = React.useState(policy?.forbiddenTools ?? "");
  const [enabled, setEnabled] = React.useState(policy?.enabled ?? true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const payload = {
      title: title.trim(),
      body,
      blockedRecipientDomains,
      forbiddenTools,
      enabled,
    };
    try {
      if (policy) {
        await api.patch(`/api/companies/${companyId}/company-policies/${policy.id}`, payload);
      } else {
        await api.post(`/api/companies/${companyId}/company-policies`, payload);
      }
      onSaved();
    } catch (err) {
      // The server 400s on reserved tool names (`find_tools` / `call_tool`).
      setError(errorMessage(err, "Could not save the policy"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={policy ? `Edit: ${policy.title}` : "New policy"}
      description="A rule every AI employee is bound by."
      size="lg"
      onSubmit={save}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {policy ? "Save changes" : "Create policy"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={error} />

        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="No discounts beyond 20%"
          maxLength={120}
          required
          autoFocus
        />

        <Textarea
          label="Injected into every AI employee's prompt, above their Soul"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[100px]"
          placeholder="Plain prose. Optional."
        />

        <Textarea
          label="Blocked recipient domains"
          value={blockedRecipientDomains}
          onChange={(e) => setBlockedRecipientDomains(e.target.value)}
          className="min-h-[70px]"
          placeholder={"competitor.com\npress-list.org"}
          hint="One domain per line. Enforced on every send — human or AI — like the do-not-email list."
        />

        <Textarea
          label="Forbidden tools"
          value={forbiddenTools}
          onChange={(e) => setForbiddenTools(e.target.value)}
          className="min-h-[70px]"
          placeholder={"send_mail\ncreate_invoice"}
          hint="One tool name per line. Refused at AI tool dispatch and audited; find_tools and call_tool cannot be forbidden."
        />

        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
          />
          Enabled
        </label>
      </div>
    </Modal>
  );
}
