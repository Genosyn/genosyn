import React from "react";
import { Archive, ArchiveRestore, Building2, ExternalLink, Merge, UserRound } from "lucide-react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { Breadcrumbs } from "../components/AppShell";
import { RecordHistory } from "../components/RecordHistory";
import { AccountMergeModal } from "../components/revenue/AccountMergeModal";
import { RevenueCustomFieldsPanel } from "../components/revenue/RevenueCustomFieldsPanel";
import { RevenueDocumentsPanel } from "../components/revenue/RevenueDocumentsPanel";
import { Button } from "../components/ui/Button";
import { useBackgroundAction } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import type { AccountMergePreview } from "../lib/accountMerge";
import { api, type Employee, type Member } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { type RevenueAccount, type RevenueAccountRecord } from "../lib/revenue";
import type { RevenueContact } from "./RevenueContacts";
import type { Deal } from "./RevenueDeals";
import type { RevenueOutletCtx } from "./RevenueLayout";

type AccountDetail = {
  account: RevenueAccountRecord;
  contacts: RevenueContact[];
  deals: Deal[];
};

function ownerValue(account: RevenueAccountRecord): string {
  if (account.ownerId) return `user:${account.ownerId}`;
  if (account.ownerEmployeeId) return `employee:${account.ownerEmployeeId}`;
  return "";
}

export default function RevenueAccountDetail() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { accountId = "" } = useParams();
  const navigate = useNavigate();
  const background = useBackgroundAction();
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
  const [announcement, setAnnouncement] = React.useState("");
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

  /**
   * Archive needs no confirm: every Contact, Deal, invoice, document and
   * activity stays linked, the banner says so at once, and the button turns
   * into Restore where the pointer already is — the undo.
   */
  function toggleArchive() {
    if (!detail) return;
    const archived = !detail.account.archivedAt;
    const before = detail.account.archivedAt;
    const setArchivedAt = (archivedAt: string | null) =>
      setDetail((current) =>
        current ? { ...current, account: { ...current.account, archivedAt } } : current,
      );
    setArchivedAt(archived ? new Date().toISOString() : null);
    setAnnouncement(
      archived
        ? `Archived ${detail.account.name}. Restore puts it back.`
        : `Restored ${detail.account.name}.`,
    );
    background(
      () =>
        api.post<RevenueAccountRecord>(
          `${base}/accounts/${accountId}/${archived ? "archive" : "restore"}`,
        ),
      {
        title: `Couldn’t ${archived ? "archive" : "restore"} this Account`,
        error: (err) => `${errorMessage(err)} The change was undone.`,
        onSuccess: () => void load(),
        onError: () => {
          setAnnouncement("");
          setArchivedAt(before);
        },
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
    <div className="page-shell p-4 sm:p-8">
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
          <Button size="sm" variant="secondary" onClick={toggleArchive}>
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
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {account.archivedAt && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          This Account is archived. Its full Revenue and Finance history is preserved, and it can
          still be merged into an active Account. Restore brings it back.
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
            <Button type="submit" loading={busy}>
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
          <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-700 dark:bg-slate-800/50 sm:grid-cols-3">
            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Headquarters
              </p>
              <p className="mt-1 whitespace-pre-line text-slate-700 dark:text-slate-200">
                {account.headquartersAddress || "Not verified"}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Parent company
              </p>
              <p className="mt-1 text-slate-700 dark:text-slate-200">
                {account.parentCompanyName || "Not verified"}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Parent domain
              </p>
              <p className="mt-1 break-all text-slate-700 dark:text-slate-200">
                {account.parentCompanyDomain || "Not verified"}
              </p>
            </div>
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

      <RecordHistory
        className="mt-6"
        companyId={company.id}
        companySlug={company.slug}
        targetType="revenue_account"
        targetId={account.id}
        noun="this account"
        currency={account.currency}
        milestones={[{ label: "Account created", at: account.createdAt, covers: ["create"] }]}
      />

      <AccountMergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        noun="Account"
        source={account}
        financeAccess={company.financeAccess}
        searchTargets={(query) =>
          api
            .get<{ rows: RevenueAccount[] }>(
              `${base}/accounts?limit=200${query ? `&q=${encodeURIComponent(query)}` : ""}`,
            )
            .then((result) => result.rows)
        }
        loadPreview={(targetId) =>
          api.get<AccountMergePreview>(
            `${base}/accounts/${account.id}/merge-preview?targetAccountId=${targetId}`,
          )
        }
        merge={({ targetId, confirmSourceName, resolutions }) =>
          api.post<AccountMergePreview>(`${base}/accounts/${account.id}/merge`, {
            targetAccountId: targetId,
            confirmSourceName,
            resolutions,
          })
        }
        emptyHint={
          <Link className="font-medium text-indigo-600" to={`${sectionUrl}/accounts`}>
            Create or restore one first.
          </Link>
        }
        onMerged={(result) => {
          setMergeOpen(false);
          navigate(`${sectionUrl}/accounts/${result.target.id}`);
        }}
      />
    </div>
  );
}
