/**
 * App-wide "content changed, refetch" fan-out.
 *
 * A single TypeORM subscriber (`server/db/subscribers/resourceChangeSubscriber`)
 * turns every content write — from HTTP routes, MCP tools, cron, pipelines,
 * mail sync, anywhere — into a coarse `resource.changed` websocket event. This
 * module is the seam between that subscriber and the socket: it coalesces a
 * burst of writes per `(company, kind)` into a single frame, so materializing
 * 500 base records or a bulk todo import collapses to one refetch instead of
 * 500.
 *
 * Coarse on purpose, exactly like the older `mail.updated` event: the frame
 * carries only a `kind` (the resource family) plus the set of parent scope ids
 * touched — never row contents. Open pages refetch through the normal
 * authorized routes, so nothing sensitive rides the socket and project /
 * channel access is re-checked on every refetch.
 *
 * The socket layer registers the real broadcast sink at boot
 * (`registerResourceChangeSink`, called from `attachRealtime`). Until then
 * `emitResourceChange` is a no-op — so writes during migrations and early boot
 * never fan out, and the subscriber can cheaply short-circuit on
 * {@link resourceEventsActive}.
 */

/** Delivers one coalesced change to every socket in the company room. */
export type ResourceChangeSink = (
  companyId: string,
  kind: string,
  scopeIds: string[],
) => void;

let sink: ResourceChangeSink | null = null;

/** companyId → kind → set of parent scope ids touched (may be empty). */
const pending = new Map<string, Map<string, Set<string>>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Collapse a burst of writes into one frame per kind. */
const FLUSH_MS = 180;
/**
 * Cap the scope set per kind per window. Past this we drop to the empty set,
 * which pages read as "refetch regardless" — a handful of extra refetches
 * beats an unbounded array on a bulk import.
 */
const MAX_SCOPES = 64;

export function registerResourceChangeSink(fn: ResourceChangeSink): void {
  sink = fn;
}

/** True once the socket layer has wired its sink; the subscriber checks this. */
export function resourceEventsActive(): boolean {
  return sink !== null;
}

/**
 * Record that a resource of `kind` changed in `companyId`, optionally scoped to
 * a parent id (a projectId for a todo, a routineId for a run, a tableId for a
 * base record) so a board only refetches for the parent it is showing. Safe to
 * call from any write path; cheap and synchronous — the actual broadcast is
 * debounced onto {@link FLUSH_MS}.
 */
export function emitResourceChange(
  companyId: string,
  kind: string,
  scopeId?: string,
): void {
  if (!sink) return;
  let byKind = pending.get(companyId);
  if (!byKind) {
    byKind = new Map();
    pending.set(companyId, byKind);
  }
  let scopes = byKind.get(kind);
  if (!scopes) {
    scopes = new Set();
    byKind.set(kind, scopes);
  }
  if (scopeId) {
    if (scopes.size < MAX_SCOPES) scopes.add(scopeId);
    // Overflow: forget the specifics and signal a company-wide refetch.
    else scopes.clear();
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_MS);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
}

function flush(): void {
  flushTimer = null;
  const current = sink;
  const batch = pending;
  if (!current) {
    batch.clear();
    return;
  }
  for (const [companyId, byKind] of batch) {
    for (const [kind, scopes] of byKind) {
      try {
        current(companyId, kind, Array.from(scopes));
      } catch {
        // One bad frame must not wedge the flush for other companies/kinds.
      }
    }
  }
  batch.clear();
}
