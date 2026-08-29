import crypto from "node:crypto";

/**
 * Mint an Ed25519 keypair for Enterprise license signing (M56).
 *
 * Run with `npm run license:keygen`. Prints both halves and writes nothing to
 * disk: commit the PUBLIC key into `LICENSE_VERIFY_PUBLIC_KEYS`
 * (server/services/license.ts) and keep the PRIVATE key out of the repo —
 * paste it once at Admin → Enterprise Licenses on the issuing install, where
 * it is stored encrypted.
 */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

const publicDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

/* eslint-disable no-console */
console.log("Ed25519 license signing keypair\n");
console.log(
  "PUBLIC key (base64 SPKI DER) — commit this into LICENSE_VERIFY_PUBLIC_KEYS in server/services/license.ts:\n",
);
console.log(`  ${publicDer}\n`);
console.log(
  "PRIVATE key (PKCS8 PEM) — keep this secret; paste it at Admin → Enterprise Licenses on the issuing install:\n",
);
console.log(privatePem);
/* eslint-enable no-console */
