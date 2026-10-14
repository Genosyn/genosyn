import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GOAL_TITLE_MAX,
  GOAL_UNIT_MAX,
  buildGoalPayload,
  formatGoalTarget,
  parseGoalSentence,
  parseGoalTarget,
  syncGoalDetails,
  type GoalDetails,
} from "./goalSentence";

describe("the target in a Goal sentence", () => {
  const cases: Array<[string, number | null]> = [
    ["Reach 50 paying customers by March", 50],
    ["Reach 2,000 newsletter subscribers", 2000],
    ["Reach 1,250,000 visits", 1_250_000],
    ["Grow monthly revenue to $2M", 2_000_000],
    ["Hit $1.5M ARR", 1_500_000],
    ["Get to 10k users", 10_000],
    ["Get to 10K users", 10_000],
    ["Reach 2.3k followers", 2300],
    ["Raise $1.1k this month", 1100],
    ["Reach 1 million users", 1_000_000],
    ["Raise 2.5 billion", 2_500_000_000],
    ["Reduce churn to 40%", 40],
    ["Increase conversion to 5 percent", 5],
    ["Reduce cost per lead to 12.5", 12.5],
    ["Ship 12 releases", 12],
    ["Be the best in town", null],
    ["", null],
  ];
  for (const [sentence, target] of cases) {
    test(`${JSON.stringify(sentence)} is ${target}`, () => {
      assert.equal(parseGoalSentence(sentence).target, target);
    });
  }

  test("takes the first number the sentence states", () => {
    assert.equal(parseGoalSentence("Reach 50 customers and 10 partners").target, 50);
  });

  test("does not mistake a date or a label for the target", () => {
    assert.equal(parseGoalSentence("In 2026, reach 1,000 customers").target, 1000);
    assert.equal(parseGoalSentence("By 2027 we want 400 customers").target, 400);
    assert.equal(parseGoalSentence("Q3: reach 500 users").target, 500);
    assert.equal(parseGoalSentence("Launch by March 15, then reach 40 customers").target, 40);
    assert.equal(parseGoalSentence("Reach 50 customers by March 2026").target, 50);
  });

  test("keeps a number that merely looks like a year when it is the only one", () => {
    assert.equal(parseGoalSentence("Reach 2000 customers").target, 2000);
    assert.equal(parseGoalSentence("Grow customers by 2000").target, 2000);
  });

  test("skips numbers that are part of a word", () => {
    assert.equal(parseGoalSentence("Run 10x faster").target, null);
    assert.equal(parseGoalSentence("Answer within 5min").target, null);
    assert.equal(parseGoalSentence("Finish 1st").target, null);
    assert.equal(parseGoalSentence("Win more B2B deals").target, null);
  });
});

describe("the direction of a Goal sentence", () => {
  for (const sentence of [
    "Reduce churn to 2%",
    "Reducing support tickets to 40 a week",
    "Cut costs to $5k",
    "Lower our refund rate to 1%",
    "Decrease response time to 20",
    "Drive down churn to 3%",
    "Drive churn down to 3%",
    "Bring churn below 2%",
    "Get under 100 open bugs",
    "Fewer than 10 incidents",
    "Spend less than $5k",
    "Keep churn at most 2%",
    "REDUCE ERRORS TO 5",
  ]) {
    test(`${JSON.stringify(sentence)} decreases to the target`, () => {
      assert.equal(parseGoalSentence(sentence).direction, "decrease_to");
    });
  }

  for (const sentence of [
    "Reach 50 paying customers by March",
    "Grow revenue to $2M",
    "Increase conversion to 5%",
    "Understand 50 customers",
    "Unless we hit 50 customers",
    "Cute is not a goal: 50 fans",
    "Get 10k signups",
    "Be the best",
  ]) {
    test(`${JSON.stringify(sentence)} increases to the target`, () => {
      assert.equal(parseGoalSentence(sentence).direction, "increase_to");
    });
  }
});

describe("the unit of a Goal sentence", () => {
  const cases: Array<[string, string]> = [
    ["Reach 50 paying customers by March", "paying customers"],
    ["Reach 1000 users", "users"],
    ["Get to 10k newsletter subscribers", "subscribers"],
    ["Grow to 10k monthly active users", "monthly active users"],
    ["Ship 12 product releases this year", "product releases"],
    ["Sign 20 customers, then expand", "customers"],
    ["Close 5 deals per month", "deals"],
    ["Grow monthly revenue to $2M", "$"],
    ["Hit €500k in sales", "€"],
    ["Reduce churn to 2%", "%"],
    ["Increase conversion to 5 percent", "%"],
    ["Cut support tickets to under 40 a week", ""],
    ["Reduce cost per lead to $12", "$"],
    ["Be the best", ""],
  ];
  for (const [sentence, unit] of cases) {
    test(`${JSON.stringify(sentence)} counts ${JSON.stringify(unit)}`, () => {
      assert.equal(parseGoalSentence(sentence).unit, unit);
    });
  }

  test("never offers a unit the Goals route would refuse", () => {
    const unit = parseGoalSentence("Reach 10 internationalization specialists").unit;
    assert(unit.length > 0 && unit.length <= GOAL_UNIT_MAX, unit);
  });

  test("keeps the last words when a long phrase has to be cut down", () => {
    assert.equal(
      parseGoalSentence("Reach 10 corporate procurement officers").unit,
      "procurement officers",
    );
  });
});

