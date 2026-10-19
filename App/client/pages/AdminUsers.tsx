import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  AtSign,
  Building2,
  Copy,
  KeyRound,
  Link2,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserPlus,
} from "lucide-react";
import { AdminCompanyRow, AdminUserRow, api } from "../lib/api";
import {
  addUserOutcome,
  addUserProblem,
  addUserRequest,
  emptyAddUserDraft,
  type AddUserDraft,
  type AddUserResponse,
} from "../lib/adminAddUser";
import { Avatar, adminUserAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { clsx } from "../components/ui/clsx";
import { useDialog } from "../components/ui/Dialog";
import { errorMessage } from "../lib/errors";
import { PASSWORD_MIN_LENGTH } from "../../shared/password";
import type { AdminOutletCtx } from "./AdminLayout";

/**
 * Admin → Users. The instance-wide directory of every human Member across all
 * companies. Add user creates an account by hand — with a password the admin
 * sets or a one-time setup link — optionally straight into a company. The one
 * destructive action that belongs at this altitude is hard-deleting a person
 * and everything account-scoped to them. Deletion is blocked in the UI for
 * yourself and for anyone who still owns a company (the server enforces both
 * too) — the row surfaces the owned companies so the operator knows what to
 * reassign first.
 */
export function AdminUsers() {
  const { me } = useOutletContext<AdminOutletCtx>();
  const [rows, setRows] = React.useState<AdminUserRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [promotingId, setPromotingId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<AdminUserRow[]>("/api/admin/users"));
      setError(null);
    } catch (err) {
      // Keep any previously-loaded rows on screen; surface the failure as its
      // own state instead of masquerading as an empty instance.
      setError(errorMessage(err, "Could not load users"));
    } finally {
      setLoading(false);
    }
  }, []);

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
      await reload();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t delete ${u.name || u.email}` });
    } finally {
      setDeletingId(null);
    }
  };

  const setMasterAdmin = async (u: AdminUserRow, next: boolean) => {
    if (!next) {
      const ok = await dialog.confirm({
        title: `Revoke master admin from ${u.name || u.email}?`,
        message:
          "They'll immediately lose access to the Admin dashboard — instance health, backups, and this directory.",
        confirmLabel: "Revoke access",
        variant: "danger",
      });
      if (!ok) return;
    }
    setPromotingId(u.id);
    try {
      await api.patch(`/api/admin/users/${u.id}/master-admin`, {
        isMasterAdmin: next,
      });
      await reload();
    } catch (err) {
      void dialog.error(err, {
        title: next
          ? `Couldn’t make ${u.name || u.email} a master admin`
          : `Couldn’t revoke master admin from ${u.name || u.email}`,
      });
    } finally {
      setPromotingId(null);
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
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={reload} loading={loading}>
              <RefreshCw size={14} /> Refresh
            </Button>
            <Button onClick={() => setAdding(true)}>
              <UserPlus size={14} /> Add user
            </Button>
          </div>
        }
      />
      <AddUserModal open={adding} onClose={() => setAdding(false)} onAdded={() => void reload()} />

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
              className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-indigo-500/25"
            />
          </div>
          {rows && (
            <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {filtered?.length ?? 0} of {rows.length}
            </span>
          )}
        </div>

        {/* A refresh that fails with rows already on screen keeps them there,
            so the failure needs its own line above the list. */}
        {error && rows !== null && <FormError message={error} />}

        {error && rows === null ? (
          <EmptyState
            title="Couldn't load users"
            description={error}
            action={
              <Button variant="secondary" onClick={reload} loading={loading}>
                <RefreshCw size={14} /> Retry
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
                ? "Users appear here once people sign up, accept a company invite, or you add them."
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
                    promoting={promotingId === u.id}
                    busy={deletingId !== null || promotingId !== null}
                    onDelete={() => deleteUser(u)}
                    onToggleMasterAdmin={(next) => setMasterAdmin(u, next)}
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
  promoting,
  busy,
  onDelete,
  onToggleMasterAdmin,
}: {
  user: AdminUserRow;
  isSelf: boolean;
  deleting: boolean;
  promoting: boolean;
  busy: boolean;
  onDelete: () => void;
  onToggleMasterAdmin: (next: boolean) => void;
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
          {user.isMasterAdmin && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <ShieldCheck size={11} className="shrink-0" /> Master admin
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
        className="shrink-0"
        loading={promoting}
        disabled={busy || (user.isMasterAdmin && isSelf)}
        title={
          user.isMasterAdmin
            ? isSelf
              ? "You can't remove your own master admin access."
              : "Revoke master admin"
            : "Grant master admin"
        }
        onClick={() => onToggleMasterAdmin(!user.isMasterAdmin)}
      >
        {user.isMasterAdmin ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
        <span className="hidden sm:inline">
          {promoting
            ? "Saving…"
            : user.isMasterAdmin
            ? "Revoke admin"
            : "Make admin"}
        </span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-rose-600 hover:bg-rose-50 hover:text-rose-700 disabled:text-slate-300 dark:text-rose-400 dark:hover:bg-rose-500/10 dark:disabled:text-slate-600"
        loading={deleting}
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

/**
 * The Add user form, then — once the account exists — what happens next: the
 * setup link to pass on (when there is one) and whether anything was emailed,
 * because an install without an email transport sends nothing.
 */
function AddUserModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [companies, setCompanies] = React.useState<AdminCompanyRow[] | null>(null);
  const [draft, setDraft] = React.useState<AddUserDraft>(() => emptyAddUserDraft([]));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [added, setAdded] = React.useState<(AddUserResponse & { email: string }) | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDraft(emptyAddUserDraft([]));
    setError(null);
    setAdded(null);
    setCopied(false);
    setCompanies(null);
    api
      .get<AdminCompanyRow[]>("/api/admin/companies")
      .then((rows) => {
        if (cancelled) return;
        setCompanies(rows);
        setDraft((current) => ({ ...current, companyId: emptyAddUserDraft(rows).companyId }));
      })
      .catch((err) => {
        if (cancelled) return;
        // The account can still be added; it just cannot start in a company.
        setCompanies([]);
        setError(errorMessage(err, "Could not load companies"));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const set = <K extends keyof AddUserDraft>(key: K, value: AddUserDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = addUserProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await api.post<AddUserResponse>("/api/admin/users", addUserRequest(draft));
      setAdded({ ...response, email: response.user.email });
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Could not add the user"));
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Couldn't copy the link. Select it and copy it yourself.");
    }
  };

  if (added) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={`Added ${added.user.name}`}
        description={added.user.email}
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="flex flex-col gap-3 text-sm text-slate-600 dark:text-slate-300">
          <p>{addUserOutcome(added)}</p>
          {added.setupLink && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={added.setupLink}
                aria-label="Setup link"
                onFocus={(event) => event.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => copyLink(added.setupLink!)}
              >
                <Copy size={14} /> Copy
              </Button>
            </div>
          )}
          {copied && <FormSuccess message="Setup link copied" />}
          <FormError message={error} />
        </div>
      </Modal>
    );
  }

  const company = companies?.find((row) => row.id === draft.companyId) ?? null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add user"
      description="Create an account for someone without asking them to sign up."
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <UserPlus size={14} /> Add user
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={error} />
        <Input
          label="Name"
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
          autoFocus
          required
          maxLength={120}
        />
        <Input
          label="Email"
          type="email"
          value={draft.email}
          onChange={(event) => set("email", event.target.value)}
          required
          maxLength={254}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
            Password
          </legend>
          <SignInChoice
            selected={draft.signIn === "link"}
            onSelect={() => set("signIn", "link")}
            icon={<Link2 size={15} />}
            title="Let them choose it"
            detail="They get a setup link that works once and expires in 7 days. You get it too, to pass on."
          />
          <SignInChoice
            selected={draft.signIn === "password"}
            onSelect={() => set("signIn", "password")}
            icon={<KeyRound size={15} />}
            title="Set it now"
            detail="Choose their first password and give it to them yourself."
          />
          {draft.signIn === "password" && (
            <Input
              label="Password"
              type="password"
              autoComplete="new-password"
              value={draft.password}
              onChange={(event) => set("password", event.target.value)}
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
          )}
        </fieldset>
        <Select
          label="Company"
          value={draft.companyId}
          onChange={(event) => set("companyId", event.target.value)}
          disabled={companies === null}
        >
          <option value="">No company yet</option>
          {(companies ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </Select>
        {company && (
          <Select
            label={`Role in ${company.name}`}
            value={draft.role}
            onChange={(event) => set("role", event.target.value as AddUserDraft["role"])}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
        )}
      </div>
    </Modal>
  );
}

function SignInChoice({
  selected,
  onSelect,
  icon,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={clsx(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition",
        selected
          ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-100 dark:border-indigo-600 dark:bg-indigo-500/10 dark:ring-indigo-950"
          : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-900",
      )}
    >
      <input type="radio" name="signIn" checked={selected} onChange={onSelect} className="sr-only" />
      <span
        className={clsx(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          selected
            ? "bg-indigo-600 text-white"
            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
          {title}
        </span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">{detail}</span>
      </span>
    </label>
  );
}
