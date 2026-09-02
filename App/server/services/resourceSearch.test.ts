import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import { Resource } from "../db/entities/Resource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { AppDataSource } from "../db/datasource.js";
import {
  deleteResourceGrantsForEmployee,
  grantAllResourcesToEmployee,
  searchResources,
  windowText,
} from "./resources.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function seedCompany() {
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner-1" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    role: "Analyst",
    slug: "ada",
    soulBody: "",
  });
  return { company, employee };
}

async function seedResource(
  companyId: string,
  employeeId: string | null,
  fields: Partial<Resource>,
) {
  const row = await insert(Resource, {
    companyId,
    slug: (fields.title ?? "r").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    sourceKind: "text",
    summary: "",
    bodyText: "",
    tags: "",
    status: "ready",
    errorMessage: "",
    bytes: 0,
    ...fields,
  });
  if (employeeId) {
    await insert(EmployeeResourceGrant, { employeeId, resourceId: row.id, accessLevel: "read" });
  }
  return row;
}

describe("searchResources", () => {
  test("matches words in any order, which the old single LIKE could not", async () => {
    const { company, employee } = await seedCompany();
    await seedResource(company.id, employee.id, {
      title: "Company Handbook",
      bodyText: "Our policy for refunds is thirty days from delivery.",
    });
    await seedResource(company.id, employee.id, {
      title: "Ops Guide",
      // The newline is what `htmlToText` and pdf-parse produce constantly, and
      // it is enough to defeat a contiguous `%refund policy%`.
      bodyText: "The refund\npolicy applies to every plan.",
    });

    const found = await searchResources(company.id, employee.id, {
      query: "refund policy",
      limit: 10,
      offset: 0,
    });
    assert.equal(found.total, 2, "both phrasings must match");
    assert.equal(found.broadened, false, "both contain every word — no fallback needed");
    for (const hit of found.hits) {
      assert.ok(hit.match, `${hit.resource.title} returned no snippet`);
      assert.ok(hit.matchedIn.includes("body"));
    }
  });

  test("is case-insensitive, and identically so on both drivers", async () => {
    const { company, employee } = await seedCompany();
    await seedResource(company.id, employee.id, {
      title: "Handbook",
      bodyText: "Our REFUND window is thirty days.",
    });
    const found = await searchResources(company.id, employee.id, {
      query: "refund",
      limit: 10,
      offset: 0,
    });
    assert.equal(found.total, 1);
    // Bare LIKE folds ASCII case on sqlite but not on postgres; the shared
    // helper lowercases both sides so the two engines agree.
    assert.ok(found.hits[0].match?.snippet.toUpperCase().includes("REFUND"));
  });

  test("a hit's bodyOffset lands the reader on the passage", async () => {
    const { company, employee } = await seedCompany();
    const filler = "irrelevant preamble. ".repeat(4_000);
    await seedResource(company.id, employee.id, {
      title: "Long Report",
      bodyText: `${filler}The renewal rate reached 94% in Q3.${filler}`,
    });

    const found = await searchResources(company.id, employee.id, {
      query: "renewal rate",
      limit: 5,
      offset: 0,
    });
    const hit = found.hits[0];
    assert.ok(hit?.match, "expected a body match");
    assert.ok(hit.match.bodyOffset > 10_000, "the hit is deep in the body");
    const win = windowText(hit.resource.bodyText, {
      offset: hit.match.bodyOffset,
      maxChars: 200,
    });
    assert.ok(
      win.text.includes("renewal rate reached 94%"),
      "search offset must feed straight into get_resource",
    );
  });

  test("falls back to partial matches rather than answering with nothing", async () => {
    const { company, employee } = await seedCompany();
    await seedResource(company.id, employee.id, {
      title: "Handbook",
      bodyText: "Our refund window is thirty days.",
    });
    const found = await searchResources(company.id, employee.id, {
      query: "refund unicorn",
      limit: 10,
      offset: 0,
    });
    assert.equal(found.broadened, true, "no row has both words, so the query broadens");
    assert.equal(found.total, 1);
  });

  test("never returns a Resource the employee was not granted", async () => {
    const { company, employee } = await seedCompany();
    await seedResource(company.id, employee.id, { title: "Shared", bodyText: "budget notes" });
    await seedResource(company.id, null, { title: "Private", bodyText: "budget notes" });

    const found = await searchResources(company.id, employee.id, {
      query: "budget",
      limit: 10,
      offset: 0,
    });
    assert.equal(found.total, 1);
    assert.equal(found.hits[0].resource.title, "Shared");
  });

  test("does not cross company boundaries", async () => {
    const { company, employee } = await seedCompany();
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: "owner-2" });
    // A grant that points at another company's row must not be enough.
    await seedResource(other.id, employee.id, { title: "Foreign", bodyText: "budget notes" });

    const found = await searchResources(company.id, employee.id, {
      query: "budget",
      limit: 10,
      offset: 0,
    });
    assert.equal(found.total, 0);
  });

  test("paginates and reports the real total", async () => {
    const { company, employee } = await seedCompany();
    for (let i = 0; i < 5; i += 1) {
      await seedResource(company.id, employee.id, {
        title: `Doc ${i}`,
        slug: `doc-${i}`,
        bodyText: "quarterly budget review",
      });
    }
    const page = await searchResources(company.id, employee.id, {
      query: "quarterly budget",
      limit: 2,
      offset: 0,
    });
    assert.equal(page.total, 5);
    assert.equal(page.hits.length, 2);
    assert.equal(page.hasMore, true);

    const last = await searchResources(company.id, employee.id, {
      query: "quarterly budget",
      limit: 2,
      offset: 4,
    });
    assert.equal(last.hits.length, 1);
    assert.equal(last.hasMore, false);
  });
});

describe("grant lifecycle", () => {
  test("a hire is handed the library that already existed", async () => {
    const { company } = await seedCompany();
    await seedResource(company.id, null, { title: "Handbook", bodyText: "…" });
    await seedResource(company.id, null, { title: "Pricing", bodyText: "…" });

    const newHire = await insert(AIEmployee, {
      companyId: company.id,
      name: "Grace",
      role: "Ops",
      slug: "grace",
      soulBody: "",
    });
    // Before M62 this was the state a new employee lived in permanently.
    let visible = await searchResources(company.id, newHire.id, {
      query: "handbook",
      limit: 10,
      offset: 0,
    });
    assert.equal(visible.total, 0);

    const granted = await grantAllResourcesToEmployee(company.id, newHire.id);
    assert.equal(granted, 2);
    visible = await searchResources(company.id, newHire.id, {
      query: "handbook",
      limit: 10,
      offset: 0,
    });
    assert.equal(visible.total, 1);
  });

  test("the back-fill is idempotent", async () => {
    const { company, employee } = await seedCompany();
    await seedResource(company.id, employee.id, { title: "Handbook", bodyText: "…" });
    assert.equal(await grantAllResourcesToEmployee(company.id, employee.id), 0);
  });

  test("firing an employee takes its grants with it", async () => {
    const { company, employee } = await seedCompany();
    await seedResource(company.id, employee.id, { title: "Handbook", bodyText: "…" });
    await deleteResourceGrantsForEmployee(employee.id);
    const left = await AppDataSource.getRepository(EmployeeResourceGrant).count({
      where: { employeeId: employee.id },
    });
    assert.equal(left, 0);
  });
});
