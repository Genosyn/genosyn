import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { activeSection } from "../../client/lib/sections.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

/**
 * The AI Employee page is Chat plus Settings and nothing else. That is a
 * product decision people keep re-litigating by adding "just one more" entry
 * beside Chat, so it is pinned here: the surfaces that used to be sidebar
 * entries stay children of `settings`, the URLs they used to answer on keep
 * redirecting, and no rail grows back.
 *
 * These are source-scanning assertions in the `server/client/` house style —
 * there is no React renderer in this repo.
 */
const MOVED_TO_SETTINGS = ["journal", "handoffs", "memory", "connections", "mcp"] as const;

describe("employee page navigation", () => {
  test("nests every relocated surface under the settings route", () => {
    const app = readAppFile("client/App.tsx");
    const settingsBlock = app.match(
      /<Route path="settings" element={<SettingsPage \/>}>(?<body>[\s\S]*?)<\/Route>/,
    )?.groups?.body;

    assert.ok(settingsBlock, "client/App.tsx must declare the employee settings route");

    for (const tab of MOVED_TO_SETTINGS) {
      assert.match(
        settingsBlock,
        new RegExp(`<Route path="${tab}"`),
        `${tab} must be a child of the employee settings route`,
      );
    }
  });

  test("leaves Chat as the only employee route beside Settings", () => {
    const app = readAppFile("client/App.tsx");
    const employeeBlock = app.match(
      /path="employees\/:empSlug"[\s\S]*?<Route index element={<Navigate to="chat" replace \/>} \/>(?<body>[\s\S]*?)\n {10}<\/Route>/,
    )?.groups?.body;

    assert.ok(employeeBlock, "client/App.tsx must declare the selected-employee route");

    const directChildren = [...employeeBlock.matchAll(/^ {12}<Route path="(?<path>[a-z]+)"/gm)].map(
      (match) => match.groups!.path,
    );
    assert.deepEqual(directChildren, ["chat", "settings"]);
  });

  test("keeps the old per-employee URLs answering", () => {
    const app = readAppFile("client/App.tsx");

    for (const tab of MOVED_TO_SETTINGS) {
      assert.match(
        app,
        new RegExp(`"${tab}",`),
        `${tab} must stay in EMPLOYEE_SETTINGS_MOVED so its legacy URL redirects`,
      );
    }
    assert.match(app, /employees\/:empSlug\/\$\{tab\}/);
    assert.match(app, /employees\/\$\{empSlug\}\/settings\/\$\{tab\}/);
    // Skills and Routines left the sub-nav earlier and keep their own redirects.
    assert.match(app, /path="employees\/:empSlug\/routines"/);
    assert.match(app, /path="employees\/:empSlug\/skills"/);
  });

  test("does not grow the employee sidebar back", () => {
    const layout = readAppFile("client/pages/EmployeeLayout.tsx");

    assert.doesNotMatch(layout, /SidebarLink/);
    assert.doesNotMatch(layout, /sidebar=/);
    // ContextualLayout hands every product section a free "Integrations" rail
    // entry; opting out is what keeps this page rail-free.
    assert.match(layout, /integrations={false}/);
  });

  test("routes both employee surfaces through one shared header", () => {
    for (const file of ["client/pages/EmployeeLayout.tsx", "client/pages/EmployeeChat.tsx"]) {
      assert.match(readAppFile(file), /<EmployeeHeader\b/, `${file} must render EmployeeHeader`);
    }

    const header = readAppFile("client/components/EmployeeHeader.tsx");
    assert.match(header, /\$\{base\}\/chat/);
    assert.match(header, /\$\{base\}\/settings/);
  });

  test("keeps deep links pointing at the surfaces' new home", () => {
    const callers: [string, RegExp][] = [
      ["client/pages/Inbox.tsx", /employees\/\$\{g\.employee\.slug\}\/settings\/journal/],
      ["client/pages/EmployeeChat.tsx", /employees\/\$\{employeeSlug\}\/settings\/journal/],
      [
        "client/pages/RepositoryAccess.tsx",
        /employees\/\$\{grant\.employee\.slug\}\/settings\/connections/,
      ],
    ];

    for (const [file, expected] of callers) {
      assert.match(readAppFile(file), expected, `${file} must link to the relocated route`);
    }
  });

  test("still resolves relocated URLs to the Employees section", () => {
    // sections.ts tests `/employees` before `/settings`, which is what stops
    // `.../employees/ada/settings/journal` lighting up the company Settings pill.
    assert.equal(activeSection("/c/acme/employees/ada/settings/journal"), "employees");
    assert.equal(activeSection("/c/acme/employees/ada/settings/mcp"), "employees");
    assert.equal(activeSection("/c/acme/employees/ada/chat"), "employees");
  });
});
