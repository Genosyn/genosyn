import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { encryptConnectionConfig } from "./integrations.js";
import { listCatalog } from "../integrations/index.js";
import {
  OAUTH_APPS_SETTING_KEY,
  clearOauthApp,
  describeOauthApps,
  getRegisteredOauthApp,
  isRegisterableOauthApp,
  parseStored,
  registeredOauthApps,
  saveOauthApp,
} from "./oauthApps.js";
import { resolveOauthState, startOauth, startOauthReconnect } from "./oauth.js";

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
});

async function rawSetting(): Promise<string> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({
    key: OAUTH_APPS_SETTING_KEY,
  });
  return row?.value ?? "";
}

describe("install-wide OAuth app registry", () => {
  test("an unregistered install offers every app, configured by nobody", async () => {
    const apps = await describeOauthApps();
    assert.ok(apps.length >= 6);
    assert.equal(
      apps.every((a) => !a.configured && a.clientId === "" && !a.hasClientSecret),
      true,
    );
    // Google leads: it is the reason most installs come here.
    assert.equal(apps[0].app, "google");
    // Every app tells the operator exactly which URI to allow-list.
    assert.equal(
      apps.every((a) => a.redirectUri.includes("/api/integrations/oauth/callback/")),
      true,
    );
    assert.deepEqual(await registeredOauthApps(), new Set());
    assert.equal(await getRegisteredOauthApp("google"), null);
  });

  test("saving a registration makes it resolvable, and never stores the secret in the clear", async () => {
    await saveOauthApp("google", { clientId: "cid-123", clientSecret: "sec-abc" });

    assert.deepEqual(await getRegisteredOauthApp("google"), {
      clientId: "cid-123",
      clientSecret: "sec-abc",
    });
    assert.deepEqual(await registeredOauthApps(), new Set(["google"]));

    const stored = await rawSetting();
    assert.ok(stored.includes("cid-123"), "client id is not a secret and is stored plainly");
    assert.equal(stored.includes("sec-abc"), false, "client secret must be encrypted at rest");
  });

  test("the admin view exposes the client id but never the secret", async () => {
    await saveOauthApp("google", { clientId: "cid-123", clientSecret: "sec-abc" });
    const google = (await describeOauthApps()).find((a) => a.app === "google")!;

    assert.equal(google.configured, true);
    assert.equal(google.clientId, "cid-123");
    assert.equal(google.hasClientSecret, true);
    assert.ok(google.updatedAt);
    assert.equal(
      JSON.stringify(google).includes("sec-abc"),
      false,
      "the descriptor must not carry the secret",
    );
  });

  test("a blank secret keeps the stored one, so a typo'd client id is fixable alone", async () => {
    await saveOauthApp("google", { clientId: "cid-typo", clientSecret: "sec-abc" });
    await saveOauthApp("google", { clientId: "cid-fixed", clientSecret: "" });

    assert.deepEqual(await getRegisteredOauthApp("google"), {
      clientId: "cid-fixed",
      clientSecret: "sec-abc",
    });
  });

  test("a first save with no secret is rejected rather than half-registering", async () => {
    await assert.rejects(
      () => saveOauthApp("google", { clientId: "cid-123", clientSecret: "" }),
      /Client Secret is required/,
    );
    await assert.rejects(
      () => saveOauthApp("google", { clientId: "  ", clientSecret: "sec" }),
      /Client ID is required/,
    );
    assert.deepEqual(await registeredOauthApps(), new Set());
  });

  test("registrations are independent, and clearing one leaves the others", async () => {
    await saveOauthApp("google", { clientId: "g-id", clientSecret: "g-sec" });
    await saveOauthApp("github", { clientId: "gh-id", clientSecret: "gh-sec" });
    assert.deepEqual(await registeredOauthApps(), new Set(["google", "github"]));

    await clearOauthApp("google");
    assert.deepEqual(await registeredOauthApps(), new Set(["github"]));
    assert.equal(await getRegisteredOauthApp("google"), null);
    assert.deepEqual(await getRegisteredOauthApp("github"), {
      clientId: "gh-id",
      clientSecret: "gh-sec",
    });
  });

  test("clearing an app that was never registered is a no-op", async () => {
    await clearOauthApp("linkedin");
    assert.deepEqual(await registeredOauthApps(), new Set());
  });

  test("only known apps are registerable", () => {
    assert.equal(isRegisterableOauthApp("google"), true);
    assert.equal(isRegisterableOauthApp("genosyn"), false);
    assert.equal(isRegisterableOauthApp(""), false);
  });

  test("concurrent saves of different apps both survive", async () => {
    // One row holds every app, so a save is a read-modify-write of the whole
    // map. Without a conditional write the loser silently erases the winner.
    await Promise.all([
      saveOauthApp("google", { clientId: "g-id", clientSecret: "g-sec" }),
      saveOauthApp("github", { clientId: "gh-id", clientSecret: "gh-sec" }),
    ]);
    assert.deepEqual(await registeredOauthApps(), new Set(["google", "github"]));
  });

  test("a save does not resurrect an app cleared in the meantime", async () => {
    await saveOauthApp("google", { clientId: "g-id", clientSecret: "g-sec" });
    // Reading first is what a cached implementation would do; the write must
    // still be evaluated against the state at write time, not this snapshot.
    await getRegisteredOauthApp("google");
    await clearOauthApp("google");
    await saveOauthApp("github", { clientId: "gh-id", clientSecret: "gh-sec" });

    assert.equal(
      await getRegisteredOauthApp("google"),
      null,
      "a revoked client must not come back through an unrelated save",
    );
  });

  test("the unlocks list is derived from the provider catalog, not hand-written", async () => {
    const google = (await describeOauthApps()).find((a) => a.app === "google")!;
    // Four integrations share the `google` OAuth app; copy that named three of
    // them would go stale the moment a fifth is added.
    assert.ok(google.unlocks.includes("Google Workspace"));
    assert.ok(google.unlocks.includes("Google Ads"));
    assert.equal(
      google.unlocks.length,
      listCatalog().filter((e) => e.oauth?.app === "google").length,
    );
  });

  test("a corrupt or hostile settings row degrades to 'nothing registered'", () => {
    assert.deepEqual(parseStored("not json at all"), {});
    assert.deepEqual(parseStored("[]"), {});
    // Unknown keys and entries missing a client id are dropped rather than
    // trusted — this row is the input to every connect flow on the install.
    assert.deepEqual(
      parseStored(
        JSON.stringify({
          evil: { clientId: "x", encryptedClientSecret: "y" },
          google: { encryptedClientSecret: "y" },
        }),
      ),
      {},
    );
  });
});

