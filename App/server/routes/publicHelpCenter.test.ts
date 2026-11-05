import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { AuthRateLimit } from "../db/entities/AuthRateLimit.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { SupportArticle } from "../db/entities/SupportArticle.js";
import { SupportDraft } from "../db/entities/SupportDraft.js";
import { SupportSettings } from "../db/entities/SupportSettings.js";
import { SupportTicket } from "../db/entities/SupportTicket.js";
import { User } from "../db/entities/User.js";
import { createApp } from "../app.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import {
  HELP_CENTER_MISS_LIMIT,
  HELP_CENTER_SEARCH_LIMIT,
  helpCenterPagesRouter,
  helpCenterSecurityHeaders,
  publicHelpCenterRouter,
} from "./publicHelpCenter.js";
import { supportRouter } from "./support.js";

/**
 * A company's public help center, through the real routers over an in-memory
 * database, in `server/app.ts`'s order.
 *
 * Anyone can call this, so the tests are about what a stranger can learn. It stays
 * off until an owner or admin turns it on, off is the same answer as never having
 * existed, a draft never appears anywhere, and nothing an Article's row also holds
 * reaches an answer. SQLite forgives a malformed uuid where Postgres raises, so the
 * tests here pin what gets refused and `scripts/testSaasPostgres.ts` runs the same
 * requests against Postgres.
 */

/** The App's real shell, so these fail if its head stops looking the way the server expects. */
const SHELL = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/index.html"),
  "utf8",
);

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let admin: User;
let member: User;
let company: Company;
let other: Company;

before(async () => {
  await initTestDb();
  const app = express();
  app.use("/api/help", helpCenterSecurityHeaders);
  app.use("/help", helpCenterSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/help", publicHelpCenterRouter);
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", supportRouter);
  app.use(helpCenterPagesRouter({ loadTemplate: async () => SHELL }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});

async function person(email: string, target: Company, role: Role): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: target.id, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "o" });
  other = await insert(Company, { name: "Other", slug: "other", ownerId: "o" });
  owner = await person("owner@example.com", company, "owner");
  admin = await person("admin@example.com", company, "admin");
  member = await person("member@example.com", company, "member");
  actingUserId = null;
});

function patchSettings(body: unknown, who: User = owner) {
  actingUserId = who.id;
  return fetch(`${baseUrl}/api/companies/${company.id}/support/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function turnOn(): Promise<void> {
  const response = await patchSettings({ helpCenterEnabled: true });
  assert.equal(response.status, 200);
}

async function article(values: Partial<SupportArticle> = {}): Promise<SupportArticle> {
  return insert(SupportArticle, {
    companyId: company.id,
    title: "How refunds work",
    body: "Refunds take five days.",
    status: "published",
    publishedAt: new Date(),
    ...values,
  });
}

type Answer<T> = { status: number; body: T & { error?: string }; text: string; headers: Headers };

async function get<T = Record<string, unknown>>(urlPath: string): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${urlPath}`);
  const text = await response.text();
  let body = {} as T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    /* A page, not JSON. */
  }
  return { status: response.status, body: body as Answer<T>["body"], text, headers: response.headers };
}

type Card = { id: string; title: string; topic: { key: string; name: string } | null };
type Home = {
  companyName: string;
  topics: Array<{ key: string; name: string; articleCount: number }>;
  articles: { total: number; hasMore: boolean; nextCursor: string | null; rows: Card[] };
};
type SearchPage = {
  companyName: string;
  hasMore: boolean;
  nextCursor: string | null;
  rows: Array<Card & { excerpt: string }>;
};

/** Everything a client could notice about an answer, beyond the clock. */
function fingerprintOf(answer: Answer<unknown>): unknown {
  const headers = [...answer.headers.entries()].filter(([name]) => name !== "date");
  return { status: answer.status, text: answer.text, headers };
}

