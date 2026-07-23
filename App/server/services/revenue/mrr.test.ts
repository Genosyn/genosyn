import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  arrCents,
  computeMrrMovement,
  computeRetention,
  monthKey,
  monthRange,
  normalizeToMonthlyCents,
  sumSnapshot,
  type RevenueSnapshot,
} from "./mrr.js";

const snap = (entries: Record<string, number>): RevenueSnapshot =>
  new Map(Object.entries(entries));

// ───────────────────── normalizeToMonthlyCents ─────────────────────

describe("normalizeToMonthlyCents", () => {
  test("a monthly plan is already monthly", () => {
    assert.equal(normalizeToMonthlyCents(10_000, "month"), 10_000);
  });

  test("a yearly plan divides by twelve", () => {
    assert.equal(normalizeToMonthlyCents(120_000, "year"), 10_000);
  });

  test("a quarterly plan divides by three, expressed either way", () => {
    assert.equal(normalizeToMonthlyCents(30_000, "quarter"), 10_000);
    assert.equal(normalizeToMonthlyCents(30_000, "month", 3), 10_000);
  });

  test("intervalCount multiplies the period", () => {
    assert.equal(normalizeToMonthlyCents(240_000, "year", 2), 10_000); // biennial
    assert.equal(normalizeToMonthlyCents(20_000, "month", 2), 10_000);
  });

  test("weekly and daily use a 365-day year", () => {
    // 365/12 = 30.4166… days per month; 7-day weeks -> 4.3452 weeks/month.
    assert.equal(normalizeToMonthlyCents(1_000, "week"), 4_345);
    assert.equal(normalizeToMonthlyCents(100, "day"), 3_042);
  });

  test("a yearly plan and its monthly twelfth agree exactly", () => {
    // The reason DAYS_PER_YEAR is 365 and not 365.25.
    assert.equal(normalizeToMonthlyCents(120_000, "year"), normalizeToMonthlyCents(10_000, "month"));
  });

  test("rounds half away from zero, matching invoice line rounding", () => {
    // 100 / 3 = 33.33 -> 33 ; 50/3 = 16.67 -> 17
    assert.equal(normalizeToMonthlyCents(100, "quarter"), 33);
    assert.equal(normalizeToMonthlyCents(50, "quarter"), 17);
    // Negative amounts (credits) round away from zero too, not toward it.
    assert.equal(normalizeToMonthlyCents(-50, "quarter"), -17);
  });

  test("passes negative amounts through — a credit is real revenue movement", () => {
    assert.equal(normalizeToMonthlyCents(-120_000, "year"), -10_000);
  });

  test("zero stays zero for every interval", () => {
    for (const i of ["day", "week", "month", "quarter", "year"] as const) {
      assert.equal(normalizeToMonthlyCents(0, i), 0);
    }
  });

  test("throws loudly on nonsense rather than returning a wrong MRR", () => {
    assert.throws(() => normalizeToMonthlyCents(Number.NaN, "month"));
    assert.throws(() => normalizeToMonthlyCents(Infinity, "month"));
    assert.throws(() => normalizeToMonthlyCents(100, "month", 0));
    assert.throws(() => normalizeToMonthlyCents(100, "month", -1));
    assert.throws(() => normalizeToMonthlyCents(100, "fortnight" as "month"));
  });
});

describe("arrCents", () => {
  test("is twelve months of MRR", () => {
    assert.equal(arrCents(10_000), 120_000);
    assert.equal(arrCents(0), 0);
    assert.equal(arrCents(-500), -6_000);
  });
});

// ───────────────────────── sumSnapshot ─────────────────────────

describe("sumSnapshot", () => {
  test("adds active entries", () => {
    assert.equal(sumSnapshot(snap({ a: 100, b: 250 })), 350);
  });

  test("ignores zero, negative, and non-finite entries", () => {
    const s = new Map<string, number>([
      ["a", 100],
      ["zero", 0],
      ["neg", -50],
      ["nan", Number.NaN],
      ["inf", Infinity],
    ]);
    assert.equal(sumSnapshot(s), 100);
  });

  test("an empty snapshot sums to zero", () => {
    assert.equal(sumSnapshot(new Map()), 0);
  });
});

// ──────────────────────── computeMrrMovement ────────────────────────

