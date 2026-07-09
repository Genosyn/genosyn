import React from "react";
import { useOutletContext } from "react-router-dom";
import { AtSign, Building2, RefreshCw, Search, Trash2 } from "lucide-react";
import { AdminUserRow, api } from "../lib/api";
import { Avatar, adminUserAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { AdminOutletCtx } from "./AdminLayout";

/**
 * Admin → Users. The instance-wide directory of every human Member across all
 * companies, with the one destructive action that belongs at this altitude:
 * hard-deleting a person and everything account-scoped to them. Deletion is
 * blocked in the UI for yourself and for anyone who still owns a company (the
 * server enforces both too) — the row surfaces the owned companies so the
 * operator knows what to reassign first.
 */
export function AdminUsers() {
  const { me } = useOutletContext<AdminOutletCtx>();
  const [rows, setRows] = React.useState<AdminUserRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<AdminUserRow[]>("/api/admin/users"));
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

  const deleteUser = async (u: AdminUserRow) => {
    const ok = await dialog.confirm({
      title: `Delete ${u.name || u.email}?`,
      message:
        "This permanently removes the user, their memberships, API keys, and notifications. Content they authored (messages, notes, todos) is kept but unlinked. This cannot be undone.",
      confirmLabel: "Delete user",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(u.id);
    try {
      await api.del(`/api/admin/users/${u.id}`);
      toast(`Deleted ${u.email}`, "success");
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
    return rows.filter((u) =>
      [u.name, u.email, u.handle ?? ""].some((f) => f.toLowerCase().includes(q)),
    );
  }, [rows, query]);

  return (
    <>
      <TopBar
        title="Users"
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
              placeholder="Search by name, email, or handle…"
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
            title="Couldn't load users"
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
            title={rows && rows.length === 0 ? "No users yet" : "No matching users"}
            description={
              rows && rows.length === 0
                ? "Users appear here once people sign up or accept a company invite."
                : "Try a different search term."
            }
          />
        ) : (
          <Card>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === me.id}
                    deleting={deletingId === u.id}
                    busy={deletingId !== null}
                    onDelete={() => deleteUser(u)}
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

function UserRow({
  user,
  isSelf,
  deleting,
  busy,
  onDelete,
}: {
  user: AdminUserRow;
  isSelf: boolean;
  deleting: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  const owns = user.ownedCompanies.length > 0;
  const blockedReason = isSelf
    ? "You can't delete your own account here."
    : owns
    ? `Owns ${user.ownedCompanies.length} ${
        user.ownedCompanies.length === 1 ? "company" : "companies"
      } — reassign or delete ${user.ownedCompanies.length === 1 ? "it" : "them"} first.`
    : null;

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar
        name={user.name || user.email}
        src={adminUserAvatarUrl(user.id, user.avatarKey)}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {user.name || "Unnamed"}
          </span>
          {isSelf && (
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              You
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <span className="truncate">{user.email}</span>
          {user.handle && (
            <span className="inline-flex items-center gap-0.5">
              <AtSign size={11} className="shrink-0" />
              {user.handle}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Building2 size={11} className="shrink-0" />
            {user.membershipCount} {user.membershipCount === 1 ? "company" : "companies"}
          </span>
          {owns && (
            <span className="truncate" title={user.ownedCompanies.map((c) => c.name).join(", ")}>
              Owns {user.ownedCompanies.map((c) => c.name).join(", ")}
            </span>
          )}
        </div>
      </div>
      <div className="hidden shrink-0 text-xs tabular-nums text-slate-400 sm:block dark:text-slate-500">
        Joined {formatDate(user.createdAt)}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-rose-600 hover:bg-rose-50 hover:text-rose-700 disabled:text-slate-300 dark:text-rose-400 dark:hover:bg-rose-500/10 dark:disabled:text-slate-600"
        disabled={busy || isSelf || owns}
        title={blockedReason ?? "Delete user"}
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