describe("off is the same as never having existed", () => {
  function pathsFor(slug: string, articleId: string): string[] {
    return [
      `/api/help/${slug}`,
      `/api/help/${slug}/articles`,
      `/api/help/${slug}/articles/${articleId}`,
      `/api/help/${slug}/search?q=refund`,
      `/help/${slug}`,
      `/help/${slug}/articles/${articleId}`,
    ];
  }

  test("a company nobody turned it on for, however it got there, reads like no company", async () => {
    const published = await article();
    const unknownId = randomUUID();

    // No settings row at all, then a row with the switch off, then a row switched back off.
    const states: Array<[string, () => Promise<void>]> = [
      ["no settings row", async () => {}],
      [
        "never turned on",
        async () => {
          assert.equal((await patchSettings({ ratingsEnabled: true })).status, 200);
        },
      ],
      [
        "turned on, then off",
        async () => {
          await turnOn();
          assert.equal((await patchSettings({ helpCenterEnabled: false })).status, 200);
        },
      ],
    ];
    for (const [state, arrange] of states) {
      await arrange();
      actingUserId = null;
      for (const [offPath, missingPath] of pathsFor("acme", published.id).map(
        (candidate, index) => [candidate, pathsFor("no-such-company", unknownId)[index]],
      )) {
        const off = await get(offPath);
        const missing = await get(missingPath);
        assert.equal(off.status, 404, `${state}: ${offPath}`);
        assert.deepEqual(
          fingerprintOf(off),
          fingerprintOf(missing),
          `${state}: ${offPath} answers differently from ${missingPath}`,
        );
      }
    }
  });

  test("a stranger asking writes nothing to the company", async () => {
    await article();
    actingUserId = null;
    assert.equal((await get("/api/help/acme")).status, 404);
    assert.equal((await get("/help/acme")).status, 404);
    assert.equal(await AppDataSource.getRepository(SupportSettings).count(), 0);
  });

  test("turning it on serves the pages, and turning it off takes them down at once", async () => {
    const published = await article();
    await turnOn();
    actingUserId = null;
    assert.equal((await get("/api/help/acme")).status, 200);
    assert.equal((await get(`/api/help/acme/articles/${published.id}`)).status, 200);
    assert.equal((await get("/api/help/acme/search?q=refund")).status, 200);
    assert.equal((await get("/help/acme")).status, 200);
    assert.equal((await get(`/help/acme/articles/${published.id}`)).status, 200);

    assert.equal((await patchSettings({ helpCenterEnabled: false })).status, 200);
    actingUserId = null;
    for (const urlPath of pathsFor("acme", published.id)) {
      assert.equal((await get(urlPath)).status, 404, urlPath);
    }
  });

  test("only owners and admins hold the switch, and the audit log says which way it went", async () => {
    assert.equal((await patchSettings({ helpCenterEnabled: true }, member)).status, 403);
    assert.equal((await get("/api/help/acme")).status, 404);

    assert.equal((await patchSettings({ helpCenterEnabled: true }, admin)).status, 200);
    actingUserId = null;
    assert.equal((await get("/api/help/acme")).status, 200);

    const event = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: company.id,
      action: "support_settings.update",
    });
    assert.equal(JSON.parse(event.metadataJson).helpCenterEnabled, true);
  });

  test("the settings answer says where it lives, on or off, for any Member to read", async () => {
    actingUserId = member.id;
    const response = await fetch(`${baseUrl}/api/companies/${company.id}/support/settings`);
    const { settings } = (await response.json()) as {
      settings: { helpCenterEnabled: boolean; helpCenterUrl: string };
    };
    assert.equal(settings.helpCenterEnabled, false);
    assert.match(settings.helpCenterUrl, /\/help\/acme$/);
  });
});

