import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Calendar, Handshake, Plus, Search } from "lucide-react";
import { api } from "../lib/api";
import type { Partnership, RevenueClassification } from "../lib/revenue";
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

function dateLabel(iso: string | null): string {
  if (!iso) return "No follow-up";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "No follow-up" : date.toLocaleDateString();
}

export default function RevenuePartnerships() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [rows, setRows] = React.useState<Partnership[] | null>(null);
  const [classifications, setClassifications] = React.useState<RevenueClassification[]>([]);
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const reload = React.useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (query) params.set("q", query);
    if (status) params.set("status", status);
    const [result, controlled] = await Promise.all([
      api.get<{ rows: Partnership[] }>(`${base}/partnerships?${params.toString()}`),
      api.get<{ rows: RevenueClassification[] }>(`${base}/classifications`),
    ]);
    setRows(result.rows);
    setClassifications(controlled.rows);
    setError(null);
  }, [base, query, status]);

  React.useEffect(() => {
    reload().catch((cause) => {
      setRows([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [reload]);

  useLiveRefetch(["partnership", "activity"], reload);
  const statuses = classifications.filter((row) => row.kind === "partnership_status");
  const types = classifications.filter((row) => row.kind === "partnership_type");
  const labelFor = (kind: RevenueClassification["kind"], value: string) =>
    classifications.find((row) => row.kind === kind && row.value === value)?.label || value || "Not set";

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Partnerships" }]} />
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Partnerships</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Partner relationships with their own status, contacts, context, and follow-up rhythm.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus size={15} /> New partnership</Button>
      </div>
      <div className="mb-4 flex gap-3">
        <div className="relative min-w-64 flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-3 text-slate-400" />
          <Input className="pl-9" placeholder="Search partnerships" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {statuses.map((row) => <option key={row.id} value={row.value}>{row.label}</option>)}
        </Select>
      </div>
      {error && <FormError message={error} />}
      {rows === null ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-16 text-center dark:border-slate-700">
          <Handshake className="mx-auto mb-3 text-slate-400" size={28} />
          <p className="font-medium text-slate-800 dark:text-slate-200">No partnerships found</p>
          <p className="mt-1 text-sm text-slate-500">Keep partner work distinct from sales deals.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          {rows.map((partnership) => (
            <Link
              key={partnership.id}
              to={`/c/${company.slug}/revenue/partnerships/${partnership.id}`}
              className="flex flex-wrap items-center gap-4 border-b border-slate-100 px-4 py-4 transition last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
            >
              <div className="min-w-0 flex-1">
                <h2 className="font-medium text-slate-900 dark:text-slate-100">{partnership.name}</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {labelFor("partnership_type", partnership.type)}
                  {partnership.channelContext ? ` · ${partnership.channelContext}` : ""}
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {labelFor("partnership_status", partnership.status)}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                <Calendar size={13} /> {dateLabel(partnership.nextFollowUpAt)}
              </span>
            </Link>
          ))}
        </div>
      )}

      <NewPartnershipModal
        open={creating}
        onClose={() => setCreating(false)}
        base={base}
        types={types}
        statuses={statuses}
        onCreated={(partnership) => {
          setCreating(false);
          setRows((current) => (current ? [partnership, ...current] : [partnership]));
        }}
      />
    </div>
  );
}

function NewPartnershipModal({
  open,
  onClose,
  base,
  types,
  statuses,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  types: RevenueClassification[];
  statuses: RevenueClassification[];
  onCreated: (row: Partnership) => void;
}) {
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [websiteUrl, setWebsiteUrl] = React.useState("");
  const [nextFollowUpAt, setNextFollowUpAt] = React.useState("");
  const [integrationContext, setIntegrationContext] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!type && types[0]) setType(types[0].value);
    if (!status && statuses[0]) setStatus(statuses[0].value);
  }, [status, statuses, type, types]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const row = await api.post<Partnership>(`${base}/partnerships`, {
        name,
        type,
        status,
        websiteUrl,
        nextFollowUpAt: nextFollowUpAt || null,
        integrationContext,
      });
      onCreated(row);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New partnership" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <Input label="Partner name" value={name} onChange={(e) => setName(e.target.value)} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            {types.map((row) => <option key={row.id} value={row.value}>{row.label}</option>)}
          </Select>
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((row) => <option key={row.id} value={row.value}>{row.label}</option>)}
          </Select>
          <Input label="Website" type="url" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} />
          <Input label="Next follow-up" type="datetime-local" value={nextFollowUpAt} onChange={(e) => setNextFollowUpAt(e.target.value)} />
        </div>
        <Textarea label="Integration or channel context" rows={3} value={integrationContext} onChange={(e) => setIntegrationContext(e.target.value)} />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create partnership"}</Button>
        </div>
      </form>
    </Modal>
  );
}
