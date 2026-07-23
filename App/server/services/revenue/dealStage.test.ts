import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyStageChange,
  effectiveProbability,
  isTerminal,
  statusForStageKind,
  weightedValueCents,
  type DealLike,
  type DealStageKind,
  type StageLike,
} from "./dealStage.js";

const KINDS: DealStageKind[] = ["open", "won", "lost"];

/** Two fixed instants — the second is four months after the first. */
const CLOSED_AT = new Date("2026-03-01T10:00:00Z");
const NOW = new Date("2026-07-23T12:00:00Z");

const mkStage = (
  kind: DealStageKind,
  probability = 50,
  id = `stage-${kind}`,
): StageLike => ({ id, kind, probability });

const mkDeal = (over: Partial<DealLike> = {}): DealLike => ({
  stageId: "stage-open",
  status: "open",
  closedAt: null,
  probabilityOverride: null,
  amountCents: 100_000,
  lostReason: "",
  ...over,
});

/** A closed-lost deal, the fixture most of the interesting paths start from. */
const lostDeal = (): DealLike =>
  mkDeal({
    stageId: "stage-lost",
    status: "lost",
    closedAt: CLOSED_AT,
    lostReason: "budget cut",
  });

// ───────────────────────── statusForStageKind ─────────────────────────

describe("statusForStageKind", () => {
  test("maps every kind to the identically named status", () => {
    assert.equal(statusForStageKind("open"), "open");
    assert.equal(statusForStageKind("won"), "won");
    assert.equal(statusForStageKind("lost"), "lost");
  });

  test("throws on an unknown kind rather than writing a garbage status", () => {
    assert.throws(() => statusForStageKind("dormant" as DealStageKind));
    assert.throws(() => statusForStageKind("" as DealStageKind));
    assert.throws(() => statusForStageKind(undefined as unknown as DealStageKind));
  });
});

describe("isTerminal", () => {
  test("won and lost are terminal", () => {
    assert.equal(isTerminal("won"), true);
    assert.equal(isTerminal("lost"), true);
  });

  test("open is not", () => {
    assert.equal(isTerminal("open"), false);
  });

  test("throws on an unknown kind instead of answering 'still open'", () => {
    assert.throws(() => isTerminal("archived" as DealStageKind));
  });
});

// ──────────────── applyStageChange — moving into an open stage ────────────────

describe("applyStageChange into an open stage", () => {
  test("adopts the new stage and stays open", () => {
    const target = mkStage("open", 20, "stage-qualified");
    const change = applyStageChange(mkDeal(), target, NOW);
    assert.deepEqual(change, {
      stageId: "stage-qualified",
      status: "open",
      closedAt: null,
      lostReason: "",
    });
  });

  test("reopening a won deal clears the close date", () => {
    const won = mkDeal({ status: "won", stageId: "stage-won", closedAt: CLOSED_AT });
    const change = applyStageChange(won, mkStage("open"), NOW);
    assert.equal(change.status, "open");
    assert.equal(change.closedAt, null);
  });

  test("reopening a lost deal clears both the close date and the loss reason", () => {
    const change = applyStageChange(lostDeal(), mkStage("open"), NOW);
    assert.equal(change.status, "open");
    assert.equal(change.closedAt, null);
    assert.equal(change.lostReason, "");
  });

  test("ignores `now` entirely — an open deal has no close date to stamp", () => {
    const a = applyStageChange(lostDeal(), mkStage("open"), NOW);
    const b = applyStageChange(lostDeal(), mkStage("open"), new Date("2099-01-01T00:00:00Z"));
    assert.deepEqual(a, b);
  });
});

// ──────────────── applyStageChange — moving into a terminal stage ────────────────

