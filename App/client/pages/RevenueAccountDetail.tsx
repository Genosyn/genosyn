import React from "react";
import { Archive, ArchiveRestore, Building2, ExternalLink, Merge, UserRound } from "lucide-react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { Breadcrumbs } from "../components/AppShell";
import { RevenueCustomFieldsPanel } from "../components/revenue/RevenueCustomFieldsPanel";
import { RevenueDocumentsPanel } from "../components/revenue/RevenueDocumentsPanel";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { api, type Customer, type Employee, type Member } from "../lib/api";
import type { RevenueAccount } from "../lib/revenue";
import type { RevenueContact } from "./RevenueContacts";
import type { Deal } from "./RevenueDeals";
import type { RevenueOutletCtx } from "./RevenueLayout";

type AccountDetail = {
  account: Customer;
  contacts: RevenueContact[];
  deals: Deal[];
};

type AccountMergeCounts = {
  contacts: number;
  deals: number;
  activities: number;
  partnerships: number;
  revenueDocuments: number;
  signalEvents: number;
  billingContacts: number;
  contracts: number;
  invoices: number;
  estimates: number;
  recurringInvoices: number;
  credits: number;
  customValuesCopied: number;
  customValueConflicts: number;
};

type AccountMergePreview = {
  source: Pick<Customer, "id" | "name" | "slug" | "archivedAt">;
  target: Pick<Customer, "id" | "name" | "slug" | "archivedAt">;
  counts: AccountMergeCounts;
  fieldConflicts?: MergeConflict[];
  customFieldConflicts?: MergeConflict[];
};

type MergeConflict = {
  field: string;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  resolution: "source" | "target";
};

function displayMergeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Empty";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function ownerValue(account: Customer): string {
  if (account.ownerId) return `user:${account.ownerId}`;
  if (account.ownerEmployeeId) return `employee:${account.ownerEmployeeId}`;
  return "";
}

