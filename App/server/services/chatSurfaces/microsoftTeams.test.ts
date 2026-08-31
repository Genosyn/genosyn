import assert from "node:assert/strict";
import crypto from "node:crypto";
import { beforeEach, describe, test } from "node:test";

import {
  bearerToken,
  BOT_FRAMEWORK_ISSUER,
  CLOCK_SKEW_MS,
  cleanTeamsText,
  createBotFrameworkKeyLoader,
  decodeTeamsEntities,
  forgetBotFrameworkKeys,
  forgetServiceUrls,
  JWKS_REFRESH_COOLDOWN_MS,
  JWKS_TTL_MS,
  lastServiceUrl,
  mentionedIds,
  microsoftTeamsChatSurface,
  normalizeTeamsActivity,
  parseJwks,
  primeBotFrameworkKeysForTests,
  rememberServiceUrl,
  sameBotId,
  stripTeamsMentions,
  TEAMS_TEXT_LIMIT,
  verifyBotFrameworkJwt,
  verifyBotFrameworkJwtWithKeyRefresh,
  type BotFrameworkKey,
} from "./microsoftTeams.js";
import { truncateForSurface, type ChatSurfaceWebhookResult } from "./types.js";

/**
 * Microsoft Teams is the only surface whose inbound credential is a signature
 * we have to check ourselves — Telegram and Slack hand us an already-
 * authenticated stream. So the bulk of this file is the JWT verifier, driven
 * by keys generated here rather than by Microsoft's live JWKS: a verifier
 * that can only be exercised against the real thing is a verifier whose
 * failure modes nobody ever sees.
 *
 * The test that matters most is `an HS256 token signed with our own public
 * key`. Trusting the header's `alg` is the classic JWT forgery, it produces
 * an implementation that looks correct in every happy-path test, and it is
 * the reason `verifyBotFrameworkJwt` refuses anything but RS256 before it
 * touches a key.
 */

const APP_ID = "11111111-2222-3333-4444-555555555555";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const BOT_ID = `28:${APP_ID}`;
const KID = "signing-key-1";
const NOW = 1_700_000_000_000;
const NOW_S = NOW / 1000;

const signer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const impostor = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const KEYS: BotFrameworkKey[] = [
  { ...signer.publicKey.export({ format: "jwk" }), kid: KID },
];

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Sign two already-encoded segments, so a test can hand over garbage on purpose. */
function segToken(headerSeg: string, payloadSeg: string, key = signer.privateKey): string {
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(`${headerSeg}.${payloadSeg}`, "ascii"),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
  );
  return `${headerSeg}.${payloadSeg}.${signature.toString("base64url")}`;
}

function jwt(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = signer.privateKey,
): string {
  return segToken(
    b64({ alg: "RS256", typ: "JWT", kid: KID, ...header }),
    b64({
      iss: BOT_FRAMEWORK_ISSUER,
      aud: APP_ID,
      serviceUrl: SERVICE_URL,
      nbf: NOW_S - 60,
      exp: NOW_S + 600,
      ...claims,
    }),
    key,
  );
}

function verify(token: string, over: { appId?: string; serviceUrl?: string; now?: number } = {}) {
  return verifyBotFrameworkJwt({
    token,
    appId: over.appId ?? APP_ID,
    keys: KEYS,
    now: over.now ?? NOW,
    ...(over.serviceUrl === undefined ? {} : { serviceUrl: over.serviceUrl }),
  });
}

function rejection(token: string, over?: Parameters<typeof verify>[1]): string {
  const result = verify(token, over);
  assert.equal(result.ok, false, "expected this token to be rejected");
  return result.ok ? "" : result.reason;
}

beforeEach(() => {
  forgetServiceUrls();
  forgetBotFrameworkKeys();
});

// ---------- JWT verification ----------

describe("verifyBotFrameworkJwt · a genuine token", () => {
  test("accepts one and reports the claims it trusted", () => {
    const result = verify(jwt(), { serviceUrl: SERVICE_URL });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.claims : null, {
      iss: BOT_FRAMEWORK_ISSUER,
      aud: APP_ID,
      exp: NOW_S + 600,
      nbf: NOW_S - 60,
      serviceUrl: SERVICE_URL,
    });
  });

  test("an audience array containing our app id is still our token", () => {
    assert.equal(verify(jwt({ aud: ["someone-else", APP_ID] })).ok, true);
  });

  test("a token with no nbf is fine — Microsoft does not always send one", () => {
    assert.equal(verify(jwt({ nbf: undefined })).ok, true);
  });
});

