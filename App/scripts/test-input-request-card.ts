/**
 * Real Chrome coverage for the person's side of an Input request: a code box only ever
 * shows while a page is really waiting; I'm ready carries no code and brings the box
 * back when the page asks; a code is typed once and leaves the page; I can't; an answer
 * in words; phone width and dark mode. And the Vault editor reading an authenticator QR
 * from an image, including Google Authenticator's export. The API is a fixture that
 * stores what it is sent. Run with `npm run test:input-request-card`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import QRCode from "qrcode";
import type { InputRequestView } from "../shared/inputRequests";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
await fs.mkdir(output, { recursive: true });

const ID = {
  code: "11111111-1111-4111-8111-111111111111",
  answer: "22222222-2222-4222-8222-222222222222",
  done: "33333333-3333-4333-8333-333333333333",
};

function request(values: Partial<InputRequestView> = {}): InputRequestView {
  return {
    id: ID.code,
    kind: "code",
    status: "waiting",
    title: "FreeAgent sign-in code",
    body: "I'm filing the VAT return, and FreeAgent wants the code it texts to your phone.",
    employee: { id: "mira", name: "Mira", slug: "mira", avatarKey: null },
    assignee: { id: "viewer", name: "Valeria" },
    pageOrigin: "https://login.freeagent.com",
    browserSessionId: null,
    vaultItemId: null,
    askingUntil: null,
    expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    createdAt: new Date(Date.now() - 12 * 3_600_000).toISOString(),
    answerPending: false,
    lastCodeRefused: false,
    tainted: false,
    adminOnly: false,
    work: {
      kind: "run",
      id: "run",
      label: "File the VAT return",
      link: "/c/acme/routines/mira/vat",
    },
    vaultLink: "/c/acme/vault",
    canAnswer: true,
    heldByStanddown: false,
    closeReason: "",
    ...values,
  };
}

const asking = (values: Partial<InputRequestView> = {}) =>
  request({
    status: "asking",
    askingUntil: new Date(Date.now() + 4 * 60_000).toISOString(),
    ...values,
  });

type Store = { rows: InputRequestView[]; writes: Array<{ path: string; body: unknown }> };

const browserErrors: string[] = [];
const fixture = await startBrowserFixture("inputRequestCardHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });

let passed = 0;
const failures: string[] = [];
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    // eslint-disable-next-line no-console
    console.error(`FAILED - ${name}\n`, error);
  }
}

async function open(
  rows: InputRequestView[],
  options: {
    width?: number;
    scheme?: "light" | "dark";
    query?: string;
    get?: (id: string) => InputRequestView | undefined;
    onAnswer?: (store: Store, row: InputRequestView, body: { value?: string }) => InputRequestView;
  } = {},
): Promise<{ page: Page; store: Store }> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1100, height: 900 },
    colorScheme: options.scheme ?? "light",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(String(error)));
  const store: Store = { rows: [...rows], writes: [] };
  await page.route("**/api/**", async (route) => {
    const incoming = route.request();
    const { pathname } = new URL(incoming.url());
    const base = "/api/companies/company/input-requests";
    if (!pathname.startsWith(base)) return route.fulfill({ json: {} });
    const [, id, action] = pathname.slice(base.length).split("/");
    if (incoming.method() === "GET") {
      if (!id) {
        return route.fulfill({
          json: store.rows.filter((row) => ["waiting", "ready", "asking"].includes(row.status)),
        });
      }
      const found = store.rows.find((row) => row.id === id) ?? options.get?.(id);
      return found
        ? route.fulfill({ json: found })
        : route.fulfill({ status: 404, json: { error: "Input request not found." } });
    }
    const body = (incoming.postDataJSON() ?? {}) as { value?: string; note?: string };
    store.writes.push({ path: `${action}`, body });
    const row = store.rows.find((candidate) => candidate.id === id)!;
    if (action === "ready") Object.assign(row, { status: "ready" });
    if (action === "decline") Object.assign(row, { status: "declined" });
    if (action === "answer") {
      if (options.onAnswer) Object.assign(row, options.onAnswer(store, row, body));
      else if (row.kind === "answer") Object.assign(row, { status: "answered" });
      else Object.assign(row, { status: "submitted", askingUntil: null });
    }
    return route.fulfill({ json: row });
  });
  await page.goto(`${fixture.origin}/${options.query ?? ""}`);
  return { page, store };
}

const codeBox = (page: Page) => page.getByLabel(/^Code for /);

async function noSidewaysScroll(page: Page): Promise<void> {
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(extra <= 0, `the page scrolls sideways by ${extra}px`);
}

/** A real Google Authenticator export payload, as its own encoder lays it out. */
function migrationUri(accounts: Array<{ secret: number[]; name: string; issuer: string }>): string {
  const varint = (value: number) => {
    const out: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
      out.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    return [...out, rest];
  };
  const bytes = (field: number, value: number[]) => [
    ...varint(field * 8 + 2),
    ...varint(value.length),
    ...value,
  ];
  const text = (value: string) => [...Buffer.from(value)];
  const number = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
  const payload = accounts.flatMap((account) =>
    bytes(1, [
      ...bytes(1, account.secret),
      ...bytes(2, text(account.name)),
      ...bytes(3, text(account.issuer)),
      ...number(4, 1),
      ...number(5, 1),
      ...number(6, 2),
    ]),
  );
  return `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(payload).toString("base64"))}`;
}

