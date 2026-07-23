import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Ban,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { api, Employee, Member } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * Contacts — the people layer of the Revenue section, and the landing page of
 * the whole section.
 *
 * The list answers one question: who have we not spoken to lately. The server
 * already orders by `lastActivityAt` with never-touched rows last, so nothing
 * here re-sorts — a client-side sort would silently disagree with the page-2
 * window the server returns.
 *
 * The other thing this page owes the person scanning it is who they must not
 * mail. A do-not-contact flag or an unsubscribe is enforced at the outbound
 * choke-point regardless, but finding out only after drafting is a waste of
 * somebody's afternoon, so both are marked on the row itself.
 */

export type ContactLifecycleStage =
  | "subscriber"
  | "lead"
  | "qualified"
  | "opportunity"
  | "customer"
  | "churned"
  | "unqualified";

export const CONTACT_LIFECYCLE_STAGES: ContactLifecycleStage[] = [
  "subscriber",
  "lead",
  "qualified",
  "opportunity",
  "customer",
  "churned",
  "unqualified",
];

/** A contact row as `GET /revenue/contacts` serializes it. */
export type RevenueContact = {
  id: string;
  companyId: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  linkedinUrl: string;
  websiteUrl: string;
  customerId: string | null;
  companyName: string;
  lifecycleStage: ContactLifecycleStage;
  ownerId: string | null;
  ownerEmployeeId: string | null;
  source: string;
  sourceDetail: string;
  score: number;
  notes: string;
  doNotContact: boolean;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
  lastActivityAt: string | null;
  archivedAt: string | null;
  createdById: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Attached by the list endpoint only — null when there is no account yet. */
  customerName?: string | null;
};

type ContactPage = { rows: RevenueContact[]; total: number };

const PAGE_SIZE = 25;

const STAGE_LABELS: Record<ContactLifecycleStage, string> = {
  subscriber: "Subscriber",
  lead: "Lead",
  qualified: "Qualified",
  opportunity: "Opportunity",
  customer: "Customer",
  churned: "Churned",
  unqualified: "Unqualified",
};

const STAGE_PILL: Record<ContactLifecycleStage, string> = {
  subscriber:
    "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  lead: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25",
  qualified:
    "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/25",
  opportunity:
    "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/25",
  customer:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25",
  churned:
    "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25",
  unqualified:
    "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25",
};