describe("the catalog tells the connect form when credentials are unnecessary", () => {
  test("no registration means no instanceApp flag anywhere", () => {
    const catalog = listCatalog();
    assert.equal(
      catalog.every((e) => !e.oauth?.instanceApp),
      true,
    );
  });

  test("one registration covers every integration sharing that OAuth app", () => {
    const catalog = listCatalog({ registeredOauthApps: new Set(["google"]) });
    const flagged = catalog.filter((e) => e.oauth?.instanceApp).map((e) => e.provider);

    // Registering `google` once unlocks Workspace, Analytics, and Search
    // Console together — they share one OAuth app.
    assert.ok(flagged.includes("google"));
    assert.ok(flagged.includes("google-analytics"));
    assert.ok(flagged.includes("google-search-console"));
    // …and nothing else.
    assert.equal(
      catalog
        .filter((e) => e.oauth && e.oauth.app !== "google")
        .every((e) => !e.oauth?.instanceApp),
      true,
    );
  });

  test("marking the catalog does not mutate the provider's static entry", () => {
    listCatalog({ registeredOauthApps: new Set(["google"]) });
    assert.equal(
      listCatalog().every((e) => !e.oauth?.instanceApp),
      true,
      "a later call with no registration must come back clean",
    );
  });
});

describe("startOauth credential resolution", () => {
  const base = {
    companyId: "company-oauth-apps-test",
    userId: "user-1",
    provider: "google",
    label: "Google Workspace",
    scopeGroups: ["mail"],
  };

  test("without a registration or per-connection credentials it explains both fixes", async () => {
    await assert.rejects(
      () => startOauth(base),
      (err: Error) => {
        assert.match(err.message, /No Google Workspace OAuth client is available/);
        assert.match(err.message, /Admin → Integrations/);
        return true;
      },
    );
  });

  test("a registered app authorizes with the instance client id — nothing typed", async () => {
    await saveOauthApp("google", { clientId: "instance-cid", clientSecret: "instance-sec" });

    const { authorizeUrl } = await startOauth(base);
    const url = new URL(authorizeUrl);
    assert.equal(url.searchParams.get("client_id"), "instance-cid");
  });

  test("per-connection credentials still win over the instance app", async () => {
    await saveOauthApp("google", { clientId: "instance-cid", clientSecret: "instance-sec" });

    const { authorizeUrl } = await startOauth({
      ...base,
      clientId: "own-cid",
      clientSecret: "own-sec",
    });
    assert.equal(new URL(authorizeUrl).searchParams.get("client_id"), "own-cid");
  });

  test("reconnect follows a rotated instance secret when the client id still matches", async () => {
    // Rotating the instance secret would otherwise break every Connection made
    // from it, with no in-place fix: reconnect is the only path that preserves
    // grants, and delete+recreate revokes the whole team's access.
    await saveOauthApp("google", { clientId: "instance-cid", clientSecret: "old-sec" });
    const conn = await insert(IntegrationConnection, {
      companyId: base.companyId,
      provider: "google",
      label: "Support Gmail",
      authMode: "oauth2",
      encryptedConfig: encryptConnectionConfig(
        {
          clientId: "instance-cid",
          clientSecret: "old-sec",
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: Date.now() + 3_600_000,
          grantedScope: "",
          scopeGroups: ["mail"],
        },
        base.companyId,
      ),
      accountHint: "support@example.com",
      status: "connected",
      statusMessage: "",
    });
    await saveOauthApp("google", { clientId: "instance-cid", clientSecret: "rotated-sec" });

    const { authorizeUrl } = await startOauthReconnect({
      companyId: base.companyId,
      userId: base.userId,
      connectionId: conn.id,
    });
    // The authorize URL only carries the client id; the rotated secret shows up
    // at the token exchange, so assert on the resolved state instead.
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const resolved = await resolveOauthState(state);
    assert.equal(resolved?.clientId, "instance-cid");
    assert.equal(resolved?.clientSecret, "rotated-sec");
  });

  test("reconnect leaves a connection that brought its own client alone", async () => {
    await saveOauthApp("google", { clientId: "instance-cid", clientSecret: "instance-sec" });
    const conn = await insert(IntegrationConnection, {
      companyId: base.companyId,
      provider: "google",
      label: "Tenant Gmail",
      authMode: "oauth2",
      encryptedConfig: encryptConnectionConfig(
        {
          clientId: "company-owned-cid",
          clientSecret: "company-owned-sec",
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: Date.now() + 3_600_000,
          grantedScope: "",
          scopeGroups: ["mail"],
        },
        base.companyId,
      ),
      accountHint: "ops@tenant.example",
      status: "connected",
      statusMessage: "",
    });

    const { authorizeUrl } = await startOauthReconnect({
      companyId: base.companyId,
      userId: base.userId,
      connectionId: conn.id,
    });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const resolved = await resolveOauthState(state);
    assert.equal(resolved?.clientId, "company-owned-cid");
    assert.equal(resolved?.clientSecret, "company-owned-sec");
  });

  test("a half-supplied pair falls back rather than authorizing with a blank secret", async () => {
    await saveOauthApp("google", { clientId: "instance-cid", clientSecret: "instance-sec" });

    // A client id with no secret would otherwise reach Google and fail at the
    // token exchange, long after the user approved consent.
    const { authorizeUrl } = await startOauth({ ...base, clientId: "own-cid", clientSecret: "" });
    assert.equal(new URL(authorizeUrl).searchParams.get("client_id"), "instance-cid");
  });
});
