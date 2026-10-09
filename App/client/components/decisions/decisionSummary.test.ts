import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatHumanDecisionContext } from "../../../shared/decisionContext";
import {
  DECISION_RECOMMENDATION_MAX,
  DECISION_SUMMARY_MAX,
  DECISION_SUMMARY_MIN,
  DERIVED_LINE_MAX,
  clip,
  decisionHeadline,
  firstSentence,
  lastParagraph,
  oneLine,
  pickupReportOf,
  plainText,
  type DecisionHeadlineInput,
} from "../../../shared/decisionSummary";

/**
 * The few lines a Decision opens on. New rows carry the employee's own short
 * summary and recommendation; older rows derive the same lines from what
 * they carry, so every row in the stack reads the same way.
 */

const OPTIONS: DecisionHeadlineInput["options"] = [
  { id: "bid", label: "Pursue: register and bid", detail: "I register today.", tone: "primary" },
  { id: "decline", label: "Decline this RFP", detail: null, tone: "neutral" },
];

function question(changes: Partial<DecisionHeadlineInput> = {}): DecisionHeadlineInput {
  return {
    title: "Decide UTA RFP UTA27 response by Oct 8 15:00 CT",
    body: formatHumanDecisionContext(
      "Bidding on UTA RFP UTA27 is a public-sector commitment with a hard deadline (Oct 8 at 15:00 CT). Existing instructions do not settle it.",
      "What happened: UTA has an open RFP.\n\nWhat I checked: the deal record.",
    ),
    summary: null,
    recommendation: null,
    options: OPTIONS,
    ...changes,
  };
}

describe("the limits an employee writes within", () => {
  test("are short enough to read in seconds, and ordered sensibly", () => {
    assert.equal(DECISION_SUMMARY_MAX, 200);
    assert.equal(DECISION_RECOMMENDATION_MAX, 160);
    assert.ok(DECISION_SUMMARY_MIN > 0 && DECISION_SUMMARY_MIN < DECISION_RECOMMENDATION_MAX);
    assert.ok(DERIVED_LINE_MAX <= DECISION_SUMMARY_MAX);
  });
});

describe("oneLine", () => {
  test("collapses whitespace, line breaks and control characters", () => {
    assert.equal(oneLine("  Acme\n\nwants\t10%\u0007 off  "), "Acme wants 10% off");
    assert.equal(oneLine("a b c"), "a b c");
    assert.equal(oneLine(""), "");
  });
});

describe("clip", () => {
  test("leaves short text alone", () => {
    assert.equal(clip("Short.", 20), "Short.");
    assert.equal(clip("x".repeat(20), 20), "x".repeat(20));
  });

  test("cuts at a word near the limit with an ellipsis, never past it", () => {
    const text = "Acme will renew for three years if we take ten percent off the list price";
    const cut = clip(text, 40);
    assert.ok(cut.length <= 40, cut);
    assert.ok(cut.endsWith("…"));
    assert.equal(cut, "Acme will renew for three years if we…");
  });

  test("cuts a single long word where it must, and never splits a surrogate pair", () => {
    assert.equal(clip("a".repeat(50), 10), `${"a".repeat(9)}…`);
    const emoji = `${"a".repeat(8)}😀😀😀`;
    const cut = clip(emoji, 10);
    assert.ok(!/[\uD800-\uDBFF]…$/.test(cut), JSON.stringify(cut));
  });

  test("drops trailing punctuation before the ellipsis", () => {
    assert.equal(clip("Acme, Globex, Initech, Umbrella and Hooli", 24), "Acme, Globex, Initech…");
  });
});

