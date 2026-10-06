import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { IntegrationAuthMode, IntegrationProvider } from "../integrations/types.js";
import { getProvider } from "../integrations/index.js";
import { googleProvider } from "../integrations/providers/google.js";
import { assertSafeOutboundConfig } from "../lib/outboundUrl.js";
import { assertSafeIntegrationConfig } from "./integrationOutboundConfig.js";

const scopeUri = "https://www.googleapis.com/auth/gmail.modify";
let lookups: string[];
beforeEach(() => {
  lookups = [];
  mock.method(dns, "lookup", async (hostname: string) => {
    lookups.push(hostname);
    throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: "EAI_AGAIN" });
  });
});
afterEach(() => {
  mock.restoreAll();
});

function validate(
  config: Record<string, unknown>,
  provider = googleProvider,
  authMode: IntegrationAuthMode = "oauth2",
): Promise<void> {
  return assertSafeIntegrationConfig({ provider, authMode, config });
}

for (const [label, scope] of [
  ["single URI", scopeUri],
  ["URI first in a list", `${scopeUri} https://www.googleapis.com/auth/userinfo.email openid`],
  ["leading and trailing whitespace", `  ${scopeUri} openid  `],
  ["opaque identifier first", `openid ${scopeUri}`],
  ["alternate issuer URI", "https://issuer.example.test/permissions/read"],
  ["empty grants", ""],
]) {
  test(`OAuth ${label} scope metadata does not perform DNS`, async () => {
    const config = Object.freeze({ scope, accessToken: "synthetic-token", expiresAt: 123 });
    await validate(config);
    assert.deepEqual(lookups, []);
    assert.equal(config.scope, scope);
    assert.deepEqual(Object.keys(config), ["scope", "accessToken", "expiresAt"]);
  });
}

for (const providerId of [
  "google",
  "google-analytics",
  "google-search-console",
  "google-ads",
  "github",
  "microsoft-ads",
]) {
  test(`${providerId} OAuth factories own the reserved scope metadata consistently`, async () => {
    const provider = getProvider(providerId);
    assert.ok(provider?.buildOauthConfig);
    assert.ok(provider.catalog.oauth);
    await validate({ scope: scopeUri }, provider);
    assert.deepEqual(lookups, []);
  });
}

for (const mode of ["apikey", "service_account", "github_app", "browser"] as const) {
  test(`${mode} configs do not acquire an OAuth metadata exemption`, async () => {
    await assert.rejects(
      validate({ scope: scopeUri }, googleProvider, mode),
      /EAI_AGAIN www\.googleapis\.com/,
    );
    assert.deepEqual(lookups, ["www.googleapis.com"]);
  });
}

test("an OAuth auth mode without a declared OAuth catalog cannot exempt scope", async () => {
  const provider: IntegrationProvider = {
    ...googleProvider,
    catalog: { ...googleProvider.catalog, oauth: undefined },
  };
  await assert.rejects(validate({ scope: scopeUri }, provider), /EAI_AGAIN/);
  assert.deepEqual(lookups, ["www.googleapis.com"]);
});

test("an OAuth catalog without the config factory cannot exempt scope", async () => {
  const provider: IntegrationProvider = { ...googleProvider, buildOauthConfig: undefined };
  await assert.rejects(validate({ scope: scopeUri }, provider), /EAI_AGAIN/);
  assert.deepEqual(lookups, ["www.googleapis.com"]);
});

for (const source of ["fields", "oauth.extraFields"]) {
  test(`a provider-declared ${source} endpoint named scope remains validated`, async () => {
    const field = { key: "scope", label: "Endpoint", type: "url" as const, required: true };
    const provider: IntegrationProvider = {
      ...googleProvider,
      catalog: {
        ...googleProvider.catalog,
        ...(source === "fields"
          ? { fields: [field] }
          : { oauth: { ...googleProvider.catalog.oauth!, extraFields: [field] } }),
      },
    };
    await assert.rejects(validate({ scope: "http://127.0.0.1/endpoint" }, provider), /non-public/);
    assert.deepEqual(lookups, []);
  });
}

for (const key of ["Scope", "scopes", "scopeUrl", "customEndpoint", "arbitraryField"]) {
  test(`the URL-shaped ${key} field does not inherit the reserved scope exemption`, async () => {
    await assert.rejects(
      validate({ scope: scopeUri, [key]: scopeUri }),
      /EAI_AGAIN www\.googleapis\.com/,
    );
    assert.deepEqual(lookups, ["www.googleapis.com"]);
  });
}

test("a real endpoint with a Google scope-looking path still performs DNS", async () => {
  await assert.rejects(
    validate({ scope: scopeUri, baseUrl: scopeUri }),
    /EAI_AGAIN www\.googleapis\.com/,
  );
  assert.deepEqual(lookups, ["www.googleapis.com"]);
});

test("actual public custom endpoints are validated without mutating the original config", async () => {
  mock.method(dns, "lookup", async (hostname: string) => {
    lookups.push(hostname);
    return [{ address: "8.8.8.8", family: 4 }];
  });
  const config = Object.freeze({
    scope: scopeUri,
    baseUrl: "https://custom.example.test/api",
    smtp_host: "mail.example.test:587",
  });
  await validate(config);
  assert.deepEqual(lookups, ["custom.example.test", "mail.example.test"]);
  assert.deepEqual(config, {
    scope: scopeUri,
    baseUrl: "https://custom.example.test/api",
    smtp_host: "mail.example.test:587",
  });
});

test("private IPv4 and IPv6 destinations still fail closed alongside OAuth metadata", async () => {
  for (const endpoint of [
    "http://127.0.0.1/api",
    "http://169.254.169.254/latest",
    "https://10.0.0.8",
    "http://[::1]/",
    "http://[fd00::1]/",
  ]) {
    await assert.rejects(validate({ scope: scopeUri, endpoint }), /non-public/, endpoint);
  }
  assert.deepEqual(lookups, []);
});

test("embedded credentials in a real endpoint remain rejected", async () => {
  await assert.rejects(
    validate({ scope: scopeUri, endpoint: "https://user:secret@public.example.test/api" }),
    /embedded credentials/,
  );
  assert.deepEqual(lookups, []);
});

test("all host-shaped config keys retain destination validation", async () => {
  for (const key of ["host", "hostname", "smtp_host", "server-hostname"]) {
    await assert.rejects(validate({ scope: scopeUri, [key]: "127.0.0.1:587" }), /non-public/, key);
  }
  assert.deepEqual(lookups, []);
});

test("the generic config validator retains its strict behavior without provider metadata", async () => {
  await assert.rejects(
    assertSafeOutboundConfig({ scope: scopeUri }),
    /EAI_AGAIN www\.googleapis\.com/,
  );
  assert.deepEqual(lookups, ["www.googleapis.com"]);
});
