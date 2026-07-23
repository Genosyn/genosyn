import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  computeBlendedCac,
  computeCacByChannel,
  computeLtvCents,
  computeLtvToCac,
  computePaybackMonths,
} from "./cac.js";

const m = (entries: Record<string, number>): ReadonlyMap<string, number> =>
  new Map(Object.entries(entries));

/** Deterministic LCG so a property-test failure is reproducible. */
const lcg = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
};

// ───────────────────────── computeCacByChannel ─────────────────────────

describe("computeCacByChannel", () => {
  test("divides spend by wins for an ordinary channel", () => {
    const rows = computeCacByChannel(m({ google: 300_000 }), m({ google: 4 }));
    assert.deepEqual(rows, [
      { channel: "google", spendCents: 300_000, wonCount: 4, cacCents: 75_000, note: "ok" },
    ]);
  });

  test("rounds half away from zero, matching invoice line rounding", () => {
    // 100/3 = 33.33 -> 33 ; 50/3 = 16.67 -> 17 ; 1/2 = 0.5 -> 1
    assert.equal(computeCacByChannel(m({ a: 100 }), m({ a: 3 }))[0].cacCents, 33);
    assert.equal(computeCacByChannel(m({ a: 50 }), m({ a: 3 }))[0].cacCents, 17);
    assert.equal(computeCacByChannel(m({ a: 1 }), m({ a: 2 }))[0].cacCents, 1);
  });

  test("spend with no wins is null and flagged, never Infinity", () => {
    const rows = computeCacByChannel(m({ billboard: 50_000 }), m({}));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cacCents, null);
    assert.equal(rows[0].note, "no-wins");
    assert.notEqual(rows[0].cacCents, Infinity);
    assert.equal(rows[0].spendCents, 50_000);
    assert.equal(rows[0].wonCount, 0);
  });

  test("an explicit zero win count reads the same as an absent key", () => {
    assert.deepEqual(
      computeCacByChannel(m({ billboard: 50_000 }), m({ billboard: 0 })),
      computeCacByChannel(m({ billboard: 50_000 }), m({})),
    );
  });

  test("wins with no spend are organic, at zero cost", () => {
    const rows = computeCacByChannel(m({}), m({ referral: 7 }));
    assert.deepEqual(rows, [
      { channel: "referral", spendCents: 0, wonCount: 7, cacCents: 0, note: "organic" },
    ]);
  });

  test("a channel with neither spend nor wins is dropped entirely", () => {
    assert.deepEqual(computeCacByChannel(m({ dead: 0 }), m({ dead: 0 })), []);
    assert.deepEqual(computeCacByChannel(m({ dead: 0 }), m({})), []);
  });

  test("takes the union of both key sets", () => {
    const rows = computeCacByChannel(m({ paid: 100 }), m({ organic: 2 }));
    assert.deepEqual(rows.map((r) => r.channel), ["paid", "organic"]);
  });

  test("empty inputs yield an empty array, not a row of zeros", () => {
    assert.deepEqual(computeCacByChannel(new Map(), new Map()), []);
  });

  test("orders by spend descending", () => {
    const rows = computeCacByChannel(
      m({ small: 1_000, big: 900_000, mid: 50_000 }),
      m({ small: 1, big: 3, mid: 2 }),
    );
    assert.deepEqual(rows.map((r) => r.channel), ["big", "mid", "small"]);
  });

  test("breaks spend ties on channel name ascending, by code unit not locale", () => {
    // Uppercase sorts before lowercase — code-unit order, deliberately not
    // localeCompare, so the order cannot shift with the server's ICU version.
    const rows = computeCacByChannel(
      m({ beta: 1_000, alpha: 1_000, Zebra: 1_000 }),
      m({ beta: 1, alpha: 1, Zebra: 1 }),
    );
    assert.deepEqual(rows.map((r) => r.channel), ["Zebra", "alpha", "beta"]);
  });

  test("no-wins rows sort by their spend; organic rows sink to the bottom", () => {
    const rows = computeCacByChannel(
      m({ google: 300_000, meta: 100_000, billboard: 50_000 }),
      m({ google: 4, meta: 5, referral: 3 }),
    );
    assert.deepEqual(rows, [
      { channel: "google", spendCents: 300_000, wonCount: 4, cacCents: 75_000, note: "ok" },
      { channel: "meta", spendCents: 100_000, wonCount: 5, cacCents: 20_000, note: "ok" },
      { channel: "billboard", spendCents: 50_000, wonCount: 0, cacCents: null, note: "no-wins" },
      { channel: "referral", spendCents: 0, wonCount: 3, cacCents: 0, note: "organic" },
    ]);
  });

  test("negative spend reads as absent — a platform credit is not a CAC", () => {
    const rows = computeCacByChannel(m({ refunded: -5_000 }), m({ refunded: 2 }));
    assert.deepEqual(rows, [
      { channel: "refunded", spendCents: 0, wonCount: 2, cacCents: 0, note: "organic" },
    ]);
  });

  test("negative win counts read as absent", () => {
    const rows = computeCacByChannel(m({ a: 500 }), m({ a: -3 }));
    assert.equal(rows[0].wonCount, 0);
    assert.equal(rows[0].note, "no-wins");
  });

  test("non-finite spend and wins read as absent rather than poisoning the row", () => {
    const rows = computeCacByChannel(
      new Map([["nan", Number.NaN], ["inf", Infinity], ["real", 900]]),
      new Map([["nan", 2], ["inf", 2], ["real", 3]]),
    );
    const byChannel = new Map(rows.map((r) => [r.channel, r]));
    assert.equal(byChannel.get("nan")?.note, "organic");
    assert.equal(byChannel.get("inf")?.note, "organic");
    assert.equal(byChannel.get("real")?.cacCents, 300);
  });

  test("a non-finite win count cannot produce a NaN cac", () => {
    const rows = computeCacByChannel(m({ a: 900 }), new Map([["a", Number.NaN]]));
    assert.equal(rows[0].cacCents, null);
    assert.equal(rows[0].note, "no-wins");
  });

  test("fractional win counts survive — multi-touch attribution splits deals", () => {
    const rows = computeCacByChannel(m({ google: 300 }), m({ google: 1.5 }));
    assert.equal(rows[0].wonCount, 1.5);
    assert.equal(rows[0].cacCents, 200);
  });

  test("does not mutate or read back through its inputs", () => {
    const spend = new Map([["a", 100]]);
    const won = new Map([["a", 2]]);
    computeCacByChannel(spend, won);
    assert.deepEqual([...spend], [["a", 100]]);
    assert.deepEqual([...won], [["a", 2]]);
  });
});