describe("the Target box", () => {
  const accepted: Array<[string, number]> = [
    ["50", 50],
    [" 50 ", 50],
    ["2,000", 2000],
    ["$2M", 2_000_000],
    ["10k", 10_000],
    ["40%", 40],
    ["1.5", 1.5],
    ["-5", -5],
  ];
  for (const [text, value] of accepted) {
    test(`reads ${JSON.stringify(text)} as ${value}`, () => {
      assert.equal(parseGoalTarget(text), value);
    });
  }

  for (const text of ["", "  ", "abc", "1,5", "50 customers", "5 to 10", "1e3", "fifty", "10x"]) {
    test(`refuses ${JSON.stringify(text)} rather than guess`, () => {
      assert.equal(parseGoalTarget(text), null);
    });
  }

  test("shows a target as plain digits", () => {
    assert.equal(formatGoalTarget(2_000_000), "2000000");
    assert.equal(formatGoalTarget(1.5), "1.5");
    assert.equal(formatGoalTarget(1100.0000000000002), "1100");
  });
});

describe("keeping the details in step with the sentence", () => {
  const blank: GoalDetails = { target: "", direction: "increase_to", unit: "" };

  test("fills every detail from the sentence", () => {
    assert.deepEqual(syncGoalDetails("Cut churn to 2%", blank, {}), {
      target: "2",
      direction: "decrease_to",
      unit: "%",
    });
  });

  test("follows the sentence as it is typed and clears when it is emptied", () => {
    const typed = syncGoalDetails("Reach 5", blank, {});
    assert.equal(typed.target, "5");
    assert.equal(syncGoalDetails("Reach 50", typed, {}).target, "50");
    assert.deepEqual(syncGoalDetails("", syncGoalDetails("Reach 50 users", blank, {}), {}), blank);
  });

  test("keeps what the person changed by hand", () => {
    const current: GoalDetails = { target: "75", direction: "decrease_to", unit: "seats" };

    assert.deepEqual(
      syncGoalDetails("Reach 50 paying customers", current, {
        target: true,
        direction: true,
        unit: true,
      }),
      current,
    );
    assert.deepEqual(syncGoalDetails("Reach 50 paying customers", current, { target: true }), {
      target: "75",
      direction: "increase_to",
      unit: "paying customers",
    });
  });
});

describe("the Goal to send", () => {
  const filled = {
    sentence: "  Reach 50 paying customers by March  ",
    target: "50",
    direction: "increase_to" as const,
    unit: " customers ",
  };

  test("trims the sentence and the unit", () => {
    assert.deepEqual(buildGoalPayload(filled), {
      ok: true,
      goal: {
        title: "Reach 50 paying customers by March",
        targetValue: 50,
        direction: "increase_to",
        unit: "customers",
      },
    });
  });

  test("reads the target the way the box shows it", () => {
    const result = buildGoalPayload({ ...filled, target: "$2M" });
    assert(result.ok);
    assert.equal(result.goal.targetValue, 2_000_000);
  });

  test("says what is missing", () => {
    assert.deepEqual(buildGoalPayload({ ...filled, sentence: "   " }), {
      ok: false,
      error: "Write your Goal in a sentence.",
    });
    assert.deepEqual(buildGoalPayload({ ...filled, target: "" }), {
      ok: false,
      error: "Add a target number for your Goal.",
    });
    assert.deepEqual(buildGoalPayload({ ...filled, target: "lots" }), {
      ok: false,
      error: "Add a target number for your Goal.",
    });
  });

  test("refuses what the Goals route would", () => {
    const longGoal = buildGoalPayload({ ...filled, sentence: "x".repeat(GOAL_TITLE_MAX + 1) });
    assert(!longGoal.ok);
    assert.match(longGoal.error, /140/);
    const longUnit = buildGoalPayload({ ...filled, unit: "u".repeat(GOAL_UNIT_MAX + 1) });
    assert(!longUnit.ok);
    assert.match(longUnit.error, /20/);
    assert(buildGoalPayload({ ...filled, sentence: "x".repeat(GOAL_TITLE_MAX) }).ok);
  });
});
