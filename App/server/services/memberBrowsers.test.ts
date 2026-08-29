import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Conversation } from "../db/entities/Conversation.js";
import { EmployeeMemberBrowserGrant } from "../db/entities/EmployeeMemberBrowserGrant.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AppDataSource } from "../db/datasource.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { hashToken } from "../lib/token.js";
import { vaultUrlAllowedForEmployee } from "../routes/browserRpc.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { registerBridgeSocket, resetMemberBrowserHubForTests } from "./memberBrowserHub.js";
import { registerResourceChangeSink } from "./resourceEvents.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import { loadBrowserConfig } from "./agent/tools/mcpSources.js";
import {
  createMemberBrowser,
  employeeHasMemberBrowserGrant,
  grantMemberBrowser,
  memberBrowsersEnabled,
  markMemberBrowserOnline,
  memberBrowserUrlAllowed,
  memberBrowserUsableForSession,
  normalizePairingCode,
  pushCurrentPolicyToAgent,
  redeemPairingCode,
  regeneratePairingCode,
  resolveBridgeToken,
  resolveMemberBrowserForSpawn,
  revokeMemberBrowser,
  updateMemberBrowser,
} from "./memberBrowsers.js";

before(async () => {
  await initTestDb();
  // The real subscriber, so the live-sync test below proves what the production
  // write path does rather than what a stub does.
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
});
beforeEach(resetTestDb);
after(closeTestDb);

let companyId: string;

beforeEach(() => {
  companyId = testCompanyId();
});

async function employee(): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name: "Operator",
    slug: `operator-${randomUUID()}`,
    role: "Operations",
    browserEnabled: true,
  });
}

async function browser(
  overrides: Partial<MemberBrowser> & { ownerUserId: string },
): Promise<MemberBrowser> {
  const { browser: row } = await createMemberBrowser({
    companyId,
    ownerUserId: overrides.ownerUserId,
    name: overrides.name ?? "Chrome on my laptop",
    allowedHosts: overrides.allowedHosts ?? "example.com",
    approvalRequired: overrides.approvalRequired,
    allowUnattended: overrides.allowUnattended,
  });
  return row;
}

/**
 * The production host matcher, reached through the one export that wraps it.
 * `memberBrowserUrlAllowed` takes the checker as a parameter so the service
 * layer does not depend on the route module — re-implementing it in the test
 * would prove nothing about what ships.
 */
function hostChecker(url: string, allowList: string[]): { ok: boolean; reason?: string } {
  return { ok: vaultUrlAllowedForEmployee(url, allowList.join("\n")) };
}

describe("member browser pairing codes", () => {
  test("stores the pairing code only as a hash and never in plaintext on the row", async () => {
    const { browser: row, pairingCode } = await createMemberBrowser({
      companyId,
      ownerUserId: "user_1",
      name: "MacBook",
    });

    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({ id: row.id });
    const serialized = JSON.stringify(stored);
    assert.doesNotMatch(serialized, new RegExp(pairingCode));
    assert.doesNotMatch(serialized, new RegExp(normalizePairingCode(pairingCode)));
    assert.equal(stored.pairingCodeHash, hashToken(normalizePairingCode(pairingCode)));
    assert.equal(stored.tokenHash, null);
    assert.equal(stored.status, "pending");
  });

  test("redeems a pairing code exactly once", async () => {
    const { pairingCode } = await createMemberBrowser({
      companyId,
      ownerUserId: "user_1",
      name: "MacBook",
    });

    const first = await redeemPairingCode(pairingCode);
    assert.ok(first);
    assert.equal(await redeemPairingCode(pairingCode), null);

    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: first.browser.id,
    });
    assert.equal(stored.pairingCodeHash, null);
    assert.equal(stored.tokenHash, hashToken(first.token));
    assert.equal(stored.status, "offline");
  });

  test("refuses a pairing code once its ten-minute window has passed", async () => {
    const { browser: row, pairingCode } = await createMemberBrowser({
      companyId,
      ownerUserId: "user_1",
      name: "MacBook",
    });
    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({ id: row.id });
    // The window itself is the invariant, not just that an expired code fails:
    // a code that outlived the terminal it was pasted into is a standing key.
    const ttlMs = stored.pairingCodeExpiresAt!.getTime() - stored.createdAt.getTime();
    assert.ok(ttlMs > 9 * 60_000 && ttlMs <= 10 * 60_000 + 5_000, `ttl was ${ttlMs}ms`);

    await AppDataSource.getRepository(MemberBrowser).update(
      { id: row.id },
      { pairingCodeExpiresAt: new Date(Date.now() - 1_000) },
    );
    assert.equal(await redeemPairingCode(pairingCode), null);
  });

  test("regenerating a pairing code burns the bridge token the old one minted", async () => {
    const { pairingCode } = await createMemberBrowser({
      companyId,
      ownerUserId: "user_1",
      name: "MacBook",
    });
    const paired = await redeemPairingCode(pairingCode);
    assert.ok(paired);
    assert.ok(await resolveBridgeToken(paired.token));

    const replacement = await regeneratePairingCode(paired.browser.id);

    // Re-pairing is what a human does when a laptop goes missing, so the
    // token that laptop still holds has to stop working immediately.
    assert.equal(await resolveBridgeToken(paired.token), null);
    assert.equal(await redeemPairingCode(pairingCode), null);
    const repaired = await redeemPairingCode(replacement);
    assert.ok(repaired);
    assert.notEqual(repaired.token, paired.token);
  });

  test("only one of ten concurrent redemptions of the same code wins", async () => {
    const { pairingCode } = await createMemberBrowser({
      companyId,
      ownerUserId: "user_1",
      name: "MacBook",
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => redeemPairingCode(pairingCode)),
    );

    const winners = results.filter((result) => result !== null);
    assert.equal(winners.length, 1);
    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: winners[0]!.browser.id,
    });
    assert.equal(stored.tokenHash, hashToken(winners[0]!.token));
  });

  test("refuses a pairing code that belongs to a revoked browser", async () => {
    const { browser: row, pairingCode } = await createMemberBrowser({
      companyId,
      ownerUserId: "user_1",
      name: "MacBook",
    });
    await revokeMemberBrowser(row.id);
    assert.equal(await redeemPairingCode(pairingCode), null);
  });
});

