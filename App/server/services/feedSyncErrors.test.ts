import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { parseRetryAfter, ProviderRequestError } from "../integrations/providerErrors.js";
import { BrexApiError } from "../integrations/providers/brex.js";
import { WiseApiError, WiseScaRequiredError } from "../integrations/providers/wise.js";
import { ConnectionAuthError } from "../integrations/types.js";
import {
  describeFeedSyncFailure,
  FEED_SYNC_ERROR_KINDS,
  FeedSyncError,
  NEEDS_A_PERSON,
  setProviderRetrySleepForTests,
  withProviderRetry,
} from "./feedSyncErrors.js";
import { StripeApiError } from "./reconcile.js";

/**
 * How a Banking sync failure becomes one line a card can show — the kind that
 * decides what fixes it, and the provider's own words kept as the details —
 * and how a single provider request is asked again when the provider was only
 * busy, but never when asking again can't help.
 */

const BREX_CASH = { provider: "Brex", credential: "token", reads: "cash transactions" };
const BREX_CARD = { provider: "Brex", credential: "token", reads: "card transactions" };
const STRIPE = { provider: "Stripe", credential: "API key", reads: "payouts" };
const WISE = { provider: "Wise", credential: "API token", reads: "balance statements" };

describe("describeFeedSyncFailure", () => {
  test("a rejected token is an auth failure that marks the Connection expired", () => {
    const failure = describeFeedSyncFailure(
      new BrexApiError("Unauthorized", 401, null, "GET /v2/accounts/cash"),
      BREX_CASH,
    );
    assert.deepEqual(failure, {
      kind: "auth",
      message: "Brex rejected the token",
      detail: "Unauthorized · HTTP 401 · GET /v2/accounts/cash",
      retryAfterMs: null,
      connectionStatus: "expired",
    });
    assert.equal(
      describeFeedSyncFailure(new StripeApiError("Stripe 401: Invalid API Key", 401), STRIPE).message,
      "Stripe rejected the API key",
    );
  });

  test("Wise's own refusal of the token keeps Wise's guidance as the details", () => {
    const err = new ConnectionAuthError(
      "Wise rejected the API token. Copy it again, or create a new one in Wise.",
      "expired",
    );
    const failure = describeFeedSyncFailure(err, WISE);
    assert.equal(failure.kind, "auth");
    assert.equal(failure.message, "Wise rejected the API token");
    assert.equal(failure.detail, err.message);
    assert.equal(failure.connectionStatus, "expired");
  });

  test("a forbidden request names what the account reads", () => {
    const failure = describeFeedSyncFailure(
      new BrexApiError("Forbidden", 403, null, "GET /v2/transactions/card/primary"),
      BREX_CARD,
    );
    assert.equal(failure.kind, "permission");
    assert.equal(failure.message, "Brex won't let this token read card transactions");
    assert.equal(failure.connectionStatus, null, "the token works; it just lacks a scope");
  });

  test("Strong Customer Authentication is a Wise limit, not a broken token", () => {
    const failure = describeFeedSyncFailure(new WiseScaRequiredError(), WISE);
    assert.equal(failure.kind, "unsupported");
    assert.match(failure.message, /Strong Customer Authentication/);
    assert.match(failure.detail, /HTTP 403/);
  });

  test("busy, unreachable and failing providers are told apart", () => {
    const limited = describeFeedSyncFailure(
      new WiseApiError("Wise is limiting how fast it answers.", 429, 7_000, "GET /profiles"),
      WISE,
    );
    assert.equal(limited.kind, "rate_limited");
    assert.equal(limited.message, "Wise asked Genosyn to slow down");
    assert.equal(limited.retryAfterMs, 7_000);

    const silent = describeFeedSyncFailure(
      new BrexApiError("Brex didn't answer within 30 seconds. Try again.", 0, null, "GET /v2/accounts/cash"),
      BREX_CASH,
    );
    assert.equal(silent.kind, "provider_unavailable");
    assert.equal(silent.message, "Brex didn't answer");
    assert.match(silent.detail, /no answer/);

    const down = describeFeedSyncFailure(new StripeApiError("Stripe 503", 503, 30_000), STRIPE);
    assert.equal(down.kind, "provider_unavailable");
    assert.equal(down.message, "Stripe had a problem on its side");
    assert.equal(down.retryAfterMs, 30_000);

    const refused = describeFeedSyncFailure(new BrexApiError("Bad cursor", 422), BREX_CASH);
    assert.equal(refused.kind, "provider_error");
    assert.equal(refused.message, "Brex refused the request");

    const missing = describeFeedSyncFailure(new BrexApiError("Not found", 404), BREX_CASH);
    assert.equal(missing.kind, "account_missing");

    const network = describeFeedSyncFailure(new TypeError("fetch failed"), BREX_CASH);
    assert.equal(network.kind, "provider_unavailable");
    assert.equal(network.message, "Genosyn couldn't reach Brex");
  });

  test("failures Genosyn recognised read as the account's own sentence", () => {
    assert.deepEqual(
      describeFeedSyncFailure(new FeedSyncError("connection_missing", "Brex Connection not found"), BREX_CASH),
      {
        kind: "connection_missing",
        message: "The Brex Connection this account used was removed",
        detail: "Brex Connection not found",
        retryAfterMs: null,
        connectionStatus: null,
      },
    );
    assert.equal(
      describeFeedSyncFailure(
        new FeedSyncError("credentials", "Integration config is corrupted"),
        STRIPE,
      ).message,
      "Genosyn can't read the Stripe API key saved on the Connection",
    );
    const bad = describeFeedSyncFailure(
      new FeedSyncError("bad_data", "Brex transaction tx_1 has no safe integer amount"),
      BREX_CASH,
    );
    assert.equal(bad.message, "Brex sent a transaction Genosyn couldn't read");
    assert.equal(bad.detail, "Brex transaction tx_1 has no safe integer amount");
    const closed = describeFeedSyncFailure(
      new FeedSyncError(
        "account_missing",
        "This Wise balance is no longer on the Connection — it may have been closed.",
      ),
      WISE,
    );
    assert.equal(
      closed.message,
      "This Wise balance is no longer on the Connection — it may have been closed",
      "one line on a card, without its full stop",
    );
  });

  test("anything else is an unexpected error, with what it said kept", () => {
    const failure = describeFeedSyncFailure(new Error("SQLITE_BUSY: database is locked"), BREX_CASH);
    assert.equal(failure.kind, "internal");
    assert.equal(failure.message, "The sync stopped on an unexpected error");
    assert.equal(failure.detail, "SQLITE_BUSY: database is locked");
    assert.equal(describeFeedSyncFailure("thrown string", BREX_CASH).detail, "thrown string");
  });

  test("lines and details are bounded, whatever a provider answers with", () => {
    const huge = describeFeedSyncFailure(new BrexApiError("x".repeat(10_000), 500), BREX_CASH);
    assert.ok(huge.detail.length <= 2_000);
    assert.ok(huge.detail.endsWith("…"));
    const long = describeFeedSyncFailure(new FeedSyncError("unsupported", "y".repeat(1_000)), WISE);
    assert.ok(long.message.length <= 300);
  });

  test("every kind is listed, and the ones only a person can fix are named", () => {
    assert.equal(new Set(FEED_SYNC_ERROR_KINDS).size, FEED_SYNC_ERROR_KINDS.length);
    for (const kind of NEEDS_A_PERSON) assert.ok(FEED_SYNC_ERROR_KINDS.includes(kind));
    for (const kind of ["rate_limited", "provider_unavailable", "internal"] as const) {
      assert.equal(NEEDS_A_PERSON.has(kind), false);
    }
  });
});