// ───────────────────────── computeBlendedCac ─────────────────────────

describe("computeBlendedCac", () => {
  test("is total spend over total wins", () => {
    const blended = computeBlendedCac(
      m({ google: 300_000, meta: 100_000 }),
      m({ google: 4, meta: 5, referral: 3 }),
    );
    assert.equal(blended, 33_333); // 400_000 / 12 = 33_333.33
  });

  test("counts spend from channels that won nothing — that is the point", () => {
    // Per-channel google CAC is 100; blended is dragged up by the dead channel.
    const spend = m({ google: 100, billboard: 300 });
    const won = m({ google: 1 });
    assert.equal(computeCacByChannel(spend, won)[1].cacCents, 100);
    assert.equal(computeBlendedCac(spend, won), 400);
  });

  test("rounds half away from zero", () => {
    assert.equal(computeBlendedCac(m({ a: 1 }), m({ a: 2 })), 1);
    assert.equal(computeBlendedCac(m({ a: 100 }), m({ a: 3 })), 33);
  });

  test("is null when nothing was won anywhere", () => {
    assert.equal(computeBlendedCac(m({ a: 10_000 }), m({})), null);
    assert.equal(computeBlendedCac(m({ a: 10_000 }), m({ a: 0 })), null);
    assert.equal(computeBlendedCac(m({ a: 10_000 }), m({ a: -4 })), null);
  });

  test("is null on empty inputs, not zero", () => {
    assert.equal(computeBlendedCac(new Map(), new Map()), null);
  });

  test("is zero when customers arrived with no spend at all", () => {
    assert.equal(computeBlendedCac(new Map(), m({ referral: 9 })), 0);
    assert.equal(computeBlendedCac(m({ referral: 0 }), m({ referral: 9 })), 0);
  });

  test("ignores negative and non-finite entries on both sides", () => {
    const spend = new Map([["a", 100], ["credit", -1_000], ["junk", Number.NaN]]);
    const won = new Map([["a", 2], ["bad", -5], ["junk", Infinity]]);
    assert.equal(computeBlendedCac(spend, won), 50);
  });
});

// ─────────────────────────── computeLtvCents ───────────────────────────