describe("verifyBotFrameworkJwt · forgeries", () => {
  /**
   * The one that decides whether this file is security or theatre: the
   * attacker knows the public key (it is published), so if the header's
   * `alg` picks the algorithm they can sign an HS256 token with it.
   */
  test("an HS256 token signed with our own public key is refused on the algorithm", () => {
    const headerSeg = b64({ alg: "HS256", typ: "JWT", kid: KID });
    const payloadSeg = b64({
      iss: BOT_FRAMEWORK_ISSUER,
      aud: APP_ID,
      serviceUrl: SERVICE_URL,
      exp: NOW_S + 600,
    });
    const pem = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
    const mac = crypto
      .createHmac("sha256", pem)
      .update(`${headerSeg}.${payloadSeg}`)
      .digest("base64url");
    assert.equal(rejection(`${headerSeg}.${payloadSeg}.${mac}`), "unsupported-alg");
  });

  test("alg \"none\" with an empty signature is refused on the algorithm", () => {
    const headerSeg = b64({ alg: "none", typ: "JWT", kid: KID });
    const payloadSeg = b64({ iss: BOT_FRAMEWORK_ISSUER, aud: APP_ID, exp: NOW_S + 600 });
    assert.equal(rejection(`${headerSeg}.${payloadSeg}.`), "unsupported-alg");
  });

  test("any other RSA variant is refused too, rather than dispatched on", () => {
    assert.equal(rejection(jwt({}, { alg: "RS512" })), "unsupported-alg");
    assert.equal(rejection(jwt({}, { alg: "PS256" })), "unsupported-alg");
    assert.equal(rejection(jwt({}, { alg: "" })), "unsupported-alg");
  });

  test("a tampered payload fails as a forgery, not as a bad claim", () => {
    const genuine = jwt();
    const [headerSeg, , signatureSeg] = genuine.split(".");
    const swapped = b64({
      iss: BOT_FRAMEWORK_ISSUER,
      aud: APP_ID,
      serviceUrl: "https://attacker.example/",
      exp: NOW_S + 600,
    });
    assert.equal(rejection(`${headerSeg}.${swapped}.${signatureSeg}`), "bad-signature");
  });

  test("a real RSA signature from the wrong key is a forgery", () => {
    assert.equal(rejection(jwt({}, {}, impostor.privateKey)), "bad-signature");
  });

  test("a signature lifted from another token does not travel", () => {
    const [, , stolen] = jwt({ aud: "another-bot" }).split(".");
    const [headerSeg, payloadSeg] = jwt().split(".");
    assert.equal(rejection(`${headerSeg}.${payloadSeg}.${stolen}`), "bad-signature");
  });
});

describe("verifyBotFrameworkJwt · key selection", () => {
  test("a kid we do not hold is reported as such, so the caller can refetch", () => {
    assert.equal(rejection(jwt({}, { kid: "rotated-away" })), "unknown-kid");
  });

  test("a token with no kid names nothing to verify against", () => {
    assert.equal(rejection(jwt({}, { kid: undefined })), "missing-kid");
    assert.equal(rejection(jwt({}, { kid: "" })), "missing-kid");
  });

  test("a non-RSA key under a matching kid is refused before any verification", () => {
    const result = verifyBotFrameworkJwt({
      token: jwt(),
      appId: APP_ID,
      now: NOW,
      keys: [{ kty: "EC", crv: "P-256", x: "abc", y: "def", kid: KID }],
    });
    assert.deepEqual(result, { ok: false, reason: "unsupported-key" });
  });

  test("an RSA key with no material at all cannot be built", () => {
    const result = verifyBotFrameworkJwt({
      token: jwt(),
      appId: APP_ID,
      now: NOW,
      keys: [{ kty: "RSA", kid: KID }],
    });
    assert.deepEqual(result, { ok: false, reason: "unsupported-key" });
  });

  /**
   * A key that is merely *wrong* rather than unbuildable still fails — the
   * point of listing both is that neither route reaches the claims.
   */
  test("an RSA key with junk material verifies nothing", () => {
    const result = verifyBotFrameworkJwt({
      token: jwt(),
      appId: APP_ID,
      now: NOW,
      keys: [{ kty: "RSA", n: "!!!not-base64!!!", e: "AQAB", kid: KID }],
    });
    assert.deepEqual(result, { ok: false, reason: "bad-signature" });
  });

  test("an empty key set rejects everything", () => {
    const result = verifyBotFrameworkJwt({ token: jwt(), appId: APP_ID, keys: [], now: NOW });
    assert.deepEqual(result, { ok: false, reason: "unknown-kid" });
  });
});

describe("verifyBotFrameworkJwt · claims", () => {
  test("the issuer must be the Bot Framework", () => {
    assert.equal(rejection(jwt({ iss: "https://login.microsoftonline.com/" })), "bad-issuer");
    assert.equal(rejection(jwt({ iss: `${BOT_FRAMEWORK_ISSUER}/` })), "bad-issuer");
    assert.equal(rejection(jwt({ iss: undefined })), "bad-issuer");
  });

  /**
   * Microsoft signs every bot's tokens with these keys, so the signature says
   * "this came from Microsoft" and only the audience says "for us".
   */
  test("a perfectly valid token addressed to another bot is not ours", () => {
    assert.equal(rejection(jwt({ aud: "99999999-0000-0000-0000-000000000000" })), "bad-audience");
    assert.equal(rejection(jwt({ aud: ["someone", "else"] })), "bad-audience");
    assert.equal(rejection(jwt({ aud: undefined })), "bad-audience");
  });

  test("a Connection with no app id configured matches nothing", () => {
    assert.equal(rejection(jwt({ aud: "" }), { appId: "" }), "bad-audience");
    assert.equal(rejection(jwt(), { appId: "   " }), "bad-audience");
  });

  test("an expired token is rejected once the skew allowance runs out", () => {
    assert.equal(rejection(jwt({ exp: NOW_S - 3600 })), "expired");
    assert.equal(rejection(jwt({ exp: NOW_S - CLOCK_SKEW_MS / 1000 - 1 })), "expired");
    assert.equal(rejection(jwt({ exp: undefined })), "expired");
    assert.equal(rejection(jwt({ exp: "soon" })), "expired");
  });

  test("a token that expired within the skew still passes — clocks drift", () => {
    assert.equal(verify(jwt({ exp: NOW_S - CLOCK_SKEW_MS / 1000 + 1 })).ok, true);
  });

  test("a token from the future waits, but only past the skew", () => {
    assert.equal(rejection(jwt({ nbf: NOW_S + CLOCK_SKEW_MS / 1000 + 1 })), "not-yet-valid");
    assert.equal(verify(jwt({ nbf: NOW_S + CLOCK_SKEW_MS / 1000 - 1 })).ok, true);
    assert.equal(rejection(jwt({ nbf: "later" })), "not-yet-valid");
  });
});

