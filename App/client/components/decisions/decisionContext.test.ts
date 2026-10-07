import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatHumanDecisionContext,
  HUMAN_DECISION_HEADING,
  parseDecisionContext,
} from "../../../shared/decisionContext";
import { contextSectionKind, repeatsHeading } from "./contextSections";

/**
 * The card reads back what intake writes, so the round trip is the contract:
 * the reason comes out whole, and the employee's own labels become sections
 * rather than one block of prose.
 */

describe("formatHumanDecisionContext", () => {
  test("puts the reason under its heading, before the context", () => {
    assert.equal(
      formatHumanDecisionContext("The renewal locks us in for three years.", "Acme asked."),
      `## ${HUMAN_DECISION_HEADING}\nThe renewal locks us in for three years.\n\nAcme asked.`,
    );
  });

  test("keeps a multi-paragraph reason one paragraph, so its end stays unambiguous", () => {
    const stored = formatHumanDecisionContext("First point.\n\n  \nSecond point.", "Context.");
    assert.deepEqual(parseDecisionContext(stored), {
      reason: "First point.\nSecond point.",
      sections: [{ label: null, body: "Context." }],
    });
  });

  test("a reason with no context is still a reason", () => {
    assert.deepEqual(parseDecisionContext(formatHumanDecisionContext("Only the reason.", "")), {
      reason: "Only the reason.",
      sections: [],
    });
  });
});

describe("parseDecisionContext", () => {
  test("splits the reason from labelled context the way employees write it", () => {
    const stored = formatHumanDecisionContext(
      "Whether EDB counts as a competitor is a business judgment the routine cannot make.",
      [
        "What happened: The run evaluated EnterpriseDB as the fourth candidate.",
        "",
        "Why it is blocked: The gate creates no records for an ambiguous company.",
        "Re-verification today (enterprisedb.com): the positioning is unchanged.",
      ].join("\n"),
    );
    assert.deepEqual(parseDecisionContext(stored), {
      reason: "Whether EDB counts as a competitor is a business judgment the routine cannot make.",
      sections: [
        {
          label: "What happened",
          body: "The run evaluated EnterpriseDB as the fourth candidate.",
        },
        {
          label: "Why it is blocked",
          body: [
            "The gate creates no records for an ambiguous company.",
            "Re-verification today (enterprisedb.com): the positioning is unchanged.",
          ].join("\n"),
        },
      ],
    });
  });

  test("headings and bold lead-ins start sections, and prose before them keeps no label", () => {
    const { sections } = parseDecisionContext(
      [
        "Acme replied overnight.",
        "## Options",
        "- Renew",
        "- Let it lapse",
        "**Recommendation:** Renew for one year.",
        "**Risk**: Prices rise in March.",
        "**Unknowns**",
        "Whether legal reviewed the clause.",
      ].join("\n"),
    );
    assert.deepEqual(sections, [
      { label: null, body: "Acme replied overnight." },
      { label: "Options", body: "- Renew\n- Let it lapse" },
      { label: "Recommendation", body: "Renew for one year." },
      { label: "Risk", body: "Prices rise in March." },
      { label: "Unknowns", body: "Whether legal reviewed the clause." },
    ]);
  });

  test("a label on its own line owns the list beneath it", () => {
    assert.deepEqual(parseDecisionContext("Facts:\n- Signed in May\n- Renews in June").sections, [
      { label: "Facts", body: "- Signed in May\n- Renews in June" },
    ]);
  });

  test("sentences, links, times, list items and mail headers are not labels", () => {
    const body = [
      "However, the gate blocked it: nothing was sent.",
      "See https://example.com/runs/1 for the run.",
      "The call is at 10:30 tomorrow.",
      "- Cost: $5,000 a year",
      "Re: Partnership with EDB",
      "**Important** the draft is unsent.",
      "**Do not send before Friday.**",
      "lowercase start: still prose",
    ].join("\n");
    assert.deepEqual(parseDecisionContext(body).sections, [{ label: null, body }]);
  });

  test("never splits inside fenced code", () => {
    const body = "```\nStatus: draft\n\nOwner: Sam\n```\nNext steps: Send it.";
    assert.deepEqual(parseDecisionContext(body).sections, [
      { label: null, body: "```\nStatus: draft\n\nOwner: Sam\n```" },
      { label: "Next steps", body: "Send it." },
    ]);
  });

  test("rows written without a reason, or without any context, read safely", () => {
    assert.deepEqual(parseDecisionContext("The draft has trade-offs."), {
      reason: null,
      sections: [{ label: null, body: "The draft has trade-offs." }],
    });
    assert.deepEqual(parseDecisionContext(""), { reason: null, sections: [] });
    assert.deepEqual(parseDecisionContext(null), { reason: null, sections: [] });
    assert.deepEqual(parseDecisionContext("## Context\n\nOptions:"), {
      reason: null,
      sections: [],
    });
  });

  test("the reason heading only counts at the start, in any case, with Windows line endings", () => {
    const parsed = parseDecisionContext(
      "\r\n## why this needs a HUMAN decision:\r\nThe price doubles.\r\n\r\nContext.",
    );
    assert.equal(parsed.reason, "The price doubles.");
    assert.deepEqual(parsed.sections, [{ label: null, body: "Context." }]);
    assert.equal(parseDecisionContext(`Intro.\n## ${HUMAN_DECISION_HEADING}\nLater.`).reason, null);
  });
});

describe("contextSectionKind", () => {
  test("reads what a section is about from the label the employee chose", () => {
    const kinds = {
      "Why it is blocked": "blocked",
      "Risk if we wait": "risk",
      "My recommendation": "recommendation",
      "Recommended option": "recommendation",
      Options: "options",
      Deadline: "timing",
      "Monthly cost": "cost",
      "Open questions": "unknowns",
      "Existing Gmail thread": "evidence",
      "Next steps": "next",
      "What happened": "background",
      Scope: "other",
    } as const;
    for (const [label, kind] of Object.entries(kinds)) {
      assert.equal(contextSectionKind(label), kind, label);
    }
    assert.equal(contextSectionKind(null), "other");
  });
});

describe("repeatsHeading", () => {
  test("ignores case and punctuation, and nothing repeats a missing heading", () => {
    assert.equal(repeatsHeading("What happened:", "What happened"), true);
    assert.equal(repeatsHeading("WHAT  HAPPENED", "What happened"), true);
    assert.equal(repeatsHeading("What happened next", "What happened"), false);
    assert.equal(repeatsHeading("What happened", undefined), false);
  });
});