const SECRET = [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef];

try {
  await check("a page that isn't waiting offers no box, only I'm ready", async () => {
    const { page, store } = await open([request()]);
    await page.getByRole("button", { name: "I'm ready" }).waitFor();
    await page.getByText("https://login.freeagent.com").waitFor();
    await page.getByText(/a code typed here wouldn't work/).waitFor();
    await page.getByText(/keeps waiting until/).waitFor();
    assert.equal(await codeBox(page).count(), 0);

    await page.getByRole("button", { name: "I'm ready" }).click();
    await page.getByText(/is signing in again/).waitFor();
    assert.deepEqual(store.writes, [{ path: "ready", body: {} }], "it carries no code");
    assert.equal(await codeBox(page).count(), 0);

    // The work gets back to the page: the box appears by itself, and only now.
    store.rows[0] = asking();
    await codeBox(page).waitFor({ timeout: 10_000 });
    await page.getByText(/^Asking now/).waitFor();
    await page.screenshot({ path: path.join(output, "input-request-asking.png") });
    await page.context().close();
  });

  await check("a code goes once, then leaves the page", async () => {
    const { page, store } = await open([asking()], {
      onAnswer: (_store, row, body) => {
        assert.equal(body.value, "481516");
        return { ...row, answerPending: true };
      },
    });
    await codeBox(page).fill("481516");
    await page.getByRole("button", { name: /Send to login\.freeagent\.com/ }).click();
    for (let i = 0; i < 100 && store.writes.length === 0; i += 1) await page.waitForTimeout(50);
    assert.deepEqual(store.writes, [{ path: "answer", body: { value: "481516" } }]);
    // The session takes it a moment later, and nothing says "sent" until it has.
    assert.equal(await page.getByText(/Sent to login\.freeagent\.com/).count(), 0);
    Object.assign(store.rows[0], { status: "submitted", answerPending: false, askingUntil: null });
    await page.getByText(/Sent to login\.freeagent\.com/).waitFor({ timeout: 10_000 });
    assert.equal(await codeBox(page).count(), 0);
    assert.ok(!(await page.content()).includes("481516"), "the code isn't left in the page");
    await page.context().close();
  });

  await check("a refused code says so, and a tainted session warns", async () => {
    const { page } = await open([asking({ lastCodeRefused: true, tainted: true })]);
    await page.getByText(/so the last code didn't work/).waitFor();
    await page.getByText(/read something from outside your company/).waitFor();
    await page.getByText(/expected to sign in to login\.freeagent\.com/).waitFor();
    await page.context().close();
  });

  await check("a code on its way can't be sent twice", async () => {
    const { page } = await open([asking({ answerPending: true })]);
    await codeBox(page).waitFor();
    assert.equal(await codeBox(page).isDisabled(), true);
    await page.context().close();
  });

  await check("I can't takes a note, and tells them what happens next", async () => {
    const { page, store } = await open([request()]);
    await page.getByRole("button", { name: "I can't" }).click();
    await page.getByLabel(/Anything Mira should know/).fill("I'm away until Monday");
    await page.getByRole("button", { name: "Tell Mira I can't" }).click();
    await page.getByText("Mira carries on without it.").waitFor();
    assert.deepEqual(store.writes, [{ path: "decline", body: { note: "I'm away until Monday" } }]);
    await page.context().close();
  });

  await check("an answer in words has no I'm ready, and warns against passwords", async () => {
    const { page, store } = await open([
      request({ id: ID.answer, kind: "answer", title: "Which VAT quarter?", pageOrigin: "" }),
    ]);
    await page.getByText(/don't put a password here/).waitFor();
    assert.equal(await page.getByRole("button", { name: "I'm ready" }).count(), 0);
    await page.getByLabel(/Your answer to Mira/).fill("Q3");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText(/carries on with your answer/).waitFor();
    assert.deepEqual(store.writes, [{ path: "answer", body: { value: "Q3" } }]);
    await page.context().close();
  });

  await check("an action is a Done button, with the browser for those who may watch", async () => {
    const { page, store } = await open([
      asking({ kind: "action", title: "Approve on your phone", browserSessionId: "session" }),
    ]);
    const link = page.getByRole("link", { name: /Open the browser/ });
    await link.waitFor();
    assert.match((await link.getAttribute("href")) ?? "", /browser-sessions\/session\/view$/);
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByText(/is checking the page/).waitFor();
    assert.deepEqual(store.writes, [{ path: "answer", body: {} }]);
    await page.context().close();
  });

  await check("someone who can't answer it isn't offered anything", async () => {
    const { page } = await open([
      asking({ canAnswer: false, assignee: { id: "other", name: "Ola" } }),
    ]);
    await page.getByText("Ola has been asked.").waitFor();
    assert.equal(await codeBox(page).count(), 0);
    assert.equal(await page.getByRole("button", { name: "I can't" }).count(), 0);
    await page.context().close();
  });

  await check("an old link to one that has ended says how it ended", async () => {
    const { page } = await open([], {
      query: `?path=${encodeURIComponent(`/c/acme/decisions#input-${ID.done}`)}`,
      get: (id) =>
        id === ID.done
          ? request({ id: ID.done, status: "expired", closeReason: "Nobody answered in time." })
          : undefined,
    });
    await page.getByText(/waited as long as it could/).waitFor();
    await page.context().close();
  });

  await check("nothing waiting draws nothing", async () => {
    const { page } = await open([]);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByRole("region", { name: "Waiting for you" }).count(), 0);
    await page.context().close();
  });

  await check("on a phone, in the dark, nothing scrolls sideways", async () => {
    const { page } = await open(
      [
        asking({ tainted: true, lastCodeRefused: true }),
        request({ id: ID.done, pageOrigin: "https://a-rather-long-subdomain.of.freeagent.com" }),
        request({ id: ID.answer, kind: "answer", pageOrigin: "" }),
      ],
      { width: 375, scheme: "dark" },
    );
    await codeBox(page).waitFor();
    await noSidewaysScroll(page);
    await page.screenshot({
      path: path.join(output, "input-request-phone-dark.png"),
      fullPage: true,
    });
    await page.context().close();
  });

  await check("the Vault reads a site's QR code from an image", async () => {
    const { page } = await open([], { query: "?screen=vault" });
    await page.getByText("Authenticator code").waitFor();
    const png = await QRCode.toBuffer(
      "otpauth://totp/FreeAgent:mira@acme.test?secret=JBSWY3DPEHPK3PXP&issuer=FreeAgent",
      { width: 300 },
    );
    await page
      .locator('input[type="file"][accept="image/*"]')
      .setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: png });
    await page.getByText(/Read the QR code/).waitFor();
    const value = await page.locator("#vault-totp-setup-key").inputValue();
    assert.match(value, /secret=JBSWY3DPEHPK3PXP/);
    await page.context().close();
  });

  await check("the Vault reads a Google Authenticator export, asking which account", async () => {
    const { page } = await open([], { query: "?screen=vault" });
    await page.getByText("Authenticator code").waitFor();
    const png = await QRCode.toBuffer(
      migrationUri([
        { secret: SECRET, name: "mira@acme.test", issuer: "FreeAgent" },
        { secret: SECRET.slice().reverse(), name: "mira@acme.test", issuer: "Xero" },
      ]),
      { width: 400 },
    );
    await page
      .locator('input[type="file"][accept="image/*"]')
      .setInputFiles({ name: "export.png", mimeType: "image/png", buffer: png });
    await page.getByText(/holds 2 accounts/).waitFor();
    await page.getByRole("button", { name: "FreeAgent (mira@acme.test)" }).click();
    const value = await page.locator("#vault-totp-setup-key").inputValue();
    assert.match(value, /^otpauth:\/\/totp\/FreeAgent/);
    assert.match(value, /secret=JBSWY3DPEHPK3PXP/);
    await page.context().close();
  });

  await check("a QR code that isn't an authenticator is refused in words", async () => {
    const { page } = await open([], { query: "?screen=vault" });
    await page.getByText("Authenticator code").waitFor();
    const png = await QRCode.toBuffer("https://example.com/not-a-code", { width: 300 });
    await page
      .locator('input[type="file"][accept="image/*"]')
      .setInputFiles({ name: "other.png", mimeType: "image/png", buffer: png });
    await page.getByText(/isn't an authenticator code/).waitFor();
    assert.equal(await page.locator("#vault-totp-setup-key").inputValue(), "");
    await page.context().close();
  });

  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join("\n")}`);
} finally {
  await browser.close();
  await fixture.close();
}

// eslint-disable-next-line no-console
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  // eslint-disable-next-line no-console
  console.error(`Failed: ${failures.join("; ")}`);
  process.exit(1);
}
