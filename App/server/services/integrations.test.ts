import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailThread } from "../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  decryptConnectionConfig,
  encryptConnectionConfig,
  persistConnectionConfigIfCurrent,
  updateOauthConnectionConfig,
  updateServiceAccountCredentials,
} from "./integrations.js";
import { createMailAccount, freshGmailAccessToken } from "./mail/accounts.js";
import { startOauthReconnect } from "./oauth.js";

const COMPANY_ID = "company-mail-reconnect-test";
const originalFetch = globalThis.fetch;

let connection: IntegrationConnection;
let account: MailAccount;
let thread: MailThread;

before(initTestDb);
after(closeTestDb);
afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await resetTestDb();
  connection = await insert(IntegrationConnection, {
    companyId: COMPANY_ID,
    provider: "google",
    label: "Support Gmail",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(
      {
        clientId: "client-id",
        clientSecret: "old-secret",
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
      },
      COMPANY_ID,
    ),
    accountHint: "support@example.com",
    status: "error",
    statusMessage: "Token expired",
    lastCheckedAt: new Date("2026-08-13T08:00:00.000Z"),
  });
  account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: connection.id,
    address: "support@example.com",
    status: "error",
    statusMessage: "The Google token expired",
    historyId: "history-42",
    lastSyncAt: new Date("2026-08-13T07:55:00.000Z"),
    syncState: "failed",
    syncAttemptId: "attempt-42",
    syncStartedAt: new Date("2026-08-13T07:54:00.000Z"),
    syncFinishedAt: new Date("2026-08-13T07:55:00.000Z"),
    backfilledAt: new Date("2026-08-01T09:00:00.000Z"),
    backfillPageToken: "",
    backfilledCount: 1234,
    createdByUserId: "user-1",
  });
  thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: "gmail-thread-1",
    subject: "Keep this mirror",
    snippet: "Existing mirrored data",
    participants: "Customer",
    labelIds: " INBOX ",
    unread: true,
    messageCount: 1,
    hasAttachments: false,
    lastMessageAt: new Date("2026-08-13T07:50:00.000Z"),
  });
});

