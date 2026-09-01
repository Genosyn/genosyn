import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

/**
 * The verified/unverified indicator on Account → Profile, pinned as markup.
 *
 * Source-scanning assertions in the `server/client/` house style — there is no
 * React renderer in this repo, and the two things most likely to be broken by a
 * later edit are structural rather than logical: the block has to stay inside
 * the personal-details form (it is about that exact field), and its button has
 * to stay `type="button"` (inside a form, the HTML default submits it, which
 * would fire a profile save on every resend).
 */
describe("Account → Profile email verification block", () => {
  const source = readAppFile("client/pages/AccountProfile.tsx");

  test("renders the notice under the email field, inside the personal-details form", () => {
    const emailFieldIndex = source.indexOf('label="Email"');
    const noticeIndex = source.indexOf("<EmailVerificationNotice");
    const handleFieldIndex = source.indexOf('label="Handle"');

    assert.ok(emailFieldIndex > 0, "the email input must still exist");
    assert.ok(noticeIndex > emailFieldIndex, "the notice belongs below the email field");
    assert.ok(noticeIndex < handleFieldIndex, "the notice belongs above the handle field");
  });

  test("keeps the resend control out of the form's submit path", () => {
    const component = source.slice(source.indexOf("function EmailVerificationNotice"));
    const button = component.match(/<Button[\s\S]*?>/)?.[0];
    assert.ok(button, "the notice must offer a resend button");
    // Without this the button submits the surrounding profile form, saving the
    // name/email/handle fields as a side effect of asking for an email.
    assert.match(button, /type="button"/);
    assert.match(component, /Resend verification email/);
  });

  test("reads the verified flag the server actually sends", () => {
    assert.match(source, /me\.emailVerified/);
    assert.match(readAppFile("client/lib/api.ts"), /emailVerified: boolean;/);
  });

  test("reports failures inline rather than through a toast", () => {
    // AGENTS.md §8: a failure belongs where the person is already looking.
    assert.match(source, /FormError/);
    assert.match(source, /FormSuccess/);
    assert.doesNotMatch(source, /\btoast\s*\(/);
  });

  test("keeps both themes on every colour the block introduces", () => {
    const component = source.slice(source.indexOf("function EmailVerificationNotice"));
    const classLists = [...component.matchAll(/className="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(classLists.length > 0, "the notice must carry Tailwind classes");
    for (const classList of classLists) {
      const tinted = classList
        .split(/\s+/)
        .filter((cls) => /^(bg|text|border)-(emerald|amber|red|slate)-/.test(cls));
      if (tinted.length === 0) continue;
      assert.match(classList, /\bdark:/, `light-only palette in: ${classList}`);
    }
  });
});