describe("parseRetryAfter", () => {
  test("reads seconds and HTTP dates, and nothing else", () => {
    const now = Date.parse("2026-10-23T10:00:00Z");
    assert.equal(parseRetryAfter("7", now), 7_000);
    assert.equal(parseRetryAfter("1.5", now), 1_500);
    assert.equal(parseRetryAfter("Fri, 23 Oct 2026 10:02:00 GMT", now), 120_000);
    assert.equal(parseRetryAfter("Fri, 23 Oct 2026 09:00:00 GMT", now), 0, "a date passed is now");
    assert.equal(parseRetryAfter("soon", now), null);
    assert.equal(parseRetryAfter("", now), null);
    assert.equal(parseRetryAfter(null, now), null);
    assert.equal(parseRetryAfter("999999999", now), 24 * 60 * 60 * 1000, "capped at a day");
  });
});

describe("withProviderRetry", () => {
  let waits: number[] = [];
  afterEach(() => {
    setProviderRetrySleepForTests(null);
  });
  function noSleeping() {
    waits = [];
    setProviderRetrySleepForTests(async (ms) => {
      waits.push(ms);
    });
  }

  function failing(errors: unknown[], value = "ok") {
    let calls = 0;
    return {
      calls: () => calls,
      request: async () => {
        calls += 1;
        const next = errors.shift();
        if (next) throw next;
        return value;
      },
    };
  }

  test("asks again after a busy or briefly unreachable provider", async () => {
    noSleeping();
    const flaky = failing([new BrexApiError("Busy", 503), new TypeError("fetch failed")]);
    assert.equal(await withProviderRetry(flaky.request), "ok");
    assert.equal(flaky.calls(), 3);
    assert.deepEqual(waits, [1_000, 2_000]);
  });

  test("waits as long as the provider asked", async () => {
    noSleeping();
    const limited = failing([new WiseApiError("Slow down", 429, 4_000)]);
    assert.equal(await withProviderRetry(limited.request), "ok");
    assert.deepEqual(waits, [4_000]);
  });

  test("gives up after three tries", async () => {
    noSleeping();
    const down = failing([
      new BrexApiError("Busy", 502),
      new BrexApiError("Busy", 502),
      new BrexApiError("Still busy", 502),
      new BrexApiError("never reached", 502),
    ]);
    await assert.rejects(withProviderRetry(down.request), /Still busy/);
    assert.equal(down.calls(), 3);
  });

  test("never asks again when the answer can't change", async () => {
    noSleeping();
    for (const err of [
      new BrexApiError("Unauthorized", 401),
      new BrexApiError("Forbidden", 403),
      new BrexApiError("Not found", 404),
      new ConnectionAuthError("Wise rejected the API token"),
      new FeedSyncError("bad_data", "no amount"),
      new Error("programming error"),
    ]) {
      const once = failing([err]);
      await assert.rejects(withProviderRetry(once.request));
      assert.equal(once.calls(), 1, `${(err as Error).message} is not retried`);
    }
    assert.deepEqual(waits, []);
  });

  test("leaves a provider alone that asks for more than twenty seconds", async () => {
    noSleeping();
    const err = new ProviderRequestError("Slow down", "Brex", 429, 60_000);
    const long = failing([err]);
    await assert.rejects(withProviderRetry(long.request), (thrown) => thrown === err);
    assert.equal(long.calls(), 1);
    assert.deepEqual(waits, []);
  });
});
