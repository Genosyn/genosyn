import {
  ACCESS_BULK_MAX_ITEMS,
  ACCESS_BULK_OUTCOMES,
  ACCESS_GROUPS,
  ACCESS_GROUP_BY_KEY,
  ACCESS_KIND_META,
  accessLevelLabel,
  type AccessBulkAction,
  type AccessBulkItem,
  type AccessBulkOutcome,
  type AccessBulkResponse,
  type AccessBulkResult,
  type AccessGroupKey,
  type AccessGroupMeta,
  type AccessItem,
  type AccessKind,
  type EmployeeAccessListing,
} from "../../shared/employeeAccess";
import { chunk } from "./selection";
import { foldSearchText, queryTokens } from "./searchText";

export {
  ACCESS_GROUPS,
  ACCESS_KIND_META,
  accessLevelLabel,
  type AccessBulkAction,
  type AccessBulkResponse,
  type AccessBulkResult,
  type AccessGroupKey,
  type AccessItem,
  type AccessKind,
  type EmployeeAccessListing,
};

/**
 * The Access page's logic, kept pure so it can be tested without a browser:
 * which rows a search and the filters keep, how they group, what a tick-all
 * ticks, and — before anything is sent — what a bulk change will do to each
 * ticked row, the way the server will decide it (`services/employeeAccess`).
 */

// ─────────────────────────────── filters ───────────────────────────────

export type AccessStatusFilter = "all" | "granted" | "not_granted";

export type AccessFilters = {
  query: string;
  group: AccessGroupKey | "all";
  status: AccessStatusFilter;
};

export const DEFAULT_ACCESS_FILTERS: AccessFilters = { query: "", group: "all", status: "all" };

/** Whether the employee reaches this row now — directly, by default, or through a notebook or parent page. */
export function hasAccess(item: AccessItem): boolean {
  return item.grant !== null || item.inherited !== null;
}

/** The words a row is found by: its name, its second line, and what kind of thing it is. */
function searchableText(item: AccessItem): string {
  const meta = ACCESS_KIND_META[item.kind];
  return foldSearchText(
    [item.label, item.detail ?? "", meta.singular, meta.plural, ACCESS_GROUP_BY_KEY[meta.group].label].join(
      " ",
    ),
  );
}

/**
 * The rows the search and filters keep, in listing order. Every word of the
 * search has to appear somewhere in the row. A row whose Grants the viewer may
 * not see is neither granted nor not granted, so only "all" shows it.
 */
export function filterAccessItems(items: readonly AccessItem[], filters: AccessFilters): AccessItem[] {
  const tokens = queryTokens(foldSearchText(filters.query));
  return items.filter((item) => {
    if (filters.group !== "all" && ACCESS_KIND_META[item.kind].group !== filters.group) return false;
    if (filters.status === "granted" && (item.hidden || !hasAccess(item))) return false;
    if (filters.status === "not_granted" && (item.hidden || hasAccess(item))) return false;
    if (tokens.length) {
      const text = searchableText(item);
      if (!tokens.every((token) => text.includes(token))) return false;
    }
    return true;
  });
}

/** Whether anything narrows the list — the empty state then says "nothing matches", not "nothing exists". */
export function filtersActive(filters: AccessFilters): boolean {
  return filters.query.trim() !== "" || filters.group !== "all" || filters.status !== "all";
}

// ─────────────────────────────── groups ───────────────────────────────

export type AccessGroupView = {
  group: AccessGroupMeta;
  /** The rows the filters keep, in listing order. */
  items: AccessItem[];
  /** Every row of the group in the listing, whatever the filters. */
  total: number;
  /** Of `total`, how many the employee reaches. */
  withAccess: number;
  /** More exist than were listed (some kind of it hit the listing's limit). */
  truncated: boolean;
  /** Why the viewer cannot list the group's kinds, when none can be listed. */
  unavailable: string | null;
};

/** The page's groups, in catalogue order, each with its filtered rows and its counts. */
export function groupAccessItems(
  listing: EmployeeAccessListing,
  filtered: readonly AccessItem[],
): AccessGroupView[] {
  const status = new Map(listing.kinds.map((entry) => [entry.kind, entry]));
  return ACCESS_GROUPS.map((group) => {
    const kinds = new Set<AccessKind>(group.kinds);
    const all = listing.items.filter((item) => kinds.has(item.kind));
    const reasons = group.kinds.map((kind) => status.get(kind)?.unavailable ?? null);
    return {
      group,
      items: filtered.filter((item) => kinds.has(item.kind)),
      total: all.length,
      withAccess: all.filter((item) => !item.hidden && hasAccess(item)).length,
      truncated: group.kinds.some((kind) => status.get(kind)?.truncated),
      unavailable: reasons.every((reason) => reason !== null) ? reasons[0] : null,
    };
  });
}

/**
 * The one reason every row of a group is locked for — "Only owners and admins
 * can grant Mailboxes." — so the group can say it once instead of on each row.
 * Null when there are fewer than two rows, or any row differs.
 */