describe("computeMrrMovement", () => {
  test("classifies all five movements in one pass", () => {
    const prev = snap({ keep: 1_000, grow: 1_000, shrink: 1_000, leave: 1_000 });
    const curr = snap({ keep: 1_000, grow: 1_500, shrink: 400, fresh: 700 });

    const m = computeMrrMovement(prev, curr);
    assert.equal(m.newCents, 700);
    assert.equal(m.expansionCents, 500);
    assert.equal(m.contractionCents, 600);
    assert.equal(m.churnCents, 1_000);
    assert.equal(m.reactivationCents, 0);
    assert.equal(m.startingCents, 4_000);
    assert.equal(m.endingCents, 3_600);
    assert.equal(m.netCents, -400);
    assert.deepEqual(m.counts, {
      new: 1,
      expanded: 1,
      reactivated: 0,
      contracted: 1,
      churned: 1,
      retained: 3,
    });
  });

  test("separates reactivation from new business when given history", () => {
    const prev = snap({ a: 1_000 });
    const curr = snap({ a: 1_000, returning: 500, brandNew: 300 });
    const m = computeMrrMovement(prev, curr, new Set(["returning"]));
    assert.equal(m.reactivationCents, 500);
    assert.equal(m.newCents, 300);
    assert.equal(m.counts.reactivated, 1);
    assert.equal(m.counts.new, 1);
  });

  test("without history, a returning customer folds into new — stated behaviour", () => {
    const m = computeMrrMovement(snap({}), snap({ returning: 500 }));
    assert.equal(m.newCents, 500);
    assert.equal(m.reactivationCents, 0);
  });

  test("a customer present in `previous` is never counted as a reactivation", () => {
    // They are in everBefore by definition; the branch must not fire for them.
    const m = computeMrrMovement(
      snap({ a: 1_000 }),
      snap({ a: 1_200 }),
      new Set(["a"]),
    );
    assert.equal(m.reactivationCents, 0);
    assert.equal(m.expansionCents, 200);
  });

  test("zero in the current snapshot is churn, not flat retention", () => {
    const m = computeMrrMovement(snap({ a: 900 }), snap({ a: 0 }));
    assert.equal(m.churnCents, 900);
    assert.equal(m.counts.churned, 1);
    assert.equal(m.counts.retained, 0);
    assert.equal(m.endingCents, 0);
  });

  test("zero in the previous snapshot is new business, not expansion", () => {
    const m = computeMrrMovement(snap({ a: 0 }), snap({ a: 900 }));
    assert.equal(m.newCents, 900);
    assert.equal(m.expansionCents, 0);
  });

  test("a customer at zero in both months is invisible", () => {
    const m = computeMrrMovement(snap({ ghost: 0 }), snap({ ghost: 0 }));
    assert.equal(m.netCents, 0);
    assert.deepEqual(m.counts, {
      new: 0, expanded: 0, reactivated: 0, contracted: 0, churned: 0, retained: 0,
    });
  });

  test("flat months produce no movement at all", () => {
    const s = snap({ a: 100, b: 200 });
    const m = computeMrrMovement(s, s);
    assert.equal(m.netCents, 0);
    assert.equal(m.counts.retained, 2);
    assert.equal(m.counts.expanded, 0);
    assert.equal(m.counts.contracted, 0);
  });

  test("empty months are all zeros, not NaN", () => {
    const m = computeMrrMovement(new Map(), new Map());
    for (const v of [
      m.startingCents, m.endingCents, m.netCents, m.newCents,
      m.expansionCents, m.contractionCents, m.churnCents, m.reactivationCents,
    ]) {
      assert.equal(v, 0);
    }
  });

  test("the first month ever is entirely new business", () => {
    const m = computeMrrMovement(new Map(), snap({ a: 100, b: 200 }));
    assert.equal(m.newCents, 300);
    assert.equal(m.netCents, 300);
    assert.equal(m.startingCents, 0);
  });

  test("losing every customer churns the whole book", () => {
    const m = computeMrrMovement(snap({ a: 100, b: 200 }), new Map());
    assert.equal(m.churnCents, 300);
    assert.equal(m.netCents, -300);
    assert.equal(m.endingCents, 0);
  });

  // ── The two invariants that make the waterfall chart add up ──

  test("INVARIANT: ending - starting === net, on a hand-built case", () => {
    const m = computeMrrMovement(
      snap({ a: 1_000, b: 2_000, c: 3_000 }),
      snap({ a: 1_500, c: 2_000, d: 4_000 }),
    );
    assert.equal(m.endingCents - m.startingCents, m.netCents);
  });

  test("INVARIANT: both identities hold across 500 pseudo-random snapshots", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = () => {
      const r = rand();
      if (r < 0.2) return 0;                    // absent
      if (r < 0.3) return -Math.floor(rand() * 500); // credit / negative
      return Math.floor(rand() * 10_000);
    };

    for (let round = 0; round < 500; round += 1) {
      const ids = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => `c${i}`);
      const prev = new Map(ids.map((id) => [id, pick()]));
      const curr = new Map(ids.map((id) => [id, pick()]));
      // Occasionally introduce a customer only present in one side.
      if (rand() < 0.5) curr.set("only-now", pick());
      if (rand() < 0.5) prev.set("only-then", pick());

      const everBefore = new Set(rand() < 0.5 ? ["only-now"] : []);
      const m = computeMrrMovement(prev, curr, everBefore);

      assert.equal(
        m.endingCents - m.startingCents,
        m.netCents,
        `round ${round}: ending-starting !== net`,
      );
      assert.equal(
        m.newCents + m.expansionCents + m.reactivationCents - m.contractionCents - m.churnCents,
        m.netCents,
        `round ${round}: components !== net`,
      );
      for (const v of [
        m.newCents, m.expansionCents, m.reactivationCents,
        m.contractionCents, m.churnCents,
      ]) {
        assert.ok(v >= 0, `round ${round}: component went negative (${v})`);
      }
    }
  });
});