describe("computeLtvCents", () => {
  test("is ARPA times margin over churn", () => {
    // $100/mo, 80% margin, 5% monthly churn -> 20-month lifetime -> $1,600.
    assert.equal(computeLtvCents(10_000, 80, 5), 160_000);
  });

  test("a 100% margin is the whole ARPA over the lifetime", () => {
    assert.equal(computeLtvCents(5_000, 100, 10), 50_000);
  });

  test("a zero margin is a zero LTV, not a null — zero is inside the range", () => {
    assert.equal(computeLtvCents(10_000, 0, 5), 0);
  });

  test("is null when the margin is outside 0..100", () => {
    assert.equal(computeLtvCents(10_000, -1, 5), null);
    assert.equal(computeLtvCents(10_000, 100.1, 5), null);
    // The classic unit error: 0.8 passed where 80 was meant is in range and
    // therefore NOT null — it just yields a small LTV. Documented, not caught.
    assert.equal(computeLtvCents(10_000, 0.8, 5), 1_600);
  });

  test("is null when churn is zero — infinite lifetime is not a board number", () => {
    assert.equal(computeLtvCents(10_000, 80, 0), null);
  });

  test("is null when churn is negative", () => {
    assert.equal(computeLtvCents(10_000, 80, -5), null);
  });

  test("accepts churn above 100% — a lifetime shorter than a month is real", () => {
    assert.equal(computeLtvCents(10_000, 100, 200), 5_000);
  });

  test("rounds half away from zero in both directions", () => {
    assert.equal(computeLtvCents(100, 50, 3), 1_667); // 1666.67
    assert.equal(computeLtvCents(1, 50, 100), 1); // exactly 0.5 -> 1
    assert.equal(computeLtvCents(-1, 50, 100), -1); // exactly -0.5 -> -1
  });

  test("a negative ARPA passes through to a negative LTV", () => {
    assert.equal(computeLtvCents(-10_000, 80, 5), -160_000);
  });

  test("throws on non-finite input — that is programmer error, not data", () => {
    assert.throws(() => computeLtvCents(Number.NaN, 80, 5));
    assert.throws(() => computeLtvCents(10_000, Infinity, 5));
    assert.throws(() => computeLtvCents(10_000, 80, Number.NaN));
    assert.throws(() => computeLtvCents(10_000, 80, -Infinity));
  });
});

// ─────────────────────────── computeLtvToCac ───────────────────────────

describe("computeLtvToCac", () => {
  test("is the multiple everybody quotes", () => {
    assert.equal(computeLtvToCac(160_000, 50_000), 3.2);
  });

  test("rounds to one decimal", () => {
    assert.equal(computeLtvToCac(100, 30), 3.3); // 3.333…
    assert.equal(computeLtvToCac(200, 30), 6.7); // 6.666…
  });

  test("propagates a null from either input", () => {
    assert.equal(computeLtvToCac(null, 50_000), null);
    assert.equal(computeLtvToCac(160_000, null), null);
    assert.equal(computeLtvToCac(null, null), null);
  });

  test("is null when CAC is zero or negative rather than a runaway multiple", () => {
    assert.equal(computeLtvToCac(160_000, 0), null);
    assert.equal(computeLtvToCac(160_000, -100), null);
  });

  test("a zero LTV against a real CAC is zero, not null", () => {
    assert.equal(computeLtvToCac(0, 50_000), 0);
  });

  test("a negative LTV yields a negative ratio", () => {
    assert.equal(computeLtvToCac(-100_000, 50_000), -2);
  });

  test("throws on non-finite input", () => {
    assert.throws(() => computeLtvToCac(Number.NaN, 50_000));
    assert.throws(() => computeLtvToCac(160_000, Infinity));
  });

  test("chains straight off computeLtvCents and computeCacByChannel", () => {
    const ltv = computeLtvCents(10_000, 80, 5);
    const rows = computeCacByChannel(m({ google: 300_000 }), m({ google: 4 }));
    assert.equal(computeLtvToCac(ltv, rows[0].cacCents), 2.1); // 160_000/75_000
    const dead = computeCacByChannel(m({ billboard: 50_000 }), m({}));
    assert.equal(computeLtvToCac(ltv, dead[0].cacCents), null);
  });
});

// ───────────────────────── computePaybackMonths ─────────────────────────

describe("computePaybackMonths", () => {
  test("is CAC over monthly gross profit", () => {
    assert.equal(computePaybackMonths(60_000, 10_000), 6);
  });

  test("rounds to one decimal", () => {
    assert.equal(computePaybackMonths(100, 30), 3.3);
    assert.equal(computePaybackMonths(50, 30), 1.7);
  });

  test("is null when the customer is unprofitable — never is not a month count", () => {
    assert.equal(computePaybackMonths(60_000, 0), null);
    assert.equal(computePaybackMonths(60_000, -1), null);
  });

  test("a zero CAC pays back immediately", () => {
    assert.equal(computePaybackMonths(0, 10_000), 0);
  });

  test("throws on non-finite input", () => {
    assert.throws(() => computePaybackMonths(Number.NaN, 10_000));
    assert.throws(() => computePaybackMonths(60_000, Infinity));
  });
});

// ──────────────────────────── property tests ────────────────────────────

