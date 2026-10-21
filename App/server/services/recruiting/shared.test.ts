import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { instructionsTextProblem } from "../../../shared/instructionsText.js";
import {
  CRITERION_RATINGS,
  CRITERION_WEIGHTS,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_CONFIRMATION_EMAIL_BODY,
  DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
  DEFAULT_OPENING_FORM,
  DEFAULT_REJECTION_EMAIL_BODY,
  DEFAULT_REJECTION_EMAIL_SUBJECT,
  DEFAULT_SCREENING_INSTRUCTIONS,
  EMAIL_TEMPLATE_PLACEHOLDERS,
  MAX_EMAIL_BODY_CHARS,
  MAX_EMAIL_SUBJECT_CHARS,
  MAX_RATING,
  MAX_SCREENING_INSTRUCTIONS_LENGTH,
  MAX_SCREENING_INSTRUCTION_LINES,
  RECRUITING_ACCESS_LEVELS,
  RECRUITING_ACCESS_RANK,
  RECRUITING_ACTIVE_STAGES,
  RECRUITING_CLOSED_STAGES,
  RECRUITING_FORWARD_STAGES,
  RECRUITING_SCREEN_STAGES,
  RECRUITING_STAGES,
  RESUME_EXTENSIONS,
  RESUME_MAX_BYTES,
  SCORE_LABEL_FLOORS,
  accentForeground,
  computeScore,
  criteriaFingerprint,
  effectiveTemplate,
  firstNameOf,
  formatAnswerValue,
  formatCompensation,
  isRecruitingStage,
  labelForScore,
  normalizeAccentColor,
  normalizeOpeningForm,
  openingMetaLine,
  renderEmailTemplate,
  type CriterionImportance,
  type CriterionRating,
  type CriterionRatingInput,
  type EmailTemplatePlaceholder,
  type EmploymentType,
  type OpeningCriterion,
  type WorkplaceType,
} from "../../../shared/recruiting.js";

/**
 * `shared/recruiting.ts` is the vocabulary and arithmetic the server, the App
 * and the careers site all import, so they agree only as long as this one
 * module is right. These pin it: the score is
 * `round(100 × Σ weight × rating ÷ (3 × Σ weight))` and no average buys a
 * candidate past a must-have; the criteria fingerprint every Scorecard stores
 * does not drift between releases; a published rate and an Opening's details
 * read the same on every screen; and applicant emails fill exactly the
 * placeholders they name and leave a typo where a person can see it.
 */

function criterion(
  id: string,
  importance: CriterionImportance,
  name: string = id,
  description = "",
): OpeningCriterion {
  return { id, name, description, importance };
}

/** Ratings by criterion id. Values off the 0–3 scale are passed through on purpose. */
function rate(entries: Record<string, unknown>): CriterionRatingInput[] {
  return Object.entries(entries).map(([criterionId, rating]) => ({
    criterionId,
    rating: rating as CriterionRating,
  }));
}

/** `count` important criteria, all rated Exceeds — padding that pushes a total up. */
function strongImportant(count: number): {
  criteria: OpeningCriterion[];
  ratings: CriterionRatingInput[];
} {
  const criteria = Array.from({ length: count }, (_, index) => criterion(`i${index}`, "important"));
  return { criteria, ratings: criteria.map((item) => ({ criterionId: item.id, rating: 3 })) };
}

const ENGINEERING_CRITERIA: OpeningCriterion[] = [
  criterion("c1", "must_have", "TypeScript", "Ships production TypeScript."),
  criterion("c2", "important", "Postgres", "Has run Postgres in production."),
  criterion("c3", "nice_to_have", "Kubernetes"),
];

