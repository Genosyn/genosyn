import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSignature,
  FileText,
  Mail,
  Pencil,
  Phone,
  Plus,
  Receipt,
  ScrollText,
} from "lucide-react";
import {
  api,
  Customer,
  displayEstimateStatus,
  displayInvoiceStatus,
  EstimateListItem,
  formatMoney,
  InvoiceListItem,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { CustomerContractsPanel } from "./CustomerContractsPanel";
import { CustomersOutletCtx } from "./CustomersLayout";

const DAY_MS = 24 * 60 * 60 * 1000;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

type Tone = "danger" | "warn" | "info";
type ActionItem = {
  id: string;
  tone: Tone;
  icon: React.ReactNode;
  label: string;
  detail: string;
  to: string;
};

/**
 * Customer detail — a single read-only overview of one account: headline
 * numbers, an "action needed" queue (overdue / unpaid invoices, estimates
 * awaiting a response), and the full history of invoices, estimates,
 * contracts, and contacts. Invoice/estimate detail still lives in Finance,
 * so rows deep-link across to those pages.
 */
export default function CustomerDetail() {
  const { company } = useOutletContext<CustomersOutletCtx>();
  const { customerSlug } = useParams();
  const navigate = useNavigate();
  const financeBase = `/c/${company.slug}/finance`;
  const customersUrl = `/c/${company.slug}/customers`;

  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [invoices, setInvoices] = React.useState<InvoiceListItem[]>([]);
  const [estimates, setEstimates] = React.useState<EstimateListItem[]>([]);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await api.get<Customer>(
          `/api/companies/${company.id}/customers/${customerSlug}`,
        );
        if (!alive) return;
        setCustomer(c);
        const [inv, est] = await Promise.all([
          api.get<InvoiceListItem[]>(
            `/api/companies/${company.id}/invoices?customerId=${c.id}`,
          ),
          api.get<EstimateListItem[]>(
            `/api/companies/${company.id}/estimates?customerId=${c.id}`,
          ),
        ]);
        if (!alive) return;
        setInvoices(inv);
        setEstimates(est);
        setReady(true);
      } catch (err) {
        if (!alive) return;
        setError((err as Error).message);
        setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [company.id, customerSlug]);

  // Outstanding (issued + unpaid) and lifetime-billed totals, grouped by
  // currency so a multi-currency account is never summed into a meaningless
  // single number.
  const { outstanding, billed } = React.useMemo(() => {
    const out = new Map<string, number>();
    const bill = new Map<string, number>();
    const now = new Date();
    for (const inv of invoices) {
      const st = displayInvoiceStatus(inv, now);
      if (st !== "draft" && st !== "void") {
        bill.set(inv.currency, (bill.get(inv.currency) ?? 0) + inv.totalCents);
      }
      if ((st === "sent" || st === "overdue") && inv.balanceCents > 0) {
        out.set(inv.currency, (out.get(inv.currency) ?? 0) + inv.balanceCents);
      }
    }
    return { outstanding: out, billed: bill };
  }, [invoices]);

  const actions = React.useMemo<ActionItem[]>(() => {
    const now = new Date();
    const items: ActionItem[] = [];
    for (const inv of invoices) {
      const st = displayInvoiceStatus(inv, now);
      const to = `${financeBase}/invoices/${inv.slug}`;
      const num = inv.number || "Draft invoice";
      if (st === "overdue") {
        const days = Math.max(
          1,
          Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / DAY_MS),
        );
        items.push({
          id: inv.id,
          tone: "danger",
          icon: <AlertTriangle size={15} />,
          label: `${num} overdue`,
          detail: `${formatMoney(inv.balanceCents, inv.currency)} · ${days} day${days === 1 ? "" : "s"} past due`,
          to,
        });
      } else if (st === "sent" && inv.balanceCents > 0) {
        items.push({
          id: inv.id,
          tone: "warn",
          icon: <Receipt size={15} />,
          label: `${num} awaiting payment`,
          detail: `${formatMoney(inv.balanceCents, inv.currency)} due ${fmtDate(inv.dueDate)}`,
          to,
        });
      } else if (st === "draft") {
        items.push({
          id: inv.id,
          tone: "info",
          icon: <FileText size={15} />,
          label: "Draft invoice not issued",
          detail: `${formatMoney(inv.totalCents, inv.currency)} · created ${fmtDate(inv.createdAt)}`,
          to,
        });
      }
    }
    for (const est of estimates) {
      const st = displayEstimateStatus(est, now);
      const to = `${financeBase}/estimates/${est.slug}`;
      const num = est.number || "Draft estimate";
      if (st === "sent") {
        items.push({
          id: est.id,
          tone: "info",
          icon: <FileSignature size={15} />,
          label: `${num} awaiting response`,
          detail: `${formatMoney(est.totalCents, est.currency)} · valid until ${fmtDate(est.validUntil)}`,
          to,
        });
      } else if (st === "expired") {
        items.push({
          id: est.id,
          tone: "warn",
          icon: <FileSignature size={15} />,
          label: `${num} expired`,
          detail: `${formatMoney(est.totalCents, est.currency)} · expired ${fmtDate(est.validUntil)}`,
          to,
        });
      }
    }
    const rank: Record<Tone, number> = { danger: 0, warn: 1, info: 2 };
    return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [invoices, estimates, financeBase]);

  if (!ready) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <Breadcrumbs items={[{ label: "Customers", to: customersUrl }, { label: "Not found" }]} />
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {error ?? "Customer not found."}
        </div>
        <div className="mt-4">
          <Link to={customersUrl}>
            <Button variant="secondary">Back to customers</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Customers", to: customersUrl }, { label: customer.name }]}
        />
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to={customersUrl}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {customer.name}
              {customer.archivedAt && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  Archived
                </span>
              )}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              {customer.email && (
                <span className="inline-flex items-center gap-1">
                  <Mail size={13} /> {customer.email}
                </span>
              )}
              {customer.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone size={13} /> {customer.phone}
                </span>
              )}
              <span className="font-mono text-xs">{customer.currency}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => navigate(`${customersUrl}/${customer.slug}/statement`)}
          >
            <ScrollText size={14} /> Statement
          </Button>
          <Button
            variant="secondary"
            onClick={() => navigate(`${customersUrl}/${customer.slug}/edit`)}
          >
            <Pencil size={14} /> Edit
          </Button>
        </div>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Annual contract value">
          {customer.annualContractValueCents > 0 ? (
            <Money
              entries={[[customer.currency, customer.annualContractValueCents]]}
            />
          ) : (
            <span className="text-sm text-slate-400 dark:text-slate-500">Not set</span>
          )}
        </StatCard>
        <StatCard label="Outstanding">
          {outstanding.size > 0 ? (
            <Money entries={[...outstanding.entries()]} />
          ) : (
            <span className="text-sm text-slate-400 dark:text-slate-500">
              Nothing outstanding
            </span>
          )}
        </StatCard>
        <StatCard label="Lifetime billed">
          {billed.size > 0 ? (
            <Money entries={[...billed.entries()]} />
          ) : (
            <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
          )}
        </StatCard>
      </div>

      {/* Action needed */}
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          Action needed
        </h2>
        {actions.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            <CheckCircle2 size={16} className="text-emerald-500" />
            All caught up — nothing needs your attention for this customer.
          </div>
        ) : (
          <ul className="space-y-2">
            {actions.map((a) => (
              <li key={`${a.tone}-${a.id}`}>
                <Link
                  to={a.to}
                  className={
                    "flex items-center gap-3 rounded-xl border p-3 text-sm shadow-sm transition-colors " +
                    toneClasses(a.tone)
                  }
                >
                  <span className="shrink-0">{a.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{a.label}</span>
                    <span className="block text-xs opacity-80">{a.detail}</span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 opacity-60" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Invoices */}
      <DocSection
        title="Invoices"
        count={invoices.length}
        newLabel="New invoice"
        newTo={`${financeBase}/invoices/new`}
        emptyText="No invoices for this customer yet."
      >
        {invoices.length > 0 && (
          <DocTable
            head={["Number", "Status", "Due", "Total", "Balance"]}
            rows={invoices.map((inv) => ({
              key: inv.id,
              to: `${financeBase}/invoices/${inv.slug}`,
              cells: [
                <span key="num" className="font-mono text-xs font-semibold">
                  {inv.number || "DRAFT"}
                </span>,
                <StatusBadge key="status" status={displayInvoiceStatus(inv)} />,
                fmtDate(inv.dueDate),
                <span key="total" className="tabular-nums">
                  {formatMoney(inv.totalCents, inv.currency)}
                </span>,
                <span key="bal" className="tabular-nums">
                  {inv.balanceCents > 0
                    ? formatMoney(inv.balanceCents, inv.currency)
                    : "—"}
                </span>,
              ],
            }))}
          />
        )}
      </DocSection>

      {/* Estimates */}
      <DocSection
        title="Estimates"
        count={estimates.length}
        newLabel="New estimate"
        newTo={`${financeBase}/estimates/new`}
        emptyText="No estimates for this customer yet."
      >
        {estimates.length > 0 && (
          <DocTable
            head={["Number", "Status", "Valid until", "Total"]}
            rows={estimates.map((est) => ({
              key: est.id,
              to: `${financeBase}/estimates/${est.slug}`,
              cells: [
                <span key="num" className="font-mono text-xs font-semibold">
                  {est.number || "DRAFT"}
                </span>,
                <StatusBadge key="status" status={displayEstimateStatus(est)} />,
                fmtDate(est.validUntil),
                <span key="total" className="tabular-nums">
                  {formatMoney(est.totalCents, est.currency)}
                </span>,
              ],
            }))}
          />
        )}
      </DocSection>

      {/* Contracts — reuse the same panel used on the edit page. */}
      <section className="mt-8">
        <CustomerContractsPanel
          company={company}
          customerId={customer.id}
          customerName={customer.name}
        />
      </section>

      {/* Contacts + details */}
      <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Contacts
          </h3>
          {customer.contacts.length === 0 ? (
            <p className="text-sm text-slate-400 dark:text-slate-500">
              No additional contacts.
            </p>
          ) : (
            <ul className="space-y-3">
              {customer.contacts.map((ct) => (
                <li key={ct.id} className="text-sm">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {ct.name}
                    {ct.isPrimary && (
                      <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                        Primary
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {[ct.role, ct.email, ct.phone].filter(Boolean).join(" · ") || "—"}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Details
          </h3>
          <dl className="space-y-2 text-sm">
            <Detail label="Tax / VAT" value={customer.taxNumber} />
            <Detail label="Default currency" value={customer.currency} />
            <Detail label="Billing address" value={customer.billingAddress} multiline />
            <Detail label="Notes" value={customer.notes} multiline />
          </dl>
        </div>
      </section>
    </div>
  );
}

function toneClasses(tone: Tone): string {
  switch (tone) {
    case "danger":
      return "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300";
    default:
      return "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800/60";
  }
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Money({ entries }: { entries: [string, number][] }) {
  return (
    <ul className="space-y-1">
      {entries.map(([cur, cents]) => (
        <li
          key={cur}
          className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100"
        >
          {formatMoney(cents, cur)}
        </li>
      ))}
    </ul>
  );
}

function DocSection({
  title,
  count,
  newLabel,
  newTo,
  emptyText,
  children,
}: {
  title: string;
  count: number;
  newLabel: string;
  newTo: string;
  emptyText: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {title}
          {count > 0 && (
            <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
              {count}
            </span>
          )}
        </h2>
        <Link
          to={newTo}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
        >
          <Plus size={12} /> {newLabel}
        </Link>
      </div>
      {count === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
          {emptyText}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

type DocRow = { key: string; to: string; cells: React.ReactNode[] };

function DocTable({ head, rows }: { head: string[]; rows: DocRow[] }) {
  const navigate = useNavigate();
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              {head.map((h, i) => (
                <th
                  key={h}
                  className={
                    "px-4 py-2 font-medium " +
                    (i >= head.length - 2 ? "text-right" : "text-left")
                  }
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr
                key={r.key}
                onClick={() => navigate(r.to)}
                className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                {r.cells.map((c, i) => (
                  <td
                    key={i}
                    className={
                      "px-4 py-3 text-slate-700 dark:text-slate-200 " +
                      (i >= r.cells.length - 2 ? "text-right" : "text-left")
                    }
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    sent: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
    paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    overdue: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
    void: "bg-slate-100 text-slate-400 line-through dark:bg-slate-800 dark:text-slate-500",
    accepted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    declined: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
    expired: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    invoiced: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  };
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
        (styles[status] ?? styles.draft)
      }
    >
      {status}
    </span>
  );
}

function Detail({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-slate-400 dark:text-slate-500">{label}</dt>
      <dd
        className={
          "text-slate-700 dark:text-slate-200 " + (multiline ? "whitespace-pre-line" : "")
        }
      >
        {value ? value : <span className="text-slate-400 dark:text-slate-500">—</span>}
      </dd>
    </div>
  );
}
