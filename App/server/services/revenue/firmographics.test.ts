import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Customer } from "../../db/entities/Customer.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueFirmographicLookup } from "../../db/entities/RevenueFirmographicLookup.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../../test/dbHarness.js";
import { encryptConnectionConfig } from "../integrations.js";
import { previewRevenueFirmographics, proposeRevenueFirmographics } from "./firmographics.js";

const originalFetch = globalThis.fetch;

before(async () => {
  // The root integration adds this entity to the production DataSource. Keep
  // this focused test runnable independently while that shared edit lands.
  const entities = AppDataSource.options.entities;
  if (!Array.isArray(entities)) throw new Error("Expected an explicit entity list");
  if (!entities.includes(RevenueFirmographicLookup)) {
    AppDataSource.setOptions({ entities: [...entities, RevenueFirmographicLookup] });
  }
  await initTestDb();
});
beforeEach(resetTestDb);
afterEach(() => {
  globalThis.fetch = originalFetch;
});
after(closeTestDb);

async function account(
  companyId: string,
  name: string,
  values: Partial<Customer> = {},
): Promise<Customer> {
  return insert(Customer, {
    companyId,
    name,
    slug: `${name.toLowerCase().replaceAll(" ", "-")}-${testId("slug")}`,
    accountStatus: "prospect",
    archivedAt: null,
    ...values,
  });
}

async function connection(
  companyId: string,
  provider = "people-data-labs",
): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId,
    provider,
    label: provider === "people-data-labs" ? "PDL production" : "Other Connection",
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig({ apiKey: "pdl_test_secret" }, companyId),
    accountHint: "pdl…cret",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
}

