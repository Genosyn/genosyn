import React from "react";
import {
  Bot,
  Building2,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  StickyNote,
  Users,
  X,
} from "lucide-react";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  filterVaultItems,
  safeVaultWebsiteUrl,
  VAULT_ITEM_TYPES,
  vaultApi,
  type VaultItem,
  type VaultItemType,
  vaultItemTypeLabel,
} from "@/lib/vault";
import { VaultItemDetail } from "@/pages/vault/VaultItemDetail";
import { VaultItemEditor } from "@/pages/vault/VaultItemEditor";

export default function Vault({ company }: { company: Company }) {
  const [items, setItems] = React.useState<VaultItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [type, setType] = React.useState<VaultItemType | "all">("all");
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<VaultItem | null>(null);
  const [selected, setSelected] = React.useState<VaultItem | null>(null);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      const next = await vaultApi.listItems(company.id);
      setItems(next);
      setSelected((current) =>
        current ? (next.find((candidate) => candidate.id === current.id) ?? null) : null,
      );
    } catch (cause) {
      setError(errorMessage(cause, "The Vault could not be loaded."));
      setItems([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    setItems(null);
    setSelected(null);
    void reload();
  }, [reload]);

  useLiveRefetch(["vault_item", "vault_member_access", "vault_employee_grant"], reload);

  const filtered = React.useMemo(
    () => filterVaultItems(items ?? [], query, type),
    [items, query, type],
  );

  async function handleSaved(saved: VaultItem) {
    setCreating(false);
    setEditing(null);
    await reload();
    setSelected(saved);
  }

  return (
    <div className="page-shell p-4 pb-14 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            <KeyRound size={21} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              Vault
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Logins with passwords, authenticator codes, and software passkeys — plus API keys and
              secure notes for Members and explicitly granted AI Employees.
            </p>
          </div>
        </div>
        <Button className="self-start" onClick={() => setCreating(true)}>
          <Plus size={14} /> Add item
        </Button>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <PromiseCard
          icon={<ShieldCheck size={17} />}
          title="Encrypted at rest"
          detail="Stored values and private context stay encrypted until an authorized request needs them."
        />
        <PromiseCard
          icon={<Users size={17} />}
          title="Member access is explicit"
          detail="Share company-wide or restrict each item, with separate View and Edit access."
        />
        <PromiseCard
          icon={<Bot size={17} />}
          title="AI-native, not prompt-native"
          detail="AI Employees use passwords, current codes, and passkeys through governed Browser actions."
        />
      </div>

      <div className="mt-7 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-end dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="vault-search"
              className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              Search Vault
            </label>
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                id="vault-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search titles, usernames, websites, and context…"
                className="h-9 w-full rounded-md border border-slate-300 bg-white pl-9 pr-9 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                  aria-label="Clear Vault search"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          <Select
            label="Item type"
            value={type}
            onChange={(event) => setType(event.target.value as VaultItemType | "all")}
            containerClassName="w-full sm:w-44"
          >
            <option value="all">All items</option>
            {VAULT_ITEM_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {items === null ? (
          <div className="flex min-h-64 items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : error ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              <RefreshCw size={13} /> Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-14">
            <EmptyState
              title="Your Vault is empty"
              description="Add a login, API key, or secure note, then attach authenticators and choose exactly which Members and AI Employees can use it."
            />
            <div className="mt-4 flex justify-center">
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus size={13} /> Add your first item
              </Button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <Search size={22} className="mx-auto text-slate-300 dark:text-slate-600" />
            <div className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              No matching Vault items
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Try another search or show all item types.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((item) => (
              <VaultItemRow key={item.id} item={item} onOpen={() => setSelected(item)} />
            ))}
          </ul>
        )}

        {items !== null && !error && items.length > 0 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <span>
              {filtered.length === items.length
                ? `${items.length} ${items.length === 1 ? "item" : "items"}`
                : `${filtered.length} of ${items.length} items`}
            </span>
            <span>Stored values never appear in this list</span>
          </div>
        )}
      </div>

      <VaultItemEditor
        companyId={company.id}
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={handleSaved}
      />
      <VaultItemEditor
        companyId={company.id}
        item={editing ?? undefined}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={handleSaved}
      />
      <VaultItemDetail
        companyId={company.id}
        item={selected}
        onClose={() => setSelected(null)}
        onEdit={(item) => {
          setSelected(null);
          setEditing(item);
        }}
        onUpdated={(updated) => {
          setSelected(updated);
          setItems(
            (current) =>
              current?.map((candidate) => (candidate.id === updated.id ? updated : candidate)) ??
              null,
          );
        }}
        onDeleted={async () => {
          setSelected(null);
          await reload();
        }}
      />
    </div>
  );
}

function VaultItemRow({ item, onOpen }: { item: VaultItem; onOpen: () => void }) {
  const website = safeVaultWebsiteUrl(item.websiteUrl);
  let hostname = "";
  if (website) hostname = new URL(website).hostname;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full flex-col gap-3 px-4 py-4 text-left transition hover:bg-slate-50 sm:flex-row sm:items-center dark:hover:bg-slate-800/50"
      >
        <VaultTypeIcon type={item.type} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {item.title}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {vaultItemTypeLabel(item.type)}
            </span>
            {item.type === "login" && item.hasTotp && (
              <span className="inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                <Smartphone size={10} /> Authenticator
              </span>
            )}
            {item.type === "login" && (item.passkeys ?? []).length > 0 && (
              <span className="inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                <Fingerprint size={10} /> {item.passkeys.length}{" "}
                {item.passkeys.length === 1 ? "passkey" : "passkeys"}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            {item.username && <span className="max-w-64 truncate">{item.username}</span>}
            {hostname && <span className="max-w-64 truncate">{hostname}</span>}
            {!item.username && !hostname && <span>Encrypted value</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
          <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 dark:border-slate-700 dark:text-slate-400">
            {item.visibility === "company" ? <Building2 size={11} /> : <Users size={11} />}
            {item.visibility === "company" ? "Company" : "Restricted"}
          </span>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {item.effectiveAccessLevel === "edit" ? "Can edit" : "View only"}
          </span>
        </div>
      </button>
    </li>
  );
}

function VaultTypeIcon({ type }: { type: VaultItemType }) {
  const icon =
    type === "login" ? (
      <LockKeyhole size={16} />
    ) : type === "api_key" ? (
      <KeyRound size={16} />
    ) : (
      <StickyNote size={16} />
    );
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
      {icon}
    </span>
  );
}

function PromiseCard({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {icon}
        </span>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</div>
      </div>
      <p className="mt-2.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail}</p>
    </div>
  );
}