describe("plainText", () => {
  test("reads markdown as the words it shows", () => {
    assert.equal(
      plainText("## Heading\n- item *one*\n1. **Bold** and __strong__ with `code`"),
      "Heading\nitem one\nBold and strong with code",
    );
    assert.equal(
      plainText("See [the deal](https://x.test/deal) and ![chart](c.png)."),
      "See the deal and chart.",
    );
    assert.equal(plainText("> quoted line"), "quoted line");
    assert.equal(plainText("<b>tags</b> go"), "tags go");
    assert.equal(plainText("Link <https://acme.test/a>"), "Link https://acme.test/a");
  });

  test("drops fenced code, closed or not", () => {
    assert.equal(plainText("Before\n```js\nconst secret = 1;\n```\nAfter"), "Before\n\nAfter");
    assert.equal(plainText("Before\n~~~\ncode"), "Before");
  });

  test("keeps snake_case and arithmetic intact", () => {
    assert.equal(
      plainText("Set max_seats to 5 * 2 for acme_corp"),
      "Set max_seats to 5 * 2 for acme_corp",
    );
  });
});

describe("firstSentence", () => {
  test("ends at the first sentence", () => {
    assert.equal(
      firstSentence("Acme wants 10% off. They will sign today if we agree."),
      "Acme wants 10% off.",
    );
    assert.equal(firstSentence("Can we bid? The deadline is close."), "Can we bid?");
    assert.equal(firstSentence("Ship it! Everyone agrees."), "Ship it!");
  });

  test("does not end after an abbreviation, an initial or a decimal", () => {
    assert.equal(
      firstSentence("Bid by Oct. 8 for the U.S. office, e.g. Austin. Then more."),
      "Bid by Oct. 8 for the U.S. office, e.g. Austin.",
    );
    assert.equal(firstSentence("Plan A. Costs more."), "Plan A. Costs more.");
    assert.equal(
      firstSentence("Raise it 2.5x this year. Then review."),
      "Raise it 2.5x this year.",
    );
    assert.equal(firstSentence("Use v1.2 now. Later v2."), "Use v1.2 now.");
  });

  test("needs a capital, a digit or a quote after the stop", () => {
    assert.equal(
      firstSentence("The total is 5. then we wait. And go."),
      "The total is 5. then we wait.",
    );
    assert.equal(firstSentence("It ends here. 3 more follow."), "It ends here.");
    assert.equal(firstSentence("Done. “Quoted” next."), "Done.");
  });

  test("stops at the end of the first paragraph", () => {
    assert.equal(firstSentence("No full stop here\n\nSecond paragraph."), "No full stop here");
    assert.equal(
      firstSentence("Joined\nacross a soft break. Next."),
      "Joined across a soft break.",
    );
  });

  test("reads markdown as text and is clipped to its limit", () => {
    assert.equal(
      firstSentence("**Why:** the [contract](https://x.test) renews. More."),
      "Why: the contract renews.",
    );
    const long = `${"word ".repeat(80)}end.`;
    assert.ok(firstSentence(long).length <= DERIVED_LINE_MAX);
    assert.ok(firstSentence(long, 50).length <= 50);
  });

  test("is empty for nothing", () => {
    assert.equal(firstSentence(""), "");
    assert.equal(firstSentence(null), "");
    assert.equal(firstSentence(undefined), "");
    assert.equal(firstSentence("```\nonly code\n```"), "");
  });
});

describe("lastParagraph", () => {
  test("takes the last paragraph of a log", () => {
    assert.equal(
      lastParagraph("Looked.\n\nChecked.\n\nRegistered on BidNet."),
      "Registered on BidNet.",
    );
    assert.equal(lastParagraph("Report:\n- one\n- two"), "Report:\n- one\n- two");
  });

  test("reads a long log without blank lines line by line", () => {
    assert.equal(lastParagraph("a\nb\nc\nd\nThe report."), "The report.");
    assert.equal(lastParagraph("a\nb\nc"), "a\nb\nc");
  });

  test("is null for nothing", () => {
    assert.equal(lastParagraph(""), null);
    assert.equal(lastParagraph("  \n\n "), null);
    assert.equal(lastParagraph(null), null);
  });
});

