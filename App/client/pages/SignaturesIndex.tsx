import React from "react";
import {
  ArrowRight,
  Bot,
  FilePlus2,
  FileSignature,
  Search,
  Send,
  UploadCloud,
  UserPlus,
} from "lucide-react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { Breadcrumbs } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import {
  SIGNATURE_STATUS_LABELS,
  envelopeFilename,
  formatSignatureDate,
  normalizeEnvelopeList,
  recipientProgress,
  signatureStatusClasses,
  type SignatureEnvelope,
  type SignatureEnvelopeStatus,
} from "@/lib/signing";
import type { SignatureOutletContext } from "@/pages/SignatureLayout";

const FILTERS: Array<{ label: string; value: "all" | SignatureEnvelopeStatus }> = [
  { label: "All", value: "all" },
  { label: "Draft", value: "draft" },
  { label: "Waiting", value: "sent" },
  { label: "In progress", value: "in_progress" },
  { label: "Completed", value: "completed" },
];

export default function SignaturesIndex() {
  const { company } = useOutletContext<SignatureOutletContext>();
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "all") as "all" | SignatureEnvelopeStatus;
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<SignatureEnvelope[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const base = `/api/companies/${company.id}/signature-envelopes`;
  const routeBase = `/c/${company.slug}/signatures`;

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const suffix = status === "all" ? "" : `?status=${encodeURIComponent(status)}`;
      setItems(normalizeEnvelopeList(await api.get<unknown>(`${base}${suffix}`)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load signature requests.");
      setItems([]);
    }
  }, [base, status]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch("signature", load);

  const visible = (items ?? []).filter((item) => {
    const haystack =
      `${item.title} ${item.customer?.name ?? ""} ${envelopeFilename(item)}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const active = (items ?? []).filter((item) =>
    ["sent", "in_progress"].includes(item.status),
  ).length;
  const completed = (items ?? []).filter((item) => item.status === "completed").length;
  const drafts = (items ?? []).filter((item) => item.status === "draft").length;

  return (
    <div className="page-shell p-4 sm:p-8">
      <Breadcrumbs items={[{ label: "Signatures" }]} />
      <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            Signatures
          </h1>
          <p className="mt-1 max-w-xl text-sm text-slate-500 dark:text-slate-400">
            Prepare, send, and track agreements without leaving Genosyn.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {drafts > 0 && (
            <Button variant="secondary" onClick={() => setParams({ status: "draft" })}>
              <Bot size={15} /> Review {drafts} {drafts === 1 ? "draft" : "drafts"}
            </Button>
          )}
          <Link to={`${routeBase}/new`}>
            <Button>
              <FilePlus2 size={15} /> New signature request
            </Button>
          </Link>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Summary label="Showing" value={items?.length ?? 0} icon={<FileSignature size={16} />} />
        <Summary label="Waiting for people" value={active} icon={<Send size={16} />} />
        <Summary label="Completed" value={completed} icon={<FileSignature size={16} />} />
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
          <div className="flex gap-1 overflow-x-auto">
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                onClick={() => {
                  if (filter.value === "all") setParams({});
                  else setParams({ status: filter.value });
                }}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
                  status === filter.value
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="relative block sm:w-64">
            <span className="sr-only">Search signature requests</span>
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-2.5 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search requests…"
              className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-indigo-900"
            />
          </label>
        </div>

        {items === null ? (
          <div className="flex h-48 items-center justify-center">
            <Spinner size={22} />
          </div>
        ) : error ? (
          <div className="p-6">
            <EmptyState
              title="Signature requests could not be loaded"
              description={error}
              action={<Button onClick={() => void load()}>Try again</Button>}
            />
          </div>
        ) : visible.length === 0 && !query && status === "all" ? (
          <FirstRequestEmpty routeBase={routeBase} />
        ) : visible.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title={
                query
                  ? "No matching requests"
                  : `No ${status === "all" ? "matching" : SIGNATURE_STATUS_LABELS[status].toLowerCase()} requests`
              }
              description={
                query
                  ? "Try a different title or customer name."
                  : "Choose another status to see the rest of your signature requests."
              }
              action={
                !query ? (
                  <Button variant="secondary" onClick={() => setParams({})}>
                    View all requests
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {visible.map((item) => (
              <EnvelopeRow key={item.id} envelope={item} to={`${routeBase}/${item.id}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FirstRequestEmpty({ routeBase }: { routeBase: string }) {
  const steps = [
    {
      icon: <UploadCloud size={17} />,
      title: "Upload a PDF",
      detail: "Start with the document your customer should review.",
    },
    {
      icon: <UserPlus size={17} />,
      title: "Add people and fields",
      detail: "Choose who signs and show them exactly where.",
    },
    {
      icon: <Send size={17} />,
      title: "Review and send",
      detail: "Track delivery, reminders, and completion in one place.",
    },
  ];
  return (
    <div className="p-4 sm:p-6">
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center dark:border-slate-700 dark:bg-slate-950/40">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Send your first signature request
        </h3>
        <p className="mx-auto mt-1 max-w-lg text-sm text-slate-500 dark:text-slate-400">
          No setup ceremony: upload the agreement, add the people who need to sign, and review it
          before anyone is contacted.
        </p>
        <div className="mx-auto mt-6 grid max-w-3xl gap-3 text-left sm:grid-cols-3">
          {steps.map((step, index) => (
            <div
              key={step.title}
              className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                  {step.icon}
                </span>
                <span>
                  <span className="text-slate-400">{index + 1}.</span> {step.title}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {step.detail}
              </p>
            </div>
          ))}
        </div>
        <Link to={`${routeBase}/new`} className="mt-6 inline-flex">
          <Button>
            <FilePlus2 size={15} /> Upload a document
          </Button>
        </Link>
      </div>
    </div>
  );
}

function Summary({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {icon} {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
    </div>
  );
}

function EnvelopeRow({ envelope, to }: { envelope: SignatureEnvelope; to: string }) {
  const progress = recipientProgress(envelope);
  return (
    <Link
      to={to}
      className="group grid gap-3 p-4 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_10rem_8rem_1rem] sm:items-center dark:hover:bg-slate-800/50"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
          {envelope.title}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="truncate">{envelope.customer?.name ?? "No customer"}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{envelopeFilename(envelope)}</span>
        </div>
      </div>
      <div>
        <span
          className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${signatureStatusClasses(envelope.status)}`}
        >
          {SIGNATURE_STATUS_LABELS[envelope.status]}
        </span>
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">
        <div>
          {progress.total ? `${progress.done} of ${progress.total} signed` : "No recipients"}
        </div>
        <div className="mt-1">{formatSignatureDate(envelope.updatedAt)}</div>
      </div>
      <ArrowRight
        size={15}
        className="hidden text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500 sm:block"
      />
    </Link>
  );
}
