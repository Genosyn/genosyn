import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AuditEvent } from "../db/entities/AuditEvent.js";
import { CompanyPolicy } from "../db/entities/CompanyPolicy.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  PolicyBlockedRecipientError,
  assertRecipientsPolicyAllowed,
  composePoliciesContext,
  parseList,
  policyForbiddingTool,
} from "./companyPolicies.js";

/**
 * The Policy layer's mechanical halves: prose injection stays bounded and
 * headerless when empty, domain blocking matches domains (and subdomains,
 * never lookalikes) with an audit trail, and the tool gate resolves the
 * first enabled policy naming the tool.
 */

let companyId: string;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
});

async function addPolicy(over: Partial<CompanyPolicy> = {}): Promise<CompanyPolicy> {
  return insert(CompanyPolicy, {
    companyId,
    title: "No competitor mail",
    body: "",
    blockedRecipientDomains: "",
    forbiddenTools: "",
    enabled: true,
    ...over,
  });
}

describe("parseList", () => {
  test("splits lines, trims, lowercases, drops blanks", () => {
    assert.deepEqual(parseList("  Rival.com \n\nSEND_MAIL\n"), ["rival.com", "send_mail"]);
  });
});

describe("composePoliciesContext", () => {
  test("empty when no policy carries prose — no header with nothing under it", async () => {
    assert.equal(await composePoliciesContext(companyId), "");
    await addPolicy({ blockedRecipientDomains: "rival.com" });
    assert.equal(await composePoliciesContext(companyId), "");
  });

  test("enabled prose rides in, disabled prose does not", async () => {
    await addPolicy({ title: "Tone", body: "Write like a human." });
    await addPolicy({ title: "Silent", body: "Never injected.", enabled: false });
    const context = await composePoliciesContext(companyId);
    assert.match(context, /## Company policies/);
    assert.match(context, /### Tone/);
    assert.match(context, /Write like a human\./);
    assert.doesNotMatch(context, /Never injected/);
  });
});

describe("assertRecipientsPolicyAllowed", () => {
  test("blocks the domain and its subdomains, audits, and names the policy", async () => {
    await addPolicy({ blockedRecipientDomains: "rival.com" });
    await assert.rejects(
      assertRecipientsPolicyAllowed(companyId, ["ceo@rival.com"]),
      PolicyBlockedRecipientError,
    );
    await assert.rejects(
      assertRecipientsPolicyAllowed(companyId, ["ceo@mail.rival.com"]),
      /No competitor mail/,
    );
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      action: "policy.violation",
    });
    assert.equal(audits.length, 2);
  });

  test("a lookalike domain passes — endsWith is anchored on a dot", async () => {
    await addPolicy({ blockedRecipientDomains: "rival.com" });
    await assert.doesNotReject(assertRecipientsPolicyAllowed(companyId, ["ok@notrival.com"]));
  });

  test("a disabled policy blocks nothing, and no policies cost nothing", async () => {
    await addPolicy({ blockedRecipientDomains: "rival.com", enabled: false });
    await assert.doesNotReject(assertRecipientsPolicyAllowed(companyId, ["ceo@rival.com"]));
    await assert.doesNotReject(assertRecipientsPolicyAllowed(testCompanyId(), ["x@rival.com"]));
  });
});

describe("policyForbiddingTool", () => {
  test("resolves the first enabled policy naming the tool, case-insensitively", async () => {
    await addPolicy({ title: "No outbound", forbiddenTools: "SEND_MAIL\ncreate_routine" });
    const policy = await policyForbiddingTool(companyId, "send_mail");
    assert.equal(policy?.title, "No outbound");
    assert.equal(await policyForbiddingTool(companyId, "list_goals"), null);
    await AppDataSource.getRepository(CompanyPolicy).update(
      { companyId },
      { enabled: false },
    );
    assert.equal(await policyForbiddingTool(companyId, "send_mail"), null);
  });
});