describe("Revenue firmographics", () => {
  test("previews fresh cache, complete Accounts, unavailable IDs, and the 100-Account cap", async () => {
    const companyId = testCompanyId();
    const conn = await connection(companyId);
    const cached = await account(companyId, "Cached");
    const complete = await account(companyId, "Complete", {
      domain: "complete.example",
      websiteUrl: "https://complete.example",
      industry: "Software",
      employeeCount: 10,
      headquartersAddress: "London",
      parentCompanyName: "Complete Holdings",
      parentCompanyDomain: "holdings.example",
    });
    const archived = await account(companyId, "Archived", { archivedAt: new Date() });
    await insert(RevenueFirmographicLookup, {
      companyId,
      customerId: cached.id,
      connectionId: conn.id,
      provider: "people-data-labs",
      providerRecordId: "",
      status: "not_found",
      normalizedSnapshotJson: JSON.stringify({
        cacheVersion: 1,
        lookupIdentity: {
          name: "cached",
          domain: "",
          website: "",
        },
        profile: null,
      }),
      confidence: 0,
      lastAttemptedAt: new Date(),
      lastMatchedAt: null,
      observedAt: null,
      lastError: "",
    });

    const preview = await previewRevenueFirmographics(companyId, {
      connectionId: conn.id,
      accountIds: [cached.id, complete.id, archived.id, testId("missing")],
    });
    assert.equal(preview.selectedAccounts, 2);
    assert.equal(preview.unavailableAccounts, 2);
    assert.equal(preview.cachedAccounts, 1);
    assert.equal(preview.completeAccounts, 1);
    assert.equal(preview.eligibleAccounts, 0);
    assert.equal(preview.estimatedExternalRequests, 0);
    assert.deepEqual(
      new Set(preview.rows.map((row) => row.state)),
      new Set(["cached_not_found", "complete"]),
    );

    await assert.rejects(
      previewRevenueFirmographics(companyId, {
        connectionId: conn.id,
        accountIds: Array.from({ length: 101 }, (_, index) => `account-${index}`),
      }),
      /limited to 100 Accounts/,
    );
    await assert.rejects(
      previewRevenueFirmographics(companyId, {
        connectionId: conn.id,
        limit: 101,
      }),
      /limit must be an integer from 1 through 100/,
    );
  });

  test("caches a normalized match and creates separate review-only evidence idempotently", async () => {
    const companyId = testCompanyId();
    const conn = await connection(companyId);
    const acme = await account(companyId, "Acme", {
      domain: "",
      websiteUrl: "",
      industry: "",
      employeeCount: 0,
      headquartersAddress: "",
      parentCompanyName: "",
      parentCompanyDomain: "",
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          status: 200,
          id: "pdl-acme",
          display_name: "Acme Ltd",
          website: "acme.example",
          industry_v2: "Software Development",
          employee_count: 137,
          likelihood: 9,
          location: {
            street_address: "1 High Street",
            locality: "London",
            country: "United Kingdom",
          },
          immediate_parent: "pdl-parent",
          affiliated_entities: [
            {
              affiliated_id: "pdl-parent",
              display_name: "Acme Holdings",
              relationship: "immediate_parent",
            },
          ],
          raw_vendor_only_field: { private: "not persisted" },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const first = await proposeRevenueFirmographics(companyId, {
      connectionId: conn.id,
      accountIds: [acme.id],
    });
    assert.deepEqual(
      {
        externalRequests: first.externalRequests,
        matched: first.matched,
        failed: first.failed,
        proposedEvidence: first.proposedEvidence,
      },
      {
        externalRequests: 1,
        matched: 1,
        failed: 0,
        proposedEvidence: 6,
      },
    );
    assert.equal(calls, 1);

    const unchanged = await AppDataSource.getRepository(Customer).findOneByOrFail({ id: acme.id });
    assert.equal(unchanged.domain, "");
    assert.equal(unchanged.websiteUrl, "");
    assert.equal(unchanged.industry, "");
    assert.equal(unchanged.employeeCount, 0);
    assert.equal(unchanged.headquartersAddress, "");
    assert.equal(unchanged.parentCompanyName, "");

    const lookup = await AppDataSource.getRepository(RevenueFirmographicLookup).findOneByOrFail({
      companyId,
      customerId: acme.id,
      connectionId: conn.id,
    });
    assert.equal(lookup.status, "matched");
    assert.equal(lookup.providerRecordId, "pdl-acme");
    assert.equal(lookup.normalizedSnapshotJson.includes("raw_vendor_only_field"), false);
    assert.equal(lookup.normalizedSnapshotJson.includes("pdl_test_secret"), false);

    const evidence = await AppDataSource.getRepository(RevenueFieldEvidence).find({
      where: { companyId, resourceType: "account", resourceId: acme.id },
      order: { fieldKey: "ASC" },
    });
    assert.deepEqual(
      evidence.map((row) => row.fieldKey),
      [
        "domain",
        "employee_count",
        "headquarters_address",
        "industry",
        "parent_company_name",
        "website_url",
      ],
    );
    assert.ok(evidence.every((row) => row.status === "proposed"));
    assert.ok(evidence.every((row) => row.sourceType === "integration"));
    assert.ok(evidence.every((row) => row.sourceId === "pdl-acme"));
    assert.ok(
      evidence.every((row) => {
        const metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
        return (
          metadata.connectionId === conn.id &&
          metadata.firmographicLookupId === lookup.id &&
          !("apiKey" in metadata)
        );
      }),
    );

    const second = await proposeRevenueFirmographics(companyId, {
      connectionId: conn.id,
      accountIds: [acme.id],
    });
    assert.equal(second.externalRequests, 0);
    assert.equal(second.cached, 1);
    assert.equal(second.proposedEvidence, 0);
    assert.equal(second.existingEvidence, 6);
    assert.equal(calls, 1);
    assert.equal(
      await AppDataSource.getRepository(RevenueFieldEvidence).countBy({
        companyId,
        resourceType: "account",
        resourceId: acme.id,
      }),
      6,
    );
  });

  test("coalesces concurrent billable lookups for the same Account and Connection", async () => {
    const companyId = testCompanyId();
    const conn = await connection(companyId);
    const acme = await account(companyId, "Concurrent Acme");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return new Response(
        JSON.stringify({
          status: 200,
          id: "pdl-concurrent-acme",
          display_name: "Concurrent Acme",
          website: "concurrent.example",
          industry_v2: "Software",
          likelihood: 9,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const results = await Promise.all([
      proposeRevenueFirmographics(companyId, {
        connectionId: conn.id,
        accountIds: [acme.id],
      }),
      proposeRevenueFirmographics(companyId, {
        connectionId: conn.id,
        accountIds: [acme.id],
      }),
    ]);

    assert.equal(calls, 1);
    assert.equal(
      results.reduce((total, result) => total + result.externalRequests, 0),
      1,
    );
    assert.equal(
      results.reduce((total, result) => total + result.matched, 0),
      1,
    );
    assert.equal(
      results.reduce((total, result) => total + result.cached, 0),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueFirmographicLookup).countBy({
        companyId,
        customerId: acme.id,
        connectionId: conn.id,
      }),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(RevenueFieldEvidence).countBy({
        companyId,
        resourceType: "account",
        resourceId: acme.id,
      }),
      3,
    );
  });

  test("invalidates matched and no-match caches when Account identity changes", async () => {
    const companyId = testCompanyId();
    const conn = await connection(companyId);
    const matched = await account(companyId, "Old Identity", {
      domain: "old.example",
      websiteUrl: "https://old.example",
    });
    const missing = await account(companyId, "Missing Old");
    const requests: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const name = url.searchParams.get("name");
      if (name?.startsWith("Missing")) {
        return new Response(JSON.stringify({ status: 404 }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          status: 200,
          id: name === "New Identity" ? "pdl-new-identity" : "pdl-old-identity",
          display_name: name,
          website: url.searchParams.get("website"),
          likelihood: 9,
          raw_provider_payload: { mustNotPersist: true },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const first = await proposeRevenueFirmographics(companyId, {
      connectionId: conn.id,
      accountIds: [matched.id, missing.id],
    });
    assert.equal(first.externalRequests, 2);
    assert.equal(first.matched, 1);
    assert.equal(first.notFound, 1);

    await AppDataSource.getRepository(Customer).update(
      { companyId, id: matched.id },
      {
        name: "New Identity",
        domain: "new.example",
        websiteUrl: "https://new.example/about",
      },
    );
    await AppDataSource.getRepository(Customer).update(
      { companyId, id: missing.id },
      { name: "Missing New" },
    );

    const preview = await previewRevenueFirmographics(companyId, {
      connectionId: conn.id,
      accountIds: [matched.id, missing.id],
    });
    assert.equal(preview.eligibleAccounts, 2);
    assert.equal(preview.cachedAccounts, 0);
    assert.equal(preview.estimatedExternalRequests, 2);

    const refreshed = await proposeRevenueFirmographics(companyId, {
      connectionId: conn.id,
      accountIds: [matched.id, missing.id],
    });
    assert.equal(refreshed.externalRequests, 2);
    assert.equal(refreshed.matched, 1);
    assert.equal(refreshed.notFound, 1);
    assert.equal(requests.length, 4);
    const refreshedMatchRequest = requests.find(
      (request) => request.searchParams.get("name") === "New Identity",
    );
    assert.ok(refreshedMatchRequest);
    assert.equal(refreshedMatchRequest.searchParams.get("pdl_id"), null);
    assert.equal(refreshedMatchRequest.searchParams.get("website"), "https://new.example/about");
    assert.ok(requests.some((request) => request.searchParams.get("name") === "Missing New"));

    const matchedLookup = await AppDataSource.getRepository(
      RevenueFirmographicLookup,
    ).findOneByOrFail({
      companyId,
      customerId: matched.id,
      connectionId: conn.id,
    });
    assert.equal(matchedLookup.providerRecordId, "pdl-new-identity");
    assert.equal(matchedLookup.normalizedSnapshotJson.includes("pdl-old-identity"), false);
    assert.equal(matchedLookup.normalizedSnapshotJson.includes("raw_provider_payload"), false);
  });

  test("remembers no-matches, isolates provider failures, and continues later Accounts", async () => {
    const companyId = testCompanyId();
    const conn = await connection(companyId);
    const good = await account(companyId, "Good");
    const missing = await account(companyId, "Missing");
    const broken = await account(companyId, "Broken");
    globalThis.fetch = (async (input) => {
      const name = new URL(String(input)).searchParams.get("name");
      if (name === "Missing") {
        return new Response(JSON.stringify({ status: 404 }), { status: 404 });
      }
      if (name === "Broken") {
        return new Response(JSON.stringify({ error: { message: "Temporary provider failure" } }), {
          status: 503,
        });
      }
      return new Response(
        JSON.stringify({
          status: 200,
          id: "pdl-good",
          name: "Good",
          website: "good.example",
          likelihood: 8,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await proposeRevenueFirmographics(companyId, {
      connectionId: conn.id,
      accountIds: [good.id, missing.id, broken.id],
    });
    assert.equal(result.externalRequests, 3);
    assert.equal(result.matched, 1);
    assert.equal(result.notFound, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.errors[0]?.accountId, broken.id);
    assert.match(result.errors[0]?.error ?? "", /Temporary provider failure/);

    const rows = await AppDataSource.getRepository(RevenueFirmographicLookup).find({
      where: { companyId, connectionId: conn.id },
    });
    const statusByAccount = new Map(rows.map((row) => [row.customerId, row.status]));
    assert.equal(statusByAccount.get(good.id), "matched");
    assert.equal(statusByAccount.get(missing.id), "not_found");
    assert.equal(statusByAccount.get(broken.id), "failed");
    assert.match(
      rows.find((row) => row.customerId === broken.id)?.lastError ?? "",
      /Temporary provider failure/,
    );
  });

  test("fails closed for cross-company and unsupported Connections", async () => {
    const firstCompanyId = testCompanyId();
    const secondCompanyId = testCompanyId();
    const pdl = await connection(firstCompanyId);
    const stripe = await connection(secondCompanyId, "stripe");

    await assert.rejects(
      previewRevenueFirmographics(secondCompanyId, { connectionId: pdl.id }),
      /not found in this company/,
    );
    await assert.rejects(
      previewRevenueFirmographics(secondCompanyId, { connectionId: stripe.id }),
      /does not support company firmographics/,
    );
  });
});
