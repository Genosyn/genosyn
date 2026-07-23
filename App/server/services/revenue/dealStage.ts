import { roundHalfAway } from "../../lib/money.js";

/**
 * The one thing the revenue board is not allowed to get wrong: a Deal's
 * `status` is whatever its stage's `kind` says it is, always.
 *
 * `Deal.status` and `DealStage.kind` are the same fact stored twice — a
 * denormalization the board and every report depend on (see `Deal.ts`). The
 * price of storing a fact twice is that something has to keep the copies
 * honest, and that something is this file. It is pure and entity-free on
 * purpose: routes, importers and the seeder all move deals between stages, and
 * a rule reimplemented at three call sites is a rule that holds at two.
 *
 * The types below are structural rather than the TypeORM entities. Importing
 * `Deal` would drag the ORM into a module whose entire job is four fields, and
 * would make it awkward to run these rules over a row nobody has loaded — a
 * CSV import, or a preview of a bulk move that must not write anything.
 *
 * Two conventions, stated once so they are not re-litigated per function:
 *
 * - **`closedAt` is written once.** A deal that reaches a terminal stage stamps
 *   its close date and keeps it, even when it is later dragged between `won`
 *   and `lost`. Sales-cycle length is measured from that stamp; letting a
 *   re-close overwrite it would silently shorten every cycle it touched, and
 *   nothing downstream could tell that it had happened.
 * - **A closed deal's probability is a fact, not an estimate.** Terminal stages
 *   answer 100 or 0 and ignore whatever number is stored on the row.
 */

export type DealStageKind = "open" | "won" | "lost";

export type DealStatus = "open" | "won" | "lost";

/** The stage fields this module needs. Structurally satisfied by `DealStage`. */
export type StageLike = {
  id: string;
  kind: DealStageKind;
  /** Default close likelihood 0-100. Clamped on read, never trusted. */
  probability: number;
};

/** The deal fields this module needs. Structurally satisfied by `Deal`. */
export type DealLike = {
  stageId: string;
  status: DealStatus;
  closedAt: Date | null;
  probabilityOverride: number | null;
  amountCents: number;
  /** Optional because importers build half a deal before there is a reason. */
  lostReason?: string;
};

/** The patch `applyStageChange` produces — inert data, safe to spread. */
export type StageChange = {
  stageId: string;
  status: DealStatus;
  closedAt: Date | null;
  lostReason: string;
};

const PROBABILITY_MIN = 0;
const PROBABILITY_MAX = 100;

/**
 * The mapping from stage kind to deal status — currently the identity, and
 * named anyway.
 *
 * It is a function so the two vocabularies stay separable: `kind` describes a
 * column on the board, `status` describes a deal. The day somebody wants a
 * fourth kind — a "dormant" column that should still count as open — this is
 * the only line that changes. An inlined `deal.status = stage.kind` cast
 * spreads that assumption across every call site instead, and casts do not
 * show up in a grep for the rule.
 *
 * Throws on an unknown kind. That is a bad enum from a hand-written migration
 * or an `as` cast, not a data condition, and writing a garbage status is
 * precisely the corruption this module exists to prevent.
 */
export function statusForStageKind(kind: DealStageKind): DealStatus {
  switch (kind) {
    case "open":
      return "open";
    case "won":
      return "won";
    case "lost":
      return "lost";
    default:
      throw new Error(`statusForStageKind: unknown stage kind ${String(kind)}`);
  }
}

/**
 * Whether a deal sitting in this kind of stage is finished.
 *
 * Defined through {@link statusForStageKind} rather than `kind !== "open"` so a
 * new kind declares itself terminal in one place, and so an invalid enum throws
 * here too instead of quietly answering "still open" — the answer that would
 * let a corrupt row keep accruing forecast.
 */
export function isTerminal(kind: DealStageKind): boolean {
  return statusForStageKind(kind) !== "open";
}

