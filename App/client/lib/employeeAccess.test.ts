import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ACCESS_BULK_MAX_ITEMS,
  ACCESS_GROUPS,
  ACCESS_KINDS,
  type AccessBulkResponse,
  type AccessItem,
  type AccessKind,
  type EmployeeAccessListing,
} from "../../shared/employeeAccess.js";
import {
  DEFAULT_ACCESS_FILTERS,
  accessBadge,
  actionLabel,
  bulkRequests,
  countGrants,
  defaultLevels,
  filterAccessItems,
  filtersActive,
  groupAccessItems,
  hasAccess,
  kindCount,
  mergeBulkResponses,
  planBulk,
  pruneSelection,
  reportBulk,
  selectableKeys,
  selectedItems,
  selectionState,
  setSelected,
  sharedLockReason,
} from "./employeeAccess.js";

function row(kind: AccessKind, id: string | null, fields: Partial<AccessItem> = {}): AccessItem {
  return {
    key: id ? `${kind}:${id}` : kind,
    kind,
    resourceId: id,
    label: fields.label ?? `${kind} ${id ?? ""}`.trim(),
    detail: null,
    href: null,
    grant: null,
    inherited: null,
    hidden: false,
    canChange: true,
    reason: null,
    ...fields,
  };
}

const granted = (level: string | null) => ({ level, byDefault: false });

const mailbox = row("mail_account", "m1", { label: "ops@acme.test", detail: "Gmail", grant: granted("draft") });
const support = row("mail_account", "m2", { label: "support@acme.test", detail: "Gmail" });
const notebook = row("notebook", "nb1", { label: "Playbooks", grant: granted("write") });
const note = row("note", "n1", {
  label: "Refund policy",
  detail: "Playbooks",
  inherited: { level: "write", fromKind: "notebook", fromId: "nb1", fromLabel: "Playbooks" },
});
const base = row("base", "b1", { label: "Leads", grant: granted(null) });
const vault = row("vault_item", "v1", {
  label: "Bank portal",
  hidden: true,
  canChange: false,
  reason: "Only the person who added this item, or an owner or admin, can see and change who uses it.",
});
const theirBrowser = row("member_browser", "mb2", {
  label: "Bob's browser",
  hidden: true,
  canChange: false,
  reason: "Only Bob can grant this browser — it runs on their computer.",
});
const routines = row("routines", null, { label: "Routines", grant: { level: "write", byDefault: true } });
const finance = row("finance", null, { label: "Finance" });
const revenue = row("revenue", null, {
  label: "Revenue",
  canChange: false,
  reason: "Only owners and admins can change Revenue access.",
});
const ITEMS = [mailbox, support, notebook, note, base, vault, theirBrowser, routines, finance, revenue];

const LISTING: EmployeeAccessListing = {
  employee: { id: "e1", name: "Ada", slug: "ada" },
  items: ITEMS,
  kinds: ACCESS_KINDS.map((kind) => ({
    kind,
    truncated: kind === "note",
    unavailable: kind === "connection" ? "Needs a browser session." : null,
  })),
  limit: 250,
};

const keysOf = (items: readonly AccessItem[]) => items.map((item) => item.key);