describe("resolving which browser a spawn drives", () => {
  test("prefers the Routine's browser over the conversation's", async () => {
    const emp = await employee();
    const routineBrowser = await browser({
      ownerUserId: "user_1",
      name: "Routine laptop",
      allowUnattended: true,
    });
    const chatBrowser = await browser({ ownerUserId: "user_1", name: "Chat laptop" });
    await grantMemberBrowser({
      companyId,
      employeeId: emp.id,
      memberBrowserId: routineBrowser.id,
    });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: chatBrowser.id });
    const routine = await insert(Routine, {
      employeeId: emp.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
      memberBrowserId: routineBrowser.id,
    });
    const conversation = await insert(Conversation, {
      employeeId: emp.id,
      ownerUserId: "user_1",
      memberBrowserId: chatBrowser.id,
    });

    const resolved = await resolveMemberBrowserForSpawn({
      employeeId: emp.id,
      companyId,
      conversationId: conversation.id,
      routineId: routine.id,
    });

    assert.equal(resolved?.id, routineBrowser.id);
  });

  test("refuses a browser this AI Employee holds no grant for", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1" });
    const conversation = await insert(Conversation, {
      employeeId: emp.id,
      ownerUserId: "user_1",
      memberBrowserId: mine.id,
    });

    assert.equal(
      await resolveMemberBrowserForSpawn({
        employeeId: emp.id,
        companyId,
        conversationId: conversation.id,
      }),
      null,
    );

    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const resolved = await resolveMemberBrowserForSpawn({
      employeeId: emp.id,
      companyId,
      conversationId: conversation.id,
    });
    assert.equal(resolved?.id, mine.id);
  });

  test("refuses a conversation owned by someone other than the browser's owner", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1" });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    // The pointer may predate an ownership change, so the check is re-derived
    // rather than trusted: a colleague's thread must not reach this machine.
    const conversation = await insert(Conversation, {
      employeeId: emp.id,
      ownerUserId: "user_2",
      memberBrowserId: mine.id,
    });

    assert.equal(
      await resolveMemberBrowserForSpawn({
        employeeId: emp.id,
        companyId,
        conversationId: conversation.id,
      }),
      null,
    );
  });

  test("refuses an ownerless conversation even when it names a browser", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1" });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const conversation = await insert(Conversation, {
      employeeId: emp.id,
      ownerUserId: null,
      source: "telegram",
      memberBrowserId: mine.id,
    });

    assert.equal(
      await resolveMemberBrowserForSpawn({
        employeeId: emp.id,
        companyId,
        conversationId: conversation.id,
      }),
      null,
    );
  });

  test("refuses a Routine unless the owner opted into unattended use", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1", allowUnattended: false });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const routine = await insert(Routine, {
      employeeId: emp.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
      memberBrowserId: mine.id,
    });

    assert.equal(
      await resolveMemberBrowserForSpawn({ employeeId: emp.id, companyId, routineId: routine.id }),
      null,
    );

    await updateMemberBrowser(mine.id, { allowUnattended: true });
    const resolved = await resolveMemberBrowserForSpawn({
      employeeId: emp.id,
      companyId,
      routineId: routine.id,
    });
    assert.equal(resolved?.id, mine.id);
  });

  test("refuses a browser belonging to another company", async () => {
    const emp = await employee();
    const otherCompanyBrowser = await AppDataSource.getRepository(MemberBrowser).save(
      AppDataSource.getRepository(MemberBrowser).create({
        companyId: testCompanyId(),
        ownerUserId: "user_1",
        name: "Elsewhere",
        status: "offline",
      }),
    );
    await grantMemberBrowser({
      companyId,
      employeeId: emp.id,
      memberBrowserId: otherCompanyBrowser.id,
    });
    const conversation = await insert(Conversation, {
      employeeId: emp.id,
      ownerUserId: "user_1",
      memberBrowserId: otherCompanyBrowser.id,
    });

    assert.equal(
      await resolveMemberBrowserForSpawn({
        employeeId: emp.id,
        companyId,
        conversationId: conversation.id,
      }),
      null,
    );
  });
});

