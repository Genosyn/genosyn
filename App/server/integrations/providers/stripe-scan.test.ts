import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readAllStripePages } from "./stripe-scan.js";

describe("Stripe complete internal scans", () => {
  test("continues past 100 rows and reports the complete cursor chain", async () => {
    const cursors: Array<string | undefined> = [];
    const result = await readAllStripePages<{ id: string }>(async (startingAfter) => {
      cursors.push(startingAfter);
      return startingAfter
        ? { data: [{ id: "last" }], has_more: false, nextStartingAfter: null }
        : { data: Array.from({ length: 100 }, (_, i) => ({ id: `row_${i}` })), has_more: true, nextStartingAfter: "row_99" };
    });
    assert.equal(result.data.length, 101);
    assert.deepEqual(cursors, [undefined, "row_99"]);
    assert.deepEqual(result.coverage, { complete: true, pages: 2, rows: 101 });
  });

  test("refuses partial scans at the bound and repeated or missing continuations", async () => {
    let call = 0;
    await assert.rejects(readAllStripePages(async () => {
      const id = String(++call);
      return { data: [{ id }], has_more: true, nextStartingAfter: id };
    }, 2), /2-page safety bound.*partial coverage/);
    await assert.rejects(readAllStripePages(async () => ({ data: [{ id: "same" }], has_more: true, nextStartingAfter: "same" })), /repeated row/);
    await assert.rejects(readAllStripePages(async () => ({ data: [{ id: "1" }], has_more: true })), /valid advancing cursor/);
    await assert.rejects(readAllStripePages(async () => ({ data: [] })), /has_more coverage/);
  });
});
