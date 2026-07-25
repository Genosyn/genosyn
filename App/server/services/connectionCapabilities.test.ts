import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import type { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  MAIL_CAPABILITIES,
  makeConnectionCapabilityGate,
  unrestrictedCapabilityGate,
} from "./connectionCapabilities.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const connection = { id: "connection_mail" } as IntegrationConnection;

describe("mail Connection capability gate", () => {
  test("keeps the public capability ladder explicit", () => {
    assert.deepEqual(MAIL_CAPABILITIES, {
      "mail.read": "read",
      "mail.draft": "draft",
      "mail.send": "send",
    });
  });

  test("fails closed when a provider invents an unknown capability", async () => {
    const gate = makeConnectionCapabilityGate({ connection, employeeId: "employee" });
    await assert.rejects(() => gate("mail.delete_everything"), /Unknown capability/);
  });

  test("passes when the Connection has not been adopted as a Mail account", async () => {
    const gate = makeConnectionCapabilityGate({ connection, employeeId: "employee" });
    await gate("mail.send");
  });

  test("denies an adopted mailbox when the employee has no Grant", async () => {
    await insert(MailAccount, {
      companyId: "company",
      connectionId: connection.id,
      address: "team@example.com",
    });
    const gate = makeConnectionCapabilityGate({ connection, employeeId: "employee" });
    await assert.rejects(() => gate("mail.read"), /No grant.*team@example\.com/);
  });

  test("enforces read < draft < send and allows higher Grants", async () => {
    const account = await insert(MailAccount, {
      companyId: "company",
      connectionId: connection.id,
      address: "team@example.com",
    });
    const grant = await insert(EmployeeMailAccountGrant, {
      employeeId: "employee",
      accountId: account.id,
      accessLevel: "draft",
    });
    const gate = makeConnectionCapabilityGate({ connection, employeeId: "employee" });
    await gate("mail.read");
    await gate("mail.draft");
    await assert.rejects(() => gate("mail.send"), /needs the "send".*yours is "draft"/);

    grant.accessLevel = "send";
    await insert(EmployeeMailAccountGrant, grant);
    await gate("mail.send");
  });

  test("does not accept another employee's Grant", async () => {
    const account = await insert(MailAccount, {
      companyId: "company",
      connectionId: connection.id,
      address: "team@example.com",
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: "somebody_else",
      accountId: account.id,
      accessLevel: "send",
    });
    const gate = makeConnectionCapabilityGate({ connection, employeeId: "employee" });
    await assert.rejects(() => gate("mail.read"), /No grant/);
  });
});

test("the explicit unrestricted gate accepts opaque capabilities", async () => {
  const gate = unrestrictedCapabilityGate();
  await gate("anything");
});