describe("filters", () => {
  test("the defaults keep every row", () => {
    assert.deepEqual(filterAccessItems(ITEMS, DEFAULT_ACCESS_FILTERS), ITEMS);
    assert.equal(filtersActive(DEFAULT_ACCESS_FILTERS), false);
  });

  test("a search needs every word somewhere in the row, its second line or its kind", () => {
    const find = (query: string) => keysOf(filterAccessItems(ITEMS, { ...DEFAULT_ACCESS_FILTERS, query }));
    assert.deepEqual(find("refund"), ["note:n1"]);
    assert.deepEqual(find("playbooks"), ["notebook:nb1", "note:n1"], "a note is found by its notebook");
    assert.deepEqual(find("mailbox"), ["mail_account:m1", "mail_account:m2"], "by kind");
    assert.deepEqual(find("gmail support"), ["mail_account:m2"]);
    assert.deepEqual(find("  REFUND   policy "), ["note:n1"], "case and spacing do not matter");
    assert.deepEqual(find("refund leads"), []);
    assert.equal(filtersActive({ ...DEFAULT_ACCESS_FILTERS, query: " x " }), true);
  });

  test("a kind filter keeps one group", () => {
    const notes = filterAccessItems(ITEMS, { ...DEFAULT_ACCESS_FILTERS, group: "notes" });
    assert.deepEqual(keysOf(notes), ["notebook:nb1", "note:n1"]);
    const sections = filterAccessItems(ITEMS, { ...DEFAULT_ACCESS_FILTERS, group: "sections" });
    assert.deepEqual(keysOf(sections), ["finance", "revenue"]);
    assert.equal(filtersActive({ ...DEFAULT_ACCESS_FILTERS, group: "notes" }), true);
  });

  test("granted counts inherited and default access; rows the viewer cannot see are in neither", () => {
    assert.equal(hasAccess(note), true);
    assert.equal(hasAccess(routines), true);
    assert.equal(hasAccess(support), false);
    const withAccess = filterAccessItems(ITEMS, { ...DEFAULT_ACCESS_FILTERS, status: "granted" });
    assert.deepEqual(keysOf(withAccess), ["mail_account:m1", "notebook:nb1", "note:n1", "base:b1", "routines"]);
    const without = filterAccessItems(ITEMS, { ...DEFAULT_ACCESS_FILTERS, status: "not_granted" });
    assert.deepEqual(keysOf(without), ["mail_account:m2", "finance", "revenue"]);
    for (const hidden of [vault, theirBrowser]) {
      assert.equal(withAccess.includes(hidden), false);
      assert.equal(without.includes(hidden), false);
    }
  });

  test("filters combine", () => {
    const rows = filterAccessItems(ITEMS, { query: "gmail", group: "mail", status: "not_granted" });
    assert.deepEqual(keysOf(rows), ["mail_account:m2"]);
  });
});

describe("groups", () => {
  test("every group in catalogue order, with its filtered rows and its own counts", () => {
    const filtered = filterAccessItems(ITEMS, { ...DEFAULT_ACCESS_FILTERS, query: "refund" });
    const groups = groupAccessItems(LISTING, filtered);
    assert.deepEqual(
      groups.map((view) => view.group.key),
      ACCESS_GROUPS.map((group) => group.key),
    );
    const notes = groups.find((view) => view.group.key === "notes")!;
    assert.deepEqual(keysOf(notes.items), ["note:n1"]);
    assert.equal(notes.total, 2, "counts ignore the filter");
    assert.equal(notes.withAccess, 2, "the notebook and the page it covers");
    assert.equal(notes.truncated, true);
    const mail = groups.find((view) => view.group.key === "mail")!;
    assert.deepEqual([mail.total, mail.withAccess, mail.items.length], [2, 1, 0]);
    const vaultGroup = groups.find((view) => view.group.key === "vault")!;
    assert.equal(vaultGroup.withAccess, 0, "a hidden row is never counted as access");
  });

  test("a group is unavailable only when none of its kinds can be listed", () => {
    const groups = groupAccessItems(LISTING, ITEMS);
    assert.equal(groups.find((view) => view.group.key === "connections")?.unavailable, "Needs a browser session.");
    assert.equal(groups.find((view) => view.group.key === "notes")?.unavailable, null);
    const partial: EmployeeAccessListing = {
      ...LISTING,
      kinds: LISTING.kinds.map((entry) =>
        entry.kind === "chart" ? { ...entry, unavailable: "No." } : entry,
      ),
    };
    assert.equal(groupAccessItems(partial, ITEMS).find((view) => view.group.key === "explore")?.unavailable, null);
  });

  test("counts the Grants someone gave, not defaults or inherited access", () => {
    assert.equal(countGrants(ITEMS), 3);
  });

  test("says a shared lock once for the group, and only when every row shares it", () => {
    const why = "Only owners and admins can grant Mailboxes.";
    const locked = (id: string) => row("mail_account", id, { canChange: false, reason: why });
    assert.equal(sharedLockReason([locked("a"), locked("b")]), why);
    assert.equal(sharedLockReason([locked("a")]), null, "one row says it itself");
    assert.equal(sharedLockReason([locked("a"), mailbox]), null, "a changeable row breaks it");
    assert.equal(
      sharedLockReason([locked("a"), row("mail_account", "c", { canChange: false, reason: "Other." })]),
      null,
    );
    assert.equal(sharedLockReason([finance, revenue]), null);
  });
});

