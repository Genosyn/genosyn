import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { employeeSettingsPage } from "./employeeSettingsNav";

describe("employeeSettingsPage", () => {
  test("reads the pane from an employee's Settings URL", () => {
    assert.equal(
      employeeSettingsPage("/c/acme/employees/ada/settings/memory", "acme", "ada"),
      "memory",
    );
    assert.equal(
      employeeSettingsPage("/c/acme/employees/ada/settings/general", "acme", "ada"),
      "general",
    );
    assert.equal(employeeSettingsPage("/c/acme/employees/ada/settings/mcp/", "acme", "ada"), "mcp");
  });

  test("is null away from a pane", () => {
    assert.equal(employeeSettingsPage("/c/acme/employees/ada/settings", "acme", "ada"), null);
    assert.equal(employeeSettingsPage("/c/acme/employees/ada/settings/", "acme", "ada"), null);
    assert.equal(employeeSettingsPage("/c/acme/employees/ada/chat", "acme", "ada"), null);
    assert.equal(employeeSettingsPage("/c/acme/employees", "acme", "ada"), null);
  });

  test("does not mistake another employee, company or section for this one", () => {
    assert.equal(
      employeeSettingsPage("/c/acme/employees/ada-lovelace/settings/memory", "acme", "ada"),
      null,
    );
    assert.equal(
      employeeSettingsPage("/c/other/employees/ada/settings/memory", "acme", "ada"),
      null,
    );
    assert.equal(employeeSettingsPage("/c/acme/settings/memory", "acme", "ada"), null);
  });

  test("survives slugs that are called settings", () => {
    // Searching the pathname for "/settings/" would stop at the employee.
    assert.equal(
      employeeSettingsPage("/c/settings/employees/settings/settings/mcp", "settings", "settings"),
      "mcp",
    );
    assert.equal(
      employeeSettingsPage("/c/acme/employees/settings/settings/journal", "acme", "settings"),
      "journal",
    );
    assert.equal(employeeSettingsPage("/c/acme/employees/settings/chat", "acme", "settings"), null);
  });
});
