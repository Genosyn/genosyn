import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeMailServers } from "./mailServerSummary.js";

const base = {
  imapHost: "imap.fastmail.com",
  imapPort: "993",
  smtpHost: "smtp.fastmail.com",
  smtpPort: "465",
  username: "",
  email: "owner@fastmail.com",
};

describe("describeMailServers", () => {
  test("names both servers with their ports", () => {
    assert.equal(describeMailServers(base), "imap.fastmail.com:993 · smtp.fastmail.com:465");
  });

  test("adds the login name only when it is not the address", () => {
    assert.equal(
      describeMailServers({ ...base, username: "Owner@Fastmail.com" }),
      "imap.fastmail.com:993 · smtp.fastmail.com:465",
    );
    assert.equal(
      describeMailServers({ ...base, username: "owner" }),
      "imap.fastmail.com:993 · smtp.fastmail.com:465 · login owner",
    );
  });

  test("says when a server is missing, and leaves out an empty port", () => {
    assert.equal(
      describeMailServers({ ...base, imapHost: " ", smtpPort: "" }),
      "No IMAP server · smtp.fastmail.com",
    );
  });
});
