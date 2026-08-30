import { AsyncLocalStorage } from "node:async_hooks";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent, AuditActorKind } from "../db/entities/AuditEvent.js";

/**
 * Append-only audit log. Called at the route seam (and from a few services —
 * cron, webhooks, approvals) whenever state changes within a company. Never
 * throws: a failed audit write must not break the mutation it was observing.
 *
 * ## Ambient provenance
 *
 * Since M58 these rows are also the **effect ledger** — the ordered list of
 * what one Run actually changed, written by the server at each write seam
 * rather than narrated by the model afterwards. That only works if the
 * coverage is total: a ledger that is silently missing a third of its rows is
 * worse than no ledger, because a Check reading it would pass a Run that never
 * did the work, and a verdict reading it would call a real success unproven.
 *
 * The `runId` is known at exactly one place — the MCP request that carries the
 * Routine's token — and the ~150 write seams below it are spread across route
 * handlers *and* the services those handlers call, which have no request to
 * thread it through. So the context is ambient rather than a parameter:
 * `withAuditContext` installs it for the duration of one MCP request, and any
 * `recordAudit` inside that request inherits it. An explicit parameter always
 * wins, and outside a context every field is null — the same as before.
 *
 * `AsyncLocalStorage` is `node:async_hooks`, so this adds no dependency.
 */

/**
 * Deliberately provenance only — no actor fields. Supplying an ambient
 * `actorEmployeeId` would silently reclassify a member-authority tool call
 * (which passes its own `actorUserId`) from `user` to `ai`, and an audit log
 * that blames the wrong principal is worse than one that is merely thin. Who
 * acted stays an explicit decision at every call site; *inside what* is
 * ambient, because the ~150 seams below the request cannot see it.
 */
export type AuditContext = {
  runId?: string | null;
  routineId?: string | null;
  conversationId?: string | null;
};

const auditContext = new AsyncLocalStorage<AuditContext>();

/**
 * Run `fn` with ambient audit provenance. Every {@link recordAudit} inside it
 * — including ones performed by services the handler calls — inherits the
 * fields it does not pass itself.
 */
export function withAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return auditContext.run(ctx, fn);
}

/** The provenance in force right now, or null outside a context. */
export function currentAuditContext(): AuditContext | null {
  return auditContext.getStore() ?? null;
}

export async function recordAudit(params: {
  companyId: string;
  actorKind?: AuditActorKind;
  actorUserId?: string | null;
  actorEmployeeId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  targetLabel?: string;
  metadata?: Record<string, unknown>;
  /** The Run this mutation happened inside. Defaults to the ambient context. */
  runId?: string | null;
  /** The conversation this mutation happened inside. Same default. */
  conversationId?: string | null;
}): Promise<void> {
  try {
    const ambient = auditContext.getStore();
    // An explicit `null` always wins — a caller that says "no Run" must not
    // have one supplied under it. `undefined` means "did not say", which is
    // what every existing call site looks like, so those inherit.
    const inherit = <T>(explicit: T | null | undefined, ambientValue: T | null | undefined) =>
      explicit === undefined ? (ambientValue ?? null) : (explicit ?? null);
    const runId = inherit(params.runId, ambient?.runId);
    const conversationId = inherit(params.conversationId, ambient?.conversationId);

    const repo = AppDataSource.getRepository(AuditEvent);
    const actorEmployeeId = params.actorEmployeeId ?? null;
    const actorUserId = params.actorUserId ?? null;
    const resolvedKind: AuditActorKind =
      params.actorKind ?? (actorEmployeeId ? "ai" : actorUserId ? "user" : "system");
    const row = repo.create({
      companyId: params.companyId,
      actorKind: resolvedKind,
      actorUserId,
      actorEmployeeId,
      runId,
      conversationId,
      action: params.action,
      targetType: params.targetType ?? "",
      targetId: params.targetId ?? null,
      targetLabel: params.targetLabel ?? "",
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : "",
      // Stamped here rather than left to the column's database default, which
      // on SQLite is `datetime('now')` — whole seconds. Every effect one Run
      // recorded therefore carried an identical timestamp, and the effect
      // ledger's "oldest first" was really "in whatever order the uuids
      // sorted". A JS `Date` round-trips at millisecond resolution on both
      // drivers, which is finer than the interval between two tool calls, so
      // the ledger now reads in the order things actually happened.
      createdAt: new Date(),
    });
    await repo.save(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[audit] failed to record event", params.action, err);
  }
}
