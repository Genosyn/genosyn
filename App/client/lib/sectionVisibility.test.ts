import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SECTION_GROUPS, type SectionKey } from "./sections.js";
import { canOpenSection, listedGroups } from "./sectionVisibility.js";
import type { SubpageViewer } from "./subpages.js";

const OWNER: SubpageViewer = { role: "owner", financeAccess: "full" };
const MEMBER_NONE: SubpageViewer = { role: "member", financeAccess: "none" };

const ALL_KEYS = SECTION_GROUPS.flatMap((group) => group.items.map((item) => item.key));
const keysOf = (viewer: SubpageViewer) =>
  listedGroups(SECTION_GROUPS, viewer).flatMap((group) => group.items.map((item) => item.key));

describe("section listing", () => {
  test("browsing lists every section an owner can open, in catalogue order", () => {
    assert.deepEqual(keysOf(OWNER), ALL_KEYS);
    assert.deepEqual(
      listedGroups(SECTION_GROUPS, OWNER).map((group) => group.label),
      SECTION_GROUPS.map((group) => group.label),
    );
  });

  test("Finance and Customers are never offered to a Member without Finance access", () => {
    for (const key of ["finance", "customers"] as SectionKey[]) {
      assert.equal(canOpenSection(key, MEMBER_NONE), false);
    }
    assert.deepEqual(
      keysOf(MEMBER_NONE),
      ALL_KEYS.filter((key) => key !== "finance" && key !== "customers" && key !== "dataRooms"),
    );
  });

  test("Data rooms are offered to owners and admins only, whatever their Finance access", () => {
    assert.equal(canOpenSection("dataRooms", OWNER), true);
    assert.equal(canOpenSection("dataRooms", { role: "admin", financeAccess: "none" }), true);
    assert.equal(canOpenSection("dataRooms", { role: "member", financeAccess: "full" }), false);
    assert.equal(canOpenSection("dataRooms", MEMBER_NONE), false);
  });
});