/** Lifecycle-stage pill. Exported so the contact detail renders the same chip. */
export function LifecycleStagePill({ stage }: { stage: ContactLifecycleStage }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset " +
        (STAGE_PILL[stage] ?? STAGE_PILL.lead)
      }
    >
      {STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

/**
 * The "you must not mail this person" markers, in one place so the list row
 * and the detail header can never drift apart on what counts as blocked.
 */
export function ContactFlagPills({
  contact,
  showArchived = true,
}: {
  contact: RevenueContact;
  showArchived?: boolean;
}) {
  const flags: { key: string; label: string; className: string }[] = [];
  if (contact.doNotContact) {
    flags.push({
      key: "dnc",
      label: "do not contact",
      className:
        "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25",
    });
  }
  if (contact.unsubscribedAt) {
    flags.push({
      key: "unsub",
      label: "unsubscribed",
      className:
        "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25",
    });
  }
  if (contact.bouncedAt) {
    flags.push({
      key: "bounced",
      label: "bounced",
      className:
        "bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/25",
    });
  }
  if (showArchived && contact.archivedAt) {
    flags.push({
      key: "archived",
      label: "archived",
      className:
        "bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700",
    });
  }
  if (flags.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {flags.map((f) => (
        <span
          key={f.key}
          className={
            "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset " +
            f.className
          }
        >
          {f.label}
        </span>
      ))}
    </span>
  );
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  if (diff < 0) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Look up an owner's display name from the two possible principal lists. */
export function ownerLabel(
  contact: { ownerId: string | null; ownerEmployeeId: string | null },
  members: Member[],
  employees: Employee[],
): { name: string; kind: "human" | "ai" } | null {
  if (contact.ownerId) {
    const m = members.find((x) => x.userId === contact.ownerId);
    return { name: m?.name || m?.email || "Unknown member", kind: "human" };
  }
  if (contact.ownerEmployeeId) {
    const e = employees.find((x) => x.id === contact.ownerEmployeeId);
    return { name: e?.name ?? "Unknown employee", kind: "ai" };
  }
  return null;
}

export default function RevenueContacts() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const navigate = useNavigate();
  const { background } = useToast();
  const dialog = useDialog();

  // `null` is the loading state — there is no separate loading flag. `total`
  // rides alongside because the pagination footer needs the server's count.
  const [rows, setRows] = React.useState<RevenueContact[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [loadError, setLoadError] = React.useState(false);
  const [offset, setOffset] = React.useState(0);
  const [stage, setStage] = React.useState<ContactLifecycleStage | "">("");
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const base = `/c/${company.slug}/revenue`;

  React.useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Back to page one whenever the window we are paging through changes.
  React.useEffect(() => {
    setOffset(0);
  }, [query, stage, showArchived]);

  const reload = React.useCallback(async () => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    if (query) params.set("q", query);
    if (stage) params.set("lifecycleStage", stage);
    if (showArchived) params.set("includeArchived", "true");
    const data = await api.get<ContactPage>(
      `/api/companies/${company.id}/revenue/contacts?${params.toString()}`,
    );
    // The API already orders by most recent activity with never-touched rows
    // last, and pages against that order — re-sorting here would disagree with
    // whatever page 2 comes back with.
    setRows(data.rows);
    setTotal(data.total);
    setLoadError(false);
  }, [company.id, offset, query, stage, showArchived]);

  const load = React.useCallback(() => {
    reload().catch(() => {
      setRows([]);
      setTotal(0);
      setLoadError(true);
    });
  }, [reload]);

  React.useEffect(() => {
    load();
  }, [load]);

  useLiveRefetch(["contact", "activity", "suppression"], load);

  // Owner names are not on the contact payload, so the two principal lists are
  // fetched once per company rather than per row.
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<Member[]>(`/api/companies/${company.id}/members`),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
    ])
      .then(([m, e]) => {
        if (cancelled) return;
        setMembers(m);
        setEmployees(e);
      })
      .catch(() => {
        // Owners degrade to "Unassigned"; the list is still usable.
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  const list = rows ?? [];
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);

  function patchRow(id: string, patch: Partial<RevenueContact>) {
    setRows((current) =>
      current ? current.map((r) => (r.id === id ? { ...r, ...patch } : r)) : current,
    );
  }

  function archive(contact: RevenueContact) {
    const archived = !contact.archivedAt;
    const before = { ...contact };
    const dropped = archived && !showArchived;
    setRows((current) => {
      if (!current) return current;
      if (dropped) return current.filter((r) => r.id !== contact.id);
      return current.map((r) =>
        r.id === contact.id
          ? { ...r, archivedAt: archived ? new Date().toISOString() : null }
          : r,
      );
    });
    if (dropped) setTotal((t) => Math.max(0, t - 1));
    background(
      () =>
        api.post<RevenueContact>(
          `/api/companies/${company.id}/revenue/contacts/${contact.id}/${
            archived ? "archive" : "restore"
          }`,
        ),
      {
        loading: archived ? "Archiving contact…" : "Restoring contact…",
        success: archived ? "Contact archived" : "Contact restored",
        error: (error) =>
          `Couldn’t update ${before.name}: ${
            error instanceof Error ? error.message : "Unknown error"
          }. The change was undone.`,
        onSuccess: () => load(),
        onError: () => {
          setRows((current) => {
            if (!current) return current;
            if (current.some((r) => r.id === before.id)) {
              return current.map((r) => (r.id === before.id ? before : r));
            }
            return [before, ...current];
          });
          if (dropped) setTotal((t) => t + 1);
        },
      },
    );
  }

  async function toggleDoNotContact(contact: RevenueContact) {
    const next = !contact.doNotContact;
    if (next) {
      const confirmed = await dialog.confirm({
        title: `Mark ${contact.name} as do not contact?`,
        message:
          "Every send path refuses mail to them from then on — a human pressing Send, a bulk send, and any sequence an AI employee runs.",
        confirmLabel: "Mark do not contact",
      });
      if (!confirmed) return;
    }
    patchRow(contact.id, { doNotContact: next });
    background(
      () =>
        api.patch<RevenueContact>(
          `/api/companies/${company.id}/revenue/contacts/${contact.id}`,
          { doNotContact: next },
        ),
      {
        loading: next ? "Marking do not contact…" : "Allowing contact…",
        success: next ? "Marked do not contact" : "Contact allowed again",
        error: (error) =>
          `Couldn’t update ${contact.name}: ${
            error instanceof Error ? error.message : "Unknown error"
          }. The change was undone.`,
        onError: () => patchRow(contact.id, { doNotContact: contact.doNotContact }),
      },
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: base }, { label: "Contacts" }]} />
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Contacts
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Everyone in the pipeline, most recently touched first.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={14} /> New contact
        </Button>
      </div>

      {/* Search + filters */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, company or title…"
              aria-label="Search contacts"
              className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-indigo-900"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 dark:border-slate-600 dark:bg-slate-900"
            />
            Show archived
          </label>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <StageChip label="All stages" active={stage === ""} onClick={() => setStage("")} />
          {CONTACT_LIFECYCLE_STAGES.map((s) => (
            <StageChip
              key={s}
              label={STAGE_LABELS[s]}
              active={stage === s}
              onClick={() => setStage(stage === s ? "" : s)}
            />
          ))}
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load contacts
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong fetching this list.
          </p>
          <Button variant="secondary" className="mt-4" onClick={load}>
            Try again
          </Button>
        </div>
      ) : rows === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {query || stage ? "No contacts match those filters" : "No contacts yet"}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            {query || stage
              ? "Try a different search, or clear the stage filter."
              : "Add the first person you are selling to. Once mail is connected, their conversations land on the timeline on their own."}
          </p>
          <div className="mt-4">
            {query || stage ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch("");
                  setStage("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button onClick={() => setCreating(true)}>
                <Plus size={14} /> New contact
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Name</th>
                    <th className="hidden px-4 py-2 text-left font-medium md:table-cell">
                      Company
                    </th>
                    <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">
                      Title
                    </th>
                    <th className="px-4 py-2 text-left font-medium">Stage</th>
                    <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">
                      Owner
                    </th>
                    <th className="px-4 py-2 text-right font-medium">Last activity</th>
                    <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {list.map((c) => {
                    const owner = ownerLabel(c, members, employees);
                    return (
                      <tr
                        key={c.id}
                        className={
                          "hover:bg-slate-50 dark:hover:bg-slate-800/50 " +
                          (c.archivedAt ? "opacity-60" : "")
                        }
                      >
                        <td className="px-4 py-3">
                          <Link
                            to={`${base}/contacts/${c.id}`}
                            className="font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                          >
                            {c.name || "Unnamed contact"}
                          </Link>
                          <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                            {c.email || "No email"}
                          </div>
                          <div className="mt-1">
                            <ContactFlagPills contact={c} />
                          </div>
                        </td>
                        <td className="hidden px-4 py-3 text-slate-600 dark:text-slate-300 md:table-cell">
                          {c.customerName || c.companyName || (
                            <span className="text-slate-400 dark:text-slate-500">—</span>
                          )}
                        </td>
                        <td className="hidden px-4 py-3 text-slate-600 dark:text-slate-300 lg:table-cell">
                          {c.title || (
                            <span className="text-slate-400 dark:text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <LifecycleStagePill stage={c.lifecycleStage} />
                        </td>
                        <td className="hidden px-4 py-3 text-slate-600 dark:text-slate-300 lg:table-cell">
                          {owner ? (
                            <span className="inline-flex items-center gap-1">
                              {owner.name}
                              {owner.kind === "ai" && (
                                <span className="rounded bg-violet-100 px-1 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                                  AI
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">
                              Unassigned
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-slate-500 dark:text-slate-400">
                          {formatRelative(c.lastActivityAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <RowMenu
                            archived={!!c.archivedAt}
                            doNotContact={c.doNotContact}
                            onOpen={() => navigate(`${base}/contacts/${c.id}`)}
                            onArchive={() => archive(c)}
                            onToggleDnc={() => void toggleDoNotContact(c)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">
              {start}–{end} of {total} contact{total === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!hasPrev}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft size={14} /> Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!hasNext}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Mounted only while open, so the form starts empty every time. */}
      {creating && (
        <NewContactModal
          companyId={company.id}
          members={members}
          employees={employees}
          onClose={() => setCreating(false)}
          onCreated={(contact) => {
            setCreating(false);
            navigate(`${base}/contacts/${contact.id}`);
          }}
        />
      )}
    </div>
  );
}

function StageChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {label}
    </button>
  );
}

function RowMenu({
  archived,
  doNotContact,
  onOpen,
  onArchive,
  onToggleDnc,
}: {
  archived: boolean;
  doNotContact: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onToggleDnc: () => void;
}) {
  return (
    <Menu
      align="right"
      width={200}
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
            icon={<Users size={14} />}
            label="Open contact"
            onSelect={() => {
              close();
              onOpen();
            }}
          />
          <MenuItem
            icon={<Ban size={14} />}
            label={doNotContact ? "Allow contact" : "Mark do not contact"}
            onSelect={() => {
              close();
              onToggleDnc();
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            label={archived ? "Restore" : "Archive"}
            onSelect={() => {
              close();
              onArchive();
            }}
          />
        </>
      )}
    </Menu>
  );
}

/**
 * New contact.
 *
 * The one failure worth designing for is the 409: the service refuses a
 * duplicate address rather than merging into the existing row, so the message
 * has to name the address that clashed instead of saying "create failed" and
 * throwing away what was typed.
 */
function NewContactModal({
  companyId,
  members,
  employees,
  onClose,
  onCreated,
}: {
  companyId: string;
  members: Member[];
  employees: Employee[];
  onClose: () => void;
  onCreated: (contact: RevenueContact) => void;
}) {
  const { background } = useToast();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [companyName, setCompanyName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [stage, setStage] = React.useState<ContactLifecycleStage>("lead");
  const [owner, setOwner] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("A name is required.");
      return;
    }
    const trimmedEmail = email.trim();
    const body: Record<string, unknown> = {
      name: trimmedName,
      lifecycleStage: stage,
    };
    if (trimmedEmail) body.email = trimmedEmail;
    if (title.trim()) body.title = title.trim();
    if (companyName.trim()) body.companyName = companyName.trim();
    if (phone.trim()) body.phone = phone.trim();
    if (owner.startsWith("u:")) body.ownerId = owner.slice(2);
    if (owner.startsWith("e:")) body.ownerEmployeeId = owner.slice(2);

    setError(null);
    setSaving(true);
    background(
      () =>
        api.post<RevenueContact>(`/api/companies/${companyId}/revenue/contacts`, body),
      {
        loading: "Creating contact…",
        success: (contact) => `${contact.name} added`,
        error: () => "The contact was not created.",
        onSuccess: (contact) => {
          setSaving(false);
          onCreated(contact);
        },
        onError: (err) => {
          setSaving(false);
          const message = err instanceof Error ? err.message : "Unknown error";
          // `api` throws a bare Error, so the 409 is recognised by the message
          // the service writes. Anything else is reported verbatim.
          setError(
            /already exists/i.test(message)
              ? `${trimmedEmail || "That address"} is already on a contact in this company. Search for it in the list and open that record instead of creating a second one.`
              : message,
          );
        },
      },
    );
  }

  return (
    <Modal open onClose={onClose} title="New contact">
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dana Reyes"
          autoFocus
          required
        />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="dana@acme.com"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="VP Engineering"
          />
          <Input
            label="Company"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Acme Inc."
          />
          <Input
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 0100"
          />
          <Select
            label="Lifecycle stage"
            value={stage}
            onChange={(e) => setStage(e.target.value as ContactLifecycleStage)}
          >
            {CONTACT_LIFECYCLE_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <Select
          label="Owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          <option value="">Unassigned</option>
          {members.length > 0 && (
            <optgroup label="People">
              {members.map((m) => (
                <option key={m.userId} value={`u:${m.userId}`}>
                  {m.name || m.email || m.userId}
                </option>
              ))}
            </optgroup>
          )}
          {employees.length > 0 && (
            <optgroup label="AI employees">
              {employees.map((emp) => (
                <option key={emp.id} value={`e:${emp.id}`}>
                  {emp.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          An address must be unique in this company — the same person cannot be
          created twice.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Spinner size={14} /> : <Plus size={14} />} Create contact
          </Button>
        </div>
      </form>
    </Modal>
  );
}
