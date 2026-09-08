import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundProactiveOpportunities,
  PROACTIVE_PACKET_MAX_CHARS,
  type ProactiveOpportunitySection,
} from "./opportunities.js";

test("the work snapshot preserves complete row identities and reports omitted evidence", () => {
  const sections: Record<string, ProactiveOpportunitySection> = {};
  for (let area = 0; area < 20; area++) {
    sections[`area${area}`] = {
      truncated: false,
      items: Array.from({ length: 5 }, (_, index) => ({
        id: `${area}-${index}`,
        kind: "record",
        title: "\u0000".repeat(500),
        reason: "\u0001".repeat(500),
        updatedAt: "2026-09-08T12:00:00.000Z",
        dueAt: "2026-09-09T12:00:00.000Z",
        tools: ["get_record"],
      })),
    };
  }
  const packet = { sections, asOf: "2026-09-08T12:00:00.000Z" };
  const result = boundProactiveOpportunities(packet);
  assert.ok(JSON.stringify(result, null, 2).length <= PROACTIVE_PACKET_MAX_CHARS);
  assert.equal(Object.keys(result.sections).length, 20);
  assert.ok(Object.values(result.sections).some((section) => section.truncated));
  for (const section of Object.values(result.sections))
    for (const item of section.items) {
      assert.match(item.id, /^\d+-\d$/);
      assert.equal(item.updatedAt, packet.asOf);
      assert.deepEqual(item.tools, ["get_record"]);
    }
  assert.equal(packet.sections.area0.items[0].title.length, 500, "source packet is never mutated");
});

test("empty and already bounded work snapshots keep source availability and truncation intact", () => {
  const packet = {
    sections: { granted: { items: [], truncated: false }, more: { items: [], truncated: true } },
  };
  assert.deepEqual(boundProactiveOpportunities(packet), packet);
  assert.throws(
    () => boundProactiveOpportunities({ sections: {}, unexpected: "x".repeat(8_000) }),
    /metadata exceeds/,
  );
});