describe("computeScore", () => {
  test("has nothing to say about an Opening with no criteria", () => {
    assert.deepEqual(computeScore([], rate({ anything: 3 })), {
      score: null,
      label: null,
      rows: [],
      missingMustHaves: [],
      partialMustHaves: [],
      unrated: [],
    });
  });

  test("scores an Application rated Exceeds on everything 100, a Strong match", () => {
    const result = computeScore(ENGINEERING_CRITERIA, rate({ c1: 3, c2: 3, c3: 3 }));
    assert.equal(result.score, 100);
    assert.equal(result.label, "strong");
    assert.deepEqual(result.missingMustHaves, []);
    assert.deepEqual(result.partialMustHaves, []);
    assert.deepEqual(result.unrated, []);
  });

  test("scores an Application rated Not shown on everything 0, Weak, naming the must-have it missed", () => {
    const result = computeScore(ENGINEERING_CRITERIA, rate({ c1: 0, c2: 0, c3: 0 }));
    assert.equal(result.score, 0);
    assert.equal(result.label, "weak");
    assert.deepEqual(result.missingMustHaves, ["TypeScript"]);
    assert.deepEqual(result.partialMustHaves, []);
    assert.deepEqual(result.unrated, []);
  });

  test("counts a must-have three times, an important criterion twice and a nice-to-have once", () => {
    assert.deepEqual(CRITERION_WEIGHTS, { must_have: 3, important: 2, nice_to_have: 1 });
    assert.equal(MAX_RATING, 3);
    assert.deepEqual([...CRITERION_RATINGS], [0, 1, 2, 3]);

    // By hand: (3×2 + 2×3 + 1×1) = 13 points of 3 × (3 + 2 + 1) = 18 possible.
    // 100 × 13 ÷ 18 = 72.2…, which rounds to 72: a Good match.
    assert.deepEqual(computeScore(ENGINEERING_CRITERIA, rate({ c1: 2, c2: 3, c3: 1 })), {
      score: 72,
      label: "good",
      rows: [
        {
          criterionId: "c1",
          name: "TypeScript",
          importance: "must_have",
          weight: 3,
          rating: 2,
          earned: 6,
          possible: 9,
        },
        {
          criterionId: "c2",
          name: "Postgres",
          importance: "important",
          weight: 2,
          rating: 3,
          earned: 6,
          possible: 6,
        },
        {
          criterionId: "c3",
          name: "Kubernetes",
          importance: "nice_to_have",
          weight: 1,
          rating: 1,
          earned: 1,
          possible: 3,
        },
      ],
      missingMustHaves: [],
      partialMustHaves: [],
      unrated: [],
    });

    // The same two ratings swapped between an important and a nice-to-have
    // criterion land far apart: 6 of 9 against 3 of 9.
    const pair = [criterion("a", "important"), criterion("b", "nice_to_have")];
    assert.equal(computeScore(pair, rate({ a: 3, b: 0 })).score, 67);
    assert.equal(computeScore(pair, rate({ a: 0, b: 3 })).score, 33);
  });

  test("rounds to the nearest whole point, and an exact half rounds up", () => {
    // 100 × 2 ÷ 3 = 66.67 → 67.
    assert.equal(computeScore([criterion("a", "nice_to_have")], rate({ a: 2 })).score, 67);
    // 100 × 1 ÷ 3 = 33.33 → 33.
    assert.equal(computeScore([criterion("a", "nice_to_have")], rate({ a: 1 })).score, 33);
    // (3×2 + 3×3 + 2×0) = 15 of 24: 100 × 15 ÷ 24 = 62.5 → 63.
    const half = computeScore(
      [criterion("a", "must_have"), criterion("b", "must_have"), criterion("c", "important")],
      rate({ a: 2, b: 3, c: 0 }),
    );
    assert.equal(half.score, 63);
    assert.equal(half.label, "good");
  });

  test("an unrated criterion earns nothing and is listed, so a thin Scorecard reads as thin", () => {
    const result = computeScore(ENGINEERING_CRITERIA, rate({ c2: 3 }));
    // 6 of 18 possible: 33.
    assert.equal(result.score, 33);
    assert.equal(result.label, "weak");
    assert.deepEqual(result.unrated, ["TypeScript", "Kubernetes"]);
    assert.deepEqual(
      result.rows.map((row) => [row.criterionId, row.rating, row.earned, row.possible]),
      [
        ["c1", null, 0, 9],
        ["c2", 3, 6, 6],
        ["c3", null, 0, 3],
      ],
    );
    // Only a must-have *rated* Not shown is missing; one left unrated is listed as unrated.
    assert.deepEqual(result.missingMustHaves, []);
    assert.deepEqual(result.partialMustHaves, []);
  });

  test("treats a rating off the 0–3 scale as no rating at all", () => {
    const criteria = [criterion("a", "important", "Postgres")];
    for (const bogus of [4, -1, 1.5, Number.NaN, null, undefined, "2", "3"]) {
      assert.deepEqual(
        computeScore(criteria, rate({ a: bogus })),
        {
          score: 0,
          label: "weak",
          rows: [
            {
              criterionId: "a",
              name: "Postgres",
              importance: "important",
              weight: 2,
              rating: null,
              earned: 0,
              possible: 6,
            },
          ],
          missingMustHaves: [],
          partialMustHaves: [],
          unrated: ["Postgres"],
        },
        String(bogus),
      );
    }
  });

  test("ignores ratings for criteria the Opening no longer has", () => {
    const criteria = [criterion("a", "important", "Postgres")];
    assert.deepEqual(
      computeScore(criteria, rate({ a: 2, removed: 0, also_removed: 3 })),
      computeScore(criteria, rate({ a: 2 })),
    );
    // Not even a removed criterion's "Not shown" holds the label down.
    const result = computeScore(criteria, rate({ removed: 0, a: 3 }));
    assert.equal(result.score, 100);
    assert.equal(result.label, "strong");
    assert.deepEqual(result.missingMustHaves, []);
    assert.deepEqual(
      result.rows.map((row) => row.criterionId),
      ["a"],
    );
  });

  test("a must-have rated Not shown makes the label Weak however high the number is", () => {
    const padding = strongImportant(6);
    const result = computeScore(
      [criterion("must", "must_have", "Work authorization"), ...padding.criteria],
      [...rate({ must: 0 }), ...padding.ratings],
    );
    // 36 of 45 possible is 80 — Strong on the number alone.
    assert.equal(result.score, 80);
    assert.equal(labelForScore(80), "strong");
    assert.equal(result.label, "weak");
    assert.deepEqual(result.missingMustHaves, ["Work authorization"]);
    assert.deepEqual(result.partialMustHaves, []);
  });

  test("a must-have rated Partly caps the label at Possible", () => {
    const padding = strongImportant(6);
    const strong = computeScore(
      [criterion("must", "must_have", "TypeScript"), ...padding.criteria],
      [...rate({ must: 1 }), ...padding.ratings],
    );
    // (3 + 36) of 45: 86.7 → 87, Strong on the number alone.
    assert.equal(strong.score, 87);
    assert.equal(strong.label, "possible");
    assert.deepEqual(strong.partialMustHaves, ["TypeScript"]);
    assert.deepEqual(strong.missingMustHaves, []);

    const good = computeScore(
      [
        criterion("must", "must_have", "TypeScript"),
        criterion("a", "important"),
        criterion("b", "important"),
      ],
      rate({ must: 1, a: 3, b: 3 }),
    );
    // (3 + 6 + 6) of 21: 71.4 → 71, Good on the number alone.
    assert.equal(good.score, 71);
    assert.equal(good.label, "possible");
  });

  test("the Partly cap never raises a label", () => {
    const possible = computeScore(
      [criterion("must", "must_have", "TypeScript"), criterion("a", "important")],
      rate({ must: 1, a: 2 }),
    );
    // (3 + 4) of 15: 46.7 → 47, Possible either way.
    assert.equal(possible.score, 47);
    assert.equal(possible.label, "possible");

    const weak = computeScore([criterion("must", "must_have", "TypeScript")], rate({ must: 1 }));
    assert.equal(weak.score, 33);
    assert.equal(weak.label, "weak");
    assert.deepEqual(weak.partialMustHaves, ["TypeScript"]);
  });

  test("a must-have rated Not shown outranks another rated Partly", () => {
    const padding = strongImportant(6);
    const result = computeScore(
      [
        criterion("a", "must_have", "TypeScript"),
        criterion("b", "must_have", "Postgres"),
        ...padding.criteria,
      ],
      [...rate({ a: 0, b: 1 }), ...padding.ratings],
    );
    // (0 + 3 + 36) of 54: 72.2 → 72.
    assert.equal(result.score, 72);
    assert.equal(result.label, "weak");
    assert.deepEqual(result.missingMustHaves, ["TypeScript"]);
    assert.deepEqual(result.partialMustHaves, ["Postgres"]);
  });

  test("labels change exactly at 80, 60 and 40", () => {
    assert.deepEqual(SCORE_LABEL_FLOORS, { strong: 80, good: 60, possible: 40 });
    assert.equal(labelForScore(100), "strong");
    assert.equal(labelForScore(80), "strong");
    assert.equal(labelForScore(79), "good");
    assert.equal(labelForScore(60), "good");
    assert.equal(labelForScore(59), "possible");
    assert.equal(labelForScore(40), "possible");
    assert.equal(labelForScore(39), "weak");
    assert.equal(labelForScore(0), "weak");

    // The same edges reached through real ratings, every must-have rated Meets
    // or better so no cap is in play.
    const cases: Array<[Array<[CriterionImportance, CriterionRating]>, number, string]> = [
      // (6 + 6) of 15
      [
        [
          ["must_have", 2],
          ["important", 3],
        ],
        80,
        "strong",
      ],
      // (6 + 9 + 4) of 24 = 79.2
      [
        [
          ["must_have", 2],
          ["must_have", 3],
          ["important", 2],
        ],
        79,
        "good",
      ],
      // (9 + 0) of 15
      [
        [
          ["must_have", 3],
          ["important", 0],
        ],
        60,
        "good",
      ],
      // (6 + 0 + 4 + 6) of 27 = 59.3
      [
        [
          ["must_have", 2],
          ["important", 0],
          ["important", 2],
          ["important", 3],
        ],
        59,
        "possible",
      ],
      // (6 + 0) of 15
      [
        [
          ["must_have", 2],
          ["important", 0],
        ],
        40,
        "possible",
      ],
      // (6 + 0 + 1) of 18 = 38.9
      [
        [
          ["must_have", 2],
          ["important", 0],
          ["nice_to_have", 1],
        ],
        39,
        "weak",
      ],
    ];
    for (const [entries, score, label] of cases) {
      const criteria = entries.map(([importance], index) => criterion(`c${index}`, importance));
      const ratings = entries.map(([, rating], index) => ({ criterionId: `c${index}`, rating }));
      const result = computeScore(criteria, ratings);
      assert.equal(result.score, score, JSON.stringify(entries));
      assert.equal(result.label, label, JSON.stringify(entries));
    }
  });

  test("a criterion of an importance this release does not know counts once and is never a must-have", () => {
    const result = computeScore(
      [criterion("odd", "critical" as CriterionImportance, "Legacy"), criterion("a", "important")],
      rate({ odd: 0, a: 3 }),
    );
    assert.equal(result.rows[0].weight, 1);
    assert.equal(result.rows[0].possible, 3);
    // 6 of 9.
    assert.equal(result.score, 67);
    assert.equal(result.label, "good");
    assert.deepEqual(result.missingMustHaves, []);
  });
});

