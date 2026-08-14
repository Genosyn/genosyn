import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { composeUntrustedChatSystemPrompt, resolveInteractiveChatContextAccess } from "./chat.js";

describe("interactive chat prompt authority", () => {
  test("an untrusted surface receives no company-derived context", () => {
    const access = resolveInteractiveChatContextAccess(null, "untrusted");

    assert.deepEqual(access, {
      soulAndSkills: false,
      memory: false,
      repositories: false,
      finance: false,
      signing: false,
      revenue: false,
      marketing: false,
      extraSystem: false,
      taggedReferences: false,
      privilegedToolSources: false,
    });

    const briefing = composeUntrustedChatSystemPrompt();
    assert.match(briefing, /not linked to an authenticated Genosyn Member/);
    assert.match(briefing, /Answer only from the current conversation/);
    assert.doesNotMatch(briefing, /## Soul|## Skill|## Memory|## Finance|## Revenue/);
  });

  test("a regular Member receives human-readable context but no unprovenanced sources", () => {
    const access = resolveInteractiveChatContextAccess(
      { role: "member", financeAccess: "none" },
      undefined,
    );

    assert.equal(access.soulAndSkills, true);
    assert.equal(access.signing, true);
    assert.equal(access.revenue, true);
    assert.equal(access.marketing, true);
    assert.equal(access.finance, false);
    assert.equal(access.memory, false);
    assert.equal(access.repositories, false);
    assert.equal(access.privilegedToolSources, false);
  });

  test("administrative Members and employee automation retain their intended authority", () => {
    const admin = resolveInteractiveChatContextAccess(
      { role: "admin", financeAccess: "none" },
      undefined,
    );
    const automation = resolveInteractiveChatContextAccess(null, "employee");

    assert.equal(Object.values(admin).every(Boolean), true);
    assert.equal(Object.values(automation).every(Boolean), true);
  });
});