describe("only published Articles appear", () => {
  test("a draft or an archived Article is never listed, found or opened", async () => {
    const published = await article({ title: "Published words", body: "Published sapphire." });
    const draft = await article({
      title: "Draft sapphire title",
      body: "Draft ruby words.",
      status: "draft",
      publishedAt: null,
      topicKey: "billing",
    });
    const archived = await article({
      title: "Archived sapphire title",
      body: "Archived emerald words.",
      status: "archived",
      topicKey: "account",
    });
    await turnOn();
    actingUserId = null;

    const home = await get<Home>("/api/help/acme");
    assert.deepEqual(
      home.body.articles.rows.map((row) => row.id),
      [published.id],
    );
    assert.equal(home.body.articles.total, 1);
    assert.deepEqual(home.body.topics, [], "a Topic with only a draft in it stays private");

    const list = await get<{ rows: Card[] }>("/api/help/acme/articles");
    assert.deepEqual(
      list.body.rows.map((row) => row.id),
      [published.id],
    );

    for (const word of ["ruby", "emerald", "Draft", "Archived"]) {
      const found = await get<SearchPage>(`/api/help/acme/search?q=${word}`);
      assert.equal(found.status, 200, word);
      assert.deepEqual(found.body.rows, [], `"${word}" is only in Articles nobody may read`);
    }
    const shared = await get<SearchPage>("/api/help/acme/search?q=sapphire");
    assert.deepEqual(
      shared.body.rows.map((row) => row.id),
      [published.id],
    );

    const missing = await get(`/api/help/acme/articles/${randomUUID()}`);
    assert.equal(missing.status, 404);
    for (const hidden of [draft, archived]) {
      const answer = await get(`/api/help/acme/articles/${hidden.id}`);
      assert.deepEqual(fingerprintOf(answer), fingerprintOf(missing), hidden.status);
      assert.equal((await get(`/help/acme/articles/${hidden.id}`)).status, 404, hidden.status);
      for (const text of [home.text, list.text, shared.text]) {
        assert.ok(!text.includes(hidden.id), `${hidden.status} id must not appear`);
      }
    }
  });

  test("taking an Article back takes it down at once", async () => {
    const published = await article();
    await turnOn();
    actingUserId = null;
    assert.equal((await get(`/api/help/acme/articles/${published.id}`)).status, 200);
    await AppDataSource.getRepository(SupportArticle).update(
      { id: published.id },
      { status: "draft" },
    );
    assert.equal((await get(`/api/help/acme/articles/${published.id}`)).status, 404);
    assert.deepEqual((await get<SearchPage>("/api/help/acme/search?q=refund")).body.rows, []);
  });

  test("another company's Article is not here, whatever its status", async () => {
    const theirs = await article({ companyId: other.id, title: "Their refund" });
    await turnOn();
    actingUserId = null;
    assert.equal((await get(`/api/help/acme/articles/${theirs.id}`)).status, 404);
    assert.deepEqual((await get<SearchPage>("/api/help/acme/search?q=refund")).body.rows, []);
    assert.deepEqual((await get<Home>("/api/help/acme")).body.articles.rows, []);
    assert.equal((await get("/api/help/other")).status, 404, "Other never turned theirs on");
  });
});

