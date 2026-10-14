import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CORE_SECTIONS, USAGE_SECTIONS } from "../../shared/navigation.js";
import { SECTION_BY_KEY, SECTION_GROUPS, type SectionKey } from "./sections.js";
import {
  canOpenSection,
  isSectionListed,
  listedGroups,
  unlistedSectionCount,
  type SectionListing,
} from "./sectionVisibility.js";
import type { SubpageViewer } from "./subpages.js";

const OWNER: SubpageViewer = { role: "owner", financeAccess: "full" };
const MEMBER_NONE: SubpageViewer = { role: "member", financeAccess: "none" };

function listing(overrides: Partial<SectionListing> = {}): SectionListing {
  return { used: new Set(), showAll: false, current: "home", viewer: OWNER, ...overrides };
}

const ALL_KEYS = SECTION_GROUPS.flatMap((group) => group.items.map((item) => item.key));

describe("section listing", () => {
  test("names only real sections, and every company section is core, usage, or Proactive", () => {
    for (const key of [...CORE_SECTIONS, ...USAGE_SECTIONS]) {
      assert.ok(SECTION_BY_KEY[key as SectionKey], `${key} is a section`);
    }
    const classified = new Set<string>([...CORE_SECTIONS, ...USAGE_SECTIONS]);
    // Proactive is a setup page whose work shows up as Routines; it is the one
    // company section neither always listed nor listed by use.
    assert.deepEqual(
      ALL_KEYS.filter((key) => !classified.has(key)),
      ["proactive"],
    );
  });

  test("a new company browses only the core", () => {
    const groups = listedGroups(SECTION_GROUPS, listing());
    assert.deepEqual(
      groups.flatMap((group) => group.items.map((item) => item.key)).sort(),
      [...CORE_SECTIONS].sort(),
    );
    assert.equal(
      unlistedSectionCount(SECTION_GROUPS, listing()),
      ALL_KEYS.length - CORE_SECTIONS.length,
    );
  });

  test("a section joins the list once the company uses it", () => {
    const used = new Set(["finance", "routines"]);
    assert.equal(isSectionListed("finance", listing({ used })), true);
    assert.equal(isSectionListed("routines", listing({ used })), true);
    assert.equal(isSectionListed("marketing", listing({ used })), false);
  });

  test("the section on screen is always listed", () => {
    assert.equal(isSectionListed("pipelines", listing({ current: "pipelines" })), true);
  });

  test("Show all lists everything, and so does not knowing what is in use", () => {
    for (const key of ALL_KEYS) {
      assert.equal(isSectionListed(key, listing({ showAll: true })), true, key);
      assert.equal(isSectionListed(key, listing({ used: null })), true, key);
    }
    assert.equal(unlistedSectionCount(SECTION_GROUPS, listing({ showAll: true })), 0);
  });

  test("Finance and Customers are never offered to a Member without Finance access", () => {
    for (const key of ["finance", "customers"] as SectionKey[]) {
      assert.equal(canOpenSection(key, MEMBER_NONE), false);
      const everything = listing({ viewer: MEMBER_NONE, showAll: true, current: key });
      assert.equal(isSectionListed(key, everything), false);
    }
    // Not counted as "more" either: Show all would not reveal them.
    assert.equal(
      unlistedSectionCount(SECTION_GROUPS, listing({ viewer: MEMBER_NONE })),
      ALL_KEYS.length - CORE_SECTIONS.length - 2,
    );
  });

  test("a group with nothing listed loses its heading", () => {
    const labels = listedGroups(SECTION_GROUPS, listing()).map((group) => group.label);
    assert.equal(labels.includes("Money"), false);
    assert.equal(labels.includes("Engineering"), false);
  });
});
