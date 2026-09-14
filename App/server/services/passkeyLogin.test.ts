import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { WebAuthnCredential } from "../db/entities/WebAuthnCredential.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { finishPasskeyLogin, PasskeyLoginStateError, startPasskeyLogin } from "./passkeyLogin.js";
import { setPublicUrl } from "./publicUrl.js";
import { verifyWebAuthnLogin } from "./twoFactor.js";
import { beginWebAuthnAuthentication, verifyStoredWebAuthnAssertion } from "./webAuthn.js";

const ORIGIN = "https://genosyn.example.test";
const RP_ID = "genosyn.example.test";

type VirtualPasskey = {
  credentialId: string;
  privateKey: KeyObject;
  cosePublicKey: Buffer;
};

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** Encode the P-256 public key as the minimal COSE EC2 map WebAuthn stores. */
function encodeCosePublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.ok(jwk.x);
  assert.ok(jwk.y);
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  assert.equal(x.length, 32);
  assert.equal(y.length, 32);
  return Buffer.concat([
    // { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

function virtualPasskey(): VirtualPasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    credentialId: randomBytes(32).toString("base64url"),
    privateKey,
    cosePublicKey: encodeCosePublicKey(publicKey),
  };
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function assertion(args: {
  passkey: VirtualPasskey;
  challenge: string;
  userId?: string;
  userHandle?: string | null;
  origin?: string;
  rpId?: string;
  counter?: number;
  flags?: number;
  corruptSignature?: boolean;
}): AuthenticationResponseJSON {
  const origin = args.origin ?? ORIGIN;
  const rpId = args.rpId ?? RP_ID;
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: args.challenge,
      origin,
      crossOrigin: false,
    }),
    "utf8",
  );
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(rpId).digest(),
    // UP + UV + backup-eligible + backed-up: proves metadata is refreshed too.
    Buffer.from([args.flags ?? 0x1d]),
    uint32(args.counter ?? 1),
  ]);
  const signatureBase = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientData).digest(),
  ]);
  const signatureBytes = sign("sha256", signatureBase, args.passkey.privateKey);
  if (args.corruptSignature) {
    signatureBytes[signatureBytes.length - 1] ^= 0x01;
  }
  const resolvedHandle =
    args.userHandle === undefined
      ? args.userId
        ? Buffer.from(args.userId, "utf8").toString("base64url")
        : undefined
      : (args.userHandle ?? undefined);
  return {
    id: args.passkey.credentialId,
    rawId: args.passkey.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signatureBytes.toString("base64url"),
      ...(resolvedHandle ? { userHandle: resolvedHandle } : {}),
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  } as AuthenticationResponseJSON;
}

async function memberWithPasskey() {
  const user = await insert(User, {
    email: `${randomBytes(8).toString("hex")}@example.test`,
    name: "Passkey Member",
    passwordHash: "not-used-by-passkey-authentication",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const passkey = virtualPasskey();
  const credential = await insert(WebAuthnCredential, {
    userId: user.id,
    credentialId: passkey.credentialId,
    publicKey: passkey.cosePublicKey.toString("base64url"),
    counter: 0,
    transports: JSON.stringify(["internal"]),
    kind: "passkey",
    name: "Test passkey",
    deviceType: "singleDevice",
    backedUp: false,
    lastUsedAt: null,
  });
  return { user, passkey, credential };
}

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  await setPublicUrl(ORIGIN);
});
after(closeTestDb);