/** FNV-1a, 32-bit, written the textbook way (BigInt, no Math.imul) to check the module against. */
function referenceFnv1a(text: string): string {
  let hash = 0x811c9dc5n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x01000193n) % 0x100000000n;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("criteriaFingerprint", () => {
  test("is the 32-bit FNV-1a of the criteria, as eight hex digits", () => {
    // The reference itself, against the published FNV-1a test vectors.
    assert.equal(referenceFnv1a(""), "811c9dc5");
    assert.equal(referenceFnv1a("a"), "e40c292c");
    assert.equal(referenceFnv1a("foobar"), "bf9cf968");

    // No criteria hash nothing: the FNV offset basis.
    assert.equal(criteriaFingerprint([]), "811c9dc5");
    const canonical = ENGINEERING_CRITERIA.map((item) =>
      [item.id, item.name, item.description, item.importance].join("\u0001"),
    ).join("\u0002");
    assert.equal(criteriaFingerprint(ENGINEERING_CRITERIA), referenceFnv1a(canonical));
    assert.match(criteriaFingerprint(ENGINEERING_CRITERIA), /^[0-9a-f]{8}$/);
  });

  test("never drifts: every Scorecard stores it and is compared against it later", () => {
    // If this value changes, every Scorecard already written reads as
    // "The criteria changed after this was scored".
    assert.equal(
      criteriaFingerprint([
        criterion("c1", "must_have", "TypeScript", "Ships production TypeScript."),
        criterion("c2", "important", "Postgres", "Has run Postgres in production."),
      ]),
      "431d909d",
    );
  });

  test("is the same for equal criteria, however they were built", () => {
    const first = criteriaFingerprint(ENGINEERING_CRITERIA);
    assert.equal(criteriaFingerprint(ENGINEERING_CRITERIA), first);
    assert.equal(criteriaFingerprint(structuredClone(ENGINEERING_CRITERIA)), first);
    assert.equal(criteriaFingerprint(ENGINEERING_CRITERIA.map((item) => ({ ...item }))), first);
  });

  test("ignores spaces around a name or description", () => {
    assert.equal(
      criteriaFingerprint([
        criterion("c1", "must_have", "  TypeScript ", " Ships production TypeScript.\n"),
        criterion("c2", "important", "Postgres\t", "Has run Postgres in production."),
        criterion("c3", "nice_to_have", "Kubernetes", "   "),
      ]),
      criteriaFingerprint(ENGINEERING_CRITERIA),
    );
  });

  test("changes when a criterion's wording, importance or id changes, or one is added or removed", () => {
    const base = criteriaFingerprint(ENGINEERING_CRITERIA);
    const withFirst = (patch: Partial<OpeningCriterion>) =>
      criteriaFingerprint([
        { ...ENGINEERING_CRITERIA[0], ...patch },
        ...ENGINEERING_CRITERIA.slice(1),
      ]);
    const changed = [
      withFirst({ name: "TypeScript and Node" }),
      withFirst({ description: "Ships production TypeScript every week." }),
      withFirst({ importance: "important" }),
      withFirst({ importance: "nice_to_have" }),
      withFirst({ id: "c9" }),
      criteriaFingerprint(ENGINEERING_CRITERIA.slice(0, 2)),
      criteriaFingerprint([...ENGINEERING_CRITERIA, criterion("c4", "nice_to_have", "Go")]),
    ];
    for (const fingerprint of changed) assert.notEqual(fingerprint, base);
    assert.equal(new Set(changed).size, changed.length);
  });

  test("keeps a name and a description apart", () => {
    // Glued together without a separator, both would read "TypeScript".
    assert.notEqual(
      criteriaFingerprint([criterion("c1", "important", "Type", "Script")]),
      criteriaFingerprint([criterion("c1", "important", "TypeScript", "")]),
    );
  });

  test("ignores the order the Opening lists its criteria in", () => {
    // Moving a criterion up or down in the editor changes no bar, so it must
    // not flag every earlier Scorecard as written against other criteria.
    assert.equal(
      criteriaFingerprint([...ENGINEERING_CRITERIA].reverse()),
      criteriaFingerprint(ENGINEERING_CRITERIA),
    );
  });
});

