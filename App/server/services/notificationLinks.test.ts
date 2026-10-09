import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { companyNotificationLink, needsCompanyPrefix } from "../../shared/notificationLink.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { createNotifications } from "./notifications.js";

/**
 * A notification opens the page it is about, in the company it is about.
 * Revision, initiative, goal, budget and autonomy notifications were written
 * with bare section paths ("/goals"), which the router's catch-all sent to the
 * first company's Home. Every row is now stored with its company's prefix,
 * and an older bare row is prefixed when it is opened.
 */

describe("companyNotificationLink", () => {
  test("a bare section path goes inside the company", () => {
    assert.equal(companyNotificationLink("acme", "/goals"), "/c/acme/goals");
    assert.equal(companyNotificationLink("acme", "/revisions"), "/c/acme/revisions");
    assert.equal(
      companyNotificationLink("acme", "/employees/ada?tab=settings#autonomy"),
      "/c/acme/employees/ada?tab=settings#autonomy",
    );
    assert.equal(companyNotificationLink("acme", "/"), "/c/acme/");
  });

  test("a link that already says where it goes is left as written", () => {
    assert.equal(companyNotificationLink("acme", "/c/globex/goals"), "/c/globex/goals");
    assert.equal(companyNotificationLink("acme", "/c"), "/c");
    assert.equal(companyNotificationLink("acme", "/invite/abc"), "/invite/abc");
    assert.equal(companyNotificationLink("acme", "/link-chat/id/token"), "/link-chat/id/token");
  });

  test("nothing that is not a plain App path is rewritten", () => {
    assert.equal(companyNotificationLink("acme", "https://example.com/x"), "https://example.com/x");
    assert.equal(companyNotificationLink("acme", "//evil.example/x"), "//evil.example/x");
    assert.equal(companyNotificationLink("acme", null), null);
    assert.equal(companyNotificationLink("acme", undefined), null);
    assert.equal(companyNotificationLink("acme", ""), null);
  });

  test("a section whose name merely starts like an exempt one still gets the prefix", () => {
    assert.equal(needsCompanyPrefix("/customers"), true);
    assert.equal(needsCompanyPrefix("/invites"), true);
    assert.equal(needsCompanyPrefix("/c/acme"), false);
  });
});

describe("createNotifications", () => {
  before(initTestDb);
  after(closeTestDb);

  let acme: Company;
  let globex: Company;
  let user: User;

  beforeEach(async () => {
    await resetTestDb();
    user = await insert(User, {
      email: "morgan@example.com",
      name: "Morgan",
      passwordHash: "x",
      sessionVersion: 0,
    });
    acme = await insert(Company, { name: "Acme", slug: "acme", ownerId: user.id });
    globex = await insert(Company, { name: "Globex", slug: "globex", ownerId: user.id });
  });

  async function stored(): Promise<Map<string, string | null>> {
    const rows = await AppDataSource.getRepository(Notification).find();
    return new Map(rows.map((row) => [row.title, row.link]));
  }

  test("a bare section path is stored inside its own company", async () => {
    await createNotifications([
      { companyId: acme.id, userId: user.id, kind: "goal_achieved", title: "goal", link: "/goals" },
      {
        companyId: globex.id,
        userId: user.id,
        kind: "revision_pending",
        title: "revision",
        link: "/revisions",
      },
    ]);
    const links = await stored();
    assert.equal(links.get("goal"), "/c/acme/goals");
    assert.equal(links.get("revision"), "/c/globex/revisions", "each row takes its own company");
  });

  test("a prefixed link, and no link at all, are stored as written", async () => {
    await createNotifications([
      {
        companyId: acme.id,
        userId: user.id,
        kind: "approval_pending",
        title: "approval",
        link: "/c/acme/approvals",
      },
      { companyId: acme.id, userId: user.id, kind: "mention", title: "none" },
    ]);
    const links = await stored();
    assert.equal(links.get("approval"), "/c/acme/approvals");
    assert.equal(links.get("none"), null);
  });
});
