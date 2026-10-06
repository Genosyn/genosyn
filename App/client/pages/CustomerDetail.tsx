import React from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  FileSignature,
  FileText,
  Globe,
  Mail,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Repeat,
  ScrollText,
  UserRound,
} from "lucide-react";
import {
  api,
  Customer,
  CustomerCredit,
  CustomerMailPage,
  displayEstimateStatus,
  displayInvoiceStatus,
  Employee,
  EstimateListItem,
  formatMoney,
  InvoiceListItem,
  Member,
  RecurringInvoiceListItem,
} from "../lib/api";
import {
  CUSTOMER_TABS,
  dealTotalsByCurrency,
  describeMailSearch,
  orderAccountDeals,
  parseCustomerTab,
  type CustomerTab,
} from "../lib/customerOverview";
import { meetingsApi, type Meeting } from "../lib/meetings";
import { newRecurringInvoicePath } from "../lib/recurringInvoiceForm";
import { describeCron } from "../lib/schedule";
import { normalizeEnvelopeList, type SignatureEnvelope } from "../lib/signing";
import { canWriteFinance } from "../lib/subpages";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { ActivityTimeline, type RevenueActivity } from "../components/revenue/ActivityTimeline";
import { RevenueCustomFieldsPanel } from "../components/revenue/RevenueCustomFieldsPanel";
import { RevenueDocumentsPanel } from "../components/revenue/RevenueDocumentsPanel";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { CustomerContractsPanel } from "./CustomerContractsPanel";
import { CustomerMailList } from "./CustomerMailPanel";
import {
  CustomerDealsTable,
  CustomerMeetingsList,
  CustomerPeoplePanel,
  CustomerSignaturesList,
  SectionHeading,
} from "./CustomerRelationshipPanels";
import { CustomersOutletCtx } from "./CustomersLayout";
import { ownerLabel, type RevenueContact } from "./RevenueContacts";
import { stagePillClasses, type Deal } from "./RevenueDeals";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAIL_PAGE = 25;
/** The server's page ceiling for customer mail. */
const MAIL_MAX_PAGE = 100;
const ACTIVITY_PAGE = 50;
/** The server's page ceiling for activities. */
const ACTIVITY_MAX_PAGE = 200;
/** Contacts, deals and meetings are listed whole, up to the list endpoints' cap. */
const LIST_LIMIT = 200;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/** An external link for the customer's website — http(s) only, never a script URL. */
function websiteHref(customer: Customer): string | null {
  const raw = customer.websiteUrl.trim() || customer.domain.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const ACCOUNT_STATUS_LABEL: Record<Customer["accountStatus"], string> = {
  prospect: "Prospect",
  customer: "Customer",
  former: "Former customer",
};

const CREDIT_KIND_LABEL: Record<CustomerCredit["kind"], string> = {
  credit_memo: "Credit memo",
  deposit: "Deposit",
  overpayment: "Overpayment",
};

type Tone = "danger" | "warn" | "info";
type ActionItem = {
  id: string;
  tone: Tone;
  icon: React.ReactNode;
  label: string;
  detail: string;
  to: string;
};

type RelationshipList = "contacts" | "deals" | "activities" | "meetings" | "envelopes";

/** Everything the account carries on the Revenue side, plus its signature requests. */
type Relationship = {
  contacts: RevenueContact[];
  deals: Deal[];
  activities: RevenueActivity[];
  activityTotal: number;
  meetings: Meeting[];
  envelopes: SignatureEnvelope[];
  /** A list that failed to load renders empty, with its error where it would be. */
  errors: Partial<Record<RelationshipList, string>>;
};

type Page<T> = { rows: T[]; total: number };

function failure(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status === "fulfilled") return undefined;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

/**
 * Customer detail — everything about one account on one page. The overview
 * keeps the headline numbers and the "action needed" queue (overdue and
 * unpaid invoices, estimates awaiting a response, recurring runs that are
 * retrying or could not email their invoice); the tabs hold the full
 * record: every email exchanged with the customer's people, the activity
 * timeline, deals, contacts, meetings, billing documents, and contracts,
 * signature requests and files. Records are edited on their own pages
 * (Finance, Revenue, Mail, Meetings, Signatures), so rows deep-link there.
 *
 * The finance routes write the customer and its billing documents, so a
 * read-only Member gets the page without Edit or the billing tab's New links;
 * every detail the edit form holds is already shown here for reading.
 */
export default function CustomerDetail() {
  const { company } = useOutletContext<CustomersOutletCtx>();
  const canWrite = canWriteFinance(company);
  const { customerSlug } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseCustomerTab(searchParams.get("tab"));
  const financeBase = `/c/${company.slug}/finance`;
  const customersUrl = `/c/${company.slug}/customers`;

  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [invoices, setInvoices] = React.useState<InvoiceListItem[]>([]);
  const [estimates, setEstimates] = React.useState<EstimateListItem[]>([]);
  const [recurring, setRecurring] = React.useState<RecurringInvoiceListItem[]>([]);
  const [credits, setCredits] = React.useState<CustomerCredit[]>([]);
  const [billingError, setBillingError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [relationship, setRelationship] = React.useState<Relationship | null>(null);
  const [loadingMoreActivity, setLoadingMoreActivity] = React.useState(false);
  const [mail, setMail] = React.useState<CustomerMailPage | null>(null);
  const [mailError, setMailError] = React.useState<string | null>(null);
  const [loadingMoreMail, setLoadingMoreMail] = React.useState(false);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  // How far the person has paged, so a live refresh keeps their place.
  const mailShown = React.useRef(MAIL_PAGE);
  const activityShown = React.useRef(ACTIVITY_PAGE);
  const tabList = React.useRef<HTMLDivElement>(null);

  const reload = React.useCallback(async () => {
    try {
      const c = await api.get<Customer>(
        `/api/companies/${company.id}/customers/${customerSlug}`,
      );
      setCustomer(c);
      const [inv, est] = await Promise.all([
        api.get<InvoiceListItem[]>(
          `/api/companies/${company.id}/invoices?customerId=${c.id}`,
        ),
        api.get<EstimateListItem[]>(
          `/api/companies/${company.id}/estimates?customerId=${c.id}`,
        ),
      ]);
      setInvoices(inv);
      setEstimates(est);
      const [rec, cred] = await Promise.allSettled([
        api.get<RecurringInvoiceListItem[]>(
          `/api/companies/${company.id}/recurring-invoices?customerId=${c.id}`,
        ),
        api.get<CustomerCredit[]>(`/api/companies/${company.id}/credit-notes?customerId=${c.id}`),
      ]);
      setRecurring(rec.status === "fulfilled" ? rec.value : []);
      setCredits(cred.status === "fulfilled" ? cred.value : []);
      setBillingError(failure(rec) ?? failure(cred) ?? null);
      setReady(true);
    } catch (err) {
      setError((err as Error).message);
      setReady(true);
    }
  }, [company.id, customerSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch(["customer", "invoice", "estimate", "recurringinvoice"], reload);

  const customerId = customer?.id ?? null;

  const reloadRelationship = React.useCallback(async () => {
    if (!customerId) return;
    const base = `/api/companies/${company.id}`;
    const activityLimit = Math.min(ACTIVITY_MAX_PAGE, activityShown.current);
    const [contacts, deals, activities, meetings, envelopes] = await Promise.allSettled([
      api.get<Page<RevenueContact>>(
        `${base}/revenue/contacts?customerId=${customerId}&limit=${LIST_LIMIT}`,
      ),
      api.get<Page<Deal>>(`${base}/revenue/deals?customerId=${customerId}&limit=${LIST_LIMIT}`),
      api.get<Page<RevenueActivity>>(
        `${base}/revenue/activities?customerId=${customerId}&includeRelatedRecords=true&limit=${activityLimit}`,
      ),
      meetingsApi.meetings(company.id, { customerId, limit: LIST_LIMIT }),
      api.get<unknown>(`${base}/signature-envelopes?customerId=${customerId}`),
    ]);
    const errors: Relationship["errors"] = {};
    const lists: Array<[RelationshipList, PromiseSettledResult<unknown>]> = [
      ["contacts", contacts],
      ["deals", deals],
      ["activities", activities],
      ["meetings", meetings],
      ["envelopes", envelopes],
    ];
    for (const [key, result] of lists) {
      const message = failure(result);
      if (message) errors[key] = message;
    }
    setRelationship({
      contacts: contacts.status === "fulfilled" ? contacts.value.rows : [],
      deals: deals.status === "fulfilled" ? deals.value.rows : [],
      activities: activities.status === "fulfilled" ? activities.value.rows : [],
      activityTotal: activities.status === "fulfilled" ? activities.value.total : 0,
      meetings: meetings.status === "fulfilled" ? meetings.value.meetings : [],
      envelopes: envelopes.status === "fulfilled" ? normalizeEnvelopeList(envelopes.value) : [],
      errors,
    });
  }, [company.id, customerId]);

  React.useEffect(() => {
    void reloadRelationship();
  }, [reloadRelationship]);

  useLiveRefetch(["contact", "deal", "activity", "meeting", "signature"], reloadRelationship);

  const reloadMail = React.useCallback(async () => {
    try {
      const page = await api.get<CustomerMailPage>(
        `/api/companies/${company.id}/customers/${customerSlug}/mail?limit=${Math.min(MAIL_MAX_PAGE, mailShown.current)}`,
      );
      setMail(page);
      setMailError(null);
    } catch (err) {
      setMailError((err as Error).message);
    }
  }, [company.id, customerSlug]);

  React.useEffect(() => {
    void reloadMail();
  }, [reloadMail]);

  // Which mail belongs to the customer follows its addresses: its billing
  // email, domain and billing contacts (`customer`), and Revenue Contacts.
  useLiveRefetch(["customer", "contact"], reloadMail);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => []),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`).catch(() => []),
    ]).then(([memberRows, employeeRows]) => {
      if (cancelled) return;
      setMembers(memberRows);
      setEmployees(employeeRows);
    });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  async function loadMoreMail() {
    if (!mail) return;
    setLoadingMoreMail(true);
    try {
      const next = await api.get<CustomerMailPage>(
        `/api/companies/${company.id}/customers/${customerSlug}/mail?limit=${MAIL_PAGE}&offset=${mail.threads.length}`,
      );
      const seen = new Set(mail.threads.map((thread) => thread.id));
      const threads = [...mail.threads, ...next.threads.filter((thread) => !seen.has(thread.id))];
      mailShown.current = threads.length;
      setMail({ ...next, offset: 0, threads });
      setMailError(null);
    } catch (err) {
      setMailError((err as Error).message);
    } finally {
      setLoadingMoreMail(false);
    }
  }

  async function loadMoreActivity() {
    if (!relationship || !customerId) return;
    setLoadingMoreActivity(true);
    try {
      const next = await api.get<Page<RevenueActivity>>(
        `/api/companies/${company.id}/revenue/activities?customerId=${customerId}&includeRelatedRecords=true&limit=${ACTIVITY_PAGE}&offset=${relationship.activities.length}`,
      );
      const seen = new Set(relationship.activities.map((activity) => activity.id));
      const activities = [
        ...relationship.activities,
        ...next.rows.filter((activity) => !seen.has(activity.id)),
      ];
      activityShown.current = activities.length;
      setRelationship({
        ...relationship,
        activities,
        activityTotal: next.total,
        errors: { ...relationship.errors, activities: undefined },
      });
    } catch (err) {
      setRelationship({
        ...relationship,
        errors: { ...relationship.errors, activities: (err as Error).message },
      });
    } finally {
      setLoadingMoreActivity(false);
    }
  }

  // On a narrow screen a linked tab can start outside the scrolled tab row.
  React.useEffect(() => {
    tabList.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, ready]);

  function setTab(next: CustomerTab) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "overview") params.delete("tab");
        else params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  }

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
    // A scheduled run that is retrying, or that issued its invoice but could
    // not email it, is billing that has not reached the customer yet.
    for (const ri of recurring) {
      const run = ri.latestRun;
      const retrying = ri.status === "active" && run?.status === "pending" && !!run.lastError;
      if (!run || (!retrying && run.status !== "failed")) continue;
      items.push({
        id: ri.id,
        tone: "warn",
        icon: <Repeat size={15} />,
        label: retrying ? `${ri.name}: run retrying` : `${ri.name}: invoice not emailed`,
        detail: run.lastError,
        to: `${financeBase}/recurring-invoices/${ri.slug}`,
      });
    }
    const rank: Record<Tone, number> = { danger: 0, warn: 1, info: 2 };
    return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [invoices, estimates, recurring, financeBase]);

  const deals = React.useMemo(
    () => orderAccountDeals(relationship?.deals ?? []),
    [relationship?.deals],
  );
  const openDeals = deals.filter((deal) => deal.status === "open");
  const dealLinks = React.useMemo(
    () =>
      Object.fromEntries(
        deals.map((deal) => [
          deal.id,
          { title: deal.title, to: `/c/${company.slug}/revenue/deals/${deal.id}` },
        ]),
      ),
    [deals, company.slug],
  );

  if (!ready) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="page-shell p-8">
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

  const editTo = canWrite ? `${customersUrl}/${customer.slug}/edit` : null;
  const website = websiteHref(customer);
  const owner = ownerLabel(customer, members, employees);
  const people = (relationship?.contacts.length ?? 0) + customer.contacts.length;
  const counts: Partial<Record<CustomerTab, number>> = {
    emails: mail?.total,
    activity: relationship?.activityTotal,
    deals: relationship?.deals.length,
    people,
    meetings: relationship?.meetings.length,
    billing: invoices.length + estimates.length + recurring.length + credits.length,
  };
  const openPipeline = dealTotalsByCurrency(deals, "open");
  const wonValue = dealTotalsByCurrency(deals, "won");

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Customers", to: customersUrl }, { label: customer.name }]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={customersUrl}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {customer.name}
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                {ACCOUNT_STATUS_LABEL[customer.accountStatus]}
              </span>
              {customer.archivedAt && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  Archived
                </span>
              )}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              {customer.email && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <Mail size={13} className="shrink-0" />
                  <span className="truncate">{customer.email}</span>
                </span>
              )}
              {customer.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone size={13} /> {customer.phone}
                </span>
              )}
              {website && (
                <a
                  href={website}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-300"
                >
                  <Globe size={13} className="shrink-0" />
                  <span className="truncate">{customer.domain || new URL(website).hostname}</span>
                </a>
              )}
              {owner && (
                <span className="inline-flex items-center gap-1">
                  <UserRound size={13} /> {owner.name}
                </span>
              )}
              <span className="font-mono text-xs">{customer.currency}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => navigate(`/c/${company.slug}/revenue/accounts/${customer.id}`)}
          >
            <Building2 size={14} /> Revenue
          </Button>
          <Button
            variant="secondary"
            onClick={() => navigate(`${customersUrl}/${customer.slug}/statement`)}
          >
            <ScrollText size={14} /> Statement
          </Button>
          {editTo && (
            <Button variant="secondary" onClick={() => navigate(editTo)}>
              <Pencil size={14} /> Edit
            </Button>
          )}
        </div>
      </div>

      {/* Narrow screens swipe the tab row; its scrollbar would only add a gray bar. */}
      <div className="mb-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          ref={tabList}
          role="tablist"
          aria-label="Customer sections"
          className="flex min-w-max gap-0.5 border-b border-slate-200 dark:border-slate-800"
        >
          {CUSTOMER_TABS.map(([key, label]) => {
            const count = counts[key];
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={
                  "-mb-px inline-flex items-center whitespace-nowrap border-b-2 px-2.5 py-2 text-sm font-medium transition " +
                  (tab === key
                    ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                    : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
                }
              >
                {label}
                {count !== undefined && count > 0 && (
                  <span className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "overview" && (
        <>
          {/* Headline numbers */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
            <StatCard label="Open pipeline">
              {openPipeline.length > 0 ? (
                <Money entries={openPipeline} />
              ) : (
                <span className="text-sm text-slate-400 dark:text-slate-500">No open deals</span>
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

          <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-6">
            <div className="min-w-0 space-y-8 lg:col-span-2">
              <section>
                <SectionHeading
                  title="Recent emails"
                  count={mail?.total}
                  action={<TabLink onClick={() => setTab("emails")}>All emails</TabLink>}
                />
                <MailSection
                  mail={mail}
                  error={mailError}
                  companySlug={company.slug}
                  editTo={editTo}
                  preview={5}
                />
              </section>

              <section>
                <SectionHeading
                  title="Recent activity"
                  count={relationship?.activityTotal}
                  action={<TabLink onClick={() => setTab("activity")}>Full timeline</TabLink>}
                />
                {relationship ? (
                  <>
                    <FormError message={relationship.errors.activities} className="mb-3" />
                    <ActivityTimeline
                      activities={relationship.activities.slice(0, 6)}
                      companySlug={company.slug}
                      total={relationship.activityTotal}
                      dealLinks={dealLinks}
                    />
                  </>
                ) : (
                  <SectionSpinner />
                )}
              </section>

              <section>
                <SectionHeading
                  title="Open deals"
                  count={openDeals.length}
                  action={<TabLink onClick={() => setTab("deals")}>All deals</TabLink>}
                />
                {!relationship ? (
                  <SectionSpinner />
                ) : openDeals.length === 0 ? (
                  <QuietEmpty>No open deals with this customer.</QuietEmpty>
                ) : (
                  <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
                    {openDeals.slice(0, 5).map((deal) => (
                      <li key={deal.id}>
                        <Link
                          to={`/c/${company.slug}/revenue/deals/${deal.id}`}
                          className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
                        >
                          <span className="min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-slate-100">
                            {deal.title}
                          </span>
                          <span
                            className={
                              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium " +
                              stagePillClasses(deal.stageKind)
                            }
                          >
                            {deal.stageName ?? "Unstaged"}
                          </span>
                          <span className="shrink-0 tabular-nums text-slate-700 dark:text-slate-200">
                            {formatMoney(deal.amountCents, deal.currency)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="min-w-0 space-y-6">
              <DetailsCard customer={customer} owner={owner} website={website} />
              <PeopleCard
                contacts={relationship?.contacts ?? []}
                customer={customer}
                companySlug={company.slug}
                onViewAll={() => setTab("people")}
              />
              <RevenueCustomFieldsPanel
                companyId={company.id}
                resourceType="account"
                resourceId={customer.id}
              />
            </div>
          </div>
        </>
      )}

      {tab === "emails" && (
        <section>
          {mail && (mail.addresses.length > 0 || mail.domain) && mail.mailboxCount > 0 && (
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              Conversations with {describeMailSearch(mail.addresses, mail.domain)}, across{" "}
              {mail.mailboxCount === 1 ? "your mailbox" : `${mail.mailboxCount} mailboxes`}.
            </p>
          )}
          <MailSection
            mail={mail}
            error={mailError}
            companySlug={company.slug}
            editTo={editTo}
            onLoadMore={() => void loadMoreMail()}
            loadingMore={loadingMoreMail}
          />
        </section>
      )}

      {tab === "activity" && (
        <section>
          {relationship ? (
            <>
              <FormError message={relationship.errors.activities} className="mb-3" />
              <ActivityTimeline
                activities={relationship.activities}
                companySlug={company.slug}
                total={relationship.activityTotal}
                dealLinks={dealLinks}
              />
              {relationship.activities.length < relationship.activityTotal && (
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void loadMoreActivity()}
                    loading={loadingMoreActivity}
                  >
                    Show older activity
                  </Button>
                </div>
              )}
            </>
          ) : (
            <SectionSpinner />
          )}
        </section>
      )}

      {tab === "deals" && (
        <section>
          {relationship ? (
            <>
              <FormError message={relationship.errors.deals} className="mb-3" />
              {deals.length > 0 && (
                <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <StatCard label="Open pipeline">
                    {openPipeline.length > 0 ? (
                      <Money entries={openPipeline} />
                    ) : (
                      <span className="text-sm text-slate-400 dark:text-slate-500">
                        No open deals
                      </span>
                    )}
                  </StatCard>
                  <StatCard label="Won">
                    {wonValue.length > 0 ? (
                      <Money entries={wonValue} />
                    ) : (
                      <span className="text-sm text-slate-400 dark:text-slate-500">
                        No won deals yet
                      </span>
                    )}
                  </StatCard>
                </div>
              )}
              <CustomerDealsTable
                deals={deals}
                companySlug={company.slug}
                members={members}
                employees={employees}
              />
            </>
          ) : (
            <SectionSpinner />
          )}
        </section>
      )}

      {tab === "people" && (
        <section>
          {relationship ? (
            <>
              <FormError message={relationship.errors.contacts} className="mb-3" />
              <CustomerPeoplePanel
                contacts={relationship.contacts}
                billingContacts={customer.contacts}
                companySlug={company.slug}
                members={members}
                employees={employees}
                canEditBilling={canWrite}
              />
            </>
          ) : (
            <SectionSpinner />
          )}
        </section>
      )}

      {tab === "meetings" && (
        <section>
          {relationship ? (
            <>
              <FormError message={relationship.errors.meetings} className="mb-3" />
              <CustomerMeetingsList meetings={relationship.meetings} companySlug={company.slug} />
            </>
          ) : (
            <SectionSpinner />
          )}
        </section>
      )}

      {tab === "billing" && (
        <>
          <FormError message={billingError} />
          <DocSection
            title="Invoices"
            count={invoices.length}
            newLabel="New invoice"
            newTo={canWrite ? `${financeBase}/invoices/new` : undefined}
            emptyText="No invoices for this customer yet."
            first
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

          <DocSection
            title="Estimates"
            count={estimates.length}
            newLabel="New estimate"
            newTo={canWrite ? `${financeBase}/estimates/new` : undefined}
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

          <DocSection
            title="Recurring invoices"
            count={recurring.length}
            newLabel="New recurring invoice"
            newTo={canWrite ? newRecurringInvoicePath(financeBase, customer.id) : undefined}
            emptyText="No recurring invoices for this customer yet."
          >
            {recurring.length > 0 && (
              <DocTable
                head={["Name", "Status", "Schedule", "Each run", "Next run", "Amount"]}
                rows={recurring.map((ri) => ({
                  key: ri.id,
                  to: `${financeBase}/recurring-invoices/${ri.slug}`,
                  cells: [
                    <span key="name" className="font-medium">
                      {ri.name}
                    </span>,
                    <StatusBadge key="status" status={ri.status} />,
                    describeCron(ri.cronExpr, ri.intervalCount),
                    ri.autoSend ? "Issue + email" : "Draft only",
                    ri.status === "active" && ri.nextRunAt ? fmtDate(ri.nextRunAt) : "—",
                    <span key="total" className="tabular-nums">
                      {formatMoney(ri.totalCents, ri.currency)}
                    </span>,
                  ],
                }))}
              />
            )}
          </DocSection>

          <DocSection
            title="Credit notes"
            count={credits.length}
            emptyText="No credit notes, deposits, or overpayments for this customer."
          >
            {credits.length > 0 && (
              <DocTable
                head={["Number", "Kind", "Status", "Issued", "Total", "Unapplied"]}
                rows={credits.map((credit) => ({
                  key: credit.id,
                  to: `${financeBase}/credit-notes/${credit.slug}`,
                  cells: [
                    <span key="num" className="font-mono text-xs font-semibold">
                      {credit.number || "DRAFT"}
                    </span>,
                    CREDIT_KIND_LABEL[credit.kind] ?? credit.kind,
                    <StatusBadge key="status" status={credit.status} />,
                    fmtDate(credit.issueDate),
                    <span key="total" className="tabular-nums">
                      {formatMoney(credit.totalCents, credit.currency)}
                    </span>,
                    <span key="open" className="tabular-nums">
                      {credit.openCents > 0 ? formatMoney(credit.openCents, credit.currency) : "—"}
                    </span>,
                  ],
                }))}
              />
            )}
          </DocSection>
        </>
      )}

      {tab === "documents" && (
        <div className="space-y-8">
          <CustomerContractsPanel
            company={company}
            customerId={customer.id}
            customerName={customer.name}
          />
          {relationship ? (
            <div>
              <FormError message={relationship.errors.envelopes} className="mb-3" />
              <CustomerSignaturesList
                envelopes={relationship.envelopes}
                companySlug={company.slug}
              />
            </div>
          ) : (
            <SectionSpinner />
          )}
          <RevenueDocumentsPanel
            companyId={company.id}
            resourceType="account"
            resourceId={customer.id}
          />
        </div>
      )}
    </div>
  );
}

function MailSection({
  mail,
  error,
  companySlug,
  editTo,
  preview,
  onLoadMore,
  loadingMore,
}: {
  mail: CustomerMailPage | null;
  error: string | null;
  companySlug: string;
  editTo: string | null;
  preview?: number;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  if (!mail) return error ? <FormError message={error} /> : <SectionSpinner />;
  return (
    <>
      <FormError message={error} className="mb-3" />
      <CustomerMailList
        mail={mail}
        companySlug={companySlug}
        editTo={editTo}
        preview={preview}
        onLoadMore={onLoadMore}
        loadingMore={loadingMore}
      />
    </>
  );
}

function DetailsCard({
  customer,
  owner,
  website,
}: {
  customer: Customer;
  owner: { name: string; kind: "human" | "ai" } | null;
  website: string | null;
}) {
  const parent = [customer.parentCompanyName, customer.parentCompanyDomain]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">Details</h3>
      <dl className="space-y-2 text-sm">
        <Detail label="Account status" value={ACCOUNT_STATUS_LABEL[customer.accountStatus]} />
        <Detail
          label="Owner"
          value={owner ? `${owner.name}${owner.kind === "ai" ? " · AI Employee" : ""}` : ""}
        />
        <Detail label="Domain" value={customer.domain} />
        <Detail
          label="Website"
          value={
            customer.websiteUrl && website ? (
              <a
                href={website}
                target="_blank"
                rel="noreferrer"
                className="break-all text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {customer.websiteUrl}
              </a>
            ) : (
              customer.websiteUrl
            )
          }
        />
        <Detail label="Industry" value={customer.industry} />
        <Detail
          label="Company size"
          value={
            customer.employeeCount > 0
              ? `${customer.employeeCount.toLocaleString()} employees`
              : ""
          }
        />
        <Detail label="Headquarters" value={customer.headquartersAddress} multiline />
        <Detail label="Parent company" value={parent} />
        <Detail label="Billing email" value={customer.email} />
        <Detail label="Phone" value={customer.phone} />
        <Detail label="Tax / VAT" value={customer.taxNumber} />
        <Detail label="Default currency" value={customer.currency} />
        <Detail label="Billing address" value={customer.billingAddress} multiline />
        <Detail label="Shipping address" value={customer.shippingAddress} multiline />
        <Detail label="Notes" value={customer.notes} multiline />
        <Detail label="Added" value={fmtDate(customer.createdAt)} />
      </dl>
    </div>
  );
}

/** The first few people at the account; the People tab lists everyone. */
function PeopleCard({
  contacts,
  customer,
  companySlug,
  onViewAll,
}: {
  contacts: RevenueContact[];
  customer: Customer;
  companySlug: string;
  onViewAll: () => void;
}) {
  const rows = [
    ...contacts.map((contact) => ({
      key: `contact-${contact.id}`,
      name: contact.name,
      detail: contact.title || contact.email,
      to: `/c/${companySlug}/revenue/contacts/${contact.id}`,
    })),
    ...customer.contacts.map((contact) => ({
      key: `billing-${contact.id}`,
      name: contact.name,
      detail: [contact.role || "Billing contact", contact.email].filter(Boolean).join(" · "),
      to: null,
    })),
  ];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          People
          {rows.length > 0 && (
            <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
              {rows.length}
            </span>
          )}
        </h3>
        {rows.length > 0 && <TabLink onClick={onViewAll}>All people</TabLink>}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">No people recorded yet.</p>
      ) : (
        <ul className="space-y-3">
          {rows.slice(0, 6).map((row) => (
            <li key={row.key} className="text-sm">
              {row.to ? (
                <Link
                  to={row.to}
                  className="font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-300"
                >
                  {row.name}
                </Link>
              ) : (
                <span className="font-medium text-slate-900 dark:text-slate-100">{row.name}</span>
              )}
              {row.detail && (
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {row.detail}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
    >
      {children} <ArrowRight size={12} />
    </button>
  );
}

function SectionSpinner() {
  return (
    <div className="flex justify-center rounded-xl border border-slate-200 bg-white p-8 dark:border-slate-700 dark:bg-slate-900">
      <Spinner size={18} />
    </div>
  );
}

function QuietEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
      {children}
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
  first = false,
  children,
}: {
  title: string;
  count: number;
  newLabel?: string;
  /** The create form New opens; left out for a Member who can't submit it. */
  newTo?: string;
  emptyText: string;
  /** The first section on a tab sits flush under the tab bar. */
  first?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className={first ? "" : "mt-8"}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {title}
          {count > 0 && (
            <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
              {count}
            </span>
          )}
        </h2>
        {newLabel && newTo && (
          <Link
            to={newTo}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
          >
            <Plus size={12} /> {newLabel}
          </Link>
        )}
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
                    "whitespace-nowrap px-4 py-2 font-medium " +
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
    issued: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
    paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    overdue: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
    void: "bg-slate-100 text-slate-400 line-through dark:bg-slate-800 dark:text-slate-500",
    accepted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    declined: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
    expired: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    invoiced: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
    active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    paused: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    ended: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  };
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
        (styles[status] ?? styles.draft)
      }
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function Detail({
  label,
  value,
  multiline,
}: {
  label: string;
  value: React.ReactNode;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-slate-400 dark:text-slate-500">{label}</dt>
      <dd
        className={
          "break-words text-slate-700 dark:text-slate-200 " +
          (multiline ? "whitespace-pre-line" : "")
        }
      >
        {value ? value : <span className="text-slate-400 dark:text-slate-500">—</span>}
      </dd>
    </div>
  );
}
