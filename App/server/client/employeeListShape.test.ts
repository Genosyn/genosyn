import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientRoot = path.join(appRoot, "client");

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolutePath);
    const isSource = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
    return entry.isFile() && isSource ? [absolutePath] : [];
  });
}

function relative(absolutePath: string): string {
  return path.relative(appRoot, absolutePath).split(path.sep).join("/");
}

/**
 * `GET /api/companies/:cid/employees` answers with a bare array, and every
 * caller in the client is typed that way. A page that decoded it as
 * `{ employees: [...] }` instead got `undefined`, fell back to `[]`, and
 * rendered an AI Employee picker with no options and no error — which is how
 * Meetings → AI access lost its Grant button. Nothing about that failure is
 * visible at runtime, so the shape is pinned here on both sides.
 */
describe("employees list response shape", () => {
  const route = fs.readFileSync(path.join(appRoot, "server/routes/employees.ts"), "utf8");

  test("the route answers with a bare array, not an object wrapper", () => {
    const listHandler = route.slice(route.indexOf('employeesRouter.get("/", '));
    const body = listHandler.slice(0, listHandler.indexOf("\n});"));

    assert.match(
      body,
      /res\.json\(rows\);/,
      "GET /employees should respond with the bare rows array",
    );
    assert.doesNotMatch(
      body,
      /res\.json\(\{\s*employees/,
      "GET /employees must not start wrapping its array — 30+ client call sites decode it bare",
    );
  });

  test("no client file decodes the endpoint as { employees: … }", () => {
    const callSite = /api\.get<([^>]*)>\(\s*`\/api\/companies\/\$\{[^}]+\}\/employees`/g;
    const offenders: string[] = [];
    let callSiteCount = 0;

    for (const file of sourceFiles(clientRoot)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(callSite)) {
        callSiteCount += 1;
        const generic = match[1];
        // `Employee[] | { employees: Employee[] }` is fine: those call sites
        // narrow with Array.isArray before reading anything.
        if (generic.includes("employees:") && !generic.includes("[] |")) {
          offenders.push(`${relative(file)} → api.get<${generic}>`);
        }
      }
    }

    assert.ok(callSiteCount > 10, `expected to find the call sites, saw ${callSiteCount}`);
    assert.deepEqual(
      offenders,
      [],
      "these files read `.employees` off a response that is a bare array, so their picker is always empty",
    );
  });
});