describe("selection", () => {
  test("only rows the viewer may change can be ticked", () => {
    assert.deepEqual(selectableKeys(ITEMS).includes(vault.key), false);
    assert.deepEqual(selectableKeys(ITEMS).includes(revenue.key), false);
    assert.equal(selectableKeys(ITEMS).length, 7);
  });

  test("a tick-all box is none, some or all of what can be ticked", () => {
    const group = [finance, revenue];
    assert.equal(selectionState(group, new Set()), "none");
    assert.equal(selectionState(group, new Set([finance.key])), "all", "revenue cannot be ticked");
    const mail = [mailbox, support];
    assert.equal(selectionState(mail, new Set([mailbox.key])), "some");
    assert.equal(selectionState([vault], new Set()), "none");
  });

  test("ticking all adds only changeable rows, and unticking leaves the rest alone", () => {
    const on = setSelected(new Set(["elsewhere"]), ITEMS, true);
    assert.equal(on.has(vault.key), false);
    assert.equal(on.has(mailbox.key), true);
    assert.equal(on.has("elsewhere"), true);
    const off = setSelected(on, [mailbox, support], false);
    assert.equal(off.has(mailbox.key), false);
    assert.equal(off.has(notebook.key), true);
  });

  test("a reload drops ticks on rows that are gone or no longer changeable", () => {
    const pruned = pruneSelection(new Set([mailbox.key, "gone:1", vault.key]), ITEMS);
    assert.deepEqual([...pruned], [mailbox.key]);
  });

  test("the ticked rows come back in listing order", () => {
    assert.deepEqual(keysOf(selectedItems(ITEMS, new Set([finance.key, mailbox.key]))), [mailbox.key, finance.key]);
  });
});

describe("planning a bulk change", () => {
  test("granting sends what is not held, leaves what is, and says why it left the rest", () => {
    const plan = planBulk("grant", [mailbox, support, note, base, routines, finance, revenue, vault]);
    assert.deepEqual(keysOf(plan.apply), ["mail_account:m2", "note:n1", "finance"]);
    assert.deepEqual(
      plan.unchanged.map((entry) => entry.item.key),
      ["mail_account:m1", "base:b1", "routines"],
    );
    assert.deepEqual(
      plan.skipped.map((entry) => [entry.item.key, entry.reason]),
      [
        ["revenue", "Only owners and admins can change Revenue access."],
        ["vault_item:v1", vault.reason],
      ],
    );
    assert.deepEqual(plan.levelKinds, [
      { kind: "mail_account", count: 1 },
      { kind: "note", count: 1 },
      { kind: "finance", count: 1 },
    ]);
  });

  test("a row whose Grants the viewer cannot see is sent: the server answers for it", () => {
    const hiddenFinance = row("finance", null, { hidden: true });
    assert.deepEqual(keysOf(planBulk("grant", [hiddenFinance]).apply), ["finance"]);
    assert.deepEqual(keysOf(planBulk("revoke", [hiddenFinance]).apply), ["finance"]);
    assert.deepEqual(keysOf(planBulk("set_level", [hiddenFinance], { finance: "read" }).apply), ["finance"]);
  });

  test("changing a level skips kinds without levels and rows not held; same level is unchanged", () => {
    const plan = planBulk("set_level", [mailbox, support, base, routines, notebook], {
      mail_account: "draft",
      routines: "run",
      notebook: "read",
    });
    assert.deepEqual(keysOf(plan.apply), ["routines", "notebook:nb1"]);
    assert.deepEqual(plan.unchanged.map((entry) => entry.item.key), ["mail_account:m1"]);
    assert.deepEqual(plan.skipped.map((entry) => entry.item.key), ["mail_account:m2", "base:b1"]);
    // The mailbox already at Draft keeps its picker, so it can still be moved.
    assert.deepEqual(plan.levelKinds, [
      { kind: "mail_account", count: 1 },
      { kind: "notebook", count: 1 },
      { kind: "routines", count: 1 },
    ]);
  });

  test("revoking leaves what is not held, and never revokes what every employee holds", () => {
    const plan = planBulk("revoke", [mailbox, support, routines, base]);
    assert.deepEqual(keysOf(plan.apply), ["mail_account:m1", "base:b1"]);
    assert.deepEqual(plan.unchanged.map((entry) => entry.item.key), ["mail_account:m2"]);
    assert.deepEqual(plan.skipped.map((entry) => entry.reason), ["Every AI Employee holds a Routines level."]);
    assert.deepEqual(plan.levelKinds, []);
  });

  test("each kind starts at its own default level", () => {
    assert.deepEqual(defaultLevels(["mail_account", "note", "base", "finance", "vault_item"]), {
      mail_account: "draft",
      note: "write",
      finance: "read",
      vault_item: "use",
    });
  });

  test("builds the request bodies, in parts the server takes at once", () => {
    const many = Array.from({ length: ACCESS_BULK_MAX_ITEMS + 5 }, (_, i) => row("note", `n${i}`));
    const freshBase = row("base", "b1", { label: "Leads" });
    const plan = planBulk("grant", [...many, finance, freshBase]);
    const bodies = bulkRequests(plan, { note: "read" });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].items.length, ACCESS_BULK_MAX_ITEMS);
    assert.ok(bodies.every((body) => body.action === "grant"));
    const flat = bodies.flatMap((body) => body.items);
    assert.deepEqual(flat[0], { kind: "note", resourceId: "n0", level: "read" });
    assert.deepEqual(flat.find((item) => item.kind === "finance"), { kind: "finance", level: "read" });
    assert.deepEqual(flat.find((item) => item.kind === "base"), { kind: "base", resourceId: "b1" });
    const revoke = bulkRequests(planBulk("revoke", [mailbox]), { mail_account: "send" });
    assert.deepEqual(revoke[0].items, [{ kind: "mail_account", resourceId: "m1" }]);
  });
});

