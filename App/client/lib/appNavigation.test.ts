import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FOOTER_GROUP_ID,
  NAV_COLLAPSED_KEY,
  NAV_GROUPS_KEY,
  attentionTotal,
  badgeCount,
  companyTabTitle,
  footerSections,
  groupIsOpen,
  groupOfSection,
  readCollapsedPreference,
  readGroupPreferences,
  sidebarGroups,
  writeCollapsedPreference,
  writeGroupPreferences,
  type NavStorage,
} from "./appNavigation.js";
import { SECTION_GROUPS, type SectionGroup } from "./sections.js";
import type { SubpageViewer } from "./subpages.js";

const OWNER: SubpageViewer = { role: "owner", financeAccess: "full" };
const MEMBER_NONE: SubpageViewer = { role: "member", financeAccess: "none" };

function memoryStorage(initial: Record<string, string> = {}): NavStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

const refusing: NavStorage = {
  getItem: () => {
    throw new Error("storage is off");
  },
  setItem: () => {
    throw new Error("storage is off");
  },
};

describe("sidebar groups", () => {
  test("list every section an owner can open, Settings at the foot rather than in the list", () => {
    const listed = sidebarGroups(OWNER).flatMap((group) => group.items.map((item) => item.key));
    const footer = footerSections(OWNER).map((item) => item.key);
    assert.deepEqual(footer, ["settings"]);
    assert.deepEqual(
      [...listed, ...footer],
      SECTION_GROUPS.flatMap((group) => group.items.map((item) => item.key)),
    );
    assert.ok(sidebarGroups(OWNER).every((group) => group.id !== FOOTER_GROUP_ID));
  });

  test("leave out what a Member without Finance access can't open", () => {
    const keys = sidebarGroups(MEMBER_NONE).flatMap((group) => group.items.map((i) => i.key));
    for (const key of ["finance", "customers", "dataRooms"]) {
      assert.equal(keys.includes(key as never), false, `${key} offered to a Member`);
    }
    assert.ok(keys.includes("revenue"), "Revenue stays, as the way a Member reaches accounts");
  });

  test("start with Home and what waits on you, the rest grouped by what it is for", () => {
    const [first] = sidebarGroups(OWNER);
    assert.deepEqual(
      first.items.map((item) => item.key),
      ["home", "decisions", "goals", "tldrs"],
    );
    assert.equal(first.startsClosed, undefined, "the first group is always open");
  });

  test("give every group a unique id the sidebar can remember it by", () => {
    const ids = SECTION_GROUPS.map((group) => group.id);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
    assert.equal(new Set(ids).size, ids.length);
  });

  test("find the group a section lives in", () => {
    const groups = sidebarGroups(OWNER);
    assert.equal(groupOfSection(groups, "revenue")?.id, "business");
    assert.equal(groupOfSection(groups, "settings"), null, "Settings is in the footer");
  });
});

describe("group open state", () => {
  const closedByDefault: SectionGroup = {
    id: "business",
    label: "Business",
    startsClosed: true,
    items: [],
  };
  const openByDefault: SectionGroup = { id: "work", label: "Work", items: [] };

  test("follows the catalogue until the person chooses", () => {
    assert.equal(groupIsOpen(closedByDefault, {}), false);
    assert.equal(groupIsOpen(openByDefault, {}), true);
  });

  test("follows the person's choice once made, either way", () => {
    assert.equal(groupIsOpen(closedByDefault, { business: true }), true);
    assert.equal(groupIsOpen(openByDefault, { work: false }), false);
  });

  test("keeps a group it can't remember open", () => {
    assert.equal(groupIsOpen({ label: "You", items: [], startsClosed: true }, {}), true);
  });
});

describe("stored preferences", () => {
  test("round-trip the collapsed choice, and read no choice as null", () => {
    const storage = memoryStorage();
    assert.equal(readCollapsedPreference(storage), null);
    writeCollapsedPreference(storage, true);
    assert.equal(storage.values[NAV_COLLAPSED_KEY], "1");
    assert.equal(readCollapsedPreference(storage), true);
    writeCollapsedPreference(storage, false);
    assert.equal(readCollapsedPreference(storage), false);
    assert.equal(readCollapsedPreference(memoryStorage({ [NAV_COLLAPSED_KEY]: "maybe" })), null);
  });

  test("round-trip group choices and ignore anything that isn't one", () => {
    const storage = memoryStorage();
    writeGroupPreferences(storage, { business: true, knowledge: false });
    assert.deepEqual(readGroupPreferences(storage), { business: true, knowledge: false });

    for (const raw of ["not json", "[true]", "null", '"open"']) {
      assert.deepEqual(readGroupPreferences(memoryStorage({ [NAV_GROUPS_KEY]: raw })), {});
    }
    assert.deepEqual(
      readGroupPreferences(memoryStorage({ [NAV_GROUPS_KEY]: '{"work":false,"ai":"yes"}' })),
      { work: false },
    );
  });

  test("work without storage at all", () => {
    assert.equal(readCollapsedPreference(null), null);
    assert.equal(readCollapsedPreference(refusing), null);
    assert.deepEqual(readGroupPreferences(refusing), {});
    assert.doesNotThrow(() => writeCollapsedPreference(refusing, true));
    assert.doesNotThrow(() => writeGroupPreferences(refusing, { work: true }));
  });
});

describe("the number beside the Decision stack", () => {
  test("adds the stack's rows and every queue the person may act on", () => {
    assert.equal(
      attentionTotal({
        decisions: 2,
        reviews: 1,
        elsewhere: {
          approvals: 3,
          revisions: 1,
          initiatives: 0,
          todoReviews: 2,
          financeProposals: 4,
        },
      }),
      13,
    );
  });

  test("counts nothing for a queue that isn't theirs", () => {
    assert.equal(
      attentionTotal({
        decisions: 1,
        reviews: null,
        elsewhere: {
          approvals: null,
          revisions: null,
          initiatives: null,
          todoReviews: 1,
          financeProposals: null,
        },
      }),
      2,
    );
  });

  test("is unknown until the counts load", () => {
    assert.equal(attentionTotal(null), null);
  });

  test("reads as a short badge past 99", () => {
    assert.equal(badgeCount(7), "7");
    assert.equal(badgeCount(99), "99");
    assert.equal(badgeCount(100), "99+");
  });
});

describe("the tab title", () => {
  test("names the section, then the company", () => {
    assert.equal(companyTabTitle("/c/acme", "Acme"), "Home · Acme");
    assert.equal(companyTabTitle("/c/acme/decisions/history", "Acme"), "Decision stack · Acme");
    assert.equal(companyTabTitle("/c/acme/employees/ada/chat", "Acme"), "AI Employees · Acme");
  });

  test("calls the first-run guide what it is", () => {
    assert.equal(companyTabTitle("/c/acme/onboarding", "Acme"), "Set up · Acme");
  });
});
