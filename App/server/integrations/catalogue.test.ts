import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  getProvider,
  listCatalog,
  listProviderIds,
  providerSupportsApiKey,
} from "./index.js";
import { INTEGRATION_CATEGORY_ORDER } from "./types.js";

describe("Integration catalogue invariants", () => {
  test("every registered provider resolves and appears exactly once", () => {
    const ids = listProviderIds();
    assert.ok(ids.length >= 25, `expected the full catalogue, got ${ids.length}`);
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

  test("every provider exposes unique, well-formed tool contracts", () => {
    const totalNames = new Set<string>();
    let toolCount = 0;
    for (const id of listProviderIds()) {
      const provider = getProvider(id)!;
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
    assert.ok(toolCount >= 150, `expected the broad tool catalogue, got ${toolCount}`);
  });

  test("connection form fields and scope groups have stable unique keys", () => {
    for (const entry of listCatalog()) {
      for (const fields of [
        entry.fields ?? [],
        entry.oauth?.extraFields ?? [],
        entry.browserLogin?.fields ?? [],
      ]) {
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
      if (catalog.browserLogin) {
        assert.equal(
          typeof provider.buildBrowserLoginConfig,
          "function",
          `${id} lacks browser-login builder`,
        );
      }
    }
  });
});
