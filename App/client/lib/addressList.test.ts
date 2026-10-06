import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { splitAddressList } from "./addressList.js";

describe("splitAddressList", () => {
  test("splits on the commas between recipients and drops blank entries", () => {
    assert.deepEqual(splitAddressList(" a@x.com,b@x.com , ,c@x.com, "), [
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });

  test("keeps a quoted name holding a comma as one recipient, as written", () => {
    assert.deepEqual(splitAddressList('"Doe, Zoë" <doe@x.com>, Bob <bob@x.com>'), [
      '"Doe, Zoë" <doe@x.com>',
      "Bob <bob@x.com>",
    ]);
  });

  test("reads an escaped quote as part of the name", () => {
    assert.deepEqual(splitAddressList('"Ann \\"Q, Jr" <q@x.com>, b@x.com'), [
      '"Ann \\"Q, Jr" <q@x.com>',
      "b@x.com",
    ]);
  });

  test("leaves an unclosed quote as one entry rather than guessing where it ends", () => {
    // One entry the server can refuse whole, rather than a guess that quietly
    // drops whoever was typed after the quote.
    assert.deepEqual(splitAddressList('"Doe <doe@x.com>, bob@x.com'), [
      '"Doe <doe@x.com>, bob@x.com',
    ]);
  });
});