export default function RevenueAccountDetail() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { accountId = "" } = useParams();
  const navigate = useNavigate();
  const dialog = useDialog();
  const { background, toast } = useToast();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [detail, setDetail] = React.useState<AccountDetail | null>(null);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [draft, setDraft] = React.useState({
    name: "",
    accountStatus: "prospect",
    domain: "",
    websiteUrl: "",
    industry: "",
    employeeCount: "",
    owner: "",
    notes: "",
  });
  const [busy, setBusy] = React.useState(false);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [result, memberRows, employeeRows] = await Promise.all([
      api.get<AccountDetail>(`${base}/accounts/${accountId}`),
      api.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => []),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`).catch(() => []),
    ]);
    setDetail(result);
    setMembers(memberRows);
    setEmployees(employeeRows);
    setDraft({
      name: result.account.name,
      accountStatus: result.account.accountStatus,
      domain: result.account.domain,
      websiteUrl: result.account.websiteUrl,
      industry: result.account.industry,
      employeeCount: result.account.employeeCount ? String(result.account.employeeCount) : "",
      owner: ownerValue(result.account),
      notes: result.account.notes,
    });
    setError(null);
  }, [accountId, base, company.id]);

  React.useEffect(() => {
    load().catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${base}/accounts/${accountId}`, {
        name: draft.name,
        accountStatus: draft.accountStatus,
        domain: draft.domain,
        websiteUrl: draft.websiteUrl,
        industry: draft.industry,
        employeeCount: draft.employeeCount ? Number(draft.employeeCount) : 0,
        ownerId: draft.owner.startsWith("user:") ? draft.owner.slice(5) : null,
        ownerEmployeeId: draft.owner.startsWith("employee:") ? draft.owner.slice(9) : null,
        notes: draft.notes,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!detail) return;
    const archived = !detail.account.archivedAt;
    if (archived) {
      const confirmed = await dialog.confirm({
        title: `Archive ${detail.account.name}?`,
        message:
          "The Account leaves default lists, but every Contact, Deal, invoice, document, and activity stays linked. You can restore it at any time.",
        confirmLabel: "Archive Account",
      });
      if (!confirmed) return;
    }
    background(
      () => api.post<Customer>(`${base}/accounts/${accountId}/${archived ? "archive" : "restore"}`),
      {
        loading: archived ? "Archiving Account…" : "Restoring Account…",
        success: archived ? "Account archived" : "Account restored",
        error: (cause) =>
          `Couldn’t ${archived ? "archive" : "restore"} this Account: ${
            cause instanceof Error ? cause.message : "Unknown error"
          }.`,
        onSuccess: () => void load(),
      },
    );
  }

  if (!detail && !error) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <FormError message={error ?? "Account not found"} />
      </div>
    );
  }

  const { account, contacts, deals } = detail;
  const openDeals = deals.filter((deal) => deal.status === "open");

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Revenue", to: sectionUrl },
            { label: "Accounts", to: `${sectionUrl}/accounts` },
            { label: account.name },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
              <Building2 size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {account.name}
              </h1>
              <p className="mt-0.5 text-sm capitalize text-slate-500">
                {account.accountStatus} account
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {account.websiteUrl && (
            <a
              href={account.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="mr-1 inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
            >
              Website <ExternalLink size={13} />
            </a>
          )}
          <Button size="sm" variant="secondary" onClick={() => setMergeOpen(true)}>
            <Merge size={14} />
            Merge
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void toggleArchive()}>
            {account.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {account.archivedAt ? "Restore" : "Archive"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-5">
          <FormError message={error} />
        </div>
      )}
      {account.archivedAt && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          This Account is archived. Its full Revenue and Finance history is preserved, and it can
          still be merged into an active Account.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <form
          onSubmit={save}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900 lg:col-span-2"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-slate-900 dark:text-slate-100">Account details</h2>
              <p className="mt-1 text-sm text-slate-500">
                Firmographics, lifecycle, ownership, and shared account notes.
              </p>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
            />
            <Select
              label="Status"
              value={draft.accountStatus}
              onChange={(event) => setDraft({ ...draft, accountStatus: event.target.value })}
            >
              <option value="prospect">Prospect</option>
              <option value="customer">Customer</option>
              <option value="former">Former customer</option>
            </Select>
            <Input
              label="Domain"
              value={draft.domain}
              onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
            />
            <Input
              label="Website"
              type="url"
              value={draft.websiteUrl}
              onChange={(event) => setDraft({ ...draft, websiteUrl: event.target.value })}
            />
            <Input
              label="Industry"
              value={draft.industry}
              onChange={(event) => setDraft({ ...draft, industry: event.target.value })}
            />
            <Input
              label="Employee count"
              type="number"
              min="0"
              value={draft.employeeCount}
              onChange={(event) => setDraft({ ...draft, employeeCount: event.target.value })}
            />
            <Select
              label="Owner"
              value={draft.owner}
              onChange={(event) => setDraft({ ...draft, owner: event.target.value })}
            >
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
          </div>
          <Textarea
            label="Account notes"
            rows={5}
            value={draft.notes}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
          />
        </form>

        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">Contacts</h2>
            {contacts.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No contacts linked yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
                {contacts.map((contact) => (
                  <li key={contact.id} className="py-3 first:pt-0 last:pb-0">
                    <Link
                      to={`${sectionUrl}/contacts/${contact.id}`}
                      className="flex items-start gap-2 text-sm hover:text-indigo-600 dark:hover:text-indigo-300"
                    >
                      <UserRound className="mt-0.5 shrink-0 text-slate-400" size={14} />
                      <span>
                        <span className="block font-medium text-slate-800 dark:text-slate-200">
                          {contact.name}
                        </span>
                        <span className="text-slate-500">
                          {contact.title || contact.email || "No role recorded"}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">Open deals</h2>
            {openDeals.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No open deals yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
                {openDeals.map((deal) => (
                  <li key={deal.id} className="py-3 first:pt-0 last:pb-0">
                    <Link
                      to={`${sectionUrl}/deals/${deal.id}`}
                      className="text-sm font-medium text-slate-800 hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-300"
                    >
                      {deal.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <RevenueCustomFieldsPanel
          companyId={company.id}
          resourceType="account"
          resourceId={account.id}
        />
        <RevenueDocumentsPanel
          companyId={company.id}
          resourceType="account"
          resourceId={account.id}
        />
      </div>

      <AccountMergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        base={base}
        sectionUrl={sectionUrl}
        source={account}
        onMerged={(result) => {
          setMergeOpen(false);
          toast(
            `${result.source.name} was merged into ${result.target.name} and archived.`,
            "success",
          );
          navigate(`${sectionUrl}/accounts/${result.target.id}`);
        }}
      />
    </div>
  );
}

function AccountMergeModal({
  open,
  onClose,
  base,
  sectionUrl,
  source,
  onMerged,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  sectionUrl: string;
  source: Customer;
  onMerged: (result: AccountMergePreview) => void;
}) {
  const [accounts, setAccounts] = React.useState<RevenueAccount[] | null>(null);
  const [targetId, setTargetId] = React.useState("");
  const [preview, setPreview] = React.useState<AccountMergePreview | null>(null);
  const [confirmName, setConfirmName] = React.useState("");
  const [resolutions, setResolutions] = React.useState<Record<string, "source" | "target">>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setTargetId("");
    setPreview(null);
    setConfirmName("");
    setResolutions({});
    setError(null);
    setAccounts(null);
    api
      .get<{ rows: RevenueAccount[] }>(`${base}/accounts?limit=200`)
      .then((result) => setAccounts(result.rows.filter((account) => account.id !== source.id)))
      .catch((cause) => {
        setAccounts([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [base, open, source.id]);

  React.useEffect(() => {
    if (!open || !targetId) {
      setPreview(null);
      return;
    }
    setPreview(null);
    setError(null);
    api
      .get<AccountMergePreview>(
        `${base}/accounts/${source.id}/merge-preview?targetAccountId=${targetId}`,
      )
      .then((result) => {
        setPreview(result);
        setResolutions(
          Object.fromEntries(
            [...(result.fieldConflicts ?? []), ...(result.customFieldConflicts ?? [])].map(
              (conflict) => [conflict.field, conflict.resolution],
            ),
          ),
        );
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [base, open, source.id, targetId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!preview || confirmName !== source.name) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<AccountMergePreview>(`${base}/accounts/${source.id}/merge`, {
        targetAccountId: targetId,
        confirmSourceName: confirmName,
        resolutions,
      });
      onMerged(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const countRows: Array<[string, number]> = preview
    ? (
        [
          ["Contacts", preview.counts.contacts],
          ["Deals", preview.counts.deals],
          ["Activities", preview.counts.activities],
          ["Partnerships", preview.counts.partnerships],
          ["Revenue documents", preview.counts.revenueDocuments],
          ["Signal events", preview.counts.signalEvents],
          ["Billing contacts", preview.counts.billingContacts],
          ["Contracts", preview.counts.contracts],
          ["Invoices", preview.counts.invoices],
          ["Estimates", preview.counts.estimates],
          ["Recurring invoices", preview.counts.recurringInvoices],
          ["Credits", preview.counts.credits],
          ["Custom values copied", preview.counts.customValuesCopied],
        ] satisfies Array<[string, number]>
      ).filter(([, count]) => count > 0)
    : [];

  return (
    <Modal open={open} onClose={onClose} title="Merge Account" size="lg">
      <form className="space-y-5" onSubmit={submit}>
        <div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Move all Revenue and Finance history from{" "}
            <span className="font-semibold text-slate-900 dark:text-slate-100">{source.name}</span>{" "}
            into one active Account. Issued document numbers stay unchanged, you choose each
            conflicting value, and the source is archived.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            This is one transaction: either every linked record moves, or none do.
          </p>
        </div>

        {accounts === null ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : accounts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500 dark:border-slate-700">
            There is no other active Account to merge into.{" "}
            <Link className="font-medium text-indigo-600" to={`${sectionUrl}/accounts`}>
              Create or restore one first.
            </Link>
          </div>
        ) : (
          <Select
            label="Destination Account"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            required
          >
            <option value="">Choose an active Account…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
                {account.domain ? ` · ${account.domain}` : ""}
              </option>
            ))}
          </Select>
        )}

        {targetId && !preview && !error && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}

        {preview && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/60">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Merge preview
            </h3>
            {countRows.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No linked records need moving.</p>
            ) : (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {countRows.map(([label, count]) => (
                  <div key={label}>
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                      {count}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {preview.counts.customValueConflicts > 0 && (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                {preview.counts.customValueConflicts} Account custom{" "}
                {preview.counts.customValueConflicts === 1 ? "value needs" : "values need"} a
                resolution below.
              </p>
            )}
          </div>
        )}

        {preview &&
          [...(preview.fieldConflicts ?? []), ...(preview.customFieldConflicts ?? [])].length >
            0 && (
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800/60">
                  <tr>
                    <th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">Archived source</th>
                    <th className="px-3 py-2">Destination</th>
                    <th className="px-3 py-2">Keep</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(preview.fieldConflicts ?? []), ...(preview.customFieldConflicts ?? [])].map(
                    (conflict) => (
                      <tr
                        key={conflict.field}
                        className="border-t border-slate-100 dark:border-slate-800"
                      >
                        <td className="px-3 py-2 font-medium">{conflict.label}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                          {displayMergeValue(conflict.sourceValue)}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                          {displayMergeValue(conflict.targetValue)}
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            aria-label={`Choose ${conflict.label} value`}
                            value={resolutions[conflict.field] ?? conflict.resolution}
                            onChange={(event) =>
                              setResolutions((current) => ({
                                ...current,
                                [conflict.field]: event.target.value as "source" | "target",
                              }))
                            }
                          >
                            <option value="target">Destination</option>
                            <option value="source">Source</option>
                          </Select>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}

        {preview && (
          <Input
            label={`Type "${source.name}" to confirm`}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            autoComplete="off"
          />
        )}

        {error && <FormError message={error} />}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!preview || confirmName !== source.name || busy}
          >
            {busy ? "Merging…" : "Merge and archive"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