describe("live re-check for a bound session", () => {
  async function boundSession(emp: AIEmployee, browserId: string): Promise<BrowserSession> {
    return insert(BrowserSession, {
      companyId,
      employeeId: emp.id,
      conversationId: null,
      runId: null,
      memberBrowserId: browserId,
      mcpToken: randomUUID(),
      mcpTokenExpiresAt: new Date(Date.now() + 60_000),
      status: "live",
    });
  }

  test("stops being usable the moment the grant row is deleted", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1" });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const session = await boundSession(emp, mine.id);

    assert.equal((await memberBrowserUsableForSession(session, emp)).ok, true);

    await AppDataSource.getRepository(EmployeeMemberBrowserGrant).delete({
      employeeId: emp.id,
      memberBrowserId: mine.id,
    });

    const verdict = await memberBrowserUsableForSession(session, emp);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? "" : verdict.reason, /no longer granted/i);
  });

  test("stops being usable once the browser is revoked", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1" });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const session = await boundSession(emp, mine.id);

    await revokeMemberBrowser(mine.id);

    const verdict = await memberBrowserUsableForSession(session, emp);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? "" : verdict.reason, /disconnected by its owner/i);
  });

  test("refuses a Run on a browser that never opted into unattended use", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1", allowUnattended: false });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const routine = await insert(Routine, {
      employeeId: emp.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
    });
    const run = await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(),
      status: "running",
    });
    const session = await boundSession(emp, mine.id);
    session.runId = run.id;
    await AppDataSource.getRepository(BrowserSession).save(session);

    const verdict = await memberBrowserUsableForSession(session, emp);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? "" : verdict.reason, /scheduled Routines/i);
  });
});

