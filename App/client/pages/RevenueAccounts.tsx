import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Archive, Building2, ExternalLink, Plus, Search, Users } from "lucide-react";
import { api, type Employee, type Member } from "../lib/api";
import type { RevenueAccount } from "../lib/revenue";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { RevenueOutletCtx } from "./RevenueLayout";

type AccountStatus = "prospect" | "customer" | "former";

const STATUS_CLASS: Record<AccountStatus, string> = {
  prospect: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  customer: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  former: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
};

export default function RevenueAccounts() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [rows, setRows] = React.useState<RevenueAccount[] | null>(null);
  const [status, setStatus] = React.useState<"all" | AccountStatus>("all");
  const [showArchived, setShowArchived] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const reload = React.useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (status !== "all") params.set("status", status);
    if (query) params.set("q", query);
    if (showArchived) params.set("includeArchived", "true");
    const result = await api.get<{ rows: RevenueAccount[] }>(
      `${base}/accounts?${params.toString()}`,
    );
    setRows(result.rows);
    setError(null);
  }, [base, query, showArchived, status]);

  React.useEffect(() => {
    reload().catch((cause) => {
      setRows([]);
      setError(cause instanceof Error ? cause.message : String(cause));
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

  useLiveRefetch(["customer", "contact", "deal"], reload);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Accounts" }]} />
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Accounts</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            One company record from first prospect conversation through billing and renewal.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={15} /> New account
        </Button>
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 text-slate-400" size={15} />
          <Input
            aria-label="Search accounts"
            placeholder="Search name, domain, or industry"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="all">All statuses</option>
          <option value="prospect">Prospects</option>
          <option value="customer">Customers</option>
          <option value="former">Former customers</option>
        </Select>
        <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <Archive size={14} />
          Show archived
        </label>
      </div>

      {error && <FormError message={error} />}
      {rows === null ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-16 text-center dark:border-slate-700">
          <Building2 className="mx-auto mb-3 text-slate-400" size={28} />
          <p className="font-medium text-slate-800 dark:text-slate-200">No accounts found</p>
          <p className="mt-1 text-sm text-slate-500">
            Create a prospect without creating a finance record twice.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((account) => (
            <Link
              key={account.id}
              to={`/c/${company.slug}/revenue/accounts/${account.id}`}
              className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-700 ${
                account.archivedAt ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-semibold text-slate-900 dark:text-slate-100">
                      {account.name}
                    </h2>
                    <ExternalLink size={12} className="text-slate-400" />
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-500">
                    {account.domain || account.industry || "No firmographic details yet"}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_CLASS[account.accountStatus]}`}
                >
                  {account.archivedAt ? "archived" : account.accountStatus}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <Users size={13} /> {account.contactCount} contacts
                </span>
                <span>{account.openDealCount} open deals</span>
                {account.employeeCount > 0 && (
                  <span>{account.employeeCount.toLocaleString()} employees</span>
                )}
                {account.industry && <span>{account.industry}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}

      <NewAccountModal
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

function NewAccountModal({
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
  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [websiteUrl, setWebsiteUrl] = React.useState("");
  const [industry, setIndustry] = React.useState("");
  const [employeeCount, setEmployeeCount] = React.useState("");
  const [status, setStatus] = React.useState<AccountStatus>("prospect");
  const [owner, setOwner] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/accounts`, {
        name,
        domain,
        websiteUrl,
        industry,
        employeeCount: employeeCount ? Number(employeeCount) : 0,
        accountStatus: status,
        ownerId: owner.startsWith("user:") ? owner.slice(5) : null,
        ownerEmployeeId: owner.startsWith("employee:") ? owner.slice(9) : null,
        notes,
      });
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New account" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="Company name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Domain"
            placeholder="example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <Input
            label="Website"
            type="url"
            placeholder="https://example.com"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
          />
          <Input label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
          <Input
            label="Employee count"
            type="number"
            min="0"
            value={employeeCount}
            onChange={(e) => setEmployeeCount(e.target.value)}
          />
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as AccountStatus)}
          >
            <option value="prospect">Prospect</option>
            <option value="customer">Customer</option>
            <option value="former">Former customer</option>
          </Select>
          <Select label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
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
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
