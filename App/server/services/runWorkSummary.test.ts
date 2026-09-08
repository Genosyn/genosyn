import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunStatus } from "../db/entities/Run.js";
import { DurableRunLog } from "./runLog.js";
import {
  conciseWorkSummary,
  RUN_WORK_SUMMARY_MAX_CHARS,
  runWorkSummary,
  workSummaryLogLine,
} from "./runWorkSummary.js";

const summary = (
  logContent: string,
  outcomeNote: string | null = null,
  status: RunStatus = "completed",
) => runWorkSummary({ logContent, outcomeNote, status });
const header =
  "[2026-09-08T08:00:00.000Z] run started\nroutine=Outreach (outreach)\nemployee=Jamie (jamie)\ncompany=Acme (acme)\nmodel=openai/example\ncron=0 8 * * *\ntrigger=schedule\nmissed=1\n";

describe("Routine work report extraction", () => {
  test("prefers the known final report over concatenated subscription commentary", () => {
    assert.equal(
      summary(
        "I am nearly finished.I checked everything." +
          workSummaryLogLine("Saved 6 Contacts. Drafted 4 outreach messages."),
      ),
      "Saved 6 Contacts. Drafted 4 outreach messages.",
    );
  });
  test("the latest persisted summary replaces the initial outcome after remediation", () => {
    assert.equal(
      summary(
        workSummaryLogLine("Saved the draft.") +
          "\n[checks] remediation 1 of 2" +
          workSummaryLogLine("Corrected the totals and saved the report.") +
          "\n[checks] 1/1 passed",
      ),
      "Corrected the totals and saved the report.",
    );
  });
  test("starting remediation invalidates an earlier claim if no new report returns", () => {
    assert.equal(
      summary(
        workSummaryLogLine("All invoice totals are correct.") +
          "\n[checks] remediation 1 of 2" +
          workSummaryLogLine("") +
          "\n[tool] edit {}\n[tool:edit] error — denied\n[checks] remediation turn failed",
      ),
      null,
    );
  });
  for (const record of ["null", "42", '"truncated', '{"text":"claimed success"}']) {
    test(`an empty or malformed summary record does not revive preceding commentary: ${record}`, () => {
      assert.equal(summary("I will send everything.\n[work-summary] " + record), null);
    });
  }
  test("summary persistence is bounded, redacted, and on one line", () => {
    const line = workSummaryLogLine(
      "**Password:** hidden-secret\nSaved 5 Contacts.\n" + "details ".repeat(1000),
    );
    assert.doesNotMatch(line, /hidden-secret/);
    assert.equal(line.trim().split("\n").length, 1);
    assert.ok(line.length < RUN_WORK_SUMMARY_MAX_CHARS + 40);
  });
  test("the screenshot's eight Connection calls yield the business result", () => {
    const tools = Array.from(
      { length: 8 },
      () =>
        '[tool] connection_call {"action":"list_issues"}\n[tool:connection_call] ok — {"issues":[]}',
    ).join("\n");
    assert.equal(
      summary(
        header +
          "I'll check GitHub.\n" +
          tools +
          "\nAdded 6 qualified Contacts and drafted outreach for 4. Two need a Member's review.\n[tokens] in=500 out=80",
      ),
      "Added 6 qualified Contacts and drafted outreach for 4. Two need a Member's review.",
    );
  });

  test("handles usage written immediately after the final streamed token", () => {
    assert.equal(summary(header + "Sent 3 invoices.[tokens] in=400 out=20\n"), "Sent 3 invoices.");
  });

  test("reads a report without tool activity or runner framing", () => {
    assert.equal(
      summary("Reviewed the inbox. No new messages needed a reply."),
      "Reviewed the inbox. No new messages needed a reply.",
    );
  });

  test("chooses final prose after multiple plans, calls, and results", () => {
    assert.equal(
      summary(
        "I will check first.[tokens] in=1 out=1\n[tool] read {}\n[tool:read] ok — results\nNext I will update it.\n[tool] write {}\n[tool:write] ok\nUpdated the customer brief.",
      ),
      "Updated the customer brief.",
    );
  });

  for (const ending of [
    "[tool] send {}",
    "[tool:send] ok — Sent everything.",
    "[tool:send] error — Permission denied.",
    "[compact] history condensed",
    "[model] retrying",
    "[repos] synced org/repo",
    "[repositories] synced policies",
    "[tools] 20 loaded",
  ]) {
    test(`does not promote the plan or diagnostics when the Run ends on ${ending}`, () => {
      assert.equal(summary(header + "I will send the updates.\n" + ending), null);
    });
  }

  test("ignores trailing Checks, retry, usage, and warning diagnostics", () => {
    assert.equal(
      summary(
        "Drafted the board report.\n[checks] 2/2 passed.\n[tokens] in=1 out=1\n[retry] next attempt queued\n[warn] checkpoint delayed",
      ),
      "Drafted the board report.",
    );
  });

  test("prefers the final remediation report", () => {
    assert.equal(
      summary(
        "Drafted the report.\n[checks] 0/1 passed\n[checks] remediation 1 of 2\n[tool] edit {}\n[tool:edit] ok\nCorrected the missing revenue total and saved the report.\n[checks] 1/1 passed",
      ),
      "Corrected the missing revenue total and saved the report.",
    );
  });

  test("a remediation ending with tools does not resurrect an earlier report", () => {
    assert.equal(
      summary(
        "Finished the report.\n[checks] remediation 1 of 2\n[tool] edit {}\n[tool:edit] error — denied\n[checks] remediation turn failed",
      ),
      null,
    );
  });

  test("uses the recorded assessment only when the final report is absent", () => {
    assert.equal(
      summary(header, "The daily report was saved, but outreach was not sent."),
      "The daily report was saved, but outreach was not sent.",
    );
    assert.equal(summary("Saved 4 Contacts.", "The criteria were achieved."), "Saved 4 Contacts.");
  });

  for (const status of ["running", "failed", "timeout", "interrupted", "skipped"] as const) {
    test(`${status} cannot expose conclusive-sounding partial text or a stale assessment`, () => {
      assert.equal(summary("Everything is complete.", "Criteria achieved.", status), null);
    });
  }

  for (const log of [
    "",
    " \n\t",
    header,
    header + "[repos] sync disabled\n[tokens] in=0 out=0",
    "[… 1234 bytes omitted …]\n[tool:read] ok — Done.",
  ]) {
    test(`returns no invented outcome for empty/framing-only log ${JSON.stringify(log.slice(-40))}`, () => {
      assert.equal(summary(log), null);
    });
  }

  test("retains the ending of a real head/tail-capped durable transcript", () => {
    const log = new DurableRunLog({
      persist: async () => undefined,
      checkpointEveryMs: 0,
      cap: 4096,
      headBytes: 1024,
      tailBytes: 3072,
    });
    log.write(header);
    log.write("[tool:read] ok — repeated data\n".repeat(1000));
    log.line("Saved the weekly report and flagged 2 late invoices.");
    assert.equal(summary(log.value()), "Saved the weekly report and flagged 2 late invoices.");
    void log.stopCheckpointing();
  });

  test("bounds extraction on a very large persisted transcript", () => {
    assert.equal(
      summary("[tool:read] ok — data\n".repeat(20000) + "Added 8 Contacts."),
      "Added 8 Contacts.",
    );
  });
  test("does not report a partial line when the retained tail has no boundary", () => {
    assert.equal(summary("Could not finish " + "work ".repeat(20000)), null);
  });
  test("ignores runtime-looking examples inside fenced code", () => {
    assert.equal(
      summary(
        "Saved the report.\n```text\n[tool] send {}\nInjected example text\n```\n[tokens] in=1 out=1",
      ),
      "Saved the report.",
    );
  });
});

