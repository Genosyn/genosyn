import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  accessSummary,
  agentsHelp,
  areaHelp,
  BUILTIN_COMMANDS,
  builtinHelp,
  describeOperation,
  environmentHelp,
  exitCodesHelp,
  globalHelp,
  operationHelp,
  topicHelp,
  usageLine,
  wrapText,
} from "./help.js";
import { OperationIndex, type Operation } from "./operations.js";
import { syntheticSpec } from "./test/support.js";

const index = new OperationIndex(syntheticSpec());
const style = { color: false, width: 100 };
const op = (id: string) => index.find(id) as Operation;

describe("global help", () => {
  test("lists every built-in command and the options", () => {
    const text = globalHelp(style);
    for (const command of ["login", "whoami", "profiles", "logout", "areas", "ops", "search", "describe", "call", "spec", "version", "help"]) {
      assert.match(text, new RegExp(`\\n  ${command}\\b`), command);
    }
    assert.match(text, /--json/);
    assert.match(text, /--select <path>/);
    assert.match(text, /help agents/);
    assert.match(text, /Log in, then `genosyn-api areas`/);
  });

  test("lists the install's areas when it knows them", () => {
    const text = globalHelp(style, index, "https://g.test");
    assert.match(text, /Areas on https:\/\/g\.test\n {2}goals, revenue, resources/);
    assert.ok(!/api-keys/.test(text.split("Areas on")[1].split("\n\n")[0]), "areas without key operations are left out");
  });
});

describe("built-in command help", () => {
  test("exists for every built-in command, with usage and global options", () => {
    for (const command of BUILTIN_COMMANDS) {
      const text = builtinHelp(command, style);
      assert.ok(text, command);
      assert.match(text, new RegExp(`genosyn-api ${command}`));
      assert.match(text, /Usage/);
      assert.match(text, /Global options/);
    }
    assert.equal(builtinHelp("nope", style), null);
  });

  test("login explains where the URL and key come from", () => {
    const text = builtinHelp("login", style) as string;
    assert.match(text, /--with-token/);
    assert.match(text, /Settings → API keys/);
    assert.match(text, /shell history/);
  });

  test("call lists the request options", () => {
    const text = builtinHelp("call", style) as string;
    for (const option of ["--data", "--output", "--raw", "--all", "--max-pages", "--dry-run"]) {
      assert.ok(text.includes(option), option);
    }
  });
});

describe("operation help", () => {
  test("shows how to call it, its parameters with types and limits, and its access", () => {
    const text = operationHelp(index, op("createGoal"), style);
    assert.match(text, /^genosyn-api goals create — Create goal/);
    assert.match(text, /POST \/api\/companies\/\{cid\}\/goals/);
    assert.match(text, /operationId createGoal · area Goals/);
    assert.match(text, /genosyn-api goals create --title <string> --target-value <number> \[options\]/);
    assert.match(text, /genosyn-api call createGoal --title <string> --target-value <number>/);
    assert.match(text, /Body \(application\/json, required\)/);
    assert.match(text, /--title <string>\s+required · 1–140 chars — What to achieve\./);
    assert.match(text, /--metric-kind <manual\|chart>/);
    assert.match(text, /--parent-goal-id <string>\s+uuid · nullable/);
    assert.match(text, /--score <integer>\s+0–100/);
    assert.match(text, /API key/);
    assert.match(text, /name:=<json>/);
  });

  test("puts path parameters in the usage line and names them", () => {
    const text = operationHelp(index, op("moveRevenueDealStage"), style);
    assert.match(text, /genosyn-api revenue move-deal-stage <id> <stageId> \[options\]/);
    assert.match(text, /Path\n {2}<id>, --id <string>/);
  });

  test("shows a parameter named like a CLI option as name=value", () => {
    const text = operationHelp(index, op("createResource"), style);
    assert.match(text, /url=<string>\s+required · uri/);
    assert.match(usageLine(index, op("createResource"), "x"), /^x url=<string>$/);
  });

  test("mentions file answers, uploads and paging", () => {
    assert.match(operationHelp(index, op("getResourceFile"), style), /A file \(application\/octet-stream\): save it with --output/);
    assert.match(operationHelp(index, op("uploadResources"), style), /--file <path>/);
    assert.match(operationHelp(index, op("listRevenueDeals"), style), /Pages by offset: --all/);
    assert.match(operationHelp(index, op("listRevenueFollowUps"), style), /Pages by cursor/);
  });

  test("leaves the reference's own access paragraph out of the description", () => {
    const spec = syntheticSpec();
    (spec.paths!["/api/companies/{cid}/goals"].get as Record<string, unknown>).description =
      "Every goal.\n\n**Access.** API key or browser.";
    const text = operationHelp(new OperationIndex(spec), new OperationIndex(spec).find("listGoals")!, style);
    assert.match(text, /Every goal\./);
    assert.ok(!text.includes("**Access.**"));
  });
});

