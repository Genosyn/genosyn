import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { IntegrationRuntimeContext } from "../types.js";
import { peopleDataLabsProvider } from "./people-data-labs.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runtime(apiKey = "pdl_test_secret_1234"): IntegrationRuntimeContext {
  return {
    authMode: "apikey",
    config: { apiKey },
    connectionId: "connection-1",
    companyId: "company-1",
  };
}

describe("People Data Labs Integration", () => {
  test("validates BYOK credentials without putting the key in the URL", async () => {
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ status: 404 }), { status: 404 });
    }) as typeof fetch;

    const result = await peopleDataLabsProvider.validateApiKey!({
      apiKey: " pdl_test_secret_1234 ",
    });

    const url = new URL(requestedUrl);
    assert.equal(url.origin + url.pathname, "https://api.peopledatalabs.com/v5/company/enrich");
    assert.equal(url.searchParams.get("website"), "genosyn-connection-check.invalid");
    assert.equal(url.searchParams.has("api_key"), false);
    assert.equal(requestedHeaders.get("X-Api-Key"), "pdl_test_secret_1234");
    assert.deepEqual(result.config, { apiKey: "pdl_test_secret_1234" });
    assert.equal(result.accountHint.includes("pdl_test_secret_1234"), false);
    assert.match(result.accountHint, /1234$/);
  });

  test("normalizes an allowlisted company profile from the fixed endpoint", async () => {
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          status: 200,
          id: "pdl-acme",
          display_name: "Acme Ltd",
          website: "www.acme.example",
          industry_v2: "Software Development",
          employee_count: 137,
          likelihood: 8,
          location: {
            name: "London, England, United Kingdom",
            street_address: "1 High Street",
            address_line_2: "Floor 4",
            locality: "London",
            region: "England",
            postal_code: "SW1A 1AA",
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
          raw_vendor_only_field: { must_not_escape: true },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const profile = await peopleDataLabsProvider.lookupCompanyFirmographics!(
      {
        name: "Acme",
        domain: "acme.example",
        location: "London",
      },
      runtime(),
    );

    assert.ok(profile);
    assert.deepEqual(
      {
        ...profile,
        observedAt: "<timestamp>",
      },
      {
        providerRecordId: "pdl-acme",
        name: "Acme Ltd",
        domain: "acme.example",
        websiteUrl: "https://www.acme.example",
        industry: "Software Development",
        employeeCount: 137,
        headquartersAddress: "1 High Street, Floor 4\nLondon, England, SW1A 1AA\nUnited Kingdom",
        parentCompany: {
          providerRecordId: "pdl-parent",
          name: "Acme Holdings",
          domain: null,
        },
        confidence: 80,
        observedAt: "<timestamp>",
      },
    );
    assert.equal(Number.isNaN(new Date(profile.observedAt).getTime()), false);

    const url = new URL(requestedUrl);
    assert.equal(url.origin + url.pathname, "https://api.peopledatalabs.com/v5/company/enrich");
    assert.equal(url.searchParams.get("name"), "Acme");
    assert.equal(url.searchParams.get("website"), "acme.example");
    assert.equal(url.searchParams.get("location"), "London");
    assert.equal(url.searchParams.get("min_likelihood"), "6");
    assert.equal(url.searchParams.get("titlecase"), "true");
    assert.match(url.searchParams.get("data_include") ?? "", /employee_count/);
    assert.equal(requestedHeaders.get("X-Api-Key"), "pdl_test_secret_1234");
    assert.equal("raw_vendor_only_field" in profile, false);
  });

  test("uses a provider record ID alone for precise refreshes", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          status: 200,
          id: "pdl-acme",
          name: "Acme",
          website: "acme.example",
          likelihood: 9,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await peopleDataLabsProvider.lookupCompanyFirmographics!(
      {
        providerRecordId: "pdl-acme",
        name: "Ignored by PDL",
        domain: "ignored.example",
      },
      runtime(),
    );

    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("pdl_id"), "pdl-acme");
    assert.equal(url.searchParams.has("name"), false);
    assert.equal(url.searchParams.has("website"), false);
  });

  test("returns null for no match and surfaces provider errors", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 404 }), { status: 404 })) as typeof fetch;
    assert.equal(
      await peopleDataLabsProvider.lookupCompanyFirmographics!(
        { domain: "missing.example" },
        runtime(),
      ),
      null,
    );

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
      })) as typeof fetch;
    await assert.rejects(
      peopleDataLabsProvider.lookupCompanyFirmographics!({ domain: "acme.example" }, runtime()),
      /Rate limit exceeded/,
    );

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
      })) as typeof fetch;
    await assert.rejects(
      peopleDataLabsProvider.validateApiKey!({ apiKey: "invalid-key" }),
      /Invalid API key/,
    );
  });

  test("rejects empty lookups before making a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    await assert.rejects(
      peopleDataLabsProvider.lookupCompanyFirmographics!({}, runtime()),
      /Provide a company name/,
    );
    assert.equal(called, false);
  });

  test("does not expose billable lookups as generic Integration tools", async () => {
    assert.deepEqual(peopleDataLabsProvider.tools, []);
    await assert.rejects(
      peopleDataLabsProvider.invokeTool("lookup_company", {}, runtime()),
      /confirmed Revenue firmographics workflow/,
    );
  });
});
