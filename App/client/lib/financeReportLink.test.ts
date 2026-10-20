import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { financeReportHref, parseFinanceReportLink } from "../../shared/financeReportLink.js";

describe("a link to Finance → Reports", () => {
  test("opens the report it was written for, on its dates", () => {
    const href = financeReportHref("income", "2026-09-01", "2026-09-30");
    assert.equal(href, "/finance/reports?report=income&from=2026-09-01&to=2026-09-30");
    assert.deepEqual(parseFinanceReportLink(href.slice(href.indexOf("?") + 1)), {
      report: "income",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    assert.deepEqual(
      parseFinanceReportLink(new URLSearchParams("report=cashflow&from=2026-02-01&to=2026-02-28")),
      { report: "cashflow", from: "2026-02-01", to: "2026-02-28" },
    );
  });

  test("asks for nothing when the link is incomplete or invalid", () => {
    for (const search of [
      "",
      "report=income",
      "report=ledger&from=2026-09-01&to=2026-09-30",
      "report=income&from=2026-9-1&to=2026-09-30",
      "report=income&from=2026-02-30&to=2026-03-01",
      "report=income&from=2026-10-01&to=2026-09-30",
      "report=income&from=2026-09-01T00:00:00Z&to=2026-09-30",
    ]) {
      assert.equal(parseFinanceReportLink(search), null, search);
    }
  });
});