describe("WebAuthn authentication primitives", () => {
  test("builds discoverable options without an account hint and account-bound 2FA options with one", async () => {
    const { user, credential } = await memberWithPasskey();

    const discoverable = await beginWebAuthnAuthentication();
    assert.ok(discoverable);
    assert.equal(discoverable.rpId, RP_ID);
    assert.equal(discoverable.userVerification, "required");
    assert.equal(discoverable.allowCredentials, undefined);
    assert.equal(JSON.stringify(discoverable).includes("allowCredentials"), false);

    const accountBound = await beginWebAuthnAuthentication(user.id);
    assert.ok(accountBound);
    assert.deepEqual(accountBound.allowCredentials, [
      { id: credential.credentialId, transports: ["internal"], type: "public-key" },
    ]);
    assert.equal(await beginWebAuthnAuthentication("missing-user"), null);
  });

  test("verifies a real P-256 assertion and advances counter and authenticator metadata", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const challenge = randomBytes(32).toString("base64url");
    const before = Date.now();

    const verified = await verifyStoredWebAuthnAssertion({
      expectedChallenge: challenge,
      response: assertion({ passkey, challenge, userId: user.id, counter: 7 }),
      requireUserHandle: true,
    });

    assert.equal(verified?.user.id, user.id);
    assert.equal(verified?.credential.id, credential.id);
    const stored = await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
      id: credential.id,
    });
    assert.equal(stored.counter, 7);
    assert.equal(stored.deviceType, "multiDevice");
    assert.equal(stored.backedUp, true);
    assert.ok((stored.lastUsedAt?.getTime() ?? 0) >= before);
  });

  test("requires and account-binds a user handle for discoverable sign-in", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const challenge = randomBytes(32).toString("base64url");

    for (const response of [
      assertion({ passkey, challenge, userHandle: null }),
      assertion({
        passkey,
        challenge,
        userHandle: Buffer.from("another-user", "utf8").toString("base64url"),
      }),
    ]) {
      assert.equal(
        await verifyStoredWebAuthnAssertion({
          expectedChallenge: challenge,
          response,
          requireUserHandle: true,
        }),
        null,
      );
    }

    const stored = await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
      id: credential.id,
    });
    assert.equal(stored.counter, 0);
    assert.equal(stored.lastUsedAt, null);
    assert.equal(user.id.length > 0, true);
  });

  test("rejects independently signed challenge, origin, RP ID, and signature failures", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const expectedChallenge = randomBytes(32).toString("base64url");
    const attempts = [
      assertion({
        passkey,
        challenge: randomBytes(32).toString("base64url"),
        userId: user.id,
      }),
      assertion({
        passkey,
        challenge: expectedChallenge,
        userId: user.id,
        origin: "https://attacker.example.test",
      }),
      assertion({
        passkey,
        challenge: expectedChallenge,
        userId: user.id,
        rpId: "attacker.example.test",
      }),
      assertion({
        passkey,
        challenge: expectedChallenge,
        userId: user.id,
        corruptSignature: true,
      }),
      assertion({
        passkey,
        challenge: expectedChallenge,
        userId: user.id,
        flags: 0x01,
      }),
    ];

    for (const response of attempts) {
      assert.equal(
        await verifyStoredWebAuthnAssertion({
          expectedChallenge,
          response,
          requireUserHandle: true,
        }),
        null,
      );
    }
    const stored = await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
      id: credential.id,
    });
    assert.equal(stored.counter, 0);
    assert.equal(stored.lastUsedAt, null);
  });

  test("rejects a replayed authenticator counter even under a fresh challenge", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const firstChallenge = randomBytes(32).toString("base64url");
    assert.ok(
      await verifyStoredWebAuthnAssertion({
        expectedChallenge: firstChallenge,
        response: assertion({ passkey, challenge: firstChallenge, userId: user.id, counter: 4 }),
        requireUserHandle: true,
      }),
    );

    const freshChallenge = randomBytes(32).toString("base64url");
    assert.equal(
      await verifyStoredWebAuthnAssertion({
        expectedChallenge: freshChallenge,
        response: assertion({ passkey, challenge: freshChallenge, userId: user.id, counter: 4 }),
        requireUserHandle: true,
      }),
      null,
    );
    assert.equal(
      (
        await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
          id: credential.id,
        })
      ).counter,
      4,
    );
  });

  test("allows exactly one concurrent assertion to claim a stale counter", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const challenges = [
      randomBytes(32).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ];
    const results = await Promise.all(
      challenges.map((challenge) =>
        verifyStoredWebAuthnAssertion({
          expectedChallenge: challenge,
          response: assertion({ passkey, challenge, userId: user.id, counter: 1 }),
          requireUserHandle: true,
        }),
      ),
    );

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(
      (
        await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
          id: credential.id,
        })
      ).counter,
      1,
    );
  });

  test("keeps password-following WebAuthn account-bound without requiring userHandle", async () => {
    const first = await memberWithPasskey();
    const second = await memberWithPasskey();
    const firstChallenge = randomBytes(32).toString("base64url");

    assert.equal(
      await verifyWebAuthnLogin({
        userId: first.user.id,
        expectedChallenge: firstChallenge,
        response: assertion({
          passkey: first.passkey,
          challenge: firstChallenge,
          userHandle: null,
          counter: 1,
        }),
      }),
      true,
    );

    const otherAccountChallenge = randomBytes(32).toString("base64url");
    assert.equal(
      await verifyWebAuthnLogin({
        userId: first.user.id,
        expectedChallenge: otherAccountChallenge,
        response: assertion({
          passkey: second.passkey,
          challenge: otherAccountChallenge,
          userHandle: null,
          counter: 1,
        }),
      }),
      false,
    );
  });
});

describe("passwordless passkey state", () => {
  test("completes a real discoverable assertion and burns its state against replay", async () => {
    const { user, passkey } = await memberWithPasskey();
    const started = await startPasskeyLogin();
    const response = assertion({
      passkey,
      challenge: started.options.challenge,
      userId: user.id,
      counter: 1,
    });

    assert.equal(
      (
        await finishPasskeyLogin({
          flowToken: started.flowToken,
          browserBinding: started.browserBinding,
          response,
        })
      )?.id,
      user.id,
    );
    await assert.rejects(
      finishPasskeyLogin({
        flowToken: started.flowToken,
        browserBinding: started.browserBinding,
        response,
      }),
      PasskeyLoginStateError,
    );
  });

  test("burns state presented from the wrong browser before it can be retried", async () => {
    const { user, passkey, credential } = await memberWithPasskey();
    const started = await startPasskeyLogin();
    const response = assertion({
      passkey,
      challenge: started.options.challenge,
      userId: user.id,
    });

    await assert.rejects(
      finishPasskeyLogin({
        flowToken: started.flowToken,
        browserBinding: "another-browser",
        response,
      }),
      PasskeyLoginStateError,
    );
    await assert.rejects(
      finishPasskeyLogin({
        flowToken: started.flowToken,
        browserBinding: started.browserBinding,
        response,
      }),
      PasskeyLoginStateError,
    );
    const stored = await AppDataSource.getRepository(WebAuthnCredential).findOneByOrFail({
      id: credential.id,
    });
    assert.equal(stored.counter, 0);
    assert.equal(stored.lastUsedAt, null);
  });

  test("allows exactly one simultaneous consumer of the same flow token", async () => {
    const { user, passkey } = await memberWithPasskey();
    const started = await startPasskeyLogin();
    const response = assertion({
      passkey,
      challenge: started.options.challenge,
      userId: user.id,
      counter: 1,
    });

    const results = await Promise.allSettled([
      finishPasskeyLogin({
        flowToken: started.flowToken,
        browserBinding: started.browserBinding,
        response,
      }),
      finishPasskeyLogin({
        flowToken: started.flowToken,
        browserBinding: started.browserBinding,
        response,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof PasskeyLoginStateError);
  });
});
