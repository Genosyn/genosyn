import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { IntegrationCatalogEntry, IntegrationConnection } from "../../client/lib/api.js";
import {
  mailReconnectHref,
  resolveReconnectTarget,
} from "../../client/lib/integrationReconnect.js";

function connection(id: string, provider = "google"): IntegrationConnection {
  return {
    id,
    companyId: "company-1",
    provider,
    label: `${provider} connection`,
    authMode: "oauth2",
    accountHint: "owner@example.com",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
    retired: null,
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:00:00.000Z",
    scopeGroups: [],
  };
}

function catalogEntry(provider: string): IntegrationCatalogEntry {
  return {
    provider,
    name: provider === "google" ? "Google Workspace" : "Stripe",
    category: provider === "google" ? "Productivity" : "Payments",
    tagline: "Connected service",
    icon: "Plug",
    authMode: "oauth2",
    enabled: true,
  };
}

describe("Email reconnect destination", () => {
  test("lets owners and admins reconnect from the Email product", () => {
    assert.equal(
      mailReconnectHref("owner", "acme", "connection-1"),
      "/c/acme/mail/integrations?reconnect=connection-1",
    );
    assert.equal(
      mailReconnectHref("admin", "acme", "connection-1"),
      "/c/acme/mail/integrations?reconnect=connection-1",
    );
  });

  test("does not expose a mutation control to members or an unresolved role", () => {
    assert.equal(mailReconnectHref("member", "acme", "connection-1"), null);
    assert.equal(mailReconnectHref(undefined, "acme", "connection-1"), null);
  });

  test("encodes route and query components independently", () => {
    assert.equal(
      mailReconnectHref("owner", "acme uk/sales", "google/id?selected=true"),
      "/c/acme%20uk%2Fsales/mail/integrations?reconnect=google%2Fid%3Fselected%3Dtrue",
    );
  });
});

describe("reconnect deep-link resolution", () => {
  const google = connection("google-1");
  const stripe = connection("stripe-1", "stripe");
  const catalog = [catalogEntry("google"), catalogEntry("stripe")];

  test("returns the exact Connection and its matching catalog entry", () => {
    assert.deepEqual(resolveReconnectTarget("google-1", [google, stripe], catalog, ["google"]), {
      entry: catalog[0],
      conn: google,
    });
  });

  test("rejects Connections outside the current product provider scope", () => {
    assert.equal(resolveReconnectTarget("stripe-1", [google, stripe], catalog, ["google"]), null);
  });

  test("allows any catalogued provider on the company-wide integrations page", () => {
    assert.deepEqual(resolveReconnectTarget("stripe-1", [google, stripe], catalog, null), {
      entry: catalog[1],
      conn: stripe,
    });
  });

  test("returns null for absent, deleted, or uncatalogued Connections", () => {
    assert.equal(resolveReconnectTarget(null, [google], catalog, ["google"]), null);
    assert.equal(resolveReconnectTarget("deleted", [google], catalog, ["google"]), null);
    assert.equal(resolveReconnectTarget("google-1", [google], [catalog[1]], ["google"]), null);
  });
});
