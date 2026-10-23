import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { GroupDiscussion } from "../db/entities/GroupDiscussion.js";
import { Membership } from "../db/entities/Membership.js";
import { Skill } from "../db/entities/Skill.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { askColleague } from "./colleagueConsult.js";
import { COLLABORATION_READ_TOOLS } from "./collaborationScope.js";
import {
  setGroupDiscussionDepsForTests,
  settleGroupDiscussionsForTests,
  startGroupDiscussion,
} from "./groupDiscussions.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { createGroupChat } from "./workspaceChat.js";

/**
 * The real chat seam under a group discussion and a colleague consult, with
 * only the model call itself replaced (`agentRuntime.run`). What these pin is
 * what the model is actually handed: read tools and nothing that acts, no
 * coding or browser, and a prompt that speaks with the employee's own Soul,
 * Skills and Memory without promising tools the turn cannot reach.
 */

let company: Company;
let owner: User;
let ada: AIEmployee;
let ben: AIEmployee;
let tempDir = "";
const originalDataDir = config.dataDir;

type Seen = {
  system: string;
  tools: string[];
  nativeCoding: boolean | undefined;
  maxSteps: number | null | undefined;
};

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-discussion-runtime-"));
  (config as { dataDir: string }).dataDir = tempDir;
});

after(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, { email: "ruth@example.test", name: "Ruth", passwordHash: "x", sessionVersion: 0 });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Head of Product",
    soulBody: "ADA-SOUL: Be decisive.",
  });
  ben = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ben",
    slug: "ben",
    role: "CFO",
    soulBody: "BEN-SOUL: Count everything.",
  });
  for (const e of [ada, ben]) {
    await insert(AIModel, {
      employeeId: e.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
  }
  await insert(Skill, {
    employeeId: ada.id,
    name: "Pricing",
    slug: "pricing",
    body: "ADA-SKILL: Anchor prices to value.",
  });
  await insert(EmployeeMemory, {
    employeeId: ada.id,
    title: "Last price change",
    body: "ADA-MEMORY: The 2025 increase lost 3% of customers.",
  });
});

afterEach(async () => {
  await settleGroupDiscussionsForTests();
  setGroupDiscussionDepsForTests(null);
});

function captureTurns(t: TestContext, replies: string[]): Seen[] {
  const seen: Seen[] = [];
  type Run = typeof agentRuntime.run;
  t.mock.method(agentRuntime, "run", (async (params: Parameters<Run>[0]) => {
    seen.push({
      system: params.system,
      tools: [...params.registry.all.keys()],
      nativeCoding: params.nativeCoding,
      maxSteps: params.maxSteps,
    });
    return { finalText: replies.shift() ?? "PASS", steps: 1, stopReason: "end_turn" };
  }) as unknown as Run);
  return seen;
}

const ALLOWED = new Set<string>([...COLLABORATION_READ_TOOLS, "find_tools", "call_tool"]);

function assertReadOnly(tools: string[]) {
  const extra = tools.filter((name) => !ALLOWED.has(name));
  assert.deepEqual(extra, [], "a talking turn holds read tools only");
  for (const name of [
    "send_mail",
    "send_workspace_message",
    "create_routine",
    "ask_colleague",
    "create_handoff",
    "delegate_parallel_work",
    "bash",
    "write_file",
  ]) {
    assert.equal(tools.includes(name), false, name);
  }
  assert.ok(tools.includes("get_self") || tools.includes("find_tools"), "it can still look things up");
}

describe("a group discussion turn through the real chat seam", () => {
  test("hands the model read tools only, and a prompt in the employee's own voice", async (t) => {
    const seen = captureTurns(t, ["Raise Pro to $49.", "Margins allow it."]);
    setGroupDiscussionDepsForTests({
      pollIntervalMs: 10,
      writeOutcome: async () => ({ ok: false, error: "not under test" }),
    });
    const chat = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: "Pricing",
      employeeIds: [ada.id, ben.id],
      memberUserIds: [],
    });
    const started = await startGroupDiscussion({
      channel: chat,
      requester: { userId: owner.id, sessionVersion: 0 },
      question: "Should we raise the Pro plan to $49?",
      minParticipants: 2,
    });
    await settleGroupDiscussionsForTests();
    const d = await AppDataSource.getRepository(GroupDiscussion).findOneByOrFail({ id: started.id });
    assert.equal(d.turnsTaken, 4, "two rounds: two views, then two passes");
    assert.equal(seen.length, 4);

    for (const turn of seen) {
      assertReadOnly(turn.tools);
      assert.equal(turn.nativeCoding, false, "no coding in a talking turn");
      assert.equal(turn.maxSteps, 8);
      assert.match(turn.system, /## What this turn can do/);
      assert.match(turn.system, /## Group discussion/);
      assert.match(turn.system, /Should we raise the Pro plan to \$49\?/);
      assert.match(turn.system, /## Delegated Member authority/);
      assert.doesNotMatch(turn.system, /\n## Tools\n/, "no briefing for tools it does not have");
    }
    const adaTurn = seen[0];
    assert.match(adaTurn.system, /ADA-SOUL: Be decisive\./);
    assert.match(adaTurn.system, /ADA-SKILL: Anchor prices to value\./);
    assert.match(adaTurn.system, /ADA-MEMORY: The 2025 increase lost 3% of customers\./);
    assert.doesNotMatch(adaTurn.system, /BEN-SOUL/, "nobody speaks with a colleague's Soul");
    const benTurn = seen[1];
    assert.match(benTurn.system, /BEN-SOUL: Count everything\./);
    assert.doesNotMatch(benTurn.system, /ADA-MEMORY|ADA-SKILL/, "nor with a colleague's Memory or Skills");
  });
});

describe("a colleague consult through the real chat seam", () => {
  test("the colleague answers read-only, as itself", async (t) => {
    const seen = captureTurns(t, ["Gross margin is 71%."]);
    const asker = issueMcpToken(ada.id, company.id, { authority: "employee" });
    try {
      const result = await askColleague({
        companyId: company.id,
        asker: ada,
        colleague: ben,
        askerToken: asker,
        askerIsCollaborating: false,
        authority: { kind: "employee" },
        question: "What is our gross margin?",
      });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.answer, "Gross margin is 71%.");
    } finally {
      revokeMcpToken(asker);
    }
    assert.equal(seen.length, 1);
    assertReadOnly(seen[0].tools);
    assert.match(seen[0].system, /## Answering a colleague/);
    assert.match(seen[0].system, /BEN-SOUL: Count everything\./);
    assert.doesNotMatch(seen[0].system, /ADA-SOUL/);
  });
});
