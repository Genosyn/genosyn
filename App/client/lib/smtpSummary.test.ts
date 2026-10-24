import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeSmtpAdvanced } from "./smtpSummary.js";

describe("describeSmtpAdvanced", () => {
  test("names the port, the TLS mode and the sender name on the defaults", () => {
    assert.equal(
      describeSmtpAdvanced({ port: "587", secure: false, fromName: "Genosyn" }),
      "Port 587 · TLS by port · From “Genosyn”",
    );
  });

  test("says when implicit TLS is forced and a port was changed", () => {
    assert.equal(
      describeSmtpAdvanced({ port: "2465", secure: true, fromName: "Sunwise Solar" }),
      "Port 2465 · Implicit TLS · From “Sunwise Solar”",
    );
  });

  test("reads a blank port as the default and a blank name as none", () => {
    assert.equal(
      describeSmtpAdvanced({ port: " ", secure: false, fromName: "  " }),
      "Port 587 · TLS by port · No sender name",
    );
  });
});
