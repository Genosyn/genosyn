import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(appRoot, "..");

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

describe("passwordless passkey sign-in client contract", () => {
  const login = readAppFile("client/pages/Login.tsx");
  const handlerStart = login.indexOf("async function signInWithPasskey");
  const handlerEnd = login.indexOf("if (twoFactor)", handlerStart);
  const handler = login.slice(handlerStart, handlerEnd);

  test("keeps the explicit passkey button outside the password submit path", () => {
    const labelIndex = login.indexOf("Sign in with a passkey");
    assert.ok(labelIndex > 0, "the signed-out page must offer passkey sign-in");
    const buttonStart = login.lastIndexOf("<Button", labelIndex);
    const button = login.slice(buttonStart, labelIndex);

    assert.match(button, /type="button"/);
    assert.match(button, /onClick=\{\(\) => void signInWithPasskey\(\)\}/);
    assert.ok(
      labelIndex < login.indexOf('label="Email"'),
      "passwordless sign-in should not appear to require an email address",
    );
  });

  test("runs options, browser assertion, verification, then a fresh authenticated document", () => {
    assert.ok(handlerStart > 0, "the passkey handler must still exist");
    assert.ok(handlerEnd > handlerStart, "the passkey handler boundary must still exist");

    const options = handler.indexOf('"/api/auth/login/passkey/options"');
    const assertion = handler.indexOf("startAuthentication({ optionsJSON: started.options })");
    const verify = handler.indexOf('"/api/auth/login/passkey/verify"');
    const navigation = handler.indexOf("window.location.assign(returnTo)");

    assert.ok(options >= 0, "the client must request a server-owned challenge");
    assert.ok(assertion > options, "the browser assertion must use that challenge");
    assert.ok(verify > assertion, "the assertion must be verified by the server");
    assert.ok(navigation > verify, "navigation must wait for successful verification");
    assert.match(handler, /flowToken: started\.flowToken/);
  });

  test("owns failures inline and leaves password sign-in as the fallback", () => {
    assert.match(handler, /setError\(passkeySignInError\(err\)\)/);
    assert.match(login, /<FormError message=\{error \?\? ssoError\}/);
    assert.match(login, /or sign in with password/);
    assert.doesNotMatch(login, /\btoast\s*\(/);
  });
});

describe("passwordless passkey sign-in copy", () => {
  const accountSecurity = readAppFile("client/pages/AccountSecurity.tsx");
  const securityDocs = fs.readFileSync(
    path.join(repoRoot, "Home/client/docs/pages/Security.tsx"),
    "utf8",
  );
  const docsNav = fs.readFileSync(path.join(repoRoot, "Home/client/docs/nav.ts"), "utf8");

  test("Account Security explains direct and password-plus-second-step sign-in", () => {
    assert.match(accountSecurity, /directly/);
    assert.match(accountSecurity, /Password or SSO sign-in requires an enrolled second step/);
    assert.match(accountSecurity, /Once added, you can use it directly from the sign-in page/);
  });

  test("the user guide documents discovery, fallback, and full-session evidence", () => {
    assert.match(securityDocs, /no email or password is\s+required/);
    assert.match(securityDocs, /discoverable credentials/);
    assert.match(securityDocs, /Password and SSO remain available/);
    assert.match(securityDocs, /both\s+primary\s+and second-factor evidence/);
    assert.match(docsNav, /Passwordless passkey sign-in/);
  });
});