describe("applyStageChange into a terminal stage", () => {
  test("open -> won stamps closedAt with now", () => {
    const change = applyStageChange(mkDeal(), mkStage("won", 100), NOW);
    assert.equal(change.status, "won");
    assert.deepEqual(change.closedAt, NOW);
    assert.equal(change.stageId, "stage-won");
  });

  test("open -> lost stamps closedAt and keeps the reason the caller already set", () => {
    const deal = mkDeal({ lostReason: "went with a competitor" });
    const change = applyStageChange(deal, mkStage("lost", 0), NOW);
    assert.equal(change.status, "lost");
    assert.deepEqual(change.closedAt, NOW);
    assert.equal(change.lostReason, "went with a competitor");
  });

  test("a missing lostReason normalizes to the empty string, never undefined", () => {
    const deal: DealLike = {
      stageId: "stage-open",
      status: "open",
      closedAt: null,
      probabilityOverride: null,
      amountCents: 1_000,
    };
    assert.equal(applyStageChange(deal, mkStage("lost"), NOW).lostReason, "");
    assert.equal(applyStageChange(deal, mkStage("won"), NOW).lostReason, "");
  });

  test("RE-CLOSE: won -> won keeps the original close date", () => {
    const won = mkDeal({ status: "won", stageId: "stage-won", closedAt: CLOSED_AT });
    const change = applyStageChange(won, mkStage("won", 100, "stage-won-2"), NOW);
    assert.deepEqual(change.closedAt, CLOSED_AT);
    assert.equal(change.stageId, "stage-won-2");
  });

  test("RE-CLOSE: lost -> lost keeps both the close date and the reason", () => {
    const change = applyStageChange(lostDeal(), mkStage("lost", 0, "stage-lost-2"), NOW);
    assert.deepEqual(change.closedAt, CLOSED_AT);
    assert.equal(change.lostReason, "budget cut");
  });

  test("LOST -> WON: original closedAt survives, status flips, reason is dropped", () => {
    const change = applyStageChange(lostDeal(), mkStage("won", 100), NOW);
    assert.deepEqual(change, {
      stageId: "stage-won",
      status: "won",
      closedAt: CLOSED_AT,
      lostReason: "",
    });
  });

  test("WON -> LOST: original closedAt survives and the status flips", () => {
    const won = mkDeal({ status: "won", stageId: "stage-won", closedAt: CLOSED_AT });
    const change = applyStageChange(won, mkStage("lost", 0), NOW);
    assert.equal(change.status, "lost");
    assert.deepEqual(change.closedAt, CLOSED_AT);
    assert.equal(change.lostReason, "");
  });

  test("a deal that reopened and re-closed gets a fresh date — the clock really restarted", () => {
    const reopened = applyStageChange(lostDeal(), mkStage("open"), CLOSED_AT);
    const reclosed = applyStageChange({ ...mkDeal(), ...reopened }, mkStage("won"), NOW);
    assert.deepEqual(reclosed.closedAt, NOW);
  });

  test("a corrupt stored closedAt is re-stamped instead of thrown on", () => {
    const broken = mkDeal({ status: "won", closedAt: new Date("not a date") });
    const change = applyStageChange(broken, mkStage("won"), NOW);
    assert.deepEqual(change.closedAt, NOW);
  });

  test("the returned closedAt is a copy, so mutating `now` cannot rewrite it", () => {
    const clock = new Date(NOW.getTime());
    const change = applyStageChange(mkDeal(), mkStage("won"), clock);
    assert.notEqual(change.closedAt, clock);
    clock.setUTCFullYear(2099);
    assert.deepEqual(change.closedAt, NOW);
  });

  test("throws on an invalid `now`, even for a move that would not use it", () => {
    assert.throws(() => applyStageChange(mkDeal(), mkStage("won"), new Date("nope")));
    assert.throws(() => applyStageChange(mkDeal(), mkStage("open"), new Date(Number.NaN)));
  });

  test("throws on an unknown stage kind before touching anything", () => {
    assert.throws(() =>
      applyStageChange(mkDeal(), mkStage("dormant" as DealStageKind), NOW),
    );
  });
});

// ───────────────────────── effectiveProbability ─────────────────────────