describe("OAuth reconnect mailbox identity guard", () => {
  test("rejects a different Google identity without mutating the Connection or mail mirror", async () => {
    const beforeConnection = await AppDataSource.getRepository(
      IntegrationConnection,
    ).findOneByOrFail({
      id: connection.id,
    });
    const beforeEncryptedConfig = beforeConnection.encryptedConfig;
    const beforeCheckedAt = beforeConnection.lastCheckedAt?.toISOString();

    await assert.rejects(
      updateOauthConnectionConfig({
        companyId: COMPANY_ID,
        connectionId: connection.id,
        config: {
          clientId: "client-id",
          clientSecret: "new-secret",
          accessToken: "wrong-mailbox-access-token",
          refreshToken: "wrong-mailbox-refresh-token",
          email: "other@example.com",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        },
        accountHint: "other@example.com",
      }),
      /Reconnect the same account \(support@example\.com\)/,
    );

    const storedConnection = await AppDataSource.getRepository(
      IntegrationConnection,
    ).findOneByOrFail({ id: connection.id });
    const storedAccount = await AppDataSource.getRepository(MailAccount).findOneByOrFail({
      id: account.id,
    });
    const storedThread = await AppDataSource.getRepository(MailThread).findOneByOrFail({
      id: thread.id,
    });

    assert.equal(storedConnection.encryptedConfig, beforeEncryptedConfig);
    assert.equal(storedConnection.accountHint, "support@example.com");
    assert.equal(storedConnection.status, "error");
    assert.equal(storedConnection.statusMessage, "Token expired");
    assert.equal(storedConnection.lastCheckedAt?.toISOString(), beforeCheckedAt);
    assert.equal(storedAccount.connectionId, connection.id);
    assert.equal(storedAccount.address, "support@example.com");
    assert.equal(storedAccount.historyId, "history-42");
    assert.equal(storedAccount.syncState, "failed");
    assert.equal(storedAccount.backfilledCount, 1234);
    assert.equal(storedThread.accountId, account.id);
    assert.equal(storedThread.gmailThreadId, "gmail-thread-1");
    assert.equal(storedThread.subject, "Keep this mirror");
    assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 1);
    assert.equal(await AppDataSource.getRepository(MailThread).count(), 1);
  });

  test("accepts the same identity case-insensitively while preserving stable mail ids and state", async () => {
    const updated = await updateOauthConnectionConfig({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      config: {
        clientId: "client-id",
        clientSecret: "new-secret",
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        email: "SUPPORT@EXAMPLE.COM",
        scope:
          "openid email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify",
      },
      accountHint: "  SUPPORT@EXAMPLE.COM ",
    });

    assert.equal(updated?.id, connection.id);
    assert.equal(updated?.label, "Support Gmail");
    assert.equal(updated?.status, "connected");
    assert.equal(updated?.statusMessage, "");
    assert.equal(updated?.accountHint, "  SUPPORT@EXAMPLE.COM ");
    assert.deepEqual(decryptConnectionConfig(updated!), {
      clientId: "client-id",
      clientSecret: "new-secret",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      email: "SUPPORT@EXAMPLE.COM",
      scope:
        "openid email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify",
    });

    const storedAccount = await AppDataSource.getRepository(MailAccount).findOneByOrFail({
      id: account.id,
    });
    const storedThread = await AppDataSource.getRepository(MailThread).findOneByOrFail({
      id: thread.id,
    });
    assert.equal(storedAccount.id, account.id);
    assert.equal(storedAccount.connectionId, connection.id);
    assert.equal(storedAccount.address, "support@example.com");
    assert.equal(storedAccount.status, "error");
    assert.equal(storedAccount.statusMessage, "The Google token expired");
    assert.equal(storedAccount.historyId, "history-42");
    assert.equal(storedAccount.syncAttemptId, "attempt-42");
    assert.equal(storedAccount.backfilledCount, 1234);
    assert.equal(storedThread.id, thread.id);
    assert.equal(storedThread.gmailThreadId, "gmail-thread-1");
    assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 1);
    assert.equal(await AppDataSource.getRepository(MailThread).count(), 1);
  });

  test("does not apply a mailbox guard to an unlinked OAuth Connection", async () => {
    await AppDataSource.getRepository(MailAccount).delete({ id: account.id });

    const updated = await updateOauthConnectionConfig({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      config: { accessToken: "other-account-token" },
      accountHint: "other@example.com",
    });

    assert.equal(updated?.id, connection.id);
    assert.equal(updated?.accountHint, "other@example.com");
    assert.deepEqual(decryptConnectionConfig(updated!), { accessToken: "other-account-token" });
  });

  test("rejects a same-identity OAuth result that was granted without Gmail", async () => {
    const before = (
      await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
        id: connection.id,
      })
    ).encryptedConfig;

    await assert.rejects(
      updateOauthConnectionConfig({
        companyId: COMPANY_ID,
        connectionId: connection.id,
        config: {
          accessToken: "identity-only-token",
          email: "support@example.com",
          scope: "openid email https://www.googleapis.com/auth/gmail.settings.basic",
        },
        accountHint: "support@example.com",
      }),
      /Gmail product selected/,
    );

    const unchanged = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: connection.id,
    });
    assert.equal(unchanged.encryptedConfig, before);
    assert.equal(unchanged.status, "error");
  });

  test("keeps Gmail selected for legacy mailbox reconnects and rejects explicitly removing it", async () => {
    const started = await startOauthReconnect({
      companyId: COMPANY_ID,
      userId: "user-1",
      connectionId: connection.id,
    });
    const scopes = new URL(started.authorizeUrl).searchParams.get("scope") ?? "";
    assert.match(scopes, /auth\/gmail\.modify/);

    await assert.rejects(
      startOauthReconnect({
        companyId: COMPANY_ID,
        userId: "user-1",
        connectionId: connection.id,
        scopeGroups: [],
      }),
      /Gmail product selected/,
    );
  });

  test("keeps service-account reconnect bound to the same impersonated mailbox", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    connection.authMode = "service_account";
    connection.encryptedConfig = encryptConnectionConfig(
      {
        clientEmail: "service@project.iam.gserviceaccount.com",
        privateKey: "old-key",
        privateKeyId: "old-key-id",
        projectId: "project-id",
        impersonationEmail: "support@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
      COMPANY_ID,
    );
    await AppDataSource.getRepository(IntegrationConnection).save(connection);
    const before = connection.encryptedConfig;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "minted-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(
      updateServiceAccountCredentials({
        companyId: COMPANY_ID,
        connectionId: connection.id,
        keyJson: {
          type: "service_account",
          client_email: "service@project.iam.gserviceaccount.com",
          private_key: privateKey,
          private_key_id: "new-key-id",
          project_id: "project-id",
        },
        impersonationEmail: "other@example.com",
        scopeGroups: ["mail"],
      }),
      /Reconnect the same account \(support@example\.com\)/,
    );

    const unchanged = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: connection.id,
    });
    assert.equal(unchanged.encryptedConfig, before);
    assert.equal(unchanged.accountHint, "support@example.com");

    const updated = await updateServiceAccountCredentials({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      keyJson: {
        type: "service_account",
        client_email: "service@project.iam.gserviceaccount.com",
        private_key: privateKey,
        private_key_id: "new-key-id",
        project_id: "project-id",
      },
      impersonationEmail: " SUPPORT@EXAMPLE.COM ",
      scopeGroups: ["mail"],
    });
    assert.equal(updated?.id, connection.id);
    assert.equal(
      updated?.accountHint,
      "service@project.iam.gserviceaccount.com → SUPPORT@EXAMPLE.COM",
    );
    const config = decryptConnectionConfig(updated!) as Record<string, unknown>;
    assert.equal(config.impersonationEmail, "SUPPORT@EXAMPLE.COM");
    assert.ok(
      Array.isArray(config.scopes) &&
        config.scopes.some((scope) => typeof scope === "string" && scope.includes("auth/gmail.")),
    );

    const omitted = await updateServiceAccountCredentials({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      keyJson: {
        type: "service_account",
        client_email: "service@project.iam.gserviceaccount.com",
        private_key: privateKey,
        private_key_id: "newer-key-id",
        project_id: "project-id",
      },
      scopeGroups: ["mail"],
    });
    const omittedConfig = decryptConnectionConfig(omitted!) as Record<string, unknown>;
    assert.equal(omittedConfig.impersonationEmail, "SUPPORT@EXAMPLE.COM");
  });

  test("links an expired-token mailbox using the exact refreshed credential snapshot", async () => {
    await AppDataSource.getRepository(MailAccount).delete({ id: account.id });
    connection.encryptedConfig = encryptConnectionConfig(
      {
        clientId: "client-id",
        clientSecret: "client-secret",
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt: 0,
        email: "support@example.com",
        scope: "openid https://www.googleapis.com/auth/gmail.modify",
      },
      COMPANY_ID,
    );
    await AppDataSource.getRepository(IntegrationConnection).save(connection);
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/gmail/v1/users/me/profile")) {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fresh-token");
        return new Response(
          JSON.stringify({ emailAddress: "support@example.com", historyId: "history-new" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const linked = await createMailAccount({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      createdByUserId: "user-1",
    });

    assert.equal(linked.address, "support@example.com");
    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: connection.id,
    });
    assert.equal(
      (decryptConnectionConfig(stored) as Record<string, unknown>).accessToken,
      "fresh-token",
    );
  });

  test("does not bind a profile read with credentials replaced during the request", async () => {
    await AppDataSource.getRepository(MailAccount).delete({ id: account.id });
    connection.encryptedConfig = encryptConnectionConfig(
      {
        accessToken: "mailbox-a-token",
        expiresAt: Date.now() + 3_600_000,
        email: "support@example.com",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      COMPANY_ID,
    );
    await AppDataSource.getRepository(IntegrationConnection).save(connection);
    let releaseProfile = (): void => undefined;
    let profileStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      profileStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/gmail/v1/users/me/profile")) {
        profileStarted();
        await gate;
        return new Response(
          JSON.stringify({ emailAddress: "support@example.com", historyId: "history-a" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const linking = createMailAccount({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      createdByUserId: "user-1",
    });
    await started;
    await updateOauthConnectionConfig({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      config: {
        accessToken: "mailbox-b-token",
        expiresAt: Date.now() + 3_600_000,
        email: "other@example.com",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      accountHint: "other@example.com",
    });
    releaseProfile();

    await assert.rejects(linking, /Connection changed while the mailbox was being linked/);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
  });

  test("serializes reconnect behind the exact SQLite mailbox-insert critical section", async () => {
    await AppDataSource.getRepository(MailAccount).delete({ id: account.id });
    connection.encryptedConfig = encryptConnectionConfig(
      {
        accessToken: "mailbox-a-token",
        expiresAt: Date.now() + 3_600_000,
        email: "support@example.com",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      COMPANY_ID,
    );
    connection.accountHint = "support@example.com";
    await AppDataSource.getRepository(IntegrationConnection).save(connection);
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/gmail/v1/users/me/profile")) {
        return new Response(
          JSON.stringify({ emailAddress: "support@example.com", historyId: "history-a" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let criticalSectionEntered = (): void => undefined;
    let releaseCriticalSection = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      criticalSectionEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCriticalSection = resolve;
    });

    const linking = createMailAccount({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      createdByUserId: "user-1",
      beforePersist: async () => {
        criticalSectionEntered();
        await gate;
      },
    });
    await entered;
    let reconnectSettled = false;
    const reconnecting = updateOauthConnectionConfig({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      config: {
        accessToken: "mailbox-b-token",
        expiresAt: Date.now() + 3_600_000,
        email: "other@example.com",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      accountHint: "other@example.com",
    }).finally(() => {
      reconnectSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(reconnectSettled, false);

    releaseCriticalSection();
    const linked = await linking;
    await assert.rejects(
      reconnecting,
      /Reconnect the same account \(support@example\.com\)/,
    );

    const storedConnection = await AppDataSource.getRepository(
      IntegrationConnection,
    ).findOneByOrFail({ id: connection.id });
    const storedAccount = await AppDataSource.getRepository(MailAccount).findOneByOrFail({
      id: linked.id,
    });
    assert.equal(storedAccount.address, "support@example.com");
    assert.equal(
      (decryptConnectionConfig(storedConnection) as Record<string, unknown>).email,
      "support@example.com",
    );
  });

  test("a reconnect wins over a stale token refresh compare-and-swap", async () => {
    connection.encryptedConfig = encryptConnectionConfig(
      {
        clientId: "client-id",
        clientSecret: "old-client-secret",
        accessToken: "expired-token",
        refreshToken: "old-refresh-token",
        expiresAt: 0,
        email: "support@example.com",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      COMPANY_ID,
    );
    await AppDataSource.getRepository(IntegrationConnection).save(connection);
    const staleConnection = await AppDataSource.getRepository(
      IntegrationConnection,
    ).findOneByOrFail({
      id: connection.id,
    });
    let releaseRefresh = (): void => undefined;
    let refreshStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    globalThis.fetch = (async (input) => {
      if (String(input) !== "https://oauth2.googleapis.com/token") {
        throw new Error(`Unexpected request: ${String(input)}`);
      }
      refreshStarted();
      await gate;
      return new Response(JSON.stringify({ access_token: "stale-refreshed-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const refreshing = freshGmailAccessToken(staleConnection);
    await started;
    await updateOauthConnectionConfig({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      config: {
        accessToken: "reconnected-token",
        refreshToken: "reconnected-refresh-token",
        expiresAt: Date.now() + 3_600_000,
        email: "support@example.com",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      accountHint: "support@example.com",
    });
    releaseRefresh();

    await assert.rejects(refreshing, /Connection changed while its token refreshed/);
    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: connection.id,
    });
    assert.equal(
      (decryptConnectionConfig(stored) as Record<string, unknown>).accessToken,
      "reconnected-token",
    );
  });

  test("credential compare-and-swap never replaces a newer reconnect", async () => {
    const staleSnapshot = connection.encryptedConfig;
    await updateOauthConnectionConfig({
      companyId: COMPANY_ID,
      connectionId: connection.id,
      config: {
        accessToken: "newest-token",
        email: "support@example.com",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      accountHint: "support@example.com",
    });

    const persisted = await persistConnectionConfigIfCurrent({
      connectionId: connection.id,
      companyId: COMPANY_ID,
      previousEncryptedConfig: staleSnapshot,
      config: { accessToken: "stale-token" },
    });

    assert.equal(persisted, null);
    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: connection.id,
    });
    assert.equal(
      (decryptConnectionConfig(stored) as Record<string, unknown>).accessToken,
      "newest-token",
    );
  });
});
