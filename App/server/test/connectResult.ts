import crypto from "node:crypto";

/**
 * What Genosyn Connect does at the end of a sign-in (`encryptResult` in
 * `Connect/src/tokens.ts`): AES-256-GCM under the result key the installation
 * sent with `start`, bound to the provider and the installation's `state`,
 * formatted `<iv>.<ciphertext and tag>` in unpadded base64url.
 *
 * Written out here rather than shared with the App's decryption, so a change
 * to either side fails a test instead of agreeing with itself. The Connect
 * sign-in E2E check runs the real service against the real App.
 */
export function sealConnectResult(args: {
  resultKey: string;
  state: string;
  value: unknown;
  provider?: string;
}): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(args.resultKey, "base64url"), iv);
  cipher.setAAD(
    Buffer.from(`genosyn-connect-result:v2:${args.provider ?? "google"}:${args.state}`),
  );
  const body = Buffer.concat([cipher.update(JSON.stringify(args.value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${Buffer.concat([body, cipher.getAuthTag()]).toString("base64url")}`;
}