describe("formatCompensation", () => {
  test("publishes a range, a floor, a ceiling or one amount, each with its period", () => {
    assert.equal(
      formatCompensation({
        minMinor: 12_000_000,
        maxMinor: 15_000_000,
        currency: "USD",
        period: "year",
      }),
      "$120,000 – $150,000 per year",
    );
    assert.equal(
      formatCompensation({ minMinor: 4_500, maxMinor: null, currency: "USD", period: "hour" }),
      "From $45 per hour",
    );
    assert.equal(
      formatCompensation({ minMinor: null, maxMinor: 900_000, currency: "EUR", period: "month" }),
      "Up to €9,000 per month",
    );
    assert.equal(
      formatCompensation({
        minMinor: 800_000,
        maxMinor: 800_000,
        currency: "USD",
        period: "project",
      }),
      "$8,000 for the project",
    );
    assert.equal(
      formatCompensation({
        minMinor: 5_500_000,
        maxMinor: 6_500_000,
        currency: "GBP",
        period: "year",
      }),
      "£55,000 – £65,000 per year",
    );
    assert.equal(
      formatCompensation({ minMinor: 25_000, maxMinor: 30_000, currency: "USD", period: "day" }),
      "$250 – $300 per day",
    );
    assert.equal(
      formatCompensation({ minMinor: 150_000, maxMinor: null, currency: "USD", period: "week" }),
      "From $1,500 per week",
    );
  });

  test("shows cents only when a rate has them, and then always two digits", () => {
    assert.equal(
      formatCompensation({ minMinor: 3_750, maxMinor: 4_025, currency: "USD", period: "hour" }),
      "$37.50 – $40.25 per hour",
    );
    assert.equal(
      formatCompensation({ minMinor: 3_740, maxMinor: null, currency: "USD", period: "hour" }),
      "From $37.40 per hour",
    );
  });

  test("keeps amounts in minor units whatever the currency", () => {
    // ¥5,000,000 is stored as 500,000,000 minor units, like every other currency.
    assert.equal(
      formatCompensation({
        minMinor: 500_000_000,
        maxMinor: null,
        currency: "JPY",
        period: "year",
      }),
      "From ¥5,000,000 per year",
    );
  });

  test("is null when the Opening publishes no rate", () => {
    assert.equal(
      formatCompensation({ minMinor: null, maxMinor: null, currency: "USD", period: "year" }),
      null,
    );
  });

  test("still reads, instead of throwing, for a currency code Intl cannot format", () => {
    assert.equal(
      formatCompensation({ minMinor: 120_000, maxMinor: null, currency: "US$", period: "week" }),
      "From 1,200 US$ per week",
    );
  });
});

