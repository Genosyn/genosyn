import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import {
  api,
  Customer,
  Employee,
  Member,
  formatMoney,
  parseMoneyToCents,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * The deal board — `GET /revenue/deals/board` rendered as one column per
 * stage, plus a flat list view of `GET /revenue/deals` for the times you want
 * to filter rather than look.
 *
 * Cards move between columns with the native HTML5 drag-and-drop API (no
 * library): dragging is a `POST /revenue/deals/:id/stage`, applied optimistically
 * and rolled back if the server refuses. The two moves that are expensive to
 * undo — into a `won` or a `lost` stage, both of which close the deal and write
 * a lifecycle activity the funnel report reads — cost one extra click each: a
 * confirm for a win, a loss reason for a loss.
 *
 * The types below mirror the server payloads (`services/revenue/deals.ts` +
 * `db/entities/*`) with Dates as the ISO strings JSON actually carries.
 */

export type DealStageKind = "open" | "won" | "lost";
export type DealStatus = "open" | "won" | "lost";

export type DealStage = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  sortOrder: number;
  /** Default close likelihood 0-100; a deal may override it per row. */
  probability: number;
  kind: DealStageKind;
  /** Hex chip colour, or "" when the company never picked one. */
  color: string;
  description: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `HydratedDeal` — the Deal row plus the names and weighting the API attaches. */
export type Deal = {
  id: string;
  companyId: string;
  title: string;
  description: string;
  customerId: string | null;
  primaryContactId: string | null;
  stageId: string;
  amountCents: number;
  currency: string;
  probabilityOverride: number | null;
  expectedCloseDate: string | null;
  status: DealStatus;
  closedAt: string | null;
  lostReason: string;
  source: string;
  ownerId: string | null;
  ownerEmployeeId: string | null;
  nextStep: string;
  lastActivityAt: string | null;
  archivedAt: string | null;
  createdById: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
  stageName: string | null;
  stageKind: DealStageKind | null;
  customerName: string | null;
  contactName: string | null;
  weightedValueCents: number;
};

export type BoardColumn = {
  stage: DealStage;
  deals: Deal[];
  totalCents: number;
  weightedCents: number;
};

/** The Contact fields these two pages render. The API sends the whole row. */
export type RevenueContact = {
  id: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  companyName: string;
  customerId: string | null;
  customerName: string | null;
};

export type ActivityKind =
  | "email_in"
  | "email_out"
  | "call"
  | "meeting"
  | "note"
  | "task"
  | "deal_created"
  | "stage_change"
  | "deal_won"
  | "deal_lost"
  | "enrollment"
  | "sequence_step"
  | "unsubscribe"
  | "bounce"
  | "signal";

export type Activity = {
  id: string;
  companyId: string;
  kind: ActivityKind;
  subject: string;
  bodyText: string;
  occurredAt: string;
  contactId: string | null;
  dealId: string | null;
  customerId: string | null;
  mailThreadId: string | null;
  mailMessageId: string | null;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  /** Kind-specific detail, serialized — the API does not parse it for you. */
  metaJson: string | null;
  createdAt: string;
};

/** One seat on the buying committee: the join row plus the person. */
export type DealContactLink = {
  id: string;
  companyId: string;
  dealId: string;
  contactId: string;
  role: string;
  sortOrder: number;
  createdAt: string;
  contact: RevenueContact | null;
};

export type DealDetailResponse = {
  deal: Deal;
  activities: Activity[];
  activityTotal: number;
  contacts: DealContactLink[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days without activity before a card starts asking for attention. */
const STALE_WARN_DAYS = 21;
const STALE_DANGER_DAYS = 45;

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

/** `2026-07-23` from an ISO timestamp — the form of a date the API accepts back. */
export function isoDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Weighted value for an optimistic move, mirroring
 * `services/revenue/dealStage.ts` — a terminal stage is 100 or 0 whatever the
 * row says, and the override beats the stage default with `??` so an explicit
 * zero survives. Kept in step so a dragged card shows the total the server is
 * about to send back rather than one that jumps on refetch.
 */
export function weightedFor(deal: Deal, stage: DealStage): number {
  const pct =
    stage.kind === "won"
      ? 100
      : stage.kind === "lost"
        ? 0
        : Math.min(100, Math.max(0, deal.probabilityOverride ?? stage.probability));
  const raw = (deal.amountCents * pct) / 100;
  // `roundHalfAway` from server/lib/money.ts, to the digit.
  return raw >= 0 ? Math.floor(raw + 0.5) : -Math.floor(-raw + 0.5);
}

export function stagePillClasses(kind: DealStageKind | null): string {
  if (kind === "won") {
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (kind === "lost") {
    return "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300";
  }
  return "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300";
}

export function statusPillClasses(status: DealStatus): string {
  if (status === "won") {
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (status === "lost") {
    return "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300";
  }
  return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
}

/** How long since anything happened, and how loudly to say so. */
export function staleness(lastActivityAt: string | null): {
  label: string;
  title: string;
  cls: string;
} {
  if (!lastActivityAt) {
    return {
      label: "No activity",
      title: "Nothing has been logged against this deal yet",
      cls: "text-slate-400 dark:text-slate-500",
    };
  }
  const then = new Date(lastActivityAt).getTime();
  if (Number.isNaN(then)) {
    return {
      label: "No activity",
      title: "Nothing has been logged against this deal yet",
      cls: "text-slate-400 dark:text-slate-500",
    };
  }
  const days = Math.max(0, Math.floor((Date.now() - then) / DAY_MS));
  const title = `Last activity ${fmtDay(lastActivityAt)} — ${days} day${days === 1 ? "" : "s"} ago`;
  if (days >= STALE_DANGER_DAYS) {
    return { label: `${days}d idle`, title, cls: "text-rose-600 dark:text-rose-400" };
  }
  if (days >= STALE_WARN_DAYS) {
    return { label: `${days}d idle`, title, cls: "text-amber-600 dark:text-amber-400" };
  }
  if (days === 0) {
    return { label: "Active today", title, cls: "text-slate-400 dark:text-slate-500" };
  }
  return { label: `${days}d idle`, title, cls: "text-slate-400 dark:text-slate-500" };
}

/** "user:<id>" / "ai:<id>" — one select for two kinds of owner. */
export function ownerKey(ownerId: string | null, ownerEmployeeId: string | null): string {
  if (ownerId) return `user:${ownerId}`;
  if (ownerEmployeeId) return `ai:${ownerEmployeeId}`;
  return "";
}

export function ownerIdsFromKey(key: string): {
  ownerId: string | null;
  ownerEmployeeId: string | null;
} {
  if (key.startsWith("user:")) return { ownerId: key.slice(5), ownerEmployeeId: null };
  if (key.startsWith("ai:")) return { ownerId: null, ownerEmployeeId: key.slice(3) };
  return { ownerId: null, ownerEmployeeId: null };
}

export default function RevenueDeals() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const navigate = useNavigate();
  const { background } = useToast();
  const dialog = useDialog();

  const base = `/api/companies/${company.id}/revenue`;
  const dealsPath = `/c/${company.slug}/revenue/deals`;

  const [view, setView] = React.useState<"board" | "list">("board");
  const [board, setBoard] = React.useState<BoardColumn[] | null>(null);
  const [boardError, setBoardError] = React.useState(false);
  const [rows, setRows] = React.useState<Deal[] | null>(null);
  const [listError, setListError] = React.useState(false);
  const [listTotal, setListTotal] = React.useState(0);

  const [status, setStatus] = React.useState("");
  const [stageFilter, setStageFilter] = React.useState("");
  const [ownerFilter, setOwnerFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");

  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [creating, setCreating] = React.useState(false);

  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overStageId, setOverStageId] = React.useState<string | null>(null);

  const stages = React.useMemo(() => (board ?? []).map((c) => c.stage), [board]);

  const loadBoard = React.useCallback(async () => {
    const res = await api.get<{ columns: BoardColumn[] }>(`${base}/deals/board`);
    setBoard(res.columns);
    setBoardError(false);
  }, [base]);

  const loadList = React.useCallback(async () => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (status) params.set("status", status);
    if (stageFilter) params.set("stageId", stageFilter);
    const owner = ownerIdsFromKey(ownerFilter);
    if (owner.ownerId) params.set("ownerId", owner.ownerId);
    if (owner.ownerEmployeeId) params.set("ownerEmployeeId", owner.ownerEmployeeId);
    params.set("limit", "200");
    const res = await api.get<{ rows: Deal[]; total: number }>(
      `${base}/deals?${params.toString()}`,
    );
    setRows(res.rows);
    setListTotal(res.total);
    setListError(false);
  }, [base, query, status, stageFilter, ownerFilter]);

  React.useEffect(() => {
    loadBoard().catch(() => {
      setBoard([]);
      setBoardError(true);
    });
  }, [loadBoard]);

  React.useEffect(() => {
    if (view !== "list") return;
    loadList().catch(() => {
      setRows([]);
      setListError(true);
    });
  }, [view, loadList]);

  // Typing in the search box must not fire a request per keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  React.useEffect(() => {
    let alive = true;
    void Promise.all([
      api.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => [] as Member[]),
      api
        .get<Employee[]>(`/api/companies/${company.id}/employees`)
        .catch(() => [] as Employee[]),
    ]).then(([m, e]) => {
      if (!alive) return;
      setMembers(m);
      setEmployees(e);
    });
    return () => {
      alive = false;
    };
  }, [company.id]);

  const reload = React.useCallback(() => {
    loadBoard().catch(() => undefined);
    if (view === "list") loadList().catch(() => undefined);
  }, [loadBoard, loadList, view]);

  useLiveRefetch(["deal", "dealstage", "activity"], reload);

  const ownerLabel = React.useCallback(
    (deal: Deal): string => {
      if (deal.ownerId) {
        return members.find((m) => m.userId === deal.ownerId)?.name ?? "Teammate";
      }
      if (deal.ownerEmployeeId) {
        return employees.find((e) => e.id === deal.ownerEmployeeId)?.name ?? "AI employee";
      }
      return "Unassigned";
    },
    [members, employees],
  );

  async function moveDeal(deal: Deal, target: DealStage) {
    if (deal.stageId === target.id) return;

    let lostReason: string | undefined;
    if (target.kind === "lost") {
      const reason = await dialog.prompt({
        title: `Mark “${deal.title}” as lost?`,
        message:
          "This closes the deal. Record why — the funnel report reads the reason back later.",
        placeholder: "Budget cut, went with a competitor, no decision…",
        confirmLabel: "Mark lost",
      });
      if (reason === null) return;
      lostReason = reason;
    } else if (target.kind === "won") {
      const ok = await dialog.confirm({
        title: `Mark “${deal.title}” as won?`,
        message: `${formatMoney(deal.amountCents, deal.currency)} closes into ${target.name}.`,
        confirmLabel: "Mark won",
      });
      if (!ok) return;
    }

    const snapshot = board;
    setBoard((current) => moveCard(current, deal.id, target.id));
    background(
      () =>
        api.post<Deal>(`${base}/deals/${deal.id}/stage`, {
          stageId: target.id,
          lostReason,
        }),
      {
        loading: `Moving to ${target.name}…`,
        success: `${deal.title} → ${target.name}`,
        error: (err) =>
          `Couldn’t move the deal: ${errText(err)}. The card was put back.`,
        onSuccess: () => reload(),
        onError: () => setBoard(snapshot),
      },
    );
  }

  function onDropInto(stage: DealStage, e: React.DragEvent) {
    e.preventDefault();
    setOverStageId(null);
    const id = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    if (!id || !board) return;
    const deal = board.flatMap((c) => c.deals).find((d) => d.id === id);
    if (!deal) return;
    void moveDeal(deal, stage);
  }

  const showBoardSpinner = board === null && !boardError;

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue" }, { label: "Deals" }]} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Deals</h1>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
            <ViewTab
              active={view === "board"}
              label="Board"
              icon={<LayoutGrid size={13} />}
              onClick={() => setView("board")}
            />
            <ViewTab
              active={view === "list"}
              label="List"
              icon={<List size={13} />}
              onClick={() => setView("list")}
            />
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus size={14} /> New deal
          </Button>
        </div>
      </div>

      {view === "list" && (
        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search deals…"
              aria-label="Search deals"
              className="pl-8"
            />
          </div>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </Select>
          <Select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            aria-label="Filter by stage"
          >
            <option value="">Any stage</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            aria-label="Filter by owner"
          >
            <option value="">Any owner</option>
            {members.map((m) => (
              <option key={m.userId} value={`user:${m.userId}`}>
                {m.name ?? m.email ?? "Teammate"}
              </option>
            ))}
            {employees.map((e) => (
              <option key={e.id} value={`ai:${e.id}`}>
                {e.name} (AI)
              </option>
            ))}
          </Select>
        </div>
      )}

      {view === "board" ? (
        boardError ? (
          <ErrorPanel
            title="Couldn’t load the board"
            onRetry={() =>
              loadBoard().catch(() => {
                setBoard([]);
                setBoardError(true);
              })
            }
          />
        ) : showBoardSpinner ? (
          <div className="flex justify-center p-16">
            <Spinner size={20} />
          </div>
        ) : (board?.length ?? 0) === 0 ? (
          <EmptyPanel
            title="No stages yet"
            body="The board draws one column per deal stage. Add a stage to get started."
          />
        ) : (
          <div className="-mx-1 overflow-x-auto px-1 pb-3">
            <div className="flex min-w-max items-start gap-3">
              {(board ?? []).map((col) => (
                <StageColumn
                  key={col.stage.id}
                  column={col}
                  isOver={overStageId === col.stage.id}
                  dragId={dragId}
                  dealsPath={dealsPath}
                  ownerLabel={ownerLabel}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (overStageId !== col.stage.id) setOverStageId(col.stage.id);
                  }}
                  onDragLeave={() =>
                    setOverStageId((current) =>
                      current === col.stage.id ? null : current,
                    )
                  }
                  onDrop={(e) => onDropInto(col.stage, e)}
                  onCardDragStart={(id, e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", id);
                    setDragId(id);
                  }}
                  onCardDragEnd={() => {
                    setDragId(null);
                    setOverStageId(null);
                  }}
                  onOpen={(id) => navigate(`${dealsPath}/${id}`)}
                />
              ))}
            </div>
          </div>
        )
      ) : listError ? (
        <ErrorPanel
          title="Couldn’t load deals"
          onRetry={() =>
            loadList().catch(() => {
              setRows([]);
              setListError(true);
            })
          }
        />
      ) : rows === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyPanel
          title="No deals match"
          body="Nothing here with those filters. Clear them, or open a new deal."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus size={14} /> New deal
            </Button>
          }
        />
      ) : (
        <DealTable
          rows={rows}
          total={listTotal}
          dealsPath={dealsPath}
          ownerLabel={ownerLabel}
        />
      )}

      {creating && (
        <NewDealModal
          companyId={company.id}
          base={base}
          stages={stages}
          members={members}
          employees={employees}
          onClose={() => setCreating(false)}
          onCreated={(deal) => {
            setCreating(false);
            reload();
            navigate(`${dealsPath}/${deal.id}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * Move one card between columns and re-total both, without waiting for the
 * server. Pure so the pre-move board can simply be kept as the rollback value.
 */
function moveCard(
  board: BoardColumn[] | null,
  dealId: string,
  toStageId: string,
): BoardColumn[] | null {
  if (!board) return board;
  const moving = board.flatMap((c) => c.deals).find((d) => d.id === dealId);
  const target = board.find((c) => c.stage.id === toStageId);
  if (!moving || !target) return board;

  const card: Deal = {
    ...moving,
    stageId: target.stage.id,
    stageName: target.stage.name,
    stageKind: target.stage.kind,
    status: target.stage.kind,
    weightedValueCents: weightedFor(moving, target.stage),
  };

  return board.map((col) => {
    const kept = col.deals.filter((d) => d.id !== dealId);
    const deals = col.stage.id === toStageId ? [card, ...kept] : kept;
    return {
      ...col,
      deals,
      totalCents: deals.reduce((sum, d) => sum + d.amountCents, 0),
      weightedCents: deals.reduce((sum, d) => sum + d.weightedValueCents, 0),
    };
  });
}

function ViewTab({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition " +
        (active
          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
      }
    >
      {icon} {label}
    </button>
  );
}

function StageColumn({
  column,
  isOver,
  dragId,
  dealsPath,
  ownerLabel,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardDragEnd,
  onOpen,
}: {
  column: BoardColumn;
  isOver: boolean;
  dragId: string | null;
  dealsPath: string;
  ownerLabel: (deal: Deal) => string;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onCardDragStart: (id: string, e: React.DragEvent) => void;
  onCardDragEnd: () => void;
  onOpen: (id: string) => void;
}) {
  const { stage, deals } = column;
  // The API totals a column in minor units without naming a currency, so the
  // header borrows the first card's. Correct for the single-currency pipeline
  // every company starts with; a mixed column is why the per-card amount is
  // always shown with its own code.
  const currency = deals[0]?.currency ?? "USD";
  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label={stage.name}
      className={
        "flex w-64 shrink-0 flex-col rounded-xl border transition-colors " +
        (isOver
          ? "border-indigo-400 bg-indigo-50/60 dark:border-indigo-500/60 dark:bg-indigo-500/10"
          : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60")
      }
    >
      <header className="border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600"
            style={stage.color ? { backgroundColor: stage.color } : undefined}
            aria-hidden="true"
          />
          <span
            className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200"
            title={stage.description || stage.name}
          >
            {stage.name}
          </span>
          <span className="ml-auto rounded-full bg-slate-200 px-1.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {deals.length}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span className="font-medium tabular-nums text-slate-600 dark:text-slate-300">
            {formatMoney(column.totalCents, currency)}
          </span>
          <span
            className="tabular-nums text-slate-400 dark:text-slate-500"
            title={`Weighted at ${stage.probability}% — the forecast contribution of this column`}
          >
            {formatMoney(column.weightedCents, currency)} wtd
          </span>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2 p-2">
        {deals.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 py-6 text-center text-[11px] text-slate-400 dark:border-slate-700 dark:text-slate-500">
            Drop a deal here
          </p>
        ) : (
          deals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              dragging={dragId === deal.id}
              dealsPath={dealsPath}
              ownerLabel={ownerLabel}
              onDragStart={(e) => onCardDragStart(deal.id, e)}
              onDragEnd={onCardDragEnd}
              onOpen={() => onOpen(deal.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function DealCard({
  deal,
  dragging,
  dealsPath,
  ownerLabel,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  deal: Deal;
  dragging: boolean;
  dealsPath: string;
  ownerLabel: (deal: Deal) => string;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const stale = staleness(deal.lastActivityAt);
  const account = deal.customerName ?? deal.contactName;
  return (
    <article
      // Dragging a card is a stage move — see moveDeal().
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={
        "group cursor-pointer rounded-lg border bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow dark:bg-slate-900 " +
        (dragging
          ? "border-indigo-400 opacity-60 dark:border-indigo-500/60"
          : "border-slate-200 dark:border-slate-700")
      }
    >
      <Link
        to={`${dealsPath}/${deal.id}`}
        onClick={(e) => e.stopPropagation()}
        className="line-clamp-2 text-sm font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
      >
        {deal.title}
      </Link>
      <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
        {account ?? "No account yet"}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
          {formatMoney(deal.amountCents, deal.currency)}
        </span>
        <span className={"text-[11px] " + stale.cls} title={stale.title}>
          {stale.label}
        </span>
      </div>
      <p className="mt-1 truncate text-[11px] text-slate-400 dark:text-slate-500">
        {ownerLabel(deal)}
      </p>
    </article>
  );
}

function DealTable({
  rows,
  total,
  dealsPath,
  ownerLabel,
}: {
  rows: Deal[];
  total: number;
  dealsPath: string;
  ownerLabel: (deal: Deal) => string;
}) {
  const navigate = useNavigate();
  return (
    <>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Deal</th>
                <th className="px-4 py-2 text-left font-medium">Stage</th>
                <th className="px-4 py-2 text-left font-medium">Owner</th>
                <th className="px-4 py-2 text-left font-medium">Expected close</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((deal) => {
                const stale = staleness(deal.lastActivityAt);
                return (
                  <tr
                    key={deal.id}
                    onClick={() => navigate(`${dealsPath}/${deal.id}`)}
                    className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`${dealsPath}/${deal.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                      >
                        {deal.title}
                      </Link>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {deal.customerName ?? deal.contactName ?? "No account yet"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
                          stagePillClasses(deal.stageKind)
                        }
                      >
                        {deal.stageName ?? "Unstaged"}
                      </span>
                      {deal.status !== "open" && (
                        <span
                          className={
                            "ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
                            statusPillClasses(deal.status)
                          }
                        >
                          {deal.status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {ownerLabel(deal)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {fmtDay(deal.expectedCloseDate)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                      {formatMoney(deal.amountCents, deal.currency)}
                    </td>
                    <td className={"px-4 py-3 text-right text-xs " + stale.cls}>
                      {stale.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {total > rows.length && (
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          Showing {rows.length} of {total} deals — narrow the filters to see the rest.
        </p>
      )}
    </>
  );
}

function ErrorPanel({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Something went wrong fetching this.
      </p>
      <Button variant="secondary" className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function EmptyPanel({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * New deal. Everything except the title is optional — a deal routinely starts
 * as a name and a number, which is exactly why `customerId` and
 * `primaryContactId` are nullable on the server.
 */
function NewDealModal({
  companyId,
  base,
  stages,
  members,
  employees,
  onClose,
  onCreated,
}: {
  companyId: string;
  base: string;
  stages: DealStage[];
  members: Member[];
  employees: Employee[];
  onClose: () => void;
  onCreated: (deal: Deal) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [currency, setCurrency] = React.useState("USD");
  const [stageId, setStageId] = React.useState(
    stages.find((s) => s.kind === "open")?.id ?? "",
  );
  const [customerId, setCustomerId] = React.useState("");
  const [contactId, setContactId] = React.useState("");
  const [closeDate, setCloseDate] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [nextStep, setNextStep] = React.useState("");
  const [description, setDescription] = React.useState("");

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [contacts, setContacts] = React.useState<RevenueContact[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void Promise.all([
      api
        .get<Customer[]>(`/api/companies/${companyId}/customers`)
        .catch(() => [] as Customer[]),
      api
        .get<{ rows: RevenueContact[] }>(`${base}/contacts?limit=200`)
        .catch(() => ({ rows: [] as RevenueContact[] })),
    ]).then(([cs, ct]) => {
      if (!alive) return;
      setCustomers(cs.filter((c) => !c.archivedAt));
      setContacts(ct.rows);
    });
    return () => {
      alive = false;
    };
  }, [companyId, base]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const code = currency.trim().toUpperCase();
    try {
      const deal = await api.post<Deal>(`${base}/deals`, {
        title: title.trim(),
        description: description.trim(),
        stageId: stageId || null,
        amountCents: parseMoneyToCents(amount),
        // The server takes exactly three characters, so a half-typed code
        // becomes the default rather than a 400 the user has to decode.
        currency: code.length === 3 ? code : "USD",
        customerId: customerId || null,
        primaryContactId: contactId || null,
        expectedCloseDate: closeDate || null,
        nextStep: nextStep.trim(),
        ...ownerIdsFromKey(owner),
      });
      onCreated(deal);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New deal" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Acme — platform renewal"
          maxLength={200}
          required
          autoFocus
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="24000"
            inputMode="decimal"
          />
          <Input
            label="Currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={3}
            placeholder="USD"
          />
          <Input
            label="Expected close"
            type="date"
            value={closeDate}
            onChange={(e) => setCloseDate(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="Stage"
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={`user:${m.userId}`}>
                {m.name ?? m.email ?? "Teammate"}
              </option>
            ))}
            {employees.map((emp) => (
              <option key={emp.id} value={`ai:${emp.id}`}>
                {emp.name} (AI)
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="Account"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">No account yet</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select
            label="Primary contact"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
          >
            <option value="">No contact yet</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.companyName ? ` — ${c.companyName}` : ""}
              </option>
            ))}
          </Select>
        </div>

        <Input
          label="Next step"
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
          placeholder="Send the security questionnaire back"
          maxLength={500}
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What are they buying, and why now?"
          className="min-h-[100px]"
        />

        <FormError message={error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Create deal"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
