import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { findScheduleNode, scheduleNodeCron } from "./index.js";
import type { PipelineGraph, PipelineNode } from "./types.js";

/**
 * The seam between a Pipeline's stored schedule and the node it came from.
 *
 * The failure this exists to stop has no symptom: the heartbeat advances
 * `nextRunAt` for a due pipeline and *then* looks up the Schedule node the
 * stored expression belongs to. When that lookup missed, the slot was consumed,
 * nothing ran, and nothing was logged — the pipeline simply stopped firing.
 */

function node(over: Partial<PipelineNode> & { id: string }): PipelineNode {
  return {
    type: "trigger.schedule",
    label: "Schedule",
    x: 0,
    y: 0,
    config: {},
    ...over,
  } as PipelineNode;
}

function graph(nodes: PipelineNode[]): PipelineGraph {
  return { nodes, edges: [] };
}

describe("scheduleNodeCron", () => {
  test("reads the expression the same way on both sides of the round trip", () => {
    assert.equal(scheduleNodeCron(node({ id: "a", config: { cronExpr: "  0 9 * * 1-5  " } })), "0 9 * * 1-5");
    assert.equal(scheduleNodeCron(node({ id: "a", config: {} })), "");
    assert.equal(scheduleNodeCron(node({ id: "a", config: { cronExpr: "" } })), "");
  });
});

describe("findScheduleNode", () => {
  test("finds the node an exact expression came from", () => {
    const target = node({ id: "sched", config: { cronExpr: "0 9 * * 1-5" } });
    assert.equal(findScheduleNode(graph([target]), "0 9 * * 1-5")?.id, "sched");
  });

  test("survives whitespace the author left in the graph", () => {
    // `syncScheduleFields` trims before storing `Pipeline.cronExpr`; the graph
    // keeps what was typed. Comparing the two spellings directly is what used
    // to silently retire a working pipeline.
    const target = node({ id: "sched", config: { cronExpr: " 0 9 * * 1-5 " } });
    assert.equal(findScheduleNode(graph([target]), "0 9 * * 1-5")?.id, "sched");
    assert.equal(findScheduleNode(graph([target]), " 0 9 * * 1-5 ")?.id, "sched");
  });

  test("picks the schedule node, never another trigger that happens to carry a cron", () => {
    const decoy = node({ id: "hook", type: "trigger.webhook", config: { cronExpr: "0 9 * * 1-5" } });
    const target = node({ id: "sched", config: { cronExpr: "0 9 * * 1-5" } });
    assert.equal(findScheduleNode(graph([decoy, target]), "0 9 * * 1-5")?.id, "sched");
  });

  test("returns null rather than guessing when the schedule has moved on", () => {
    const target = node({ id: "sched", config: { cronExpr: "0 9 * * 1-5" } });
    assert.equal(findScheduleNode(graph([target]), "0 17 * * 5"), null);
    assert.equal(findScheduleNode(graph([target]), null), null);
    assert.equal(findScheduleNode(graph([target]), ""), null);
    assert.equal(findScheduleNode(graph([]), "0 9 * * 1-5"), null);
  });

  test("with two schedules on one pipeline, matches the one that is due", () => {
    const morning = node({ id: "morning", config: { cronExpr: "0 9 * * 1-5" } });
    const evening = node({ id: "evening", config: { cronExpr: "0 17 * * 5" } });
    assert.equal(findScheduleNode(graph([morning, evening]), "0 17 * * 5")?.id, "evening");
  });
});
