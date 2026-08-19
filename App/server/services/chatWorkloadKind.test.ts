import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Company } from "../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { workloadKindForTurn } from "./chat.js";
import { acquireWorkloadLease, releaseWorkloadLease } from "./workloadLeases.js";

/**
 * Which workload slot a chat-seam turn takes, and why it matters.
 *
 * The interesting case is a Repository work session started from chat: the
 * conversation that called `start_repository_work_session` is still holding
 * the employee's chat lease when the session begins. If the session asked for
 * a second chat lease it would be refused every time, and the Member would get
 * a `failed` session whose stated reason was that the employee was busy with
 * the conversation that started it. So the pairing asserted here — session
 * turns take a `routine` slot — is load-bearing, not cosmetic.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

describe("the workload slot a chat-seam turn takes", () => {
  test("an ordinary chat turn takes the chat slot", () => {
    assert.equal(workloadKindForTurn({}), "chat");
    assert.equal(workloadKindForTurn({ repositoryWorkSessionId: null }), "chat");
  });

  test("a Repository work session does not take the employee's chat slot", () => {
    assert.equal(workloadKindForTurn({ repositoryWorkSessionId: "session_1" }), "routine");
  });

  test("so a session can start while the conversation that asked for it is mid-turn", async () => {
    const co = await insert(Company, {
      name: "Acme",
      slug: "acme",
      ownerId: "owner_1",
    });

    // The chat turn running `start_repository_work_session` right now.
    const conversation = await acquireWorkloadLease(
      co.id,
      "employee_1",
      workloadKindForTurn({}),
      60_000,
    );

    // The session it starts must not be refused by that lease.
    const session = await acquireWorkloadLease(
      co.id,
      "employee_1",
      workloadKindForTurn({ repositoryWorkSessionId: "session_1" }),
      60_000,
    );

    assert.equal(session.kind, "routine");
    await releaseWorkloadLease(session);
    await releaseWorkloadLease(conversation);
  });
});