describe("openingMetaLine", () => {
  test("joins department, employment type, workplace and location with dots", () => {
    assert.equal(
      openingMetaLine({
        department: "Engineering",
        employmentType: "full_time",
        workplace: "remote",
        location: "Berlin",
      }),
      "Engineering · Full-time · Remote · Berlin",
    );
    assert.equal(
      openingMetaLine({ employmentType: "full_time", workplace: "remote", location: "Berlin" }),
      "Full-time · Remote · Berlin",
    );
    assert.equal(
      openingMetaLine({ employmentType: "contract", workplace: "onsite", location: "" }),
      "Contract · On-site",
    );
    assert.equal(
      openingMetaLine({
        department: "Design",
        employmentType: "internship",
        workplace: "hybrid",
        location: "Lisbon",
      }),
      "Design · Internship · Hybrid · Lisbon",
    );
  });

  test("trims and skips blank parts", () => {
    assert.equal(
      openingMetaLine({
        department: "  ",
        employmentType: "part_time",
        workplace: "hybrid",
        location: "  Paris ",
      }),
      "Part-time · Hybrid · Paris",
    );
    assert.equal(
      openingMetaLine({
        department: " Sales ",
        employmentType: "temporary",
        workplace: "onsite",
        location: "\t",
      }),
      "Sales · Temporary · On-site",
    );
  });

  test("skips an employment type or workplace it has no label for", () => {
    assert.equal(
      openingMetaLine({
        employmentType: "seasonal" as EmploymentType,
        workplace: "office" as WorkplaceType,
        location: "Lisbon",
      }),
      "Lisbon",
    );
  });
});

