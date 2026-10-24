import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeCompanyAdvanced } from "./companySettingsSummary.js";

describe("describeCompanyAdvanced", () => {
  test("names the web address and that two-factor sign-in is optional by default", () => {
    assert.equal(
      describeCompanyAdvanced({ slug: "acme", requireTwoFactor: false }),
      "Web address /c/acme · Two-factor sign-in optional",
    );
  });

  test("says when two-factor sign-in is required", () => {
    assert.equal(
      describeCompanyAdvanced({ slug: "sunwise-solar", requireTwoFactor: true }),
      "Web address /c/sunwise-solar · Two-factor sign-in required",
    );
  });

  test("still reads while the address is being retyped", () => {
    assert.equal(
      describeCompanyAdvanced({ slug: "", requireTwoFactor: false }),
      "Web address /c/… · Two-factor sign-in optional",
    );
  });
});
