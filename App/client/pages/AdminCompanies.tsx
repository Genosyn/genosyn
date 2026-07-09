import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, ExternalLink, RefreshCw, Search, Trash2, Users } from "lucide-react";
import { AdminCompanyRow, api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { AdminOutletCtx } from "./AdminLayout";

/**
 * Admin → Companies. The instance-wide directory of every company (tenant) on
 * the deployment, with member and AI-employee counts and a hard-delete that
 * runs the same cascade as a company's own "delete company" flow. Deleting the
 * company you're currently signed into bounces you back to the root so the app
 * can re-resolve which company to show.
 */
export function AdminCompanies() {
  const { company, onCompaniesChanged } = useOutletContext<AdminOutletCtx>();
  const [rows, setRows] = React.useState<AdminCompanyRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<AdminCompanyRow[]>("/api/admin/companies"));
      setError(null);
    } catch (err) {
      // Keep any previously-loaded rows on screen; surface the failure as its
      // own state instead of masquerading as an empty instance.
      setError((err as Error).message);
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const deleteCompany = async (c: AdminCompanyRow) => {
    const isCurrent = c.id === company.id;
    const ok = await dialog.confirm({
      title: `Delete ${c.name}?`,
      message: isCurrent
        ? "This is the company you're currently in. Deleting it permanently removes every employee, routine, message, note, and finance record it owns, plus its files on disk. You'll be returned to your other companies. This cannot be undone."
        : "This permanently removes every employee, routine, message, note, and finance record this company owns, plus its files on disk. This cannot be undone.",
      confirmLabel: "Delete company",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(c.id);
    try {
      await api.del(`/api/admin/companies/${c.id}`);
      toast(`Deleted ${c.name}`, "success");
      if (isCurrent) {
        // We just deleted the company backing this URL. A soft navigate would
        // land on the parent's still-stale companies array and resolve right
        // back to this now-404 company, so hard-reload to "/" — App refetches
        // the company list and redirects to a live one (or onboarding).
        window.location.href = "/";
        return;
      }
      // Keep the top company switcher + route resolver in sync, then refresh
      // this list.
      onCompaniesChanged();
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setDeletingId(null);
    }
  };

  const filtered = React.useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) =>
      [c.name, c.slug, c.owner?.name ?? "", c.owner?.email ?? ""].some((f) =>
        f.toLowerCase().includes(q),
      ),
    );
  }, [rows, query]);

  return (
    <>
      <TopBar
        title="Companies"
        right={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, slug, or owner…"
              className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-indigo-900"
            />
          </div>
          {rows && (
            <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {filtered?.length ?? 0} of {rows.length}
            </span>
          )}
        </div>

        {error && rows === null ? (
          <EmptyState
            title="Couldn't load companies"
            description={error}
            action={
              <Button variant="secondary" onClick={reload} disabled={loading}>
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Retry
              </Button>
            }
          />
        ) : filtered === null ? (
          <Card>
            <CardBody>
              <Spinner />
            </CardBody>
          </Card>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={rows && rows.length === 0 ? "No companies yet" : "No matching companies"}
            description={
              rows && rows.length === 0
                ? "Companies appear here as soon as someone creates one."
                : "Try a different search term."
            }
          />
        ) : (
          <Card>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((c) => (
                  <CompanyRow
                    key={c.id}
                    company={c}
                    isCurrent={c.id === company.id}
                    deleting={deletingId === c.id}
                    busy={deletingId !== null}
                    onDelete={() => deleteCompany(c)}
                  />
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}

function CompanyRow({
  company,
  isCurrent,
  deleting,
  busy,
  onDelete,
}: {
  company: AdminCompanyRow;
  isCurrent: boolean;
  deleting: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to={`/c/${company.slug}`}
            className="group inline-flex min-w-0 items-center gap-1 truncate text-sm font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
          >
            <span className="truncate">{company.name}</span>
            <ExternalLink
              size={12}
              className="shrink-0 text-slate-300 group-hover:text-indigo-500 dark:text-slate-600"
            />
          </Link>
          {isCurrent && (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              Current
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {company.slug}
          </code>
          <span className="truncate">
            {company.owner
              ? `Owner: ${company.owner.name || company.owner.email}`
              : "No owner"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Users size={11} className="shrink-0" />
            {company.memberCount} {company.memberCount === 1 ? "member" : "members"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Bot size={11} className="shrink-0" />
            {company.employeeCount} {company.employeeCount === 1 ? "employee" : "employees"}
          </span>
        </div>
      </div>
      <div className="hidden shrink-0 text-xs tabular-nums text-slate-400 sm:block dark:text-slate-500">
        {formatDate(company.createdAt)}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-rose-600 hover:bg-rose-50 hover:text-rose-700 disabled:text-slate-300 dark:text-rose-400 dark:hover:bg-rose-500/10 dark:disabled:text-slate-600"
        disabled={busy}
        title="Delete company"
        onClick={onDelete}
      >
        <Trash2 size={14} />
        {deleting ? "Deleting…" : ""}
      </Button>
    </li>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
