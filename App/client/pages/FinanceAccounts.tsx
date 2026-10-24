import React from "react";
import { useOutletContext } from "react-router-dom";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Account, ACCOUNT_TYPE_LABEL, AccountType, api } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { FormError } from "../components/ui/FormError";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { errorMessage } from "../lib/errors";
import { ACCOUNT_TYPE_MEANING, ACCOUNT_TYPE_ORDER, accountMeaning } from "../lib/ledgerAccounts";
import { canWriteFinance } from "../lib/subpages";
import { FinanceOutletCtx } from "./FinanceLayout";

const TYPE_BADGE: Record<AccountType, string> = {
  asset: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  liability: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  equity: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  revenue: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  expense: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

/**
 * Chart of accounts. Phase B of the Finance milestone (M19).
 *
 * Auto-seeds the default CoA on first open via the GET /accounts endpoint.
 * Humans can rename system accounts, add custom accounts, and archive
 * unused customs. System accounts (the seeded ones) cannot be deleted —
 * the auto-post hooks in `services/finance.ts` look them up by code.
 * A read-only Member sees the chart without New account or the row menu,
 * which only edits what the rows already show.
 */
export default function FinanceAccounts() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const background = useBackgroundAction();
  const dialog = useDialog();
  const [accounts, setAccounts] = React.useState<Account[] | null>(null);
  const [editing, setEditing] = React.useState<Account | "new" | null>(null);

  const reload = React.useCallback(async () => {
    const list = await api.get<Account[]>(`/api/companies/${company.id}/accounts`);
    setAccounts(list);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setAccounts([]));
  }, [reload]);

  useLiveRefetch("financeaccount", reload);

  function archive(a: Account) {
    const optimistic = {
      ...a,
      archivedAt: a.archivedAt ? null : new Date().toISOString(),
    };
    setAccounts(
      (current) => current?.map((item) => (item.id === a.id ? optimistic : item)) ?? current,
    );
    background(
      () =>
        api.patch<Account>(`/api/companies/${company.id}/accounts/${a.id}`, {
          archived: !a.archivedAt,
        }),
      {
        title: "Couldn’t update the account",
        error: (error) => `${errorMessage(error)} The change was undone.`,
        onSuccess: (updated) => {
          setAccounts(
            (current) =>
              current?.map((item) => (item.id === updated.id ? updated : item)) ?? current,
          );
        },
        onError: () => {
          setAccounts(
            (current) => current?.map((item) => (item.id === a.id ? a : item)) ?? current,
          );
        },
      },
    );
  }

  async function remove(a: Account) {
    const ok = await dialog.confirm({
      title: `Delete ${a.code} ${a.name}?`,
      message: "Only allowed if no ledger lines reference this account.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const originalIndex = accounts?.findIndex((item) => item.id === a.id) ?? -1;
    setAccounts((current) => current?.filter((item) => item.id !== a.id) ?? current);
    background(() => api.del(`/api/companies/${company.id}/accounts/${a.id}`), {
      title: "Couldn’t delete the account",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onError: () => {
        setAccounts((current) => {
          if (!current || current.some((item) => item.id === a.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, a);
          return next;
        });
      },
    });
  }

  // Group by type for accountant-friendly presentation.
  const grouped = React.useMemo(() => {
    if (!accounts) return null;
    const m = new Map<AccountType, Account[]>();
    for (const t of ACCOUNT_TYPE_ORDER) m.set(t, []);
    for (const a of accounts) m.get(a.type)?.push(a);
    return m;
  }, [accounts]);

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Chart of accounts" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Chart of accounts
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            The categories every amount in your books is filed under — the ones you pick when you
            categorize a bank or card transaction. Accounts marked system are used automatically by
            invoices, bills, and banking: rename them freely, but they can&apos;t be removed.
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setEditing("new")}>
            <Plus size={14} /> New account
          </Button>
        )}
      </div>

      {grouped === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : (
        <div className="space-y-6">
          {ACCOUNT_TYPE_ORDER.map((type) => {
            const rows = grouped.get(type) ?? [];
            if (rows.length === 0) return null;
            return (
              <div
                key={type}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
                  <h2 className="text-xs font-medium flex items-center gap-2 text-slate-500 dark:text-slate-400">
                    <span className={"rounded px-1.5 py-0.5 " + TYPE_BADGE[type]}>
                      {ACCOUNT_TYPE_LABEL[type]}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {ACCOUNT_TYPE_MEANING[type]}
                  </p>
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rows.map((a) => (
                      <tr key={a.id} className={a.archivedAt ? "opacity-50" : ""}>
                        <td className="w-24 px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {a.code}
                        </td>
                        <td className="px-2 py-2 text-slate-900 dark:text-slate-100">
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() => setEditing(a)}
                              className="text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
                            >
                              {a.name}
                            </button>
                          ) : (
                            a.name
                          )}
                          {a.isSystem && (
                            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400 inline-block first-letter:uppercase">
                              system
                            </span>
                          )}
                          {accountMeaning(a) && (
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {accountMeaning(a)}
                            </div>
                          )}
                        </td>
                        {canWrite && (
                          <td className="px-2 py-2 text-right">
                            <RowMenu
                              account={a}
                              onEdit={() => setEditing(a)}
                              onArchive={() => archive(a)}
                              onDelete={() => remove(a)}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <AccountEditor
          companyId={company.id}
          account={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function RowMenu({
  account,
  onEdit,
  onArchive,
  onDelete,
}: {
  account: Account;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const archived = !!account.archivedAt;
  return (
    <Menu
      align="right"
      width={176}
      trigger={({ ref, onClick }) => (
        <button
          ref={ref}
          onClick={onClick}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label="Row menu"
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<Pencil size={14} />}
            label="Edit"
            onSelect={() => {
              close();
              onEdit();
            }}
          />
          {!account.isSystem && (
            <MenuItem
              icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              label={archived ? "Unarchive" : "Archive"}
              onSelect={() => {
                close();
                onArchive();
              }}
            />
          )}
          {!account.isSystem && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 size={14} className="text-red-500" />}
                label={<span className="text-red-600 dark:text-red-400">Delete</span>}
                onSelect={() => {
                  close();
                  onDelete();
                }}
              />
            </>
          )}
        </>
      )}
    </Menu>
  );
}

function AccountEditor({
  companyId,
  account,
  onClose,
  onSaved,
}: {
  companyId: string;
  account: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = React.useState(account?.code ?? "");
  const [name, setName] = React.useState(account?.name ?? "");
  const [type, setType] = React.useState<AccountType>(account?.type ?? "asset");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const isSystem = !!account?.isSystem;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = isSystem
        ? { name: name.trim() }
        : { code: code.trim(), name: name.trim(), type };
      if (account) {
        await api.patch(`/api/companies/${companyId}/accounts/${account.id}`, body);
      } else {
        await api.post(`/api/companies/${companyId}/accounts`, body);
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={account ? `Edit ${account.code} ${account.name}` : "New account"}
    >
      <form onSubmit={save} className="space-y-4">
        <Input
          label="Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. 4100"
          required
          maxLength={20}
          disabled={isSystem}
        />
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
        />
        <Select
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as AccountType)}
          disabled={isSystem}
        >
          {ACCOUNT_TYPE_ORDER.map((t) => (
            <option key={t} value={t}>
              {ACCOUNT_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        {isSystem && (
          <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            This is a system account — invoices, bills, and banking find it by its code, so the
            code and type can&apos;t change. Renaming it is fine.
          </p>
        )}
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={busy}
            disabled={!name.trim() || (!isSystem && !code.trim())}
          >
            {account ? "Save" : "Create account"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