// ────────────────────────── computeRetention ──────────────────────────

describe("computeRetention", () => {
  test("NRR exceeds 100% when expansion outweighs churn; GRR cannot", () => {
    const cohort = snap({ a: 1_000, b: 1_000, c: 1_000 });
    const later = snap({ a: 2_000, b: 1_000, c: 0 });
    const r = computeRetention(cohort, later);
    assert.equal(r.startingCents, 3_000);
    assert.equal(r.endingCents, 3_000);
    assert.equal(r.retainedCents, 2_000); // min(1000,2000) + min(1000,1000) + 0
    assert.equal(r.nrrPct, 100);
    assert.equal(r.grrPct, 66.7);
    assert.equal(r.churnedCount, 1);
    assert.equal(r.cohortSize, 3);
  });

  test("GRR is capped per customer, so one big expansion cannot mask churn", () => {
    const r = computeRetention(snap({ a: 100, b: 100 }), snap({ a: 10_000, b: 0 }));
    assert.equal(r.nrrPct, 5_000);
    assert.equal(r.grrPct, 50);
  });

  test("perfect retention is 100/100", () => {
    const s = snap({ a: 500, b: 500 });
    const r = computeRetention(s, s);
    assert.equal(r.nrrPct, 100);
    assert.equal(r.grrPct, 100);
    assert.equal(r.churnedCount, 0);
  });

  test("total churn is 0/0", () => {
    const r = computeRetention(snap({ a: 500 }), new Map());
    assert.equal(r.nrrPct, 0);
    assert.equal(r.grrPct, 0);
    assert.equal(r.churnedCount, 1);
  });

  test("customers outside the cohort are ignored — that is somebody else's new business", () => {
    const r = computeRetention(snap({ a: 1_000 }), snap({ a: 1_000, stranger: 9_999 }));
    assert.equal(r.endingCents, 1_000);
    assert.equal(r.nrrPct, 100);
    assert.equal(r.cohortSize, 1);
  });

  test("an empty cohort yields nulls, never a divide-by-zero", () => {
    const r = computeRetention(new Map(), snap({ a: 100 }));
    assert.equal(r.nrrPct, null);
    assert.equal(r.grrPct, null);
    assert.equal(r.cohortSize, 0);
  });

  test("a cohort of only zero-value rows is treated as empty", () => {
    const r = computeRetention(snap({ a: 0, b: -5 }), snap({ a: 100 }));
    assert.equal(r.cohortSize, 0);
    assert.equal(r.nrrPct, null);
  });

  test("percentages are rounded to one decimal", () => {
    const r = computeRetention(snap({ a: 3_000 }), snap({ a: 1_000 }));
    assert.equal(r.grrPct, 33.3);
  });
});

// ─────────────────────── monthKey / monthRange ───────────────────────

describe("monthKey", () => {
  test("formats as YYYY-MM, zero padded, in UTC", () => {
    assert.equal(monthKey(new Date("2026-07-23T12:00:00Z")), "2026-07");
    assert.equal(monthKey(new Date("2026-01-01T00:00:00Z")), "2026-01");
    assert.equal(monthKey(new Date("2026-12-31T23:59:59Z")), "2026-12");
  });

  test("uses UTC, so a local-midnight instant does not slide a month", () => {
    // 2026-08-01T00:30 in UTC+02:00 is still July 31 UTC.
    assert.equal(monthKey(new Date("2026-07-31T22:30:00Z")), "2026-07");
  });
});

describe("monthRange", () => {
  test("is inclusive at both ends, oldest first", () => {
    assert.deepEqual(
      monthRange(new Date("2026-05-15T00:00:00Z"), new Date("2026-08-02T00:00:00Z")),
      ["2026-05", "2026-06", "2026-07", "2026-08"],
    );
  });

  test("a single month yields one key", () => {
    assert.deepEqual(
      monthRange(new Date("2026-07-01T00:00:00Z"), new Date("2026-07-31T00:00:00Z")),
      ["2026-07"],
    );
  });

  test("crosses a year boundary", () => {
    assert.deepEqual(
      monthRange(new Date("2025-11-10T00:00:00Z"), new Date("2026-02-01T00:00:00Z")),
      ["2025-11", "2025-12", "2026-01", "2026-02"],
    );
  });

  test("an inverted range yields nothing rather than looping forever", () => {
    assert.deepEqual(
      monthRange(new Date("2026-08-01T00:00:00Z"), new Date("2026-05-01T00:00:00Z")),
      [],
    );
  });

  test("does not skip a month when the start day is the 31st", () => {
    // Naive `setMonth` arithmetic on Jan 31 lands on Mar 3; anchoring to the
    // first of the month is what stops February vanishing.
    assert.deepEqual(
      monthRange(new Date("2026-01-31T00:00:00Z"), new Date("2026-04-01T00:00:00Z")),
      ["2026-01", "2026-02", "2026-03", "2026-04"],
    );
  });
});
