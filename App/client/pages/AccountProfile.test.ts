import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isResendDelivery,
  resendOutcomeCopy,
  unverifiedNoticeCopy,
  type ResendDelivery,
} from "./AccountProfile.js";

/**
 * The copy Account → Profile puts next to the email address.
 *
 * It is tested as data because the distinctions in it are the feature: a
 * "skipped" delivery has to read as a failure rather than a green tick, and
 * only a master admin may be told which install-wide setting is at fault.
 */

const DELIVERIES: ResendDelivery[] = ["sent", "skipped", "failed", "already_verified"];

const OPERATOR = { email: "operator@example.com", isMasterAdmin: true };
const MEMBER = { email: "member@example.com", isMasterAdmin: false };

describe("isResendDelivery", () => {
  test("accepts every status the endpoint can answer with", () => {
    for (const delivery of DELIVERIES) {
      assert.equal(isResendDelivery(delivery), true, delivery);
    }
  });

  test("rejects anything else, so a stale server cannot put a raw string on screen", () => {
    for (const value of [undefined, null, "", "SENT", "Sent", "ok", "queued", 1, true, {}, []]) {
      assert.equal(isResendDelivery(value), false, JSON.stringify(value) ?? "undefined");
    }
  });

  test("does not treat inherited object keys as statuses", () => {
    // An array `includes` cannot be fooled the way a plain-object lookup can,
    // and this is the assertion that keeps it that way.
    assert.equal(isResendDelivery("constructor"), false);
    assert.equal(isResendDelivery("toString"), false);
    assert.equal(isResendDelivery("__proto__"), false);
  });
});

describe("resendOutcomeCopy", () => {
  test("a real send is the only green answer, and it names the address", () => {
    const copy = resendOutcomeCopy("sent", MEMBER);
    assert.equal(copy.tone, "success");
    assert.match(copy.message, /member@example\.com/);
    assert.match(copy.message, /24 hours/);
  });

  test("an already-verified address is a quiet success, not a send", () => {
    const copy = resendOutcomeCopy("already_verified", MEMBER);
    assert.equal(copy.tone, "success");
    assert.doesNotMatch(copy.message, /sent/i);
  });

  test("a link that only reached the server log reads as a failure, not a send", () => {
    for (const opts of [OPERATOR, MEMBER]) {
      const copy = resendOutcomeCopy("skipped", opts);
      // The bug being fixed: this used to be indistinguishable from success,
      // so the person sat waiting for mail that was never posted.
      assert.equal(copy.tone, "error", `isMasterAdmin=${opts.isMasterAdmin}`);
    }
  });

  test("a rejected send reads as a failure too", () => {
    for (const opts of [OPERATOR, MEMBER]) {
      assert.equal(resendOutcomeCopy("failed", opts).tone, "error");
    }
  });

  test("only an operator is told which install-wide setting to fix", () => {
    for (const delivery of ["skipped", "failed"] as const) {
      const operator = resendOutcomeCopy(delivery, OPERATOR).message;
      const member = resendOutcomeCopy(delivery, MEMBER).message;
      assert.match(operator, /Admin → Email transport/, delivery);
      // Naming an install-wide transport to an ordinary Member is operator
      // configuration they have no business reading.
      assert.doesNotMatch(member, /Admin → Email transport/, delivery);
      assert.match(member, /administrator/i, delivery);
      assert.notEqual(operator, member, delivery);
    }
  });

  test("only the console fallback sends anyone to the server log", () => {
    // `failed` never prints the body — claiming otherwise sends an operator
    // hunting through logs for a line that was never written.
    assert.match(resendOutcomeCopy("skipped", OPERATOR).message, /server log/);
    assert.doesNotMatch(resendOutcomeCopy("failed", OPERATOR).message, /server log/);
  });

  test("never leaks the address to someone else's copy", () => {
    const copy = resendOutcomeCopy("skipped", OPERATOR);
    assert.doesNotMatch(copy.message, /operator@example\.com/);
  });

  test("every status yields a usable sentence, for both kinds of account", () => {
    for (const delivery of DELIVERIES) {
      for (const opts of [OPERATOR, MEMBER]) {
        const copy = resendOutcomeCopy(delivery, opts);
        assert.ok(["success", "error"].includes(copy.tone), `${delivery} tone`);
        assert.ok(copy.message.trim().length > 0, `${delivery} message`);
        assert.match(copy.message, /\.$/, `${delivery} should end in a full stop`);
      }
    }
  });
});

describe("unverifiedNoticeCopy", () => {
  test("tells an operator the consequence they are already hitting", () => {
    // `requireMasterAdmin` refuses an unverified account on every install, not
    // just shared SaaS — which is exactly the message that sent the person
    // looking for a button that did not exist.
    assert.match(unverifiedNoticeCopy({ isMasterAdmin: true }), /instance administration/);
  });

  test("does not threaten an ordinary Member with a door they never open", () => {
    const member = unverifiedNoticeCopy({ isMasterAdmin: false });
    assert.doesNotMatch(member, /instance administration/);
    assert.ok(member.trim().length > 0);
  });

  test("says something different to each", () => {
    assert.notEqual(
      unverifiedNoticeCopy({ isMasterAdmin: true }),
      unverifiedNoticeCopy({ isMasterAdmin: false }),
    );
  });
});

describe("copy hygiene", () => {
  test("no sentence carries a bare apostrophe or quote", () => {
    // These strings are one refactor away from being JSX children, where a raw
    // ' or " trips react/no-unescaped-entities and takes CI down with it.
    const everything = [
      unverifiedNoticeCopy({ isMasterAdmin: true }),
      unverifiedNoticeCopy({ isMasterAdmin: false }),
      ...DELIVERIES.flatMap((delivery) => [
        resendOutcomeCopy(delivery, OPERATOR).message,
        resendOutcomeCopy(delivery, MEMBER).message,
      ]),
    ];
    for (const sentence of everything) {
      assert.doesNotMatch(sentence, /['"]/, sentence);
    }
  });
});