describe("the application form settings", () => {
  test("ask for a resume and leave every other standard field optional by default", () => {
    assert.deepEqual(DEFAULT_OPENING_FORM, {
      phone: "optional",
      location: "optional",
      linkedin: "optional",
      website: "optional",
      resume: "required",
      coverLetter: "optional",
    });
  });

  test("fall back to the defaults, as a fresh copy, when nothing usable is stored", () => {
    for (const stored of [undefined, null, "required", 42, true, [], {}]) {
      const form = normalizeOpeningForm(stored);
      assert.deepEqual(form, DEFAULT_OPENING_FORM, JSON.stringify(stored));
      assert.notEqual(form, DEFAULT_OPENING_FORM);
    }
    const form = normalizeOpeningForm(null);
    form.phone = "hidden";
    assert.equal(DEFAULT_OPENING_FORM.phone, "optional");
  });

  test("keep what was stored and fill only the gaps", () => {
    assert.deepEqual(normalizeOpeningForm({ phone: "required", website: "hidden" }), {
      phone: "required",
      location: "optional",
      linkedin: "optional",
      website: "hidden",
      resume: "required",
      coverLetter: "optional",
    });
    assert.deepEqual(
      normalizeOpeningForm({
        phone: "hidden",
        location: "required",
        linkedin: "required",
        website: "optional",
        resume: "optional",
        coverLetter: "required",
      }),
      {
        phone: "hidden",
        location: "required",
        linkedin: "required",
        website: "optional",
        resume: "optional",
        coverLetter: "required",
      },
    );
  });

  test("replace a value they do not know with the default and drop unknown fields", () => {
    assert.deepEqual(
      normalizeOpeningForm({
        phone: "mandatory",
        location: 3,
        linkedin: "REQUIRED",
        coverLetter: null,
        fax: "required",
      }),
      DEFAULT_OPENING_FORM,
    );
  });

  test("never hide the resume: a stored hidden resume becomes optional", () => {
    assert.equal(normalizeOpeningForm({ resume: "hidden" }).resume, "optional");
    assert.equal(normalizeOpeningForm({ resume: "optional" }).resume, "optional");
    assert.equal(normalizeOpeningForm({ resume: "required" }).resume, "required");
  });
});

const SAMPLE_VALUES: Record<EmailTemplatePlaceholder, string> = {
  first_name: "Ada",
  full_name: "Ada Lovelace",
  opening_title: "Senior Backend Engineer",
  company_name: "Acme",
  opening_url: "https://acme.example/careers/openings/senior-backend-engineer",
};