describe("nothing internal leaks", () => {
  test("a row answers its own public fields and nothing else", async () => {
    const ticketId = randomUUID();
    const authorEmployeeId = randomUUID();
    const authorUserId = randomUUID();
    const published = await article({
      topicKey: "billing",
      sourceTicketId: ticketId,
      createdByEmployeeId: authorEmployeeId,
      createdByUserId: authorUserId,
      citedCount: 41,
      lastCitedAt: new Date(),
    });
    await turnOn();
    actingUserId = null;

    const home = await get<Home>("/api/help/acme");
    assert.deepEqual(Object.keys(home.body).sort(), ["articles", "companyName", "topics"]);
    assert.deepEqual(Object.keys(home.body.articles.rows[0]).sort(), ["id", "title", "topic"]);
    const found = await get<SearchPage>("/api/help/acme/search?q=refund");
    assert.deepEqual(Object.keys(found.body.rows[0]).sort(), ["excerpt", "id", "title", "topic"]);
    const read = await get<{ companyName: string; article: Record<string, unknown> }>(
      `/api/help/acme/articles/${published.id}`,
    );
    assert.deepEqual(Object.keys(read.body).sort(), ["article", "companyName"]);
    assert.deepEqual(Object.keys(read.body.article).sort(), [
      "body",
      "id",
      "title",
      "topic",
      "updatedAt",
    ]);

    for (const answer of [home, found, read]) {
      for (const secret of [ticketId, authorEmployeeId, authorUserId, "citedCount", "status"]) {
        assert.ok(!answer.text.includes(secret), `${secret} must not reach the public`);
      }
    }
  });

  test("a Topic is a name, and only once it has a published Article", async () => {
    assert.equal(
      (
        await patchSettings({
          topics: [
            {
              name: "Refund escalations",
              description: "Send these to Olive, she handles the angry ones.",
              autoReply: true,
              assigneeUserId: owner.id,
            },
            { name: "Quiet topic", description: "Nothing published here." },
            { name: "Account access", description: "When someone cannot sign in." },
          ],
        })
      ).status,
      200,
    );
    const settings = await AppDataSource.getRepository(SupportSettings).findOneByOrFail({
      companyId: company.id,
    });
    const [refunds, , access] = JSON.parse(settings.topicsJson ?? "[]") as Array<{ key: string }>;
    await article({ title: "B", topicKey: access.key });
    await article({ title: "A", topicKey: refunds.key });
    await article({ title: "C", topicKey: refunds.key });
    await article({ title: "Gone", topicKey: "topic_the_owners_removed" });
    await article({ title: "None", topicKey: null });
    await turnOn();
    actingUserId = null;

    const home = await get<Home>("/api/help/acme");
    assert.deepEqual(
      home.body.topics,
      [
        { key: refunds.key, name: "Refund escalations", articleCount: 2 },
        { key: access.key, name: "Account access", articleCount: 1 },
      ],
      "in the owners' order, and only those with an Article",
    );
    const topicOf = (title: string) =>
      home.body.articles.rows.find((row) => row.title === title)?.topic;
    assert.deepEqual(topicOf("A"), { key: refunds.key, name: "Refund escalations" });
    assert.equal(topicOf("Gone"), null);
    assert.equal(topicOf("None"), null);
    for (const secret of [
      "Send these to Olive",
      "When someone cannot sign in",
      "autoReply",
      "assignee",
      owner.id,
      "Quiet topic",
      "topic_the_owners_removed",
    ]) {
      assert.ok(!home.text.includes(secret), `${secret} must not reach the public`);
    }
  });

  test("search reads Articles and nothing else the company holds", async () => {
    const ticket = await insert(SupportTicket, {
      companyId: company.id,
      number: 1,
      inboxId: randomUUID(),
      accountId: randomUUID(),
      subject: "Marmalade is broken",
      requesterEmail: "ada@customer.test",
      requesterName: "Ada",
      lastActivityAt: new Date(),
      status: "open",
      aiSummary: "Ada says marmalade is broken.",
    });
    await insert(SupportDraft, {
      companyId: company.id,
      ticketId: ticket.id,
      answerable: false,
      gapQuestion: "Why is marmalade broken?",
      body: "Marmalade draft reply.",
    });
    await article();
    await turnOn();
    actingUserId = null;
    for (const word of ["marmalade", "ada@customer.test"]) {
      assert.deepEqual((await get<SearchPage>(`/api/help/acme/search?q=${word}`)).body.rows, []);
    }
  });
});

