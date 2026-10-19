import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addUserOutcome,
  addUserProblem,
  addUserRequest,
  emptyAddUserDraft,
  type AddUserDraft,
} from "./adminAddUser.js";

const ready: AddUserDraft = {
  name: "Grace Hopper",
  email: "grace@example.com",
  signIn: "link",
  password: "",
  companyId: "",
  role: "member",
};

describe("emptyAddUserDraft", () => {
  test("starts in the only company on a single-company install", () => {
    assert.equal(emptyAddUserDraft([{ id: "acme" }]).companyId, "acme");
  });

  test("starts in no company when there is none or a choice to make", () => {
    assert.equal(emptyAddUserDraft([]).companyId, "");
    assert.equal(emptyAddUserDraft([{ id: "a" }, { id: "b" }]).companyId, "");
  });

  test("defaults to a setup link and the Member role", () => {
    const draft = emptyAddUserDraft([]);
    assert.equal(draft.signIn, "link");
    assert.equal(draft.role, "member");
    assert.equal(draft.password, "");
  });
});

describe("addUserProblem", () => {
  test("accepts a complete form", () => {
    assert.equal(addUserProblem(ready), null);
    assert.equal(
      addUserProblem({ ...ready, signIn: "password", password: "twelve chars" }),
      null,
    );
  });

  test("names the first missing piece", () => {
    assert.equal(addUserProblem({ ...ready, name: "  " }), "Enter their name.");
    assert.equal(addUserProblem({ ...ready, email: "grace" }), "Enter a valid email address.");
    assert.equal(addUserProblem({ ...ready, email: "grace@local" }), "Enter a valid email address.");
  });

  test("holds a password the admin sets to the server's minimum", () => {
    assert.match(
      addUserProblem({ ...ready, signIn: "password", password: "eleven char" }) ?? "",
      /at least 12 characters/,
    );
  });

  test("ignores a typed password when the person will choose their own", () => {
    assert.equal(addUserProblem({ ...ready, signIn: "link", password: "x" }), null);
  });
});

describe("addUserRequest", () => {
  test("sends no password for a setup link, even one typed before switching", () => {
    assert.deepEqual(addUserRequest({ ...ready, password: "left over text" }), {
      name: "Grace Hopper",
      email: "grace@example.com",
      password: null,
      companyId: null,
      role: "member",
    });
  });

  test("sends the password, company and role the admin chose, trimmed", () => {
    assert.deepEqual(
      addUserRequest({
        ...ready,
        name: " Grace ",
        email: " grace@example.com ",
        signIn: "password",
        password: " keep spaces ",
        companyId: "acme",
        role: "admin",
      }),
      {
        name: "Grace",
        email: "grace@example.com",
        password: " keep spaces ",
        companyId: "acme",
        role: "admin",
      },
    );
  });
});

describe("addUserOutcome", () => {
  const email = "grace@example.com";
  const link = "https://genosyn.example/reset/token?setup=1";

  test("says the setup link was emailed when it was", () => {
    assert.match(
      addUserOutcome({ setupLink: link, emailStatus: "sent", email }),
      /emailed the setup link to grace@example\.com/,
    );
  });

  test("says nothing was emailed when no transport is set up", () => {
    const outcome = addUserOutcome({ setupLink: link, emailStatus: "skipped", email });
    assert.match(outcome, /No email transport is set up/);
    assert.match(outcome, /yourself/);
  });

  test("says the email failed when it did", () => {
    assert.match(
      addUserOutcome({ setupLink: link, emailStatus: "failed", email }),
      /could not be sent/,
    );
  });

  test("reminds the admin to pass on a password they set", () => {
    assert.match(
      addUserOutcome({ setupLink: null, emailStatus: "sent", email }),
      /Give them the password you set/,
    );
    assert.match(
      addUserOutcome({ setupLink: null, emailStatus: "skipped", email }),
      /Nothing was emailed/,
    );
  });
});