/**
 * Move `deal` into `stage` and return the fields that must change with it.
 *
 * Returns a patch instead of mutating, because callers want both halves: the
 * route hands it straight to `repo.update`, and a bulk-move preview computes
 * the outcome for fifty deals without touching one of them.
 *
 * The rules, and the reason for each:
 *
 * - Into `won`/`lost`: status follows the kind, and `closedAt` is stamped with
 *   `now` **only if the deal was not already closed**. A rep correcting won →
 *   lost a week later must not restart the sales-cycle clock.
 * - Into `open`: `closedAt` returns to null and `lostReason` is cleared. A
 *   reopened deal still carrying "budget cut" reads as lost everywhere the
 *   reason is shown, and the next loss will have a different cause anyway.
 * - `lost` → `won`: the original `closedAt` survives, the status flips, the
 *   loss reason is dropped. The deal closed when it closed; it just turns out
 *   to have closed the other way.
 *
 * `lostReason` therefore only survives a lost → lost move. Supplying the new
 * reason is the caller's job — this function has no idea why anything was lost,
 * and guessing would be worse than leaving it empty.
 *
 * `now` is a parameter rather than `Date.now()` so the caller owns the clock
 * and the tests are deterministic. It is rejected when invalid even on a move
 * that would not use it: a caller with a broken clock is going to corrupt a
 * close date one move later, and the harmless move is the cheap place to find
 * out. A stored `closedAt` that is itself an Invalid Date is treated as absent
 * instead — that is corrupt data rather than programmer error, and re-stamping
 * it is the only repair available here.
 *
 * Both returned Dates are fresh copies, so the patch is inert: a caller that
 * mutates `now` afterwards cannot reach back into a deal's close date.
 */
export function applyStageChange(deal: DealLike, stage: StageLike, now: Date): StageChange {
  const status = statusForStageKind(stage.kind);
  if (Number.isNaN(now.getTime())) {
    throw new Error("applyStageChange: now must be a valid Date");
  }

  if (status === "open") {
    return { stageId: stage.id, status, closedAt: null, lostReason: "" };
  }

  let closedAtMs = now.getTime();
  if (deal.closedAt !== null && !Number.isNaN(deal.closedAt.getTime())) {
    closedAtMs = deal.closedAt.getTime();
  }

  return {
    stageId: stage.id,
    status,
    closedAt: new Date(closedAtMs),
    lostReason: status === "lost" ? (deal.lostReason ?? "") : "",
  };
}

/**
 * Close likelihood 0-100 for `deal` sitting in `stage`.
 *
 * A terminal stage answers 100 or 0 outright, ignoring both the stage's stored
 * probability and the rep's override. A closed deal's probability is a fact,
 * not an estimate: won money is not "90% likely", and no leftover optimism on
 * the row should keep a lost deal contributing to weighted pipeline. That is
 * the rule which stops closed deals leaking into the forecast, so it sits above
 * the override rather than below it.
 *
 * For open stages the override wins when present — `??`, not `||`, so an
 * explicit 0 ("this one is dead and I have not marked it lost yet") is honoured
 * rather than falling back to the stage default.
 *
 * Out-of-range numbers are clamped, not rejected: a probability of 150 is a bad
 * edit or an old import, not a crash, and clamping is what keeps weighted value
 * inside the deal amount whatever got stored. Fractions survive the clamp —
 * rounding belongs at the money boundary, and doing it here would round twice.
 *
 * Throws only on a non-finite number, which no column can hold and no UI can
 * produce; it means a caller did arithmetic on `undefined` and would otherwise
 * poison every total downstream with NaN.
 */
export function effectiveProbability(deal: DealLike, stage: StageLike): number {
  const status = statusForStageKind(stage.kind);
  if (status === "won") return PROBABILITY_MAX;
  if (status === "lost") return PROBABILITY_MIN;

  const raw = deal.probabilityOverride ?? stage.probability;
  if (!Number.isFinite(raw)) {
    throw new Error("effectiveProbability: probability must be finite");
  }
  return Math.min(PROBABILITY_MAX, Math.max(PROBABILITY_MIN, raw));
}

/**
 * The deal's contribution to weighted pipeline, in integer cents.
 *
 * Rounds half away from zero via {@link roundHalfAway}, the same helper invoice
 * lines use, so a half-cent lands the same direction here as it does on the
 * document the customer eventually receives rather than leaving two totals that
 * are meant to reconcile a cent apart.
 *
 * Negative amounts pass straight through instead of being floored at zero: a
 * clawback or a credit deal is real pipeline movement, and hiding it would make
 * the board total disagree with the sum of the rows above it.
 */
export function weightedValueCents(deal: DealLike, stage: StageLike): number {
  if (!Number.isFinite(deal.amountCents)) {
    throw new Error("weightedValueCents: amountCents must be finite");
  }
  return roundHalfAway((deal.amountCents * effectiveProbability(deal, stage)) / 100);
}