describe("verifyBotFrameworkJwt · serviceUrl binding", () => {
  /**
   * The outbound endpoint is learned from inbound traffic, so an activity
   * that could name any serviceUrl would be a way to aim our bearer token.
   */
  test("a token minted for one endpoint cannot carry an activity from another", () => {
    assert.equal(
      rejection(jwt(), { serviceUrl: "https://attacker.example/" }),
      "service-url-mismatch",
    );
  });

  test("the trailing slash Microsoft sometimes omits is not a mismatch", () => {
    assert.equal(
      verify(jwt({ serviceUrl: "https://smba.trafficmanager.net/emea" }), {
        serviceUrl: "https://smba.trafficmanager.net/emea/",
      }).ok,
      true,
    );
  });

  test("a token without the claim binds to nothing and still verifies", () => {
    const result = verify(jwt({ serviceUrl: undefined }), { serviceUrl: SERVICE_URL });
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.claims.serviceUrl : "unset", undefined);
  });
});

describe("verifyBotFrameworkJwt · malformed input", () => {
  test("anything that is not three base64url segments is malformed", () => {
    assert.equal(rejection(""), "malformed");
    assert.equal(rejection("one.two"), "malformed");
    assert.equal(rejection("one.two.three.four"), "malformed");
    assert.equal(rejection("héader.payload.sig"), "malformed");
    assert.equal(rejection("aGVhZGVy.payload!.sig"), "malformed");
    assert.equal(rejection(".."), "malformed");
  });

  test("a header that is not a JSON object is a bad header", () => {
    const headerSeg = Buffer.from("not json at all", "utf8").toString("base64url");
    assert.equal(rejection(`${headerSeg}.${b64({})}.c2ln`), "bad-header");
    assert.equal(rejection(`${b64("a string")}.${b64({})}.c2ln`), "bad-header");
  });

  test("a correctly signed payload that is not JSON is a bad payload", () => {
    const payloadSeg = Buffer.from("still not json", "utf8").toString("base64url");
    const token = segToken(b64({ alg: "RS256", kid: KID }), payloadSeg);
    assert.equal(rejection(token), "bad-payload");
  });

  test("surrounding whitespace on the token is tolerated", () => {
    assert.equal(verify(`  ${jwt()}  `).ok, true);
  });
});