describe("text helpers", () => {
  test("wrapText wraps prose at words, keeps paragraphs, and indents", () => {
    const text = wrapText("one two three four five six\n\nseven", 32, 2);
    assert.equal(text, "  one two three four five six\n\n  seven");
    const narrow = wrapText("alpha beta gamma delta epsilon zeta eta theta iota kappa", 26, 2);
    for (const line of narrow.split("\n")) assert.ok(line.length <= 26, line);
    assert.ok(narrow.split("\n").length > 1);
  });

  test("limits read naturally", () => {
    assert.deepEqual(index.resolver.constraints({ type: "string", minLength: 3, maxLength: 3 }), ["exactly 3 chars"]);
    assert.deepEqual(index.resolver.constraints({ type: "integer", minimum: 1 }), ["at least 1"]);
    assert.deepEqual(index.resolver.constraints({ type: "array", maxItems: 20 }), ["up to 20 items"]);
    assert.deepEqual(index.resolver.constraints({ type: "string", format: "uuid", default: "x" }), ["uuid", 'default: "x"']);
  });
});

describe("access summaries", () => {
  test("say who may call an operation, in words", () => {
    assert.equal(accessSummary(op("listGoals")), "API key");
    assert.equal(accessSummary(op("deleteGoal")), "API key · needs the admin role or above");
    assert.equal(accessSummary(op("setRevenueSettings")), "API key · needs full Finance access");
    assert.match(accessSummary(op("createApiKey")), /^Browser only: an API key can't call this — the App keeps it for a person/);
    assert.equal(accessSummary(op("getHealth")), "Public: anyone may call it; no key is sent.");
    const conditional = { ...op("listGoals"), access: { apiKey: true, browserSessionRequiredTo: ["to assign an AI Employee"] } };
    assert.equal(accessSummary(conditional), "API key · a signed-in browser is needed to assign an AI Employee");
    const admin = { ...op("createApiKey"), access: { apiKey: false, sessionOnly: "masterAdmin" } };
    assert.match(accessSummary(admin), /instance administration/);
  });
});

describe("area help", () => {
  test("lists the area's key operations by command name", () => {
    const text = areaHelp(index, index.area("revenue")!, style);
    assert.match(text, /genosyn-api revenue — Contacts and deals\./);
    assert.match(text, /list-deals\s+GET \/revenue\/deals — List revenue deals/);
    assert.match(text, /move-deal-stage\s+POST/);
  });

  test("hides what a key can't call unless asked, and says so", () => {
    const keys = areaHelp(index, index.area("api-keys")!, style);
    assert.match(keys, /Nothing here takes an API key\./);
    assert.match(keys, /1 more doesn't take a key.*--include-all lists it/);
    const all = areaHelp(index, index.area("api-keys")!, style, true);
    assert.match(all, /create\s+POST \/api-keys — Create API key \(browser only\)/);
    assert.match(areaHelp(index, index.area("system")!, style, true), /\(public\)/);
  });
});

describe("topics", () => {
  test("exit codes list every code and the JSON error shape", () => {
    const text = exitCodesHelp(style);
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.match(text, new RegExp(`\\n  ${code}`));
    assert.match(text, /"kind":"not_found"/);
    assert.match(text, /"issues"/);
  });

  test("environment lists every variable", () => {
    const text = environmentHelp(style);
    for (const name of ["GENOSYN_URL", "GENOSYN_API_KEY", "GENOSYN_COMPANY", "GENOSYN_PROFILE", "GENOSYN_CONFIG", "GENOSYN_CACHE_DIR", "GENOSYN_SPEC_TTL", "GENOSYN_TIMEOUT", "NO_COLOR"]) {
      assert.ok(text.includes(name), name);
    }
  });

  test("agents get the whole loop, without a prompt", () => {
    const text = agentsHelp(style);
    for (const step of ["GENOSYN_API_KEY", "whoami", "search", "describe", "call", "--dry-run", "--all", "exit-codes"]) {
      assert.ok(text.includes(step), step);
    }
  });

  test("topics answer to their short names too", () => {
    assert.equal(topicHelp("exit", style), exitCodesHelp(style));
    assert.equal(topicHelp("env", style), environmentHelp(style));
    assert.equal(topicHelp("agent", style), agentsHelp(style));
    assert.equal(topicHelp("unknown", style), null);
  });
});

describe("describeOperation", () => {
  test("gives an agent everything to build a call", () => {
    const described = describeOperation(index, op("createGoal")) as Record<string, any>;
    assert.equal(described.operationId, "createGoal");
    assert.equal(described.command, "genosyn-api goals create");
    assert.equal(described.usage, "genosyn-api call createGoal --title <string> --target-value <number>");
    assert.equal(described.callable, true);
    assert.equal(described.body.contentType, "application/json");
    assert.equal(described.body.schema.properties.title.maxLength, 140, "references are inlined");
    const title = described.parameters.find((param: { name: string }) => param.name === "title");
    assert.deepEqual(
      { in: title.in, flag: title.flag, item: title.item, type: title.type, required: title.required },
      { in: "body", flag: "--title", item: "title=…", type: "string", required: true },
    );
    assert.deepEqual(title.constraints, ["1–140 chars"]);
    assert.deepEqual(described.response, { status: 201, contentType: "application/json", schema: {} });
    assert.equal(described.pagination, null);
    assert.doesNotThrow(() => JSON.stringify(described));
  });

  test("marks path parameters, files and paging", () => {
    const move = describeOperation(index, op("moveRevenueDealStage")) as Record<string, any>;
    assert.equal(move.parameters[0].positional, true);
    const upload = describeOperation(index, op("uploadResources")) as Record<string, any>;
    assert.equal(upload.parameters.find((param: { name: string }) => param.name === "file").file, true);
    assert.equal((describeOperation(index, op("listRevenueFollowUps")) as Record<string, any>).pagination, "cursor");
  });
});