describe("applicant email templates", () => {
  test("fill every placeholder they know", () => {
    assert.deepEqual(
      [...EMAIL_TEMPLATE_PLACEHOLDERS],
      ["first_name", "full_name", "opening_title", "company_name", "opening_url"],
    );
    assert.equal(
      renderEmailTemplate(
        "{{first_name}}|{{full_name}}|{{opening_title}}|{{company_name}}|{{opening_url}}",
        SAMPLE_VALUES,
      ),
      "Ada|Ada Lovelace|Senior Backend Engineer|Acme|https://acme.example/careers/openings/senior-backend-engineer",
    );
  });

  test("allow spaces inside the braces and fill a placeholder every time it appears", () => {
    assert.equal(
      renderEmailTemplate(
        "{{ first_name }}, {{first_name}} and {{  company_name\t}}",
        SAMPLE_VALUES,
      ),
      "Ada, Ada and Acme",
    );
  });

  test("leave an unknown or mistyped placeholder as written, so the preview shows the typo", () => {
    assert.equal(
      renderEmailTemplate(
        "Hi {{firstname}} {{First_Name}} {{first-name}} {{first_name} {{salary}} {{ }}",
        SAMPLE_VALUES,
      ),
      "Hi {{firstname}} {{First_Name}} {{first-name}} {{first_name} {{salary}} {{ }}",
    );
  });

  test("insert values exactly as given, in one pass", () => {
    const values = {
      ...SAMPLE_VALUES,
      first_name: "{{company_name}}",
      full_name: "$& $1 $$",
      company_name: "R&D <Labs>",
    };
    assert.equal(
      renderEmailTemplate("{{first_name}} / {{full_name}} / {{company_name}}", values),
      "{{company_name}} / $& $1 $$ / R&D <Labs>",
    );
  });

  test("render the default confirmation cleanly", () => {
    assert.equal(
      renderEmailTemplate(DEFAULT_CONFIRMATION_EMAIL_SUBJECT, SAMPLE_VALUES),
      "We received your application for Senior Backend Engineer",
    );
    assert.equal(
      renderEmailTemplate(DEFAULT_CONFIRMATION_EMAIL_BODY, SAMPLE_VALUES),
      [
        "Hi Ada,",
        "",
        "Thank you for applying for the Senior Backend Engineer role at Acme. We have received your application, and we will get back to you as soon as we can.",
        "",
        "You can read the opening again at any time: https://acme.example/careers/openings/senior-backend-engineer",
        "",
        "The Acme team",
      ].join("\n"),
    );
  });

  test("render the default rejection cleanly", () => {
    assert.equal(
      renderEmailTemplate(DEFAULT_REJECTION_EMAIL_SUBJECT, SAMPLE_VALUES),
      "Your application for Senior Backend Engineer",
    );
    assert.equal(
      renderEmailTemplate(DEFAULT_REJECTION_EMAIL_BODY, SAMPLE_VALUES),
      [
        "Hi Ada,",
        "",
        "Thank you for your interest in the Senior Backend Engineer role at Acme, and for the time you put into applying. After careful review, we have decided not to move forward with your application.",
        "",
        "We are grateful you considered us, and we wish you the very best.",
        "",
        "The Acme team",
      ].join("\n"),
    );
  });

  test("defaults use only known placeholders and fit the limits an edited template must meet", () => {
    for (const template of [
      DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
      DEFAULT_CONFIRMATION_EMAIL_BODY,
      DEFAULT_REJECTION_EMAIL_SUBJECT,
      DEFAULT_REJECTION_EMAIL_BODY,
    ]) {
      for (const [, key] of template.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
        assert.ok((EMAIL_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(key), key);
      }
      assert.doesNotMatch(renderEmailTemplate(template, SAMPLE_VALUES), /\{\{|\}\}/);
    }
    assert.ok(DEFAULT_CONFIRMATION_EMAIL_SUBJECT.length <= MAX_EMAIL_SUBJECT_CHARS);
    assert.ok(DEFAULT_REJECTION_EMAIL_SUBJECT.length <= MAX_EMAIL_SUBJECT_CHARS);
    assert.ok(DEFAULT_CONFIRMATION_EMAIL_BODY.length <= MAX_EMAIL_BODY_CHARS);
    assert.ok(DEFAULT_REJECTION_EMAIL_BODY.length <= MAX_EMAIL_BODY_CHARS);
  });

  test("greet a candidate by the first word of their name, or as 'there'", () => {
    assert.equal(firstNameOf("Ada Lovelace"), "Ada");
    assert.equal(firstNameOf("  Grace\tBrewster  Hopper "), "Grace");
    assert.equal(firstNameOf("Cher"), "Cher");
    assert.equal(firstNameOf(""), "there");
    assert.equal(firstNameOf("   "), "there");
  });

  test("follow the current default until a company writes its own, even an empty one", () => {
    assert.equal(effectiveTemplate(null, "Default"), "Default");
    assert.equal(effectiveTemplate(undefined, "Default"), "Default");
    assert.equal(effectiveTemplate("", "Default"), "");
    assert.equal(effectiveTemplate("Ours", "Default"), "Ours");
  });
});

describe("formatAnswerValue", () => {
  test("reads each kind of answer as one line, and a missing one as a dash", () => {
    assert.equal(formatAnswerValue({ kind: "short_text", value: null }), "—");
    assert.equal(formatAnswerValue({ kind: "short_text", value: "" }), "—");
    assert.equal(
      formatAnswerValue({ kind: "short_text", value: undefined as unknown as null }),
      "—",
    );
    assert.equal(formatAnswerValue({ kind: "multi_select", value: [] }), "—");
    assert.equal(formatAnswerValue({ kind: "yes_no", value: true }), "Yes");
    assert.equal(formatAnswerValue({ kind: "yes_no", value: false }), "No");
    assert.equal(formatAnswerValue({ kind: "multi_select", value: ["Go", "Rust"] }), "Go, Rust");
    assert.equal(formatAnswerValue({ kind: "number", value: 0 }), "0");
    assert.equal(formatAnswerValue({ kind: "number", value: 7.5 }), "7.5");
    assert.equal(formatAnswerValue({ kind: "long_text", value: "Because." }), "Because.");
  });
});

describe("stages", () => {
  test("run forward from Applied to Hired, or end Rejected or Withdrawn", () => {
    assert.deepEqual(
      [...RECRUITING_STAGES],
      ["applied", "screening", "interview", "offer", "hired", "rejected", "withdrawn"],
    );
    assert.deepEqual(RECRUITING_FORWARD_STAGES, [
      "applied",
      "screening",
      "interview",
      "offer",
      "hired",
    ]);
    assert.deepEqual(RECRUITING_CLOSED_STAGES, ["rejected", "withdrawn"]);
    assert.deepEqual(
      [...RECRUITING_FORWARD_STAGES, ...RECRUITING_CLOSED_STAGES].sort(),
      [...RECRUITING_STAGES].sort(),
    );
    assert.deepEqual(RECRUITING_ACTIVE_STAGES, ["applied", "screening", "interview", "offer"]);
  });

  test("an AI Employee with screen access moves Applications only up to Interview", () => {
    assert.deepEqual(RECRUITING_SCREEN_STAGES, ["applied", "screening", "interview"]);
    for (const stage of ["offer", "hired", "rejected", "withdrawn"]) {
      assert.ok(!(RECRUITING_SCREEN_STAGES as string[]).includes(stage), stage);
    }
  });

  test("recognises exactly the stage names", () => {
    for (const stage of RECRUITING_STAGES) assert.equal(isRecruitingStage(stage), true, stage);
    for (const value of ["Applied", "pipeline", "new", "", " applied", null, undefined, 1, {}]) {
      assert.equal(isRecruitingStage(value), false, String(value));
    }
  });
});

describe("Recruiting access levels", () => {
  test("rank read below screen below hire, listed in that order", () => {
    assert.deepEqual([...RECRUITING_ACCESS_LEVELS], ["read", "screen", "hire"]);
    assert.deepEqual(RECRUITING_ACCESS_RANK, { read: 0, screen: 1, hire: 2 });
    const ranks = RECRUITING_ACCESS_LEVELS.map((level) => RECRUITING_ACCESS_RANK[level]);
    assert.deepEqual(
      ranks,
      [...ranks].sort((a, b) => a - b),
    );
    assert.ok(RECRUITING_ACCESS_RANK.read < RECRUITING_ACCESS_RANK.screen);
    assert.ok(RECRUITING_ACCESS_RANK.screen < RECRUITING_ACCESS_RANK.hire);
  });
});

describe("the careers site accent color", () => {
  test("normalizes #rgb and #rrggbb to lower-case six digits", () => {
    assert.equal(normalizeAccentColor("#4F46E5"), "#4f46e5");
    assert.equal(normalizeAccentColor("  #4f46e5\n"), "#4f46e5");
    assert.equal(normalizeAccentColor("#ABC"), "#aabbcc");
    assert.equal(normalizeAccentColor("#0f0"), "#00ff00");
    assert.equal(normalizeAccentColor(DEFAULT_ACCENT_COLOR), "#4f46e5");
  });

  test("refuses anything else", () => {
    for (const value of [
      "",
      "4f46e5",
      "#4f46e",
      "#4f46e5f",
      "#4f46e5ff",
      "#abcd",
      "#ab",
      "#ggg",
      "#12345g",
      "# abc",
      "red",
      "rgb(79, 70, 229)",
    ]) {
      assert.equal(normalizeAccentColor(value), null, value);
    }
  });

  test("puts black text on a light accent and white text on a dark one", () => {
    assert.equal(accentForeground("#ffffff"), "#000000");
    assert.equal(accentForeground("#fff"), "#000000");
    assert.equal(accentForeground("#facc15"), "#000000");
    assert.equal(accentForeground("#000000"), "#ffffff");
    assert.equal(accentForeground("#1e3a8a"), "#ffffff");
    assert.equal(accentForeground(DEFAULT_ACCENT_COLOR), "#ffffff");
  });

  test("switches at a relative luminance of 0.179", () => {
    // #767676 has a luminance of about 0.181; #757575 about 0.178.
    assert.equal(accentForeground("#767676"), "#000000");
    assert.equal(accentForeground("#757575"), "#ffffff");
  });

  test("reads an accent it cannot parse as the default accent", () => {
    assert.equal(accentForeground("not a color"), accentForeground(DEFAULT_ACCENT_COLOR));
    assert.equal(accentForeground(""), "#ffffff");
  });
});

describe("resume uploads", () => {
  test("accept PDF, Word, plain text, Markdown, RTF and OpenDocument files up to 10 MB", () => {
    assert.deepEqual(
      [...RESUME_EXTENSIONS],
      [".pdf", ".docx", ".doc", ".txt", ".md", ".rtf", ".odt"],
    );
    for (const extension of RESUME_EXTENSIONS) assert.match(extension, /^\.[a-z]+$/);
    assert.equal(RESUME_MAX_BYTES, 10_485_760);
  });
});

describe("the default screening instructions", () => {
  test("can be saved as they are", () => {
    assert.equal(
      instructionsTextProblem(DEFAULT_SCREENING_INSTRUCTIONS, {
        maxLength: MAX_SCREENING_INSTRUCTIONS_LENGTH,
        maxLines: MAX_SCREENING_INSTRUCTION_LINES,
      }),
      null,
    );
    assert.equal(DEFAULT_SCREENING_INSTRUCTIONS.split("\n").length, 4);
  });
});