describe("decisionHeadline", () => {
  test("a new row shows the employee's own lines", () => {
    const headline = decisionHeadline(
      question({
        summary: "  UTA wants bids by Oct 8.\nWe fit, but nobody owns the deal.  ",
        recommendation: "Bid: we fit, and registering takes a day.",
      }),
    );
    assert.deepEqual(headline, {
      question: "Decide UTA RFP UTA27 response by Oct 8 15:00 CT",
      summary: "UTA wants bids by Oct 8. We fit, but nobody owns the deal.",
      summaryDerived: false,
      recommendation: "Bid: we fit, and registering takes a day.",
      recommendedOptionId: "bid",
    });
  });

  test("an older row derives its line from the first sentence of its reason", () => {
    const headline = decisionHeadline(question());
    assert.equal(
      headline.summary,
      "Bidding on UTA RFP UTA27 is a public-sector commitment with a hard deadline (Oct 8 at 15:00 CT).",
    );
    assert.equal(headline.summaryDerived, true);
    assert.equal(headline.recommendation, "Pursue: register and bid");
    assert.equal(headline.recommendedOptionId, "bid");
  });

  test("without a stated reason, it reads the first sentence of the context", () => {
    const headline = decisionHeadline(
      question({ body: "What happened: Acme asked for 10% off. They renew Friday." }),
    );
    assert.equal(headline.summary, "Acme asked for 10% off.");
    assert.equal(headline.summaryDerived, true);
  });

  test("a blank summary is treated as missing", () => {
    assert.equal(decisionHeadline(question({ summary: "   " })).summaryDerived, true);
  });

  test("never repeats the question as its line", () => {
    const headline = decisionHeadline(
      question({ title: "Raise prices?", body: "Raise prices?\n\nMore detail below." }),
    );
    assert.equal(headline.summary, null);
  });

  test("nothing to say is null, not an empty line", () => {
    const headline = decisionHeadline(
      question({ body: "", options: [{ id: "a", label: "A", detail: null, tone: "neutral" }] }),
    );
    assert.equal(headline.summary, null);
    assert.equal(headline.recommendation, null);
    assert.equal(headline.recommendedOptionId, null);
  });

  test("a stored recommendation wins over the marked option, which still marks its button", () => {
    const headline = decisionHeadline(question({ recommendation: "Decline: we cannot staff it." }));
    assert.equal(headline.recommendation, "Decline: we cannot staff it.");
    assert.equal(headline.recommendedOptionId, "bid");
  });
});

describe("pickupReportOf", () => {
  const log =
    "Looked up the deal.\n\nRegistered on BidNet.\n\nRegistered and saved the RFP to the deal.";

  test("a recorded report leads, with the log behind it", () => {
    assert.deepEqual(
      pickupReportOf({
        pickupStatus: "done",
        pickupSummary: log,
        pickupReport: " Saved the RFP. ",
      }),
      { report: "Saved the RFP.", reportDerived: false, log },
    );
  });

  test("an older finished pickup reads its last paragraph", () => {
    assert.deepEqual(pickupReportOf({ pickupStatus: "done", pickupSummary: log }), {
      report: "Registered and saved the RFP to the deal.",
      reportDerived: true,
      log,
    });
  });

  test("a log that is only the report has nothing more to show", () => {
    assert.deepEqual(
      pickupReportOf({ pickupStatus: "done", pickupSummary: "Sent it.", pickupReport: "Sent it." }),
      { report: "Sent it.", reportDerived: false, log: null },
    );
    assert.deepEqual(pickupReportOf({ pickupStatus: "done", pickupSummary: "Sent it." }), {
      report: "Sent it.",
      reportDerived: true,
      log: null,
    });
  });

  test("a failed or skipped pickup has no report: its summary is the reason", () => {
    for (const pickupStatus of ["failed", "skipped", "running", "none"]) {
      assert.deepEqual(
        pickupReportOf({
          pickupStatus,
          pickupSummary: "No AI Model is connected.",
          pickupReport: null,
        }),
        { report: null, reportDerived: false, log: "No AI Model is connected." },
        pickupStatus,
      );
    }
    assert.deepEqual(pickupReportOf({ pickupStatus: "done", pickupSummary: null }), {
      report: null,
      reportDerived: false,
      log: null,
    });
  });
});
