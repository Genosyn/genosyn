import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { chatWithEmployee, type ChatOptions } from "./chat.js";
import { createPrivilegedMemberToolAuthorizer } from "./memberTurnAuthority.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function fixture(role: Role = "admin") {
  const user = await insert(User, {
    email: "admin@authority.example",
    passwordHash: "hash",
    name: "Authority Admin",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Authority Co",
    slug: "authority-co",
    ownerId: user.id,
  });
  const membership = await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role,
  });
  const authorize = createPrivilegedMemberToolAuthorizer({
    companyId: company.id,
    userId: user.id,
    sessionVersion: user.sessionVersion,
  });
  return { authorize, company, membership, user };
}

describe("live privileged Member turn authority", () => {
  test("allows a current owner or admin on every privileged call", async () => {
    for (const role of ["owner", "admin"] as const) {
      await resetTestDb();
      const { authorize } = await fixture(role);
      assert.equal(await authorize(), null);
      assert.equal(await authorize(), null);
    }
  });

  test("revokes and latches when the User auth epoch changes", async () => {
    const { authorize, user } = await fixture();
    assert.equal(await authorize(), null);

    user.sessionVersion += 1;
    await AppDataSource.getRepository(User).save(user);
    assert.match((await authorize()) ?? "", /authentication changed/);

    user.sessionVersion -= 1;
    await AppDataSource.getRepository(User).save(user);
    assert.match((await authorize()) ?? "", /authentication changed/);
  });

  test("revokes and latches administrative tools after demotion", async () => {
    const { authorize, membership } = await fixture();
    membership.role = "member";
    await AppDataSource.getRepository(Membership).save(membership);
    assert.match((await authorize()) ?? "", /no longer an owner or admin/);

    membership.role = "admin";
    await AppDataSource.getRepository(Membership).save(membership);
    assert.match((await authorize()) ?? "", /no longer an owner or admin/);
  });

  test("revokes and latches when company membership is removed", async () => {
    const { authorize, membership } = await fixture();
    await AppDataSource.getRepository(Membership).delete({ id: membership.id });
    assert.match((await authorize()) ?? "", /no longer has access/);

    await AppDataSource.getRepository(Membership).save(membership);
    assert.match((await authorize()) ?? "", /no longer has access/);
  });

  test("fails closed when an interactive Member turn omits or reuses an auth epoch", async () => {
    const { company, user } = await fixture("member");
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Epoch checker",
      slug: "epoch-checker",
      role: "Operations",
      soulBody: "",
    });

    const missingAuthority = { requesterUserId: user.id } as unknown as ChatOptions;
    const missing = await chatWithEmployee(company.id, employee.id, "Hello", [], missingAuthority);
    assert.equal(missing.status, "error");
    assert.match(missing.reply, /company access changed/i);

    const current = await chatWithEmployee(company.id, employee.id, "Hello", [], {
      requesterUserId: user.id,
      requesterSessionVersion: user.sessionVersion,
    });
    assert.equal(current.status, "skipped");
    assert.match(current.reply, /no AI Model connected/i);

    user.sessionVersion += 1;
    await AppDataSource.getRepository(User).save(user);
    const stale = await chatWithEmployee(company.id, employee.id, "Hello", [], {
      requesterUserId: user.id,
      requesterSessionVersion: user.sessionVersion - 1,
    });
    assert.equal(stale.status, "error");
    assert.match(stale.reply, /company access changed/i);
  });
});