describe("every 404 is one 404", () => {
  test("a malformed slug or id answers exactly like an unknown one", async () => {
    await article();
    await turnOn();
    actingUserId = null;
    const unknownSlug = await get("/api/help/no-such-company");
    const unknownId = await get(`/api/help/acme/articles/${randomUUID()}`);
    assert.equal(unknownSlug.status, 404);
    assert.deepEqual(fingerprintOf(unknownSlug), fingerprintOf(unknownId));
    for (const urlPath of [
      "/api/help/ACME",
      "/api/help/-acme",
      "/api/help/ac%00me",
      "/api/help/a%27%20OR%201%3D1",
      `/api/help/${"a".repeat(121)}`,
      "/api/help/no_such/articles",
      "/api/help/no_such/search?q=refund",
      "/api/help/acme/articles/not-a-uuid",
      "/api/help/acme/articles/123",
      "/api/help/acme/articles/%00",
      "/api/help/acme/articles/00000000-0000-0000-0000-00000000000g",
      "/api/help/acme/articles/00000000-0000-0000-0000-0000000000000",
    ]) {
      assert.deepEqual(fingerprintOf(await get(urlPath)), fingerprintOf(unknownSlug), urlPath);
    }
    for (const urlPath of [
      "/help",
      "/help/ACME",
      "/help/acme/articles/not-a-uuid",
      "/help/acme/nothing-here",
      "/help/acme/articles/not-a-uuid/more",
    ]) {
      assert.equal((await get(urlPath)).status, 404, urlPath);
    }
  });

  test("every answer stays out of caches and search engines and sets no cookie", async () => {
    const published = await article();
    await turnOn();
    actingUserId = null;
    for (const urlPath of [
      "/api/help/acme",
      "/api/help/acme/articles",
      `/api/help/acme/articles/${published.id}`,
      "/api/help/acme/search?q=refund",
      "/api/help/no-such-company",
      "/help/acme",
      `/help/acme/articles/${published.id}`,
      "/help/no-such-company",
    ]) {
      const { headers } = await get(urlPath);
      assert.equal(headers.get("x-robots-tag"), "noindex, nofollow", urlPath);
      assert.match(headers.get("cache-control") ?? "", /no-store/, urlPath);
      assert.equal(headers.get("set-cookie"), null, urlPath);
    }
  });
});

describe("search is safe to call from anywhere", () => {
  test("it is throttled, and being throttled does not stop anyone reading", async () => {
    const published = await article();
    await turnOn();
    actingUserId = null;
    for (let attempt = 0; attempt < HELP_CENTER_SEARCH_LIMIT.maxAttempts; attempt++) {
      assert.equal((await get("/api/help/acme/search?q=refund")).status, 200, `search ${attempt}`);
    }
    const refused = await get("/api/help/acme/search?q=refund");
    assert.equal(refused.status, 429);
    assert.match(refused.body.error ?? "", /Too many searches/);
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
    assert.equal((await get("/api/help/acme")).status, 200);
    assert.equal((await get(`/api/help/acme/articles/${published.id}`)).status, 200);
  });

  test("words match literally, whatever they are", async () => {
    await article({ title: "Plain", body: "Nothing to see." });
    const percent = await article({ title: "Discounts", body: "Save 100% today." });
    const snake = await article({ title: "Fields", body: "Set the user_id field." });
    await turnOn();
    actingUserId = null;
    const ids = async (q: string) =>
      (await get<SearchPage>(`/api/help/acme/search?q=${encodeURIComponent(q)}`)).body.rows.map(
        (row) => row.id,
      );
    assert.deepEqual(await ids("%"), [percent.id]);
    assert.deepEqual(await ids("user_id"), [snake.id]);
    assert.deepEqual(await ids("_"), [snake.id]);
    assert.deepEqual(await ids("' OR 1=1 --"), []);
    assert.deepEqual(await ids("100% save"), [percent.id], "words AND together, in any order");
    assert.deepEqual(await ids("\u0000save"), [percent.id], "a NUL is no part of a word");
    assert.deepEqual(await ids("\u0000"), [], "nothing left of it to search for");
  });

  test("a search it cannot read is refused the same way for any slug", async () => {
    await turnOn();
    actingUserId = null;
    for (const query of [
      "",
      "?q=",
      "?q=%20%20",
      `?q=${"a".repeat(201)}`,
      "?q=a&q=b",
      "?q[x]=a",
      "?q=a&unknown=1",
      "?q=a&limit=0",
      "?q=a&limit=abc",
    ]) {
      const on = await get(`/api/help/acme/search${query}`);
      const off = await get(`/api/help/other/search${query}`);
      const missing = await get(`/api/help/no-such-company/search${query}`);
      assert.equal(on.status, 400, query);
      assert.deepEqual(fingerprintOf(off), fingerprintOf(on), query);
      assert.deepEqual(fingerprintOf(missing), fingerprintOf(on), query);
    }
  });

  test("it shows the passage it matched, as plain text", async () => {
    const filler = "Words that have nothing to do with it. ".repeat(40);
    await article({
      title: "Exports",
      body: `${filler}To **export** your [data](https://example.test/x) use <b>Settings</b>. ${filler}`,
    });
    await article({ title: "Exporting by title", body: "# Heading\n\nThe start of it." });
    await turnOn();
    actingUserId = null;
    const { rows } = (await get<SearchPage>("/api/help/acme/search?q=export")).body;
    const inBody = rows.find((row) => row.title === "Exports")?.excerpt ?? "";
    assert.match(inBody, /^…/);
    assert.match(inBody, /To export your data use Settings/);
    assert.ok(inBody.length <= 202, `${inBody.length} characters`);
    assert.equal(rows.find((row) => row.title !== "Exports")?.excerpt, "Heading The start of it.");
  });

  test("a hostile body cannot make writing an excerpt slow", async () => {
    await article({ title: "Hostile", body: "![".repeat(40_000) });
    await turnOn();
    actingUserId = null;
    const started = Date.now();
    assert.equal((await get("/api/help/acme/search?q=hostile")).status, 200);
    assert.ok(Date.now() - started < 2_000, "bounded by the window it reads");
  });
});