export function sharedLockReason(items: readonly AccessItem[]): string | null {
  if (items.length < 2) return null;
  const first = items[0].reason;
  if (!first) return null;
  return items.every((item) => !item.canChange && item.reason === first) ? first : null;
}

/** How many Grants someone actually gave this employee: defaults and inherited access are not counted. */
export function countGrants(items: readonly AccessItem[]): number {
  return items.filter((item) => item.grant !== null && !item.grant.byDefault).length;
}

// ─────────────────────────────── selection ───────────────────────────────

/** The keys of the rows the viewer may change; only those can be ticked. */
export function selectableKeys(items: readonly AccessItem[]): string[] {
  return items.filter((item) => item.canChange).map((item) => item.key);
}

export type SelectionState = "none" | "some" | "all";

/** A tick-all box's state over the rows it covers — rows that cannot be ticked are left out. */
export function selectionState(items: readonly AccessItem[], selected: ReadonlySet<string>): SelectionState {
  const keys = selectableKeys(items);
  if (keys.length === 0) return "none";
  const ticked = keys.filter((key) => selected.has(key)).length;
  if (ticked === 0) return "none";
  return ticked === keys.length ? "all" : "some";
}

/** Tick (or untick) every changeable row among `items`. */
export function setSelected(
  selected: ReadonlySet<string>,
  items: readonly AccessItem[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const key of selectableKeys(items)) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** After a reload: keep only ticks on rows that are still there and still changeable. */
export function pruneSelection(selected: ReadonlySet<string>, items: readonly AccessItem[]): Set<string> {
  const keep = new Set(selectableKeys(items));
  return new Set([...selected].filter((key) => keep.has(key)));
}

/** The ticked rows, in listing order. */
export function selectedItems(items: readonly AccessItem[], selected: ReadonlySet<string>): AccessItem[] {
  return items.filter((item) => selected.has(item.key));
}

// ─────────────────────────────── bulk changes ───────────────────────────────

/** The level each kind gets in a bulk change, by kind. */
export type LevelChoice = Partial<Record<AccessKind, string>>;

export type PlannedRow = { item: AccessItem; reason: string };

export type BulkPlan = {
  action: AccessBulkAction;
  /** Rows the change will be sent for. */
  apply: AccessItem[];
  /** Rows already as asked: nothing is sent for them. */
  unchanged: PlannedRow[];
  /** Rows the change does not apply to. */
  skipped: PlannedRow[];
  /** Kinds among `apply` that take a level, with how many rows each, in catalogue order. */
  levelKinds: Array<{ kind: AccessKind; count: number }>;
};

/** Each kind's own default level, for the kinds that have levels. */
export function defaultLevels(kinds: Iterable<AccessKind>): LevelChoice {
  const out: LevelChoice = {};
  for (const kind of kinds) {
    const level = ACCESS_KIND_META[kind].defaultLevel;
    if (level && ACCESS_KIND_META[kind].levels.length) out[kind] = level;
  }
  return out;
}

const KIND_ORDER = new Map(
  ACCESS_GROUPS.flatMap((group) => group.kinds).map((kind, index) => [kind, index] as const),
);

/**
 * What a bulk change will do to each ticked row, decided the way the server
 * decides it before it sends anything: granting what is already held, or
 * revoking what is not, changes nothing; Routines and the Resources library
 * are always held, so they move between levels and are never revoked; a kind
 * without levels has no level to change. A row whose Grants the viewer may not
 * see is always sent — the server answers for it.
 */
export function planBulk(
  action: AccessBulkAction,
  items: readonly AccessItem[],
  levels: LevelChoice = {},
): BulkPlan {
  const plan: BulkPlan = { action, apply: [], unchanged: [], skipped: [], levelKinds: [] };
  // The rows a level can be chosen for: everything sent, and — for a level
  // change — every held row, even one already at the level picked so far, so
  // its picker stays on screen to be moved.
  const levelRows: AccessItem[] = [];
  for (const item of items) {
    const meta = ACCESS_KIND_META[item.kind];
    const held = item.grant !== null;
    if (!item.canChange) {
      plan.skipped.push({ item, reason: item.reason ?? "You cannot change this one." });
      continue;
    }
    if (action === "grant") {
      if (!item.hidden && held) {
        plan.unchanged.push({ item, reason: "Already granted." });
        continue;
      }
    } else if (action === "set_level") {
      if (meta.levels.length === 0) {
        plan.skipped.push({ item, reason: `${meta.plural} have no levels.` });
        continue;
      }
      if (!item.hidden && !held) {
        plan.skipped.push({ item, reason: "Not granted yet." });
        continue;
      }
      levelRows.push(item);
      const target = levels[item.kind];
      if (!item.hidden && target && item.grant?.level === target) {
        plan.unchanged.push({ item, reason: `Already ${accessLevelLabel(item.kind, target)}.` });
        continue;
      }
    } else {
      if (meta.heldByDefault) {
        plan.skipped.push({ item, reason: `Every AI Employee holds a ${meta.singular} level.` });
        continue;
      }
      if (!item.hidden && !held) {
        plan.unchanged.push({ item, reason: "Not granted." });
        continue;
      }
    }
    plan.apply.push(item);
    if (action === "grant") levelRows.push(item);
  }
  if (action !== "revoke") {
    const counts = new Map<AccessKind, number>();
    for (const item of levelRows) {
      if (ACCESS_KIND_META[item.kind].levels.length === 0) continue;
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    }
    plan.levelKinds = [...counts]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0));
  }
  return plan;
}