describe("reading the outcome", () => {
  const response = (results: AccessBulkResponse["results"]): AccessBulkResponse => {
    const summary = { granted: 0, updated: 0, revoked: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const result of results) summary[result.outcome] += 1;
    return { action: "grant", results, summary };
  };
  const result = (key: string, kind: AccessKind, outcome: AccessBulkResponse["results"][number]["outcome"], message: string | null = null) => ({
    key,
    kind,
    resourceId: key.includes(":") ? key.split(":")[1] : null,
    outcome,
    level: null,
    message,
    status: outcome === "failed" ? 403 : null,
  });

  test("several parts read as one", () => {
    const merged = mergeBulkResponses("grant", [
      response([result("note:n1", "note", "granted")]),
      response([result("finance", "finance", "failed", "No."), result("base:b1", "base", "unchanged")]),
    ]);
    assert.equal(merged.results.length, 3);
    assert.deepEqual(merged.summary, { granted: 1, updated: 0, revoked: 0, unchanged: 1, skipped: 0, failed: 1 });
  });

  test("names each refused row, with the reason its kind gave", () => {
    const report = reportBulk(
      response([
        result("note:n1", "note", "granted"),
        result("finance", "finance", "failed", "Only owners and admins can change Finance access."),
        result("vault_item:zz", "vault_item", "failed"),
        result("base:b1", "base", "unchanged"),
        result("routines", "routines", "skipped"),
      ]),
      ITEMS,
    );
    assert.equal(report.done, 1);
    assert.equal(report.untouched, 2);
    assert.deepEqual(report.failures, [
      { key: "finance", label: "Finance", message: "Only owners and admins can change Finance access." },
      { key: "vault_item:zz", label: "Vault item", message: "The change was refused." },
    ]);
  });

  test("labels read naturally", () => {
    assert.equal(actionLabel("grant", 1), "Grant 1 item");
    assert.equal(actionLabel("set_level", 3), "Change 3 items");
    assert.equal(actionLabel("revoke", 2), "Revoke 2 items");
    assert.equal(kindCount("note", 1), "1 Note");
    assert.equal(kindCount("mail_account", 2), "2 Mailboxes");
  });
});

describe("a row's access, in words", () => {
  test("says the level held, how it is held, or that it is not shown", () => {
    assert.deepEqual(accessBadge(mailbox), { text: "Draft", tone: "granted" });
    assert.deepEqual(accessBadge(base), { text: "Granted", tone: "granted" });
    assert.equal(accessBadge(routines).text, "Read + write · default");
    assert.equal(accessBadge(routines).tone, "default");
    assert.equal(accessBadge(note).text, "Can edit via notebook");
    assert.equal(accessBadge(note).tone, "inherited");
    assert.match(accessBadge(note).title ?? "", /Playbooks/);
    assert.deepEqual(accessBadge(support), { text: "No access", tone: "none" });
    assert.equal(accessBadge(vault).text, "Not shown to you");
    assert.equal(accessBadge(vault).title, vault.reason);
  });
});