describe("pages read on by keyset", () => {
  async function allPages<Row extends { id: string }>(
    urlPath: string,
    limit: number,
  ): Promise<{ rows: Row[]; pages: number }> {
    const rows: Row[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const separator = urlPath.includes("?") ? "&" : "?";
      const answer: Answer<{ rows: Row[]; nextCursor: string | null; hasMore: boolean }> =
        await get(
          `${urlPath}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
      assert.equal(answer.status, 200, answer.text);
      rows.push(...answer.body.rows);
      cursor = answer.body.nextCursor;
      assert.equal(answer.body.hasMore, cursor !== null);
      pages += 1;
    } while (cursor);
    return { rows, pages };
  }

  test("every Article comes once, by title, however the titles tie", async () => {
    const titles = ["Delta", "Alpha", "Same", "Same", "Same", "Bravo", "Charlie"];
    const made = await Promise.all(titles.map((title) => article({ title, body: "shared word" })));
    await turnOn();
    actingUserId = null;
    for (const urlPath of ["/api/help/acme/articles", "/api/help/acme/search?q=shared"]) {
      const { rows, pages } = await allPages<Card>(urlPath, 2);
      assert.equal(pages, 4, urlPath);
      assert.deepEqual(
        rows.map((row) => row.title),
        ["Alpha", "Bravo", "Charlie", "Delta", "Same", "Same", "Same"],
        urlPath,
      );
      assert.equal(new Set(rows.map((row) => row.id)).size, made.length, urlPath);
    }
  });

  test("an Article published between pages neither skips nor repeats a row", async () => {
    for (const title of ["Bravo", "Delta", "Foxtrot"]) await article({ title });
    await turnOn();
    actingUserId = null;
    const first = await get<{ rows: Card[]; nextCursor: string }>(
      "/api/help/acme/articles?limit=1",
    );
    assert.deepEqual(
      first.body.rows.map((row) => row.title),
      ["Bravo"],
    );
    await article({ title: "Alpha" });
    const rest = await get<{ rows: Card[]; nextCursor: string | null }>(
      `/api/help/acme/articles?limit=10&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    assert.deepEqual(
      rest.body.rows.map((row) => row.title),
      ["Delta", "Foxtrot"],
    );
  });

  test("a page asking for too much is cut, not refused", async () => {
    for (let index = 0; index < 55; index++) {
      await article({ title: `Article ${String(index).padStart(2, "0")}`, body: "shared" });
    }
    await turnOn();
    actingUserId = null;
    const found = await get<SearchPage>("/api/help/acme/search?q=shared&limit=5000");
    assert.equal(found.body.rows.length, 50);
    assert.equal(found.body.hasMore, true);
    assert.ok(!("total" in found.body), "a search does not read every Article twice to count");
  });

  test("a rewritten cursor is refused before it reaches the query", async () => {
    for (const title of ["Alpha", "Bravo", "Charlie"]) await article({ title, body: "shared" });
    await turnOn();
    actingUserId = null;
    for (const urlPath of [
      "/api/help/acme/articles?limit=1",
      "/api/help/acme/search?q=shared&limit=1",
    ]) {
      const page = await get<{ nextCursor: string }>(urlPath);
      const real = JSON.parse(Buffer.from(page.body.nextCursor, "base64url").toString("utf8")) as {
        k: unknown[];
      };
      assert.equal(real.k.length, 2);
      const rewritten = (k: unknown[]) =>
        Buffer.from(JSON.stringify({ ...real, k }), "utf8").toString("base64url");
      for (const k of [
        ["Alpha", "not-a-uuid"],
        ["Alpha", "'; DROP TABLE support_articles; --"],
        ["Al\u0000pha", real.k[1]],
        [1, real.k[1]],
        ["Alpha", 1],
        ["Alpha"],
        ["Alpha", real.k[1], "more"],
      ]) {
        const refused = await get(`${urlPath}&cursor=${rewritten(k)}`);
        assert.equal(refused.status, 400, JSON.stringify(k));
        assert.match(refused.body.error ?? "", /cursor/, JSON.stringify(k));
      }
      assert.equal((await get(`${urlPath}&cursor=not-a-cursor`)).status, 400);
      assert.equal((await get(`${urlPath}&cursor=${rewritten(real.k)}`)).status, 200);
    }
  });

  test("a cursor works only for the list and the words that issued it", async () => {
    for (const title of ["Alpha", "Bravo"]) await article({ title, body: "shared other" });
    await article({ title: "Theirs", body: "shared", companyId: other.id });
    await turnOn();
    await insert(SupportSettings, { companyId: other.id, helpCenterEnabled: true });
    actingUserId = null;
    const search = (await get<{ nextCursor: string }>("/api/help/acme/search?q=shared&limit=1"))
      .body.nextCursor;
    const list = (await get<{ nextCursor: string }>("/api/help/acme/articles?limit=1")).body
      .nextCursor;
    for (const urlPath of [
      `/api/help/acme/articles?cursor=${search}`,
      `/api/help/acme/search?q=shared&cursor=${list}`,
      `/api/help/acme/search?q=other&cursor=${search}`,
      `/api/help/other/search?q=shared&cursor=${search}`,
      `/api/help/other/articles?cursor=${list}`,
    ]) {
      assert.equal((await get(urlPath)).status, 400, urlPath);
    }
    assert.equal((await get(`/api/help/acme/search?q=%20shared%20&cursor=${search}`)).status, 200);
  });
});

describe("scanning is stopped, and reading leaves nothing behind", () => {
  test("misses count, however they are asked for, and then every read waits", async () => {
    const published = await article();
    await turnOn();
    actingUserId = null;
    const misses = [
      "/api/help/no-such-company",
      `/api/help/acme/articles/${randomUUID()}`,
      "/api/help/acme/articles/not-a-uuid",
      "/help/no-such-company",
    ];
    for (let attempt = 0; attempt < HELP_CENTER_MISS_LIMIT.maxAttempts; attempt++) {
      const urlPath = misses[attempt % misses.length];
      assert.equal((await get(urlPath)).status, 404, `${urlPath}, miss ${attempt}`);
    }
    for (const urlPath of [
      "/api/help/acme",
      "/api/help/no-such-company",
      `/api/help/acme/articles/${published.id}`,
      "/api/help/acme/articles/not-a-uuid",
      "/help/acme",
      "/help/no-such-company",
    ]) {
      const refused = await get(urlPath);
      assert.equal(refused.status, 429, urlPath);
      assert.ok(Number(refused.headers.get("retry-after")) > 0, urlPath);
    }
    // The shell draws the page, and asks the API, which says the same thing.
    assert.match((await get("/help/acme")).text, /<title>Page not available<\/title>/);
  });

  test("a visitor who only reads leaves no row with their address in it", async () => {
    const published = await article();
    await turnOn();
    actingUserId = null;
    assert.equal((await get("/api/help/acme")).status, 200);
    assert.equal((await get(`/api/help/acme/articles/${published.id}`)).status, 200);
    assert.equal((await get("/help/acme")).status, 200);
    assert.equal(await AppDataSource.getRepository(AuthRateLimit).count(), 0);
  });
});

describe("the real app", () => {
  test("mounts it ahead of the session, with its headers on every path", async () => {
    await article();
    await turnOn();
    actingUserId = null;
    const real = createApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => real.once("listening", resolve));
    const origin = `http://127.0.0.1:${(real.address() as AddressInfo).port}`;
    try {
      // A cookie this install did not sign must change nothing about a public answer.
      const headers = { cookie: "genosyn.sid=e30=; genosyn.sid.sig=not-a-signature" };
      for (const [urlPath, status] of [
        ["/api/help/acme", 200],
        ["/api/help/no-such-company", 404],
        ["/help/no-such-company", 404],
      ] as const) {
        const response = await fetch(`${origin}${urlPath}`, { headers });
        assert.equal(response.status, status, urlPath);
        assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", urlPath);
        assert.match(response.headers.get("cache-control") ?? "", /no-store/, urlPath);
        if (urlPath.startsWith("/api/")) {
          assert.equal(response.headers.get("set-cookie"), null, `${urlPath} never sees the session`);
        }
      }
    } finally {
      await new Promise((resolve) => real.close(resolve));
    }
  });
});