/** The request bodies for a plan, split into parts the server takes at once. */
export function bulkRequests(
  plan: BulkPlan,
  levels: LevelChoice,
): Array<{ action: AccessBulkAction; items: AccessBulkItem[] }> {
  const items: AccessBulkItem[] = plan.apply.map((item) => {
    const meta = ACCESS_KIND_META[item.kind];
    const body: AccessBulkItem = { kind: item.kind };
    if (meta.scope === "resource") body.resourceId = item.resourceId;
    if (plan.action !== "revoke" && meta.levels.length) {
      const level = levels[item.kind] ?? meta.defaultLevel;
      if (level) body.level = level;
    }
    return body;
  });
  return chunk(items, ACCESS_BULK_MAX_ITEMS).map((part) => ({ action: plan.action, items: part }));
}

/** Several responses (one per part) read as one. */
export function mergeBulkResponses(
  action: AccessBulkAction,
  responses: readonly AccessBulkResponse[],
): AccessBulkResponse {
  const summary = Object.fromEntries(ACCESS_BULK_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    AccessBulkOutcome,
    number
  >;
  const results: AccessBulkResult[] = [];
  for (const response of responses) {
    results.push(...response.results);
    for (const outcome of ACCESS_BULK_OUTCOMES) summary[outcome] += response.summary[outcome] ?? 0;
  }
  return { action, results, summary };
}

export type BulkReport = {
  /** Rows the change was made to. */
  done: number;
  /** Rows the server found already as asked, or that did not apply. */
  untouched: number;
  /** Rows a kind's own rule refused, with the row's name and the reason. */
  failures: Array<{ key: string; label: string; message: string }>;
};

/** What a finished bulk change did, with each refused row named. */
export function reportBulk(response: AccessBulkResponse, items: readonly AccessItem[]): BulkReport {
  const labelOf = new Map(items.map((item) => [item.key, item.label]));
  const report: BulkReport = { done: 0, untouched: 0, failures: [] };
  for (const result of response.results) {
    if (result.outcome === "failed") {
      report.failures.push({
        key: result.key,
        label: labelOf.get(result.key) ?? ACCESS_KIND_META[result.kind].singular,
        message: result.message ?? "The change was refused.",
      });
    } else if (result.outcome === "unchanged" || result.outcome === "skipped") {
      report.untouched += 1;
    } else {
      report.done += 1;
    }
  }
  return report;
}

/** "Grant 3 rows" — the confirm button's words for a plan. */
export function actionLabel(action: AccessBulkAction, count: number): string {
  const rows = `${count} ${count === 1 ? "item" : "items"}`;
  if (action === "grant") return `Grant ${rows}`;
  if (action === "set_level") return `Change ${rows}`;
  return `Revoke ${rows}`;
}

/** "3 Notes", "1 Mailbox". */
export function kindCount(kind: AccessKind, count: number): string {
  const meta = ACCESS_KIND_META[kind];
  return `${count} ${count === 1 ? meta.singular : meta.plural}`;
}

// ─────────────────────────────── a row's access, in words ───────────────────────────────

export type AccessBadge = {
  text: string;
  tone: "granted" | "inherited" | "default" | "none" | "hidden";
  /** A longer line for a tooltip or a second row. */
  title?: string;
};

/** What a row shows about the employee's access to it. */
export function accessBadge(item: AccessItem): AccessBadge {
  if (item.hidden) {
    return { text: "Not shown to you", tone: "hidden", title: item.reason ?? undefined };
  }
  if (item.grant) {
    const label = item.grant.level ? accessLevelLabel(item.kind, item.grant.level) : "Granted";
    if (item.grant.byDefault) {
      return { text: `${label} · default`, tone: "default", title: "Every AI Employee holds this until someone narrows it." };
    }
    return { text: label, tone: "granted" };
  }
  if (item.inherited) {
    const from = ACCESS_KIND_META[item.inherited.fromKind].singular.toLowerCase();
    return {
      text: `${accessLevelLabel(item.kind, item.inherited.level)} via ${from}`,
      tone: "inherited",
      title: `Reaches this through the ${from} “${item.inherited.fromLabel}”.`,
    };
  }
  return { text: "No access", tone: "none" };
}