describe("Routine recording consent", () => {
  test("never falls back to the App browser when a selected legacy browser lacks consent", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1", allowUnattended: true });
    await AppDataSource.getRepository(MemberBrowser).update(
      { id: mine.id },
      { routineRecordingConsentAt: null },
    );
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const routine = await insert(Routine, {
      employeeId: emp.id,
      name: "Legacy nightly",
      slug: `legacy-nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
      memberBrowserId: mine.id,
    });

    await assert.rejects(
      loadBrowserConfig(emp.id, { routineId: routine.id, runId: randomUUID() }),
      /re-enable unattended use.*consent to Routine recording/i,
    );
    assert.equal(await AppDataSource.getRepository(BrowserSession).countBy({}), 0);
  });
});

describe("member browser host policy", () => {
  test("refuses everything when the allow list is empty", () => {
    // The deliberate difference from AIEmployee.browserAllowedHosts, where an
    // empty list means unrestricted. On somebody's own laptop "no list" must
    // never widen into "anywhere".
    let checkerCalls = 0;
    const verdict = memberBrowserUrlAllowed(
      "https://example.com/",
      { allowedHosts: "", name: "MacBook" },
      (url, allowList) => {
        checkerCalls += 1;
        return hostChecker(url, allowList);
      },
    );

    assert.equal(verdict.ok, false);
    assert.equal(checkerCalls, 0);
    assert.match(verdict.ok ? "" : verdict.reason, /no allowed hosts/i);
    assert.match(verdict.ok ? "" : verdict.reason, /MacBook/);
  });

  test("treats a list of only comments and blank lines as empty", () => {
    const verdict = memberBrowserUrlAllowed(
      "https://example.com/",
      { allowedHosts: "# only mail\n\n   \n", name: "MacBook" },
      hostChecker,
    );
    assert.equal(verdict.ok, false);
  });

  test("enforces the browser's globs and never lets a star cross a dot", () => {
    const row = { allowedHosts: "*.example.com\nmail.google.com\nshop.*.test", name: "MacBook" };

    assert.equal(memberBrowserUrlAllowed("https://example.com/a", row, hostChecker).ok, true);
    assert.equal(memberBrowserUrlAllowed("https://app.example.com/a", row, hostChecker).ok, true);
    assert.equal(memberBrowserUrlAllowed("https://mail.google.com/", row, hostChecker).ok, true);
    assert.equal(memberBrowserUrlAllowed("https://shop.eu.test/", row, hostChecker).ok, true);

    assert.equal(memberBrowserUrlAllowed("https://google.com/", row, hostChecker).ok, false);
    assert.equal(memberBrowserUrlAllowed("https://shop.eu.west.test/", row, hostChecker).ok, false);
    // The attack the label-safe glob exists for: a suffix that merely starts
    // with an allowed name is a different site entirely.
    assert.equal(
      memberBrowserUrlAllowed("https://example.com.attacker.test/", row, hostChecker).ok,
      false,
    );
  });
});

describe("revoking a member browser", () => {
  test("drops every grant and clears the conversation and Routine pointers", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1", allowUnattended: true });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const conversation = await insert(Conversation, {
      employeeId: emp.id,
      ownerUserId: "user_1",
      memberBrowserId: mine.id,
    });
    const routine = await insert(Routine, {
      employeeId: emp.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
      memberBrowserId: mine.id,
    });

    await revokeMemberBrowser(mine.id);

    assert.equal(await employeeHasMemberBrowserGrant(emp.id, mine.id), false);
    assert.equal(
      (await AppDataSource.getRepository(Conversation).findOneByOrFail({ id: conversation.id }))
        .memberBrowserId,
      null,
    );
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id }))
        .memberBrowserId,
      null,
    );
    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: mine.id,
    });
    assert.equal(stored.status, "revoked");
    assert.equal(stored.tokenHash, null);
    assert.ok(stored.revokedAt);
  });

  test("closes the browser sessions already bound to it", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1" });
    const session = await insert(BrowserSession, {
      companyId,
      employeeId: emp.id,
      conversationId: null,
      runId: null,
      memberBrowserId: mine.id,
      mcpToken: randomUUID(),
      mcpTokenExpiresAt: new Date(Date.now() + 60_000),
      status: "live",
    });

    await revokeMemberBrowser(mine.id);

    assert.equal(
      (await AppDataSource.getRepository(BrowserSession).findOneByOrFail({ id: session.id }))
        .status,
      "closed",
    );
  });

  /**
   * A regression guard with a specific past in mind. Cutting the routines loose
   * went through `Repository.update()` by criteria, which broadcasts only the
   * partial it was handed — `{ memberBrowserId: null }`, with no `employeeId` —
   * so the subscriber could not hop to the company and no other open Routines
   * page ever refetched. The rows were unbound; the app just didn't say so, and
   * a colleague's screen went on offering a browser that had been revoked.
   */
  test("announces a routine change for the routines it cut loose", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1", allowUnattended: true });
    await insert(Routine, {
      employeeId: emp.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
      memberBrowserId: mine.id,
    });
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((id, kind) => events.push({ companyId: id, kind }));

    await revokeMemberBrowser(mine.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(
      events.some((e) => e.companyId === companyId && e.kind === "routine"),
      `expected a routine change for ${companyId}, saw ${JSON.stringify(events)}`,
    );
  });

  test("a browser no routine was bound to announces nothing", async () => {
    // Every revocation would otherwise wake every open Routines page in the
    // company for a routine list that did not move.
    const mine = await browser({ ownerUserId: "user_1" });
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((id, kind) => events.push({ companyId: id, kind }));

    await revokeMemberBrowser(mine.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(
      events.filter((e) => e.companyId === companyId && e.kind === "routine"),
      [],
    );
  });
});

describe("pushing the host policy to the agent", () => {
  /**
   * The agent starts with an empty allow list, and an empty list means "open
   * nothing". So the policy has to reach it the moment it connects — not only
   * when a chat spawns a session. Before this, starting the bridge after
   * opening the chat produced a browser that refused every navigation, with
   * nothing in the UI to explain why.
   */
  function stubSocket(sent: string[]) {
    return {
      on() {},
      send(data: string) {
        sent.push(data);
      },
      close() {},
    } as unknown as Parameters<typeof registerBridgeSocket>[0]["ws"];
  }

  test("an agent is told its allow list as soon as it comes online", async () => {
    const mine = await browser({
      ownerUserId: "user_1",
      allowedHosts: "mail.google.com\n# a comment\n\n*.notion.so",
    });
    const sent: string[] = [];
    registerBridgeSocket({
      browserId: mine.id,
      companyId,
      ownerUserId: "user_1",
      ws: stubSocket(sent),
    });

    await markMemberBrowserOnline(mine.id, { platform: "darwin" });

    const policy = sent.map((raw) => JSON.parse(raw)).find((frame) => frame.t === "policy");
    assert.ok(policy, "the agent never received a policy frame");
    // Comments and blank lines are the agent's problem to not have.
    assert.deepEqual(policy.allowedHosts, ["mail.google.com", "*.notion.so"]);
    resetMemberBrowserHubForTests();
  });

  test("editing the allow list reaches the machine that enforces it", async () => {
    const mine = await browser({ ownerUserId: "user_1", allowedHosts: "old.example" });
    const sent: string[] = [];
    registerBridgeSocket({
      browserId: mine.id,
      companyId,
      ownerUserId: "user_1",
      ws: stubSocket(sent),
    });

    await updateMemberBrowser(mine.id, { allowedHosts: "new.example" });

    const policies = sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.t === "policy");
    assert.deepEqual(policies.at(-1)?.allowedHosts, ["new.example"]);
    resetMemberBrowserHubForTests();
  });

  test("a revoked browser is never handed a policy", async () => {
    const mine = await browser({ ownerUserId: "user_1", allowedHosts: "old.example" });
    await revokeMemberBrowser(mine.id);
    const sent: string[] = [];
    registerBridgeSocket({
      browserId: mine.id,
      companyId,
      ownerUserId: "user_1",
      ws: stubSocket(sent),
    });

    await pushCurrentPolicyToAgent(mine.id);

    assert.deepEqual(
      sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.t === "policy"),
      [],
    );
    resetMemberBrowserHubForTests();
  });
});

/**
 * The multi-tenant invariant.
 *
 * The member-browser switch is an operator-editable runtime setting now, so the
 * old boot-time refusal in `validateRuntimeSecurity` could only have checked a
 * value that changes afterwards. The boundary lives in the resolver instead,
 * and this is what holds it: a shared install can never turn member browsers
 * on, whatever the setting says.
 */
describe("the multi-tenant kill switch", () => {
  const mutable = config as unknown as { security: { multiTenant: boolean } };
  const original = mutable.security.multiTenant;

  afterEach(() => {
    mutable.security.multiTenant = original;
    overrideRuntimeSettingsForTests(null);
  });

  test("a single-tenant install follows the runtime setting", () => {
    mutable.security.multiTenant = false;

    overrideRuntimeSettingsForTests({ agent: { memberBrowsersEnabled: true } });
    assert.equal(memberBrowsersEnabled(), true);

    overrideRuntimeSettingsForTests({ agent: { memberBrowsersEnabled: false } });
    assert.equal(memberBrowsersEnabled(), false);
  });

  test("multi-tenant forces the answer to false even when the setting says on", () => {
    mutable.security.multiTenant = true;
    overrideRuntimeSettingsForTests({ agent: { memberBrowsersEnabled: true } });

    assert.equal(memberBrowsersEnabled(), false);
  });

  test("a browser cannot be resolved for a spawn on a multi-tenant install", async () => {
    const emp = await employee();
    const mine = await browser({ ownerUserId: "user_1" });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: mine.id });
    const conversation = await insert(Conversation, {
      employeeId: emp.id,
      ownerUserId: "user_1",
      memberBrowserId: mine.id,
    });

    // Resolvable on a single-tenant install with the setting on …
    mutable.security.multiTenant = false;
    overrideRuntimeSettingsForTests({ agent: { memberBrowsersEnabled: true } });
    assert.equal(
      (
        await resolveMemberBrowserForSpawn({
          employeeId: emp.id,
          companyId,
          conversationId: conversation.id,
        })
      )?.id,
      mine.id,
    );

    // … and refused on a shared one, with the same setting still on.
    mutable.security.multiTenant = true;
    assert.equal(
      await resolveMemberBrowserForSpawn({
        employeeId: emp.id,
        companyId,
        conversationId: conversation.id,
      }),
      null,
    );
  });
});