describe("invariants", () => {
  test("INVARIANT: blended CAC sits between the min and max channel CAC when every channel has wins", () => {
    const rand = lcg(0x51f3a7d);

    for (let round = 0; round < 500; round += 1) {
      const channelCount = 1 + Math.floor(rand() * 7);
      const spend = new Map<string, number>();
      const won = new Map<string, number>();
      for (let i = 0; i < channelCount; i += 1) {
        const channel = `ch${i}`;
        // Occasionally zero spend (organic) — still a channel with wins.
        spend.set(channel, rand() < 0.15 ? 0 : Math.floor(rand() * 500_000));
        won.set(channel, 1 + Math.floor(rand() * 40));
      }

      const rows = computeCacByChannel(spend, won);
      assert.equal(rows.length, channelCount, `round ${round}: a channel went missing`);

      const cacs: number[] = [];
      for (const row of rows) {
        assert.notEqual(row.note, "no-wins", `round ${round}: every channel had wins`);
        assert.notEqual(row.cacCents, null, `round ${round}: unexpected null cac`);
        if (row.cacCents !== null) cacs.push(row.cacCents);
      }

      const blended = computeBlendedCac(spend, won);
      assert.notEqual(blended, null, `round ${round}: wins exist, blended must not be null`);
      if (blended === null) continue;

      // Blended is a wins-weighted mean of the per-channel CACs, and
      // roundHalfAway is monotonic, so rounding cannot push it outside.
      assert.ok(
        blended >= Math.min(...cacs) && blended <= Math.max(...cacs),
        `round ${round}: blended ${blended} outside [${Math.min(...cacs)}, ${Math.max(...cacs)}]`,
      );
    }
  });

  test("INVARIANT: rows are sorted, finite, flagged consistently, and never Infinity", () => {
    const rand = lcg(0x2b7c19e);
    const pick = () => {
      const r = rand();
      if (r < 0.2) return 0;
      if (r < 0.3) return -Math.floor(rand() * 1_000);
      if (r < 0.35) return Number.NaN;
      return Math.floor(rand() * 200_000);
    };

    for (let round = 0; round < 500; round += 1) {
      const ids = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => `ch${i}`);
      const spend = new Map(ids.map((id) => [id, pick()]));
      const won = new Map(ids.map((id) => [id, Math.floor(pick() / 1_000)]));
      if (rand() < 0.5) spend.set("spend-only", pick());
      if (rand() < 0.5) won.set("wins-only", Math.floor(pick() / 1_000));

      const rows = computeCacByChannel(spend, won);

      for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1];
        const curr = rows[i];
        assert.ok(prev.spendCents >= curr.spendCents, `round ${round}: spend out of order`);
        if (prev.spendCents === curr.spendCents) {
          assert.ok(prev.channel < curr.channel, `round ${round}: tie not broken by name`);
        }
      }

      for (const row of rows) {
        assert.ok(row.spendCents >= 0 && Number.isFinite(row.spendCents));
        assert.ok(row.wonCount >= 0 && Number.isFinite(row.wonCount));
        assert.ok(
          row.spendCents > 0 || row.wonCount > 0,
          `round ${round}: an all-zero row survived`,
        );
        assert.equal(
          row.cacCents === null,
          row.note === "no-wins",
          `round ${round}: null cac and note disagree`,
        );
        if (row.cacCents !== null) {
          assert.ok(Number.isFinite(row.cacCents), `round ${round}: cac ${row.cacCents} not finite`);
          assert.ok(Number.isInteger(row.cacCents), `round ${round}: cac ${row.cacCents} not cents`);
        }
        assert.equal(row.note === "organic", row.spendCents === 0 && row.wonCount > 0);
      }
    }
  });

  test("INVARIANT: payback and LTV/CAC agree on sign and nullity", () => {
    const rand = lcg(0x7d21c05);

    for (let round = 0; round < 300; round += 1) {
      const arpa = Math.floor(rand() * 50_000);
      const margin = Math.floor(rand() * 101);
      const churn = Math.floor(rand() * 20) - 2; // sweeps through 0 and negatives
      const cac = Math.floor(rand() * 100_000) - 10_000; // sweeps through 0

      const ltv = computeLtvCents(arpa, margin, churn);
      assert.equal(ltv === null, churn <= 0, `round ${round}: LTV nullity tracks churn`);

      const ratio = computeLtvToCac(ltv, cac);
      assert.equal(ratio === null, ltv === null || cac <= 0, `round ${round}: ratio nullity`);
      if (ratio !== null) assert.ok(Number.isFinite(ratio));

      const monthlyProfit = Math.round((arpa * margin) / 100);
      const payback = computePaybackMonths(cac, monthlyProfit);
      assert.equal(payback === null, monthlyProfit <= 0, `round ${round}: payback nullity`);
      if (payback !== null) {
        assert.ok(Number.isFinite(payback));
        assert.equal(payback, Math.round(payback * 10) / 10, `round ${round}: not one decimal`);
      }
    }
  });
});
