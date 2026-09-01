import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  getProvider,
  getRetiredProvider,
  listCatalog,
  listProviderIds,
  listRetiredProviderIds,
  providerSupportsApiKey,
} from "./index.js";
import { INTEGRATION_CATEGORY_ORDER } from "./types.js";

/**
 * The catalogue named explicitly, rather than counted.
 *
 * A `length >= N` assertion used to guard this, which is exactly the check
 * that stays green while a provider silently disappears from the registry.
 * Adding or retiring a connector is a deliberate act, so it should mean
 * editing this list.
 */
const EXPECTED_PROVIDER_IDS = [
  "stripe",
  "brex",
  "google",
  "google-analytics",
  "google-search-console",
  "imap",
  "github",
  "forgejo",
  "airtable",
  "postgres",
  "mysql",
  "clickhouse",
  "notion",
  "linear",
  "telegram",
  "slack",
  "microsoft-teams",
  "whatsapp",
  "x",
  "reddit",
  "linkedin",
  "google-ads",
  "meta-ads",
  "microsoft-ads",
  "reddit-ads",
];

describe("Integration catalogue invariants", () => {
  test("every registered provider resolves and appears exactly once", () => {
    const ids = listProviderIds();
    assert.deepEqual([...ids].sort(), [...EXPECTED_PROVIDER_IDS].sort());
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      listCatalog().map((entry) => entry.provider),
      ids,
    );
    for (const id of ids) {
      assert.equal(getProvider(id)?.catalog.provider, id);
    }
    assert.equal(getProvider("not-a-provider"), null);
  });

  test("catalog metadata is complete and categories are supported", () => {
    for (const entry of listCatalog()) {
      assert.match(entry.provider, /^[a-z][a-z0-9-]*$/);
      assert.ok(entry.name.trim(), `${entry.provider} has no name`);
      assert.ok(entry.tagline.trim(), `${entry.provider} has no tagline`);
      assert.ok(entry.icon.trim(), `${entry.provider} has no icon`);
      assert.ok(
        INTEGRATION_CATEGORY_ORDER.includes(entry.category),
        `${entry.provider} has unknown category ${entry.category}`,
      );
      if (!entry.enabled) {
        assert.ok(entry.disabledReason?.trim(), `${entry.provider} is disabled without a reason`);
      }
    }
  });

  /**
   * Connectors that carry a credential and expose no model-callable tools.
   *
   * `imap` is the only one, and the omission is the point: an AI Employee
   * reaches an IMAP mailbox through `EmployeeMailAccountGrant`, which is
   * ranked read < draft < send per mailbox. A duplicate set of mail tools
   * hanging off the Connection grant would let an employee granted the
   * *connection* send mail without anyone granting it the *mailbox*.
   */
  const CREDENTIAL_ONLY_PROVIDERS = new Set(["imap"]);

  test("every provider exposes unique, well-formed tool contracts", () => {
    const totalNames = new Set<string>();
    let toolCount = 0;
    for (const id of listProviderIds()) {
      const provider = getProvider(id)!;
      if (CREDENTIAL_ONLY_PROVIDERS.has(id)) {
        assert.equal(provider.tools.length, 0, `${id} is credential-only but exposes tools`);
        continue;
      }
      assert.ok(provider.tools.length > 0, `${id} exposes no tools`);
      const local = new Set<string>();
      for (const tool of provider.tools) {
        toolCount += 1;
        assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${id}.${tool.name}`);
        assert.ok(!local.has(tool.name), `${id} duplicates ${tool.name}`);
        local.add(tool.name);
        totalNames.add(`${id}.${tool.name}`);
        assert.ok(tool.description.trim(), `${id}.${tool.name} has no description`);
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.inputSchema.additionalProperties, false);
        for (const required of tool.inputSchema.required ?? []) {
          assert.ok(
            Object.hasOwn(tool.inputSchema.properties, required),
            `${id}.${tool.name} requires undeclared property ${required}`,
          );
        }
      }
    }
    assert.equal(totalNames.size, toolCount);
    // A floor rather than the list above, because tools churn inside a
    // provider in a way connectors do not. It is still worth raising when it
    // falls behind: the catalogue is 165 tools today, so 160 leaves room to
    // add and retire a handful while a whole provider going quiet still trips.
    assert.ok(toolCount >= 160, `expected the broad tool catalogue, got ${toolCount}`);
  });

  test("connection form fields and scope groups have stable unique keys", () => {
    for (const entry of listCatalog()) {
      for (const fields of [entry.fields ?? [], entry.oauth?.extraFields ?? []]) {
        const keys = fields.map((field) => field.key);
        assert.equal(new Set(keys).size, keys.length, `${entry.provider} repeats a field key`);
        for (const field of fields) {
          assert.match(field.key, /^[A-Za-z][A-Za-z0-9]*$/);
          assert.ok(field.label.trim());
        }
      }
      for (const groups of [
        entry.oauth?.scopeGroups ?? [],
        entry.serviceAccount?.scopeGroups ?? [],
      ]) {
        const keys = groups.map((group) => group.key);
        assert.equal(new Set(keys).size, keys.length, `${entry.provider} repeats a scope group`);
        for (const group of groups) {
          assert.ok(group.label.trim());
          assert.ok(group.description.trim());
          assert.ok(group.scopes.length > 0);
          assert.equal(new Set(group.scopes).size, group.scopes.length);
        }
      }
    }
  });

  test("declared connection modes have matching provider hooks", () => {
    for (const id of listProviderIds()) {
      const provider = getProvider(id)!;
      const { catalog } = provider;
      assert.equal(
        providerSupportsApiKey(provider),
        !!provider.validateApiKey && (catalog.fields?.length ?? 0) > 0,
      );
      if (catalog.authMode === "apikey") {
        assert.equal(providerSupportsApiKey(provider), true, `${id} cannot validate its key form`);
      }
      if (catalog.oauth) {
        assert.equal(typeof provider.buildOauthConfig, "function", `${id} lacks OAuth builder`);
      }
      if (catalog.serviceAccount) {
        assert.equal(
          typeof provider.buildServiceAccountConfig,
          "function",
          `${id} lacks service-account builder`,
        );
      }
      if (catalog.githubApp) {
        assert.equal(
          typeof provider.buildGithubAppConfig,
          "function",
          `${id} lacks GitHub App builder`,
        );
      }
    }
  });

  test("retired provider ids are described and never shadow a live provider", () => {
    const live = new Set(listProviderIds());
    const retired = listRetiredProviderIds();
    assert.ok(retired.length > 0);
    assert.equal(new Set(retired).size, retired.length);
    for (const id of retired) {
      // Reusing a retired id would silently repoint an operator's surviving
      // rows at a different service.
      assert.ok(!live.has(id), `${id} is both registered and retired`);
      const entry = getRetiredProvider(id)!;
      assert.equal(entry.provider, id);
      assert.ok(entry.name.trim(), `${id} has no display name`);
      assert.match(entry.retiredIn, /^\d+\.\d+\.\d+$/);
      assert.ok(entry.reason.trim(), `${id} does not say what to do instead`);
    }
    assert.equal(getRetiredProvider("stripe"), null);
    assert.equal(getRetiredProvider("not-a-provider"), null);
  });

  test("LinkedIn defaults to permissions available without partner review", () => {
    const linkedin = getProvider("linkedin");
    assert.ok(linkedin?.catalog.oauth);
    assert.deepEqual(
      linkedin.catalog.oauth.scopeGroups
        ?.filter((group) => group.defaultSelected)
        .map((group) => group.key),
      ["post_member"],
    );
  });
});