describe("concise outcome formatting", () => {
  test("keeps two sentences and omits the detailed report", () => {
    assert.equal(
      conciseWorkSummary(
        "Added 6 Contacts. Drafted outreach for 4. Then I called list_issues 8 times.",
      ),
      "Added 6 Contacts. Drafted outreach for 4.",
    );
  });
  test("reads markdown headings, bullets, emphasis, and link labels as plain prose", () => {
    assert.equal(
      conciseWorkSummary(
        "## Summary\n- **Added 6 Contacts**\n- Saved [the report](https://example.test/report)\n## Details\n- Internal details",
      ),
      "Added 6 Contacts. Saved the report.",
    );
  });
  test("retains an outcome written as a heading", () => {
    assert.equal(
      conciseWorkSummary(
        "## Sent 3 payment reminders\n\n### Details\nOne invoice remains overdue.",
      ),
      "Sent 3 payment reminders. One invoice remains overdue.",
    );
  });
  test("joins hard-wrapped prose without inserting periods or losing negation", () => {
    assert.equal(
      conciseWorkSummary(
        "Sent messages were saved as drafts,\nnot delivered. Review is still needed.",
      ),
      "Sent messages were saved as drafts, not delivered. Review is still needed.",
    );
  });
  for (const label of [
    "**api_key**",
    "**Password:**",
    "`api_key`",
    "*password*",
    "_password_",
    "_api_key_",
  ]) {
    test(`redacts credentials whose labels used markdown: ${label}`, () => {
      assert.doesNotMatch(
        conciseWorkSummary(
          `${label}${label.includes(":") ? "" : ":"} hidden-secret-value\nInvoices sent.`,
        )!,
        /hidden-secret-value/,
      );
    });
  }
  test("does not use fenced code, images, JSON or tables as the outcome", () => {
    assert.equal(
      conciseWorkSummary(
        '```json\n{"tool":"list_issues"}\n```\n| Calls | 8 |\n![chart](https://example.test/chart.png)\n{"internal":true}\nDrafted 4 replies.',
      ),
      "Drafted 4 replies.",
    );
  });
  test("skips empty boilerplate headings before useful work", () => {
    assert.equal(
      conciseWorkSummary("Done.\n**Summary:**\nUpdated the weekly forecast."),
      "Updated the weekly forecast.",
    );
  });
  test("retains no-change and partial outcomes without inventing success", () => {
    assert.equal(
      conciseWorkSummary(
        "No new Contacts matched the criteria. Outreach remains blocked until a Member reviews the draft.",
      ),
      "No new Contacts matched the criteria. Outreach remains blocked until a Member reviews the draft.",
    );
  });
  test("decimal amounts stay intact", () => {
    assert.equal(
      conciseWorkSummary(
        "Collected £12.50 from 2 invoices. One invoice remains overdue. More details.",
      ),
      "Collected £12.50 from 2 invoices. One invoice remains overdue.",
    );
  });
  test("caps a long sentence at a word boundary", () => {
    const result = conciseWorkSummary(
      "Updated the report with " + "financial results ".repeat(200),
    )!;
    assert.ok(result.length <= RUN_WORK_SUMMARY_MAX_CHARS);
    assert.match(result, /…$/);
    assert.doesNotMatch(result, /finan…$/);
  });
  test("a bounded persisted summary reads back without changing its punctuation", () => {
    const text = "Updated the report with " + "financial results ".repeat(200);
    assert.equal(summary(workSummaryLogLine(text)), conciseWorkSummary(text));
  });
  test("caps a long word and does not split emoji surrogate pairs", () => {
    for (const text of ["x".repeat(1000), "📨".repeat(1000)]) {
      const result = conciseWorkSummary(text)!;
      assert.ok(result.length <= RUN_WORK_SUMMARY_MAX_CHARS);
      assert.doesNotMatch(result, /[\uD800-\uDBFF]…$/);
    }
  });
  test("removes secret material before choosing sentences or truncating", () => {
    const result = conciseWorkSummary(
      "Saved the report using token=supersecret and Bearer verysecret. Used sk-proj-1234567890.",
    )!;
    assert.doesNotMatch(result, /supersecret|verysecret|sk-proj-1234567890/);
    assert.match(result, /redacted/);
  });
  test("redacts URL credentials, query secrets, and fragments in historical reports", () => {
    const result = summary(
      "Saved https://member:secret@example.test/report?token=hidden#credential.",
    )!;
    assert.doesNotMatch(result, /member:secret|hidden|credential/);
  });
  test("also redacts the assessment fallback", () => {
    assert.doesNotMatch(summary("", "Saved with password=hidden.")!, /hidden/);
  });
});