describe("effectiveProbability", () => {
  test("falls back to the stage default when there is no override", () => {
    assert.equal(effectiveProbability(mkDeal(), mkStage("open", 35)), 35);
  });

  test("an override beats the stage default", () => {
    assert.equal(
      effectiveProbability(mkDeal({ probabilityOverride: 80 }), mkStage("open", 35)),
      80,
    );
  });

  test("an override of 0 is honoured — `??` not `||`", () => {
    assert.equal(
      effectiveProbability(mkDeal({ probabilityOverride: 0 }), mkStage("open", 35)),
      0,
    );
  });

  test("clamps a negative override to 0", () => {
    assert.equal(
      effectiveProbability(mkDeal({ probabilityOverride: -25 }), mkStage("open", 35)),
      0,
    );
  });

  test("clamps an override above 100 to 100", () => {
    assert.equal(
      effectiveProbability(mkDeal({ probabilityOverride: 150 }), mkStage("open", 35)),
      100,
    );
  });

  test("clamps an out-of-range stage default too — bad data can live on either row", () => {
    assert.equal(effectiveProbability(mkDeal(), mkStage("open", -5)), 0);
    assert.equal(effectiveProbability(mkDeal(), mkStage("open", 400)), 100);
  });

  test("0 and 100 are inside the range, not clamped off it", () => {
    assert.equal(effectiveProbability(mkDeal(), mkStage("open", 0)), 0);
    assert.equal(effectiveProbability(mkDeal(), mkStage("open", 100)), 100);
  });

  test("fractions survive — rounding belongs at the money boundary", () => {
    assert.equal(effectiveProbability(mkDeal(), mkStage("open", 12.5)), 12.5);
  });

  test("a won stage is 100 regardless of what is stored on either row", () => {
    assert.equal(effectiveProbability(mkDeal(), mkStage("won", 10)), 100);
    assert.equal(
      effectiveProbability(mkDeal({ probabilityOverride: 5 }), mkStage("won", 0)),
      100,
    );
  });

  test("a lost stage is 0 regardless of what is stored on either row", () => {
    assert.equal(effectiveProbability(mkDeal(), mkStage("lost", 90)), 0);
    assert.equal(
      effectiveProbability(mkDeal({ probabilityOverride: 95 }), mkStage("lost", 90)),
      0,
    );
  });

  test("throws on a non-finite probability rather than poisoning totals with NaN", () => {
    assert.throws(() => effectiveProbability(mkDeal(), mkStage("open", Number.NaN)));
    assert.throws(() => effectiveProbability(mkDeal(), mkStage("open", Infinity)));
    assert.throws(() =>
      effectiveProbability(mkDeal({ probabilityOverride: Number.NaN }), mkStage("open", 50)),
    );
  });

  test("throws on an unknown stage kind", () => {
    assert.throws(() =>
      effectiveProbability(mkDeal(), mkStage("dormant" as DealStageKind, 50)),
    );
  });
});

// ───────────────────────── weightedValueCents ─────────────────────────

describe("weightedValueCents", () => {
  test("is amount times probability", () => {
    assert.equal(weightedValueCents(mkDeal({ amountCents: 10_000 }), mkStage("open", 25)), 2_500);
  });

  test("rounds half away from zero, matching invoice line rounding", () => {
    // 333 * 50% = 166.5 -> 167
    assert.equal(weightedValueCents(mkDeal({ amountCents: 333 }), mkStage("open", 50)), 167);
    // 333 * 33% = 109.89 -> 110
    assert.equal(weightedValueCents(mkDeal({ amountCents: 333 }), mkStage("open", 33)), 110);
  });

  test("negative amounts round away from zero too, not toward it", () => {
    assert.equal(weightedValueCents(mkDeal({ amountCents: -333 }), mkStage("open", 50)), -167);
  });

  test("a won stage is worth the full amount", () => {
    assert.equal(
      weightedValueCents(mkDeal({ amountCents: 123_456, probabilityOverride: 10 }), mkStage("won", 10)),
      123_456,
    );
  });

  test("a lost stage is worth nothing, however optimistic the row is", () => {
    assert.equal(
      weightedValueCents(mkDeal({ amountCents: 123_456, probabilityOverride: 99 }), mkStage("lost", 99)),
      0,
    );
  });

  test("a zero-amount deal weighs zero at any probability", () => {
    for (const kind of KINDS) {
      assert.equal(weightedValueCents(mkDeal({ amountCents: 0 }), mkStage(kind, 75)), 0);
    }
  });

  test("a zero probability weighs zero at any amount", () => {
    assert.equal(weightedValueCents(mkDeal({ amountCents: 999_999 }), mkStage("open", 0)), 0);
  });

  test("a clamped over-100 probability cannot inflate the deal above its amount", () => {
    assert.equal(
      weightedValueCents(mkDeal({ amountCents: 5_000, probabilityOverride: 500 }), mkStage("open", 10)),
      5_000,
    );
  });

  test("throws on a non-finite amount", () => {
    assert.throws(() => weightedValueCents(mkDeal({ amountCents: Number.NaN }), mkStage("open")));
    assert.throws(() => weightedValueCents(mkDeal({ amountCents: Infinity }), mkStage("open")));
  });
});

