/**
 * Real Chrome coverage for the shorter sign-in, onboarding and Settings
 * flows, on the real App: sign in, sign up, forgot and reset start with the
 * cursor in their first field, and the "reset link sent" screen leads back to
 * sign in; accepting an invitation opens the company just joined rather than
 * whichever membership comes first (Accept itself stays); the Connect dialog
 * starts in the credential rather than the prefilled Label, with its labels
 * tied to their fields; and the onboarding company step starts in the first
 * empty box and saves with ⌘/Ctrl+Enter. Each flow counts its clicks. Run
 * with `npm run test:clicks-settings`.
 */
import assert from "node:assert/strict";
import type { Company, IntegrationCatalogEntry } from "../client/lib/api";
import { API, COMPANY, startApp, waitForFocus, type ApiRoute } from "./appFixture";

const app = await startApp("Fewer clicks — sign-in, onboarding and Settings");

// ─────────────────────────── signed out ───────────────────────────

const signedOut: ApiRoute[] = [
  ["GET", "/api/auth/sso-providers", () => []],
  ["GET", /^\/api\/auth\/sso\//, () => ({ enabled: false })],
  ["GET", "/api/auth/passkeys/available", () => ({ available: false })],
];

await app.check("Sign in: the cursor starts in Email; type, Tab, type, Enter", async () => {
  const view = await app.open({
    path: "/login",
    signedOut: true,
    routes: [["POST", "/api/auth/login", () => ({ ok: true })], ...signedOut],
  });
  const { page } = view;
  await waitForFocus(page.getByLabel("Email", { exact: true }), "Email has focus");
  await page.keyboard.type("morgan@example.test");
  await page.keyboard.press("Tab");
  await page.keyboard.type("correct horse battery");
  await page.keyboard.press("Enter");
  const write = await view.waitForWrite((w) => w.path === "/api/auth/login");
  assert.equal(write.body.email, "morgan@example.test");
  assert.equal(view.clicks(), 0);
  await page.close();
});

await app.check(
  "Sign up: the cursor starts in Name; an invitation's hint still reaches Email",
  async () => {
    const view = await app.open({
      path: "/signup?invitation=invite-token",
      signedOut: true,
      routes: signedOut,
    });
    const { page } = view;
    await waitForFocus(page.getByLabel("Name", { exact: true }), "Name has focus");
    const email = page.getByLabel("Email", { exact: true });
    const describedBy = await email.getAttribute("aria-describedby");
    assert.ok(describedBy?.includes("signup-invitation-hint"), `described by ${describedBy}`);
    assert.match(
      (await page.locator("#signup-invitation-hint").textContent()) ?? "",
      /email address this invitation was sent to/,
    );
    await page.close();
  },
);

await app.check(
  "Forgot password: Email has the cursor; the sent screen leads back to sign in",
  async () => {
    const view = await app.open({
      path: "/forgot",
      signedOut: true,
      routes: [["POST", "/api/auth/forgot", () => ({ ok: true })], ...signedOut],
    });
    const { page } = view;
    const email = page.getByLabel("Email", { exact: true });
    await waitForFocus(email, "Email has focus");
    assert.equal(await email.getAttribute("autocomplete"), "email");
    await page.keyboard.type("morgan@example.test");
    await page.keyboard.press("Enter");
    await page.getByText(/a reset link has been sent/).waitFor();
    await view.click(page.getByRole("link", { name: "Back to sign in" }));
    await view.landedOn("/login");
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check(
  "Reset password: the new password has the cursor and a manager's hint",
  async () => {
    const view = await app.open({ path: "/reset/reset-token", signedOut: true, routes: signedOut });
    const { page } = view;
    const password = page.getByLabel("New password", { exact: true });
    await waitForFocus(password, "New password has focus");
    assert.equal(await password.getAttribute("autocomplete"), "new-password");
    await page.close();
  },
);

// ─────────────────────────── invitations ───────────────────────────

await app.check(
  "Accepting an invitation opens the company just joined, not the first membership",
  async () => {
    const globex: Company = { ...COMPANY, id: "globex", slug: "globex", name: "Globex" };
    const view = await app.open({
      path: "/invite/invite-token",
      routes: [
        // Acme comes first: a plain "/" would land there.
        ["GET", "/api/companies", () => [{ ...COMPANY }, globex]],
        ["POST", "/api/invitations/accept", () => ({ companyId: "globex", companySlug: "globex" })],
      ],
    });
    const { page } = view;
    const accept = page.getByRole("button", { name: "Accept invitation" });
    await accept.waitFor();
    const navigation = page.waitForURL((url) => url.pathname === "/c/globex");
    await view.click(accept);
    await navigation;
    assert.equal(view.clicks(), 1, "Accept stays an explicit click");
    await page.close();
  },
);

// ─────────────────────────── Settings ───────────────────────────

const STRIPE: IntegrationCatalogEntry = {
  provider: "stripe",
  name: "Stripe",
  category: "Payments",
  tagline: "Charges, customers and payouts.",
  description: "Paste a restricted API key with read access.",
  icon: "stripe",
  authMode: "apikey",
  enabled: true,
  fields: [
    {
      key: "secretKey",
      label: "Secret key",
      type: "password",
      placeholder: "rk_live_…",
      required: true,
    },
  ],
} as IntegrationCatalogEntry;

await app.check(
  "Connect an Integration: the cursor starts in the credential, and Enter connects",
  async () => {
    const view = await app.open({
      path: "/c/acme/settings/integrations",
      routes: [
        ["GET", `${API}/integrations/catalog`, () => [STRIPE]],
        ["GET", `${API}/integrations/connections`, () => []],
        [
          "POST",
          `${API}/integrations/connections`,
          ({ body }) => ({
            id: "conn-stripe",
            provider: "stripe",
            label: body.label,
          }),
        ],
        ["GET", `${API}/employees`, () => []],
        ["GET", /\/integrations\/chat-identities/, () => []],
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: /Stripe/ }).first());
    const dialog = page.getByRole("dialog");
    const secret = dialog.getByLabel(/Secret key/);
    await waitForFocus(secret, "the credential has focus, not the prefilled Label");
    assert.equal(await dialog.getByLabel("Label", { exact: true }).inputValue(), "Stripe");
    await page.keyboard.type("rk_test_123");
    await page.keyboard.press("Enter");
    const write = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${API}/integrations/connections`,
    );
    assert.deepEqual(write.body.fields, { secretKey: "rk_test_123" });
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

// ─────────────────────────── onboarding ───────────────────────────

await app.check(
  "Onboarding: the company step starts in the empty Vision and saves with ⌘/Ctrl+Enter",
  async () => {
    const half: Company = {
      ...COMPANY,
      mission: "Answer every customer within the hour.",
      vision: "",
    };
    const view = await app.open({
      path: "/c/acme/onboarding",
      company: half,
      routes: [
        ["PATCH", `${API}`, ({ body }) => ({ ...half, ...body })],
        [
          "GET",
          `${API}/onboarding-status`,
          () => ({
            complete: false,
            employee: null,
            modelConnected: false,
            routineCount: 0,
            scheduledRoutineCount: 0,
            nextRunAt: null,
            skillCount: 0,
            mailGranted: false,
            mailAccessLevel: null,
            nextStep: "company",
          }),
        ],
        ["GET", `${API}/employees`, () => []],
        ["GET", /\/employee-templates/, () => []],
      ],
    });
    const { page } = view;
    const vision = page.getByLabel("Vision", { exact: true });
    await waitForFocus(vision, "the first empty box, Vision, has focus");
    await page.keyboard.type("Every customer feels heard.");
    await page.keyboard.press("ControlOrMeta+Enter");
    const write = await view.waitForWrite((w) => w.method === "PATCH" && w.path === API);
    assert.deepEqual(write.body, {
      mission: "Answer every customer within the hour.",
      vision: "Every customer feels heard.",
    });
    assert.equal(view.clicks(), 0);
    await page.close();
  },
);

await app.finish();