describe("the pages", () => {
  test("say whose they are in the head, for whatever a link is pasted into", async () => {
    const published = await article({ title: "How refunds work", body: "# Refunds\n\nFive days." });
    await turnOn();
    actingUserId = null;
    const home = await get("/help/acme");
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    assert.match(home.text, /<title>Acme help center<\/title>/);
    assert.match(home.text, /<meta name="robots" content="noindex, nofollow" \/>/);
    assert.match(home.text, /<meta name="description" content="Answers from Acme\." \/>/);
    assert.ok(!home.text.includes("Run your company autonomously"));
    assert.ok(home.text.includes('id="root"'), "still the App's shell");

    const page = await get(`/help/acme/articles/${published.id}`);
    assert.match(page.text, /<title>How refunds work · Acme help center<\/title>/);
    assert.match(page.text, /<meta name="description" content="Refunds Five days\." \/>/);
  });

  test("say nothing about what was asked for when it is not there", async () => {
    const draft = await article({ status: "draft", title: "Secret plans" });
    await turnOn();
    actingUserId = null;
    const hidden = await get(`/help/acme/articles/${draft.id}`);
    const missing = await get("/help/no-such-company");
    assert.equal(hidden.status, 404);
    assert.equal(hidden.text, missing.text);
    assert.ok(!hidden.text.includes("Secret plans"));
    assert.ok(!hidden.text.includes("Acme"));
  });

  test("a title cannot escape the head, or splice the template", async () => {
    const hostile = `"></title><script>alert(1)</script> $' $\` $&`;
    const published = await article({ title: hostile, body: `</meta><script>alert(2)</script>` });
    await turnOn();
    actingUserId = null;
    const page = await get(`/help/acme/articles/${published.id}`);
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes("<script>alert"), "nothing a company typed runs");
    assert.equal(page.text.split("<!doctype html>").length, 2, "the template was not spliced");
    assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});