describe("verifyBotFrameworkJwtWithKeyRefresh", () => {
  function counting(sets: BotFrameworkKey[][]) {
    const calls: boolean[] = [];
    return {
      calls,
      loadKeys: async ({ forceRefresh }: { forceRefresh: boolean }) => {
        calls.push(forceRefresh);
        return sets[Math.min(calls.length - 1, sets.length - 1)];
      },
    };
  }

  test("an unknown kid buys exactly one forced refetch, and the rotation lands", async () => {
    const loader = counting([[], KEYS]);
    const result = await verifyBotFrameworkJwtWithKeyRefresh({
      token: jwt(),
      appId: APP_ID,
      now: NOW,
      loadKeys: loader.loadKeys,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(loader.calls, [false, true]);
  });

  test("a kid still unknown after the refetch stays rejected, without a third try", async () => {
    const loader = counting([[]]);
    const result = await verifyBotFrameworkJwtWithKeyRefresh({
      token: jwt(),
      appId: APP_ID,
      now: NOW,
      loadKeys: loader.loadKeys,
    });
    assert.deepEqual(result, { ok: false, reason: "unknown-kid" });
    assert.deepEqual(loader.calls, [false, true]);
  });

  /** Refetching on a forgery would let a bad token DoS us against Microsoft. */
  test("every other failure is final — no refetch", async () => {
    for (const token of [jwt({ aud: "someone-else" }), jwt({ exp: NOW_S - 9999 }), "rubbish"]) {
      const loader = counting([KEYS]);
      const result = await verifyBotFrameworkJwtWithKeyRefresh({
        token,
        appId: APP_ID,
        now: NOW,
        loadKeys: loader.loadKeys,
      });
      assert.equal(result.ok, false);
      assert.deepEqual(loader.calls, [false]);
    }
  });

  test("a genuine token never triggers a refetch", async () => {
    const loader = counting([KEYS]);
    const result = await verifyBotFrameworkJwtWithKeyRefresh({
      token: jwt(),
      appId: APP_ID,
      serviceUrl: SERVICE_URL,
      now: NOW,
      loadKeys: loader.loadKeys,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(loader.calls, [false]);
  });
});

/**
 * The messaging endpoint takes the token as its only credential, so an
 * unauthenticated caller decides how often we go and ask Microsoft for keys.
 * A `kid` nobody ever issued is free to mint and used to buy two requests to
 * login.botframework.com each — these tests count the requests a burst of
 * them is allowed to spend, which is why the fetcher and the clock are both
 * fakes.
 */
describe("createBotFrameworkKeyLoader · the refresh cooldown", () => {
  const ROTATED_KID = "signing-key-2";
  const ROTATED_KEYS: BotFrameworkKey[] = [
    { ...impostor.publicKey.export({ format: "jwk" }), kid: ROTATED_KID },
  ];

  /** A genuine token from after a rotation: new kid, new key, real signature. */
  function rotatedJwt(): string {
    return jwt({}, { kid: ROTATED_KID }, impostor.privateKey);
  }

  function harness() {
    let clock = NOW;
    let fetches = 0;
    let serving: () => BotFrameworkKey[] = () => KEYS;
    const loader = createBotFrameworkKeyLoader({
      now: () => clock,
      fetchKeys: async () => {
        fetches += 1;
        return serving();
      },
    });
    return {
      loader,
      fetches: () => fetches,
      advance: (ms: number) => {
        clock += ms;
      },
      serve: (next: () => BotFrameworkKey[]) => {
        serving = next;
      },
      verify: (token: string) =>
        verifyBotFrameworkJwtWithKeyRefresh({
          token,
          appId: APP_ID,
          now: clock,
          loadKeys: loader.load,
        }),
    };
  }

  /**
   * Both halves at once: one request for the whole burst, and *every*
   * delivery in it verifies. Coalescing without the second assertion would
   * look identical to a cooldown that simply refused eight times.
   */
  test("a burst signed by a rotated key spends one fetch, and all of it lands", async () => {
    const h = harness();
    h.loader.prime(KEYS);
    h.serve(() => ROTATED_KEYS);
    const results = await Promise.all(Array.from({ length: 8 }, () => h.verify(rotatedJwt())));
    assert.deepEqual(
      results.map((r) => r.ok),
      Array.from({ length: 8 }, () => true),
    );
    assert.equal(h.fetches(), 1);
  });

  test("a second unknown kid inside the window buys no request at all", async () => {
    const h = harness();
    h.loader.prime(KEYS);
    h.serve(() => ROTATED_KEYS);
    assert.equal((await h.verify(rotatedJwt())).ok, true);
    assert.equal(h.fetches(), 1);

    const unknown = await h.verify(jwt({}, { kid: "never-issued" }));
    assert.deepEqual(unknown, { ok: false, reason: "unknown-kid" });
    assert.equal(h.fetches(), 1);

    // A plain rejection, the same shape an outright forgery gets, because
    // `verifyAndNormalize` turns every reason into the same bare 401 — the
    // endpoint must not answer "which keys are you holding?".
    const forged = await h.verify(jwt({}, { kid: ROTATED_KID }, signer.privateKey));
    assert.deepEqual(forged, { ok: false, reason: "bad-signature" });
    assert.equal(h.fetches(), 1);
  });

  /** The cost of the window: a rotation is late by at most one of them. */
  test("a rotation lands as soon as the window is over", async () => {
    const h = harness();
    h.loader.prime(KEYS);
    assert.equal((await h.verify(rotatedJwt())).ok, false);
    assert.equal(h.fetches(), 1);

    h.serve(() => ROTATED_KEYS);
    h.advance(JWKS_REFRESH_COOLDOWN_MS - 1);
    assert.equal((await h.verify(rotatedJwt())).ok, false, "still inside the window");
    assert.equal(h.fetches(), 1);

    h.advance(1);
    assert.equal((await h.verify(rotatedJwt())).ok, true);
    assert.equal(h.fetches(), 2);
  });

  test("a fetch that rejects poisons neither the cache nor the next window", async () => {
    const h = harness();
    h.serve(() => {
      throw new Error("login.botframework.com is having a minute");
    });
    const both = await Promise.allSettled([h.loader.load(), h.loader.load()]);
    assert.deepEqual(
      both.map((r) => r.status),
      ["rejected", "rejected"],
      "the failure is shared, not repeated",
    );
    assert.equal(h.fetches(), 1);

    // Nothing cached and nothing left in flight: it is the window that holds
    // the retry back, and it lets go on its own.
    assert.deepEqual(await h.loader.load(), []);
    assert.equal(h.fetches(), 1);

    h.advance(JWKS_REFRESH_COOLDOWN_MS);
    h.serve(() => KEYS);
    assert.deepEqual(await h.loader.load(), KEYS);
    assert.equal(h.fetches(), 2);
  });

  test("a refresh that fails past the TTL serves the keys we already had, to everyone", async () => {
    const h = harness();
    h.loader.prime(KEYS);
    h.advance(JWKS_TTL_MS);
    h.serve(() => {
      throw new Error("login.botframework.com is having a minute");
    });
    assert.deepEqual(await Promise.all([h.loader.load(), h.loader.load()]), [KEYS, KEYS]);
    assert.equal(h.fetches(), 1);
  });

  test("the honest path never reaches for the network twice in a day", async () => {
    const h = harness();
    assert.deepEqual(await h.loader.load(), KEYS);
    h.advance(JWKS_TTL_MS - 1);
    assert.equal((await h.verify(jwt({ exp: NOW_S + JWKS_TTL_MS / 1000 }))).ok, true);
    assert.equal(h.fetches(), 1);
  });
});

describe("parseJwks", () => {
  test("keeps RSA keys that name themselves and carry material", () => {
    assert.deepEqual(
      parseJwks({
        keys: [
          { kty: "RSA", kid: "a", n: "AAA", e: "AQAB", endorsements: ["msteams"] },
          { kty: "EC", kid: "b", x: "1", y: "2" },
          { kty: "RSA", n: "AAA", e: "AQAB" },
          { kty: "RSA", kid: "c", e: "AQAB" },
          { kty: "RSA", kid: "", n: "AAA", e: "AQAB" },
          null,
          "nonsense",
        ],
      }).map((k) => k.kid),
      ["a"],
    );
  });

  test("a document without a key array yields nothing rather than throwing", () => {
    assert.deepEqual(parseJwks({}), []);
    assert.deepEqual(parseJwks(null), []);
    assert.deepEqual(parseJwks({ keys: "oops" }), []);
  });
});

// ---------- Text handling ----------

describe("stripTeamsMentions", () => {
  test("the whole mention goes, display name included", () => {
    assert.equal(cleanTeamsText("<at>Finley</at> what is our runway?"), "what is our runway?");
  });

  test("attributes and several mentions in one message", () => {
    assert.equal(
      cleanTeamsText('<at id="0">Finley</at> and <at id="1">Ada</at> — status?'),
      "and — status?",
    );
  });

  test("an unbalanced tag loses the tag and keeps the words", () => {
    assert.equal(stripTeamsMentions("<at>Finley ping"), " Finley ping");
    assert.equal(cleanTeamsText("<at>Finley ping"), "Finley ping");
    assert.equal(cleanTeamsText("Finley</at> ping"), "Finley ping");
  });

  test("a message that is nothing but a mention has no question in it", () => {
    assert.equal(cleanTeamsText("<at>Finley</at>"), "");
  });
});

describe("decodeTeamsEntities", () => {
  test("decodes the entities Microsoft Teams escapes", () => {
    assert.equal(decodeTeamsEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"), `a & b <c> "d" 'e'`);
    assert.equal(decodeTeamsEntities("hard&nbsp;space"), "hard space");
  });

  /** One pass, so a literal `&amp;lt;` the sender typed does not become `<`. */
  test("does not decode its own output", () => {
    assert.equal(decodeTeamsEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  });

  test("leaves entities it does not know alone", () => {
    assert.equal(decodeTeamsEntities("caf&eacute; &#x41;"), "caf&eacute; &#x41;");
  });
});

describe("cleanTeamsText", () => {
  test("collapses runs of spaces but keeps paragraph breaks", () => {
    assert.equal(cleanTeamsText("one   two\n\nthree"), "one two\n\nthree");
    assert.equal(cleanTeamsText("a\n\n\n\n\nb"), "a\n\nb");
  });

  test("unicode survives intact", () => {
    assert.equal(cleanTeamsText("¿Cuál es el runway? 🚀 日本語"), "¿Cuál es el runway? 🚀 日本語");
  });

  test("whitespace-only text becomes empty", () => {
    assert.equal(cleanTeamsText("   \n\t  "), "");
  });
});

describe("sameBotId", () => {
  test("Microsoft's two prefixes name the same bot", () => {
    assert.equal(sameBotId(`28:${APP_ID}`, `28:orgid:${APP_ID}`), true);
    assert.equal(sameBotId(`28:${APP_ID}`, `28:${APP_ID.toUpperCase()}`), true);
  });

  test("different apps are different bots, and a missing id matches nothing", () => {
    assert.equal(sameBotId("28:abc", "28:def"), false);
    assert.equal(sameBotId(null, "28:abc"), false);
    assert.equal(sameBotId("28:abc", null), false);
  });
});

describe("mentionedIds", () => {
  test("reads mention entities and ignores everything else", () => {
    assert.deepEqual(
      mentionedIds([
        { type: "mention", mentioned: { id: BOT_ID, name: "Finley" } },
        { type: "clientInfo", locale: "en-GB" },
        { type: "Mention", mentioned: { id: "29:human" } },
        { type: "mention" },
        { type: "mention", mentioned: { id: 42 } },
        null,
      ]),
      [BOT_ID, "29:human"],
    );
  });

  test("a non-array entities field is no mentions, not a crash", () => {
    assert.deepEqual(mentionedIds(undefined), []);
    assert.deepEqual(mentionedIds({ type: "mention" }), []);
  });
});

describe("bearerToken", () => {
  test("reads the header Express lowercased, and the one it did not", () => {
    assert.equal(bearerToken({ authorization: "Bearer abc.def.ghi" }), "abc.def.ghi");
    assert.equal(bearerToken({ Authorization: "bearer abc.def.ghi" }), "abc.def.ghi");
    assert.equal(bearerToken({ authorization: "Bearer   abc.def.ghi  " }), "abc.def.ghi");
  });

  test("anything that is not a bearer JWT is no credential at all", () => {
    assert.equal(bearerToken({}), null);
    assert.equal(bearerToken({ authorization: "" }), null);
    assert.equal(bearerToken({ authorization: "Bearer" }), null);
    assert.equal(bearerToken({ authorization: "Basic abc.def.ghi" }), null);
    assert.equal(bearerToken({ authorization: "Bearer abc def" }), null);
    assert.equal(bearerToken({ authorization: "Bearer abc<script>" }), null);
  });
});

// ---------- Normalization ----------

function activity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    id: "1700000000001",
    serviceUrl: SERVICE_URL,
    text: "what is our runway?",
    from: { id: "29:ada", name: "Ada Lovelace", aadObjectId: "aad-ada" },
    recipient: { id: BOT_ID, name: "Finley" },
    conversation: { id: "a:1x2y3z", conversationType: "personal" },
    ...over,
  };
}

function normalize(over: Record<string, unknown> = {}) {
  return normalizeTeamsActivity({
    activity: activity(over),
    connectionId: "conn-1",
    companyId: "co-1",
  });
}

describe("normalizeTeamsActivity · a direct message", () => {
  test("becomes a turn with every field the inbound core reads", () => {
    assert.deepEqual(normalize(), {
      provider: "microsoft-teams",
      connectionId: "conn-1",
      companyId: "co-1",
      externalKey: "a:1x2y3z",
      externalUserId: "aad-ada",
      externalUserLabel: "Ada Lovelace",
      threadTitle: null,
      text: "what is our runway?",
      group: false,
      externalMessageId: "1700000000001",
      replyTo: {
        conversationId: "a:1x2y3z",
        serviceUrl: SERVICE_URL,
        activityId: "1700000000001",
      },
    });
  });

  test("answers without an @-mention — a 1:1 chat is already addressed to us", () => {
    assert.equal(normalize({ entities: [] })?.text, "what is our runway?");
  });

  /** The Entra object id is the strong claim; the channel handle is a fallback. */
  test("prefers aadObjectId and falls back to the channel id for a guest", () => {
    assert.equal(normalize()?.externalUserId, "aad-ada");
    assert.equal(
      normalize({ from: { id: "29:guest", name: "Guest" } })?.externalUserId,
      "29:guest",
    );
  });

  test("a sender with no id at all is nobody we can bind", () => {
    assert.equal(normalize({ from: { name: "Ada" } }), null);
  });
});

describe("normalizeTeamsActivity · what it declines", () => {
  test("anything that is not a message", () => {
    for (const type of ["conversationUpdate", "typing", "messageReaction", "invoke", "", undefined]) {
      assert.equal(normalize({ type }), null, String(type));
    }
  });

  test("a message with no text once the mention is gone", () => {
    assert.equal(normalize({ text: "" }), null);
    assert.equal(normalize({ text: "   " }), null);
    assert.equal(normalize({ text: undefined }), null);
  });

  /** Our own reply coming back at us is how a bot talks to itself forever. */
  test("its own echo, matched on the recipient id", () => {
    assert.equal(normalize({ from: { id: BOT_ID, name: "Finley" } }), null);
    assert.equal(normalize({ from: { id: `28:orgid:${APP_ID}`, name: "Finley" } }), null);
  });

  test("anything another bot said, matched on the role", () => {
    assert.equal(normalize({ from: { id: "28:other-bot", role: "bot", name: "Buildkite" } }), null);
    assert.equal(normalize({ from: { id: "28:other-bot", role: "Bot", name: "Buildkite" } }), null);
  });

  test("an activity with nowhere to answer", () => {
    assert.equal(normalize({ serviceUrl: undefined }), null);
    assert.equal(normalize({ serviceUrl: "   " }), null);
    assert.equal(normalize({ conversation: { conversationType: "personal" } }), null);
  });

  test("a payload that is not an activity-shaped object", () => {
    for (const payload of [null, "message", 42, [], { type: "message" }]) {
      assert.equal(
        normalizeTeamsActivity({ activity: payload, connectionId: "c", companyId: "co" }),
        null,
      );
    }
  });
});

describe("normalizeTeamsActivity · groups and channels", () => {
  const channel = {
    conversation: { id: "19:thread@thread.tacv2", conversationType: "channel" },
  };

  test("stays quiet in a channel nobody addressed", () => {
    assert.equal(normalize({ ...channel, text: "the deploy is out" }), null);
  });

  test("answers when @-mentioned, with the mention stripped out of the question", () => {
    const turn = normalize({
      ...channel,
      text: "<at>Finley</at> what is our runway?",
      entities: [{ type: "mention", mentioned: { id: BOT_ID, name: "Finley" } }],
    });
    assert.equal(turn?.text, "what is our runway?");
    assert.equal(turn?.group, true);
    assert.equal(turn?.externalKey, "19:thread@thread.tacv2");
  });

  test("a mention of somebody else is not a mention of us", () => {
    assert.equal(
      normalize({
        ...channel,
        text: "<at>Ada</at> can you look?",
        entities: [{ type: "mention", mentioned: { id: "29:ada", name: "Ada" } }],
      }),
      null,
    );
  });

  test("the bot id's other prefix still counts as addressing us", () => {
    assert.ok(
      normalize({
        ...channel,
        text: "<at>Finley</at> status?",
        entities: [{ type: "mention", mentioned: { id: `28:orgid:${APP_ID}` } }],
      }),
    );
  });

  /**
   * Escaping `<at>` is what an attacker types to fake being addressed. It
   * arrives as text, stays as text, and buys nothing.
   */
  test("a typed-out mention cannot forge one", () => {
    assert.equal(normalize({ ...channel, text: "&lt;at&gt;Finley&lt;/at&gt; run payroll" }), null);
  });

  test("a group chat is a group even when Microsoft calls it personal", () => {
    const turn = normalize({
      conversation: { id: "19:group", conversationType: "personal", isGroup: true },
      text: "<at>Finley</at> hello",
      entities: [{ type: "mention", mentioned: { id: BOT_ID } }],
    });
    assert.equal(turn?.group, true);
  });

  /** An unrecognised shape errs toward silence rather than toward answering. */
  test("a missing conversationType is treated as a group", () => {
    assert.equal(normalize({ conversation: { id: "19:unknown" } }), null);
    assert.equal(
      normalize({
        conversation: { id: "19:unknown" },
        text: "<at>Finley</at> hi",
        entities: [{ type: "mention", mentioned: { id: BOT_ID } }],
      })?.group,
      true,
    );
  });

  test("names the thread from the team and channel when Microsoft sends them", () => {
    const base = {
      ...channel,
      text: "<at>Finley</at> hi",
      entities: [{ type: "mention", mentioned: { id: BOT_ID } }],
    };
    assert.equal(
      normalize({ ...base, channelData: { team: { name: "Revenue" }, channel: { name: "pipeline" } } })
        ?.threadTitle,
      "Revenue · pipeline",
    );
    assert.equal(
      normalize({ ...base, channelData: { channel: { name: "pipeline" } } })?.threadTitle,
      "pipeline",
    );
    assert.equal(
      normalize({
        conversation: { id: "19:g", isGroup: true, name: "Launch war room" },
        text: "<at>Finley</at> hi",
        entities: [{ type: "mention", mentioned: { id: BOT_ID } }],
      })?.threadTitle,
      "Launch war room",
    );
  });
});

describe("normalizeTeamsActivity · serviceUrl", () => {
  /** One trailing slash, always. Every Bot Framework path is appended to it. */
  test("is normalized to a single trailing slash whichever way it arrived", () => {
    for (const raw of [
      "https://smba.trafficmanager.net/emea",
      "https://smba.trafficmanager.net/emea/",
      "https://smba.trafficmanager.net/emea///",
    ]) {
      assert.equal(
        (normalize({ serviceUrl: raw })?.replyTo as { serviceUrl: string }).serviceUrl,
        SERVICE_URL,
        raw,
      );
    }
  });

  test("a message with no id still routes, it just cannot be de-duplicated", () => {
    const turn = normalize({ id: undefined });
    assert.equal(turn?.externalMessageId, null);
    assert.equal((turn?.replyTo as { activityId: string | null }).activityId, null);
  });
});

// ---------- Learned service URLs ----------

describe("rememberServiceUrl / lastServiceUrl", () => {
  test("remembers a normalized endpoint per Connection", () => {
    rememberServiceUrl("conn-1", "https://smba.trafficmanager.net/emea");
    rememberServiceUrl("conn-2", "https://smba.trafficmanager.net/apac/");
    assert.equal(lastServiceUrl("conn-1"), SERVICE_URL);
    assert.equal(lastServiceUrl("conn-2"), "https://smba.trafficmanager.net/apac/");
  });

  test("a Connection nobody has messaged knows nothing — a cold process cannot reach out", () => {
    assert.equal(lastServiceUrl("conn-never-seen"), null);
    forgetServiceUrls();
    rememberServiceUrl("conn-1", SERVICE_URL);
    forgetServiceUrls();
    assert.equal(lastServiceUrl("conn-1"), null);
  });

  test("refuses anything it would not send a bearer token to", () => {
    rememberServiceUrl("conn-1", "http://attacker.example");
    rememberServiceUrl("conn-1", "");
    rememberServiceUrl("", SERVICE_URL);
    assert.equal(lastServiceUrl("conn-1"), null);
    assert.equal(lastServiceUrl(""), null);
  });

  test("the newest endpoint wins — Microsoft moves conversations between regions", () => {
    rememberServiceUrl("conn-1", "https://smba.trafficmanager.net/emea");
    rememberServiceUrl("conn-1", "https://smba.trafficmanager.net/uk");
    assert.equal(lastServiceUrl("conn-1"), "https://smba.trafficmanager.net/uk/");
  });
});

// ---------- Adapter shape and send ----------

describe("microsoftTeamsChatSurface", () => {
  test("is a webhook surface that needs a public URL and starts no loop", () => {
    assert.equal(microsoftTeamsChatSurface.provider, "microsoft-teams");
    assert.equal(microsoftTeamsChatSurface.transport, "webhook");
    assert.equal(microsoftTeamsChatSurface.requiresPublicUrl, true);
    assert.equal(microsoftTeamsChatSurface.textLimit, TEAMS_TEXT_LIMIT);
    assert.equal(microsoftTeamsChatSurface.run, undefined);
    assert.equal(typeof microsoftTeamsChatSurface.webhook?.verifyAndNormalize, "function");
    // Microsoft Teams has no GET handshake to answer.
    assert.equal(microsoftTeamsChatSurface.webhook?.verifyHandshake, undefined);
  });

  test("the reply cap trims at the boundary and leaves a shorter reply alone", () => {
    const exact = "x".repeat(TEAMS_TEXT_LIMIT);
    assert.equal(truncateForSurface(exact, TEAMS_TEXT_LIMIT), exact);
    const over = truncateForSurface("x".repeat(TEAMS_TEXT_LIMIT + 1), TEAMS_TEXT_LIMIT);
    assert.equal(over.length, TEAMS_TEXT_LIMIT);
    assert.match(over, /…\(truncated\)$/);
  });

  test("send refuses a reply target it cannot address", async () => {
    for (const replyTo of [
      {},
      { conversationId: "19:x" },
      { serviceUrl: SERVICE_URL },
      { conversationId: "19:x", serviceUrl: "  " },
    ]) {
      await assert.rejects(
        microsoftTeamsChatSurface.send({
          connectionId: "conn-1",
          config: { appId: APP_ID, appPassword: "secret" },
          replyTo,
          text: "hello",
        }),
        /missing a conversationId or serviceUrl/,
      );
    }
  });

  test("send refuses a plaintext endpoint before it mints a token", async () => {
    await assert.rejects(
      microsoftTeamsChatSurface.send({
        connectionId: "conn-1",
        config: { appId: APP_ID, appPassword: "secret" },
        replyTo: { conversationId: "19:x", serviceUrl: "http://attacker.example" },
        text: "hello",
      }),
      /not a usable https serviceUrl/,
    );
    assert.equal(lastServiceUrl("conn-1"), null);
  });
});

// ---------- The webhook, end to end ----------

describe("webhook.verifyAndNormalize", () => {
  const webhook = microsoftTeamsChatSurface.webhook!;

  function liveJwt(claims: Record<string, unknown> = {}): string {
    const nowS = Math.floor(Date.now() / 1000);
    return jwt({ nbf: nowS - 30, exp: nowS + 600, ...claims });
  }

  function deliver(args: {
    token?: string;
    body?: unknown;
    rawBody?: Buffer;
    appId?: string;
  }): Promise<ChatSurfaceWebhookResult> {
    return webhook.verifyAndNormalize({
      connectionId: "conn-1",
      companyId: "co-1",
      config: { appId: args.appId ?? APP_ID, appPassword: "secret" },
      rawBody: args.rawBody ?? Buffer.from(JSON.stringify(args.body ?? activity()), "utf8"),
      headers: args.token ? { authorization: `Bearer ${args.token}` } : {},
      query: {},
    });
  }

  test("a genuine delivery becomes one turn and teaches us the endpoint", async () => {
    primeBotFrameworkKeysForTests(KEYS);
    const result = await deliver({ token: liveJwt() });
    assert.equal(result.kind, "turns");
    assert.equal(result.kind === "turns" ? result.turns.length : -1, 1);
    assert.equal(
      result.kind === "turns" ? result.turns[0].externalUserId : null,
      "aad-ada",
    );
    assert.equal(lastServiceUrl("conn-1"), SERVICE_URL);
  });

  /**
   * Being added to a channel is a `conversationUpdate`, and it is the first —
   * sometimes the only — chance to learn where that channel lives.
   */
  test("a verified non-message teaches us the endpoint and produces no turn", async () => {
    primeBotFrameworkKeysForTests(KEYS);
    const result = await deliver({
      token: liveJwt(),
      body: activity({ type: "conversationUpdate", text: undefined }),
    });
    assert.deepEqual(result, { kind: "turns", turns: [] });
    assert.equal(lastServiceUrl("conn-1"), SERVICE_URL);
  });

  test("no bearer, no audience, wrong scheme — all 401, all before any parsing", async () => {
    primeBotFrameworkKeysForTests(KEYS);
    assert.deepEqual(await deliver({}), { kind: "reject", status: 401 });
    assert.deepEqual(await deliver({ token: liveJwt(), appId: "" }), {
      kind: "reject",
      status: 401,
    });
    assert.deepEqual(
      await webhook.verifyAndNormalize({
        connectionId: "conn-1",
        companyId: "co-1",
        config: { appId: APP_ID },
        rawBody: Buffer.from("{}", "utf8"),
        headers: { authorization: `Basic ${liveJwt()}` },
        query: {},
      }),
      { kind: "reject", status: 401 },
    );
  });

  test("an unparseable body is a 400, so a broken proxy reads differently in the log", async () => {
    primeBotFrameworkKeysForTests(KEYS);
    assert.deepEqual(await deliver({ token: liveJwt(), rawBody: Buffer.from("<html>", "utf8") }), {
      kind: "reject",
      status: 400,
    });
  });

  test("a forged or stale token is 401 and teaches us nothing", async () => {
    primeBotFrameworkKeysForTests(KEYS);
    const forged = jwt({}, {}, impostor.privateKey);
    assert.deepEqual(await deliver({ token: forged }), { kind: "reject", status: 401 });
    assert.deepEqual(await deliver({ token: jwt() }), { kind: "reject", status: 401 });
    assert.equal(lastServiceUrl("conn-1"), null);
  });

  /** The poisoning attempt this surface most needs to survive. */
  test("an activity pointing somewhere the token does not vouch for is rejected", async () => {
    primeBotFrameworkKeysForTests(KEYS);
    const result = await deliver({
      token: liveJwt(),
      body: activity({ serviceUrl: "https://attacker.example/" }),
    });
    assert.deepEqual(result, { kind: "reject", status: 401 });
    assert.equal(lastServiceUrl("conn-1"), null);
  });

  test("a token for another bot cannot drive this Connection", async () => {
    primeBotFrameworkKeysForTests(KEYS);
    const result = await deliver({ token: liveJwt({ aud: "99999999-0000-0000-0000-000000000000" }) });
    assert.deepEqual(result, { kind: "reject", status: 401 });
  });
});