// ───────────────────────────── property tests ─────────────────────────────

/** Deterministic LCG so a failure is reproducible. Never Math.random. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe("invariants over seeded pseudo-random deals", () => {
  test("INVARIANT: applyStageChange is idempotent across 500 rounds", () => {
    const rand = lcg(0x51f3a7d);
    const pickKind = () => KINDS[Math.min(KINDS.length - 1, Math.floor(rand() * KINDS.length))];
    const base = Date.UTC(2024, 0, 1);

    for (let round = 0; round < 500; round += 1) {
      const startKind = pickKind();
      const deal = mkDeal({
        stageId: `stage-${round}`,
        status: statusForStageKind(startKind),
        closedAt: isTerminal(startKind) ? new Date(base + Math.floor(rand() * 1e10)) : null,
        probabilityOverride: rand() < 0.5 ? null : Math.floor(rand() * 140) - 20,
        amountCents: Math.floor(rand() * 2_000_000) - 500_000,
        lostReason: startKind === "lost" ? "budget cut" : "",
      });
      const target = mkStage(pickKind(), Math.floor(rand() * 140) - 20, `target-${round}`);

      // A second, strictly later clock: re-applying must not re-stamp anything.
      const first = applyStageChange(deal, target, new Date(base + Math.floor(rand() * 1e10)));
      const second = applyStageChange(
        { ...deal, ...first },
        target,
        new Date(base + 1e11 + Math.floor(rand() * 1e10)),
      );

      assert.deepEqual(second, first, `round ${round}: not idempotent`);
      assert.equal(
        first.status,
        statusForStageKind(target.kind),
        `round ${round}: status stopped mirroring the stage kind`,
      );
      assert.equal(
        first.closedAt === null,
        !isTerminal(target.kind),
        `round ${round}: closedAt disagrees with terminality`,
      );
      assert.ok(
        first.lostReason === "" || first.status === "lost",
        `round ${round}: a loss reason survived onto a non-lost deal`,
      );
    }
  });

  test("INVARIANT: weighted value never escapes the deal amount, across 500 rounds", () => {
    const rand = lcg(0x1d4b2c9);
    const pickKind = () => KINDS[Math.min(KINDS.length - 1, Math.floor(rand() * KINDS.length))];

    for (let round = 0; round < 500; round += 1) {
      const deal = mkDeal({
        probabilityOverride: rand() < 0.5 ? null : Math.floor(rand() * 300) - 100,
        amountCents: Math.floor(rand() * 4_000_000) - 2_000_000,
      });
      const stage = mkStage(pickKind(), Math.floor(rand() * 300) - 100, `s${round}`);

      const p = effectiveProbability(deal, stage);
      assert.ok(p >= 0 && p <= 100, `round ${round}: probability escaped 0..100 (${p})`);

      const weighted = weightedValueCents(deal, stage);
      assert.ok(Number.isInteger(weighted), `round ${round}: weighted value was not an integer`);
      assert.ok(
        Math.abs(weighted) <= Math.abs(deal.amountCents),
        `round ${round}: |weighted| ${weighted} exceeded |amount| ${deal.amountCents}`,
      );
      assert.ok(
        weighted === 0 || Math.sign(weighted) === Math.sign(deal.amountCents),
        `round ${round}: weighted value flipped sign`,
      );
    }
  });
});
