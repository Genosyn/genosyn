import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { githubProvider } from "./github.js";
import { memoryContinuationStore } from "../../services/integrationContinuations.js";
import { forgetRememberedGithubEvents, listGithubRepositoryActivity } from "./github-activity.js";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; forgetRememberedGithubEvents(); });
const repo = { owner: "acme", repo: "widgets" };
function event(id: string, created_at = "2026-09-20T12:00:00Z", type = "PushEvent", payload: unknown = {}) {
  return { id, type, created_at, actor: { login: "octocat" }, repo: { name: "acme/widgets" }, payload };
}
function json(data: unknown, link?: string) {
  return new Response(JSON.stringify(data), { headers: link ? { link } : {} });
}
function feed(ids: string[]) {
  globalThis.fetch = (async () => json(ids.map((id) => event(id)))) as typeof fetch;
}
function pagedFeed(ids: string[]) {
  const calls: number[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/repos/acme/widgets/events");
    assert.equal(url.searchParams.get("per_page"), "100");
    const page = Number(url.searchParams.get("page"));
    calls.push(page);
    return json(ids.slice((page - 1) * 100, page * 100).map((id) => event(id)),
      page * 100 < ids.length
        ? `<https://api.github.com/repositories/380744866/events?per_page=100&page=${page + 1}>; rel="next"`
        : undefined);
  }) as typeof fetch;
  return calls;
}

// Captured from the old encoder. At character 292, changing 6 to 5 still
// produces valid JSON with unique numeric IDs, but changes 100 snapshot IDs.
const legacyCursorFixture = "gha1.VdcxjxtVAIXR__JqB-6d8dhed5SpoQKlWLyjxCLYK9sJAsR_RwkgHaa7ozejrzrS-3N8Xm_38_Uyjt2MX86Xl3Ecp0-3-_U2NuO2vl7v58f19vs4jufTr-u3v51f3q-P-9iM0_VyWU-P8_Xy9ss3L-fbenqMzbifL6d1HC-fPn7cjE-Xx_njf-P68329fV5fvnuM45gy7d7k6c10-CHLcckx-SbJj2Mzni-nD9fb178-PeXLMydjM15v19N6v68vb1_u4_jTu824X55f7x-uj39e_P_0v2N6enIcHHvHzrE4to7ZMTnqsOBgwcGCgwUHCw4WHCw4WHCw4GDBwYK9BXsL9hbsLdhbsLdgb8Hegr0Fewt2Fuws2Fmws2Bnwc6CnQU7C3YW7CxYLFgsWCxYLFgsWCxYLFgsWCxYLNhasLVga8HWgq0FWwu2Fmwt2FqwtWC2YLZgtmC2YLZgtmC2YLZgtmC2YLJgsmCyYLJgsmCyYLJgsmCyYLKgFtSCWlALakEtqAW1oBbUglgQC2JBLIgFsSAWxIJYoInVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaWE2sJlYTq4nVxGpiNbGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE2MJkYTo4nRxGhiNDGaGE1MpvFuM75e7r_e_edsxuvz-_X78x_rOC5__Q0";
const fixtureIds = Array.from({ length: 299 }, (_, i) => String(9900000300 - i));

function checkedPayload(payload: string) {
  return `gha2.${payload}.${createHash("sha256").update(payload).digest("hex")}`;
}
function checkedState(state: unknown) {
  return checkedPayload(deflateRawSync(Buffer.from(JSON.stringify(state))).toString("base64url"));
}
/** The full checksummed value a short reference stands for. */
async function fullToken(reference: string) {
  assert.match(reference, /^gha3\.[a-f0-9]{20}$/);
  const value = await memoryContinuationStore.load(reference);
  assert.ok(value, "the reference was issued");
  return value;
}
async function legacyToken(reference: string) {
  const value = await fullToken(reference);
  assert.match(value, /^gha2\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  return `gha1.${value.split(".")[1]}`;
}
async function invalidContinuation(args: unknown) {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
  await assert.rejects(listGithubRepositoryActivity(args, "token"), /Invalid GitHub activity continuation/);
  assert.equal(calls, 0, "invalid saved state must be rejected before consulting the retained feed");
}

describe("GitHub activity continuation integrity", () => {
  test("the captured legacy fixture reproduces a valid but corrupted cursor being mistaken for missing events", async () => {
    Date.now = () => Date.parse("2026-09-28T06:20:00Z");
    pagedFeed(fixtureIds);
    const valid = await listGithubRepositoryActivity({ ...repo, per_page: 5, cursor: legacyCursorFixture }, "token");
    assert.deepEqual(valid.eventIds, fixtureIds.slice(30, 35));
    assert.equal(legacyCursorFixture[292], "6");
    const corrupted = `${legacyCursorFixture.slice(0, 292)}5${legacyCursorFixture.slice(293)}`;
    const decoded = JSON.parse(inflateRawSync(Buffer.from(corrupted.slice(5), "base64url")).toString("utf8"));
    assert.equal(decoded.snapshotIds.length, 299);
    assert.equal(new Set(decoded.snapshotIds).size, 299);
    assert.equal(decoded.snapshotIds[30], "9900000570");
    const result = await listGithubRepositoryActivity({ ...repo, per_page: 5, cursor: corrupted }, "token");
    // Backward compatibility cannot add a checksum to a value already saved.
    assert.equal(result.coverage.gap?.reason, "snapshot_events_missing");
    assert.ok(result.coverage.gap.missingEventIds.includes("9900000570"));
    assert.equal(result.coverage.processedBefore, 30);
    assert.deepEqual(result.eventIds, []);
    assert.equal(result.checkpoint, null);
  });

  test("the same valid DEFLATE corruption is rejected before any provider request when a checksum is present", async () => {
    const protectedCursor = checkedPayload(legacyCursorFixture.slice(5));
    const corrupted = `${protectedCursor.slice(0, 292)}5${protectedCursor.slice(293)}`;
    await invalidContinuation({ ...repo, per_page: 5, cursor: corrupted });
  });

  test("new resume cursors, next cursors and completed checkpoints are short references to checksummed values", async () => {
    feed(["3", "2", "1"]);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
    const full = await listGithubRepositoryActivity(repo, "token");
    for (const reference of [first.resumeCursor, first.nextCursor, full.checkpoint]) {
      assert.ok(reference);
      const value = await fullToken(reference);
      const match = value.match(/^gha2\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/);
      assert.ok(match);
      assert.equal(Buffer.from(match[1], "base64url").toString("base64url"), match[1]);
      assert.equal(match[2], createHash("sha256").update(match[1]).digest("hex"));
    }
  });

  for (const kind of ["cursor", "checkpoint"] as const) {
    test(`rejects a one-character mutation anywhere in a newly issued ${kind}`, async () => {
      feed(["3", "2", "1"]);
      const result = await listGithubRepositoryActivity(repo, "token");
      const value = (kind === "cursor" ? result.resumeCursor : result.checkpoint)!;
      let calls = 0;
      globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
      for (let index = 0; index < value.length; index += 1) {
        const replacement = value[index] === "a" ? "b" : "a";
        const changed = value.slice(0, index) + replacement + value.slice(index + 1);
        await assert.rejects(listGithubRepositoryActivity({ ...repo, [kind]: changed }, "token"), /Invalid GitHub activity continuation/);
      }
      assert.equal(calls, 0);
    });
  }

  const payload = legacyCursorFixture.slice(5);
  const protectedFixture = checkedPayload(payload);
  const digest = protectedFixture.split(".")[2];
  const malformed = [
    ["unknown version", protectedFixture.replace("gha2.", "gha3.")],
    ["legacy prefix with a new checksum suffix", protectedFixture.replace("gha2.", "gha1.")],
    ["missing checksum", `gha2.${payload}`],
    ["empty checksum", `gha2.${payload}.`],
    ["short checksum", `gha2.${payload}.${digest.slice(1)}`],
    ["nonhex checksum", `gha2.${payload}.${"g".repeat(64)}`],
    ["noncanonical checksum case", `gha2.${payload}.${digest.toUpperCase()}`],
    ["extra segment", `${protectedFixture}.extra`],
    ["empty payload", `gha2..${digest}`],
    ["padded base64", `gha2.${payload}=.${digest}`],
    ["truncated payload", `gha2.${payload.slice(0, -1)}.${digest}`],
    ["truncated checksum", protectedFixture.slice(0, -1)],
    ["leading whitespace", ` ${protectedFixture}`],
    ["trailing whitespace", `${protectedFixture}\n`],
  ];
  for (const [reason, value] of malformed) {
    test(`rejects ${reason} before inflating or reading GitHub`, async () => {
      await invalidContinuation({ ...repo, per_page: 5, cursor: value });
    });
  }

  test("a valid checksum cannot admit noncanonical base64 or invalid compressed data", async () => {
    // The unused trailing bits in _x are nonzero, although Buffer decodes it
    // to the same byte as canonical _w. Both cases have matching checksums.
    assert.equal(Buffer.from("_x", "base64url").toString("base64url"), "_w");
    for (const encoded of ["_x", "_w", "a"])
      await invalidContinuation({ ...repo, cursor: checkedPayload(encoded) });
  });

  test("a valid checksum does not bypass the decompressed-size bound", async () => {
    const oversized = deflateRawSync(Buffer.from(JSON.stringify({ padding: "x".repeat(65_001) }))).toString("base64url");
    await invalidContinuation({ ...repo, cursor: checkedPayload(oversized) });
  });

  const decodedFixture = JSON.parse(inflateRawSync(Buffer.from(payload, "base64url")).toString("utf8")) as Record<string, unknown>;
  const invalidStates = [
    ["unsupported state version", { version: 2 }],
    ["wrong state kind", { kind: "checkpoint" }],
    ["unknown state field", { untrusted: true }],
    ["invalid observation date", { observedAt: "yesterday" }],
    ["position past snapshot", { position: 300 }],
    ["negative position", { position: -1 }],
    ["empty page size", { pageSize: 0 }],
    ["oversized page", { pageSize: 101 }],
    ["duplicate snapshot ID", { snapshotIds: ["1", "1"], position: 0 }],
    ["duplicate processed and unread ID", { processedIds: [fixtureIds[0]] }],
    ["more than 300 snapshot IDs", { snapshotIds: [...fixtureIds, "extra-1", "extra-2"] }],
    ["more than 300 combined IDs", { processedIds: ["extra-1", "extra-2"] }],
  ] as const;
  for (const [reason, patch] of invalidStates) {
    test(`a valid checksum still rejects ${reason}`, async () => {
      await invalidContinuation({ ...repo, per_page: 5, cursor: checkedState({ ...decodedFixture, ...patch }) });
    });
  }

  test("legacy 300-ID cursors resume partial batches and legacy checkpoints pick up delayed arrivals", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(300 - i));
    const oldestFirst = [...ids].reverse();
    pagedFeed(ids);
    const args = { ...repo, per_page: 100 };
    const first = await listGithubRepositoryActivity(args, "token");
    const partial = await listGithubRepositoryActivity({ ...args, cursor: await legacyToken(first.resumeCursor!), afterEventId: oldestFirst[99] }, "token");
    assert.deepEqual(partial.eventIds, oldestFirst.slice(100, 200));
    assert.equal(partial.coverage.processedBefore, 100);
    assert.match(partial.nextCursor!, /^gha3\./);
    const final = await listGithubRepositoryActivity({ ...args, cursor: await legacyToken(partial.nextCursor!) }, "token");
    assert.deepEqual(final.eventIds, oldestFirst.slice(200));
    assert.equal(final.coverage.snapshotComplete, true);
    assert.match(final.checkpoint!, /^gha3\./);
    pagedFeed([...ids.slice(0, 50), "delayed", ...ids.slice(50, -1)]);
    const next = await listGithubRepositoryActivity({ ...args, checkpoint: await legacyToken(final.checkpoint!) }, "token");
    assert.deepEqual(next.eventIds, ["delayed"]);
    assert.equal(next.coverage.complete, false);
    assert.equal(next.coverage.snapshotComplete, true);
    assert.match(next.checkpoint!, /^gha3\./);
  });

  for (const version of ["legacy", "full", "short"] as const) {
    test(`${version} values retain Connection, repository, filter, page and acknowledgment boundaries`, async () => {
      feed(["4", "3", "2", "1"]);
      const args = { ...repo, per_page: 2, since: "2026-09-19T00:00:00Z", until: "2026-09-21T00:00:00Z" };
      const first = await listGithubRepositoryActivity(args, "token");
      const last = await listGithubRepositoryActivity({ ...args, cursor: first.nextCursor }, "token");
      const convert = async (value: string) =>
        version === "legacy" ? legacyToken(value) : version === "full" ? fullToken(value) : value;
      const cursor = await convert(first.resumeCursor!);
      let calls = 0;
      globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
      for (const kind of ["cursor", "checkpoint"] as const) {
        const value = kind === "cursor" ? cursor : await convert(last.checkpoint!);
        for (const patch of [
          { owner: "other" }, { repo: "other" }, { since: undefined }, { until: undefined },
          { since: "2026-09-18T00:00:00Z" }, { until: "2026-09-22T00:00:00Z" },
        ]) await assert.rejects(listGithubRepositoryActivity({ ...args, ...patch, [kind]: value }, "token"), /scope unchanged/);
        await assert.rejects(listGithubRepositoryActivity({ ...args, [kind]: value }, "token", "other-connection"), /scope unchanged/);
      }
      await assert.rejects(listGithubRepositoryActivity({ ...args, per_page: 3, cursor }, "token"), /scope unchanged/);
      await assert.rejects(listGithubRepositoryActivity({ ...args, cursor, afterEventId: "3" }, "token"), /saved batch/);
      await assert.rejects(listGithubRepositoryActivity({ ...args, checkpoint: cursor }, "token"), /Invalid GitHub activity continuation/);
      assert.equal(calls, 0);
    });
  }
});

describe("GitHub structured activity coverage", () => {
  test("accepts GitHub's numeric repository pagination and resumes all 300 retained events", async () => {
    const input = { owner: "OneUptime", repo: "oneuptime", per_page: 100 };
    const calls: number[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      // GitHub's Link is canonicalized to /repositories/<id>/events, even
      // though the caller used /repos/<owner>/<repo>/events. The numeric URL
      // supplies only the next page number; credentials stay on our own path.
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, "/repos/OneUptime/oneuptime/events");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-secret");
      const page = Number(url.searchParams.get("page"));
      calls.push(page);
      return json(Array.from({ length: 100 }, (_, i) => event(String(300 - (page - 1) * 100 - i))),
        page < 3
          ? `<https://api.github.com/repositories/380744866/events?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/repositories/380744866/events?per_page=100&page=3>; rel="last"`
          : '<https://api.github.com/repositories/380744866/events?per_page=100&page=2>; rel="prev"');
    }) as typeof fetch;

    const first = await listGithubRepositoryActivity(input, "github-secret", "connection");
    assert.deepEqual(first.eventIds, Array.from({ length: 100 }, (_, i) => String(i + 1)));
    assert.deepEqual(calls, [1, 2, 3, 1]);
    assert.equal(first.coverage.scanned, 300);
    assert.equal(first.coverage.retainedFeedAtCapacity, true);
    assert.equal(first.coverage.complete, false);
    assert.equal(first.coverage.snapshotComplete, false);
    assert.ok(first.nextCursor);
    assert.equal(first.checkpoint, null);

    const second = await listGithubRepositoryActivity({ ...input, cursor: first.nextCursor }, "github-secret", "connection");
    assert.deepEqual(second.eventIds, Array.from({ length: 100 }, (_, i) => String(i + 101)));
    assert.equal(second.coverage.processedBefore, 100);
    assert.ok(second.nextCursor);
    const last = await listGithubRepositoryActivity({ ...input, cursor: second.nextCursor }, "github-secret", "connection");
    assert.deepEqual(last.eventIds, Array.from({ length: 100 }, (_, i) => String(i + 201)));
    assert.equal(last.nextCursor, null);
    assert.ok(last.checkpoint);
    assert.equal(last.coverage.snapshotComplete, true);
    assert.equal(last.coverage.complete, false);
    const checkpoint = await listGithubRepositoryActivity({ ...input, checkpoint: last.checkpoint }, "github-secret", "connection");
    assert.deepEqual(checkpoint.eventIds, []);
    assert.equal(checkpoint.coverage.checkpointStatus, "resumed");
    assert.equal(checkpoint.coverage.complete, false);
    assert.deepEqual(calls, Array.from({ length: 4 }, () => [1, 2, 3, 1]).flat());
  });

  test("keeps caller batch size independent of canonical provider pages and resumes a partial batch", async () => {
    const feedIds = Array.from({ length: 203 }, (_, i) => String(203 - i));
    const ids = [...feedIds].reverse();
    const calls = pagedFeed(feedIds);
    const input = { ...repo, per_page: 73 };
    const first = await listGithubRepositoryActivity(input, "token");
    assert.deepEqual(first.eventIds, ids.slice(0, 73));
    assert.equal(first.coverage.scanned, 203);
    assert.equal(first.coverage.retainedFeedAtCapacity, false);
    const partial = await listGithubRepositoryActivity({
      ...input, cursor: first.resumeCursor, afterEventId: ids[27],
    }, "token");
    assert.deepEqual(partial.eventIds, ids.slice(28, 101));
    assert.equal(partial.coverage.processedBefore, 28);
    assert.ok(partial.nextCursor);
    const second = await listGithubRepositoryActivity({ ...input, cursor: first.nextCursor }, "token");
    const replay = await listGithubRepositoryActivity({ ...input, cursor: first.nextCursor }, "token");
    assert.deepEqual(second.eventIds, ids.slice(73, 146));
    assert.deepEqual(replay.eventIds, second.eventIds);
    const last = await listGithubRepositoryActivity({ ...input, cursor: second.nextCursor }, "token");
    assert.deepEqual(last.eventIds, ids.slice(146));
    assert.equal(last.coverage.snapshotComplete, true);
    assert.equal(last.nextCursor, null);
    assert.ok(last.checkpoint);
    assert.deepEqual(calls, Array.from({ length: 5 }, () => [1, 2, 3, 1]).flat());
  });

  test("canonical pagination does not claim recovery of older historical activity", async () => {
    const calls = pagedFeed(Array.from({ length: 300 }, (_, i) => String(300 - i)));
    const result = await listGithubRepositoryActivity({
      ...repo, since: "2026-09-08T00:00:00Z", until: "2026-09-19T00:00:00Z",
    }, "token");
    assert.deepEqual(calls, [1, 2, 3, 1]);
    assert.deepEqual(result.eventIds, []);
    assert.equal(result.coverage.scanned, 300);
    assert.equal(result.coverage.snapshotComplete, true);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.retainedFeedAtCapacity, true);
    assert.equal(result.coverage.oldestScannedAt, "2026-09-20T12:00:00.000Z");
    assert.deepEqual(result.coverage.filters, {
      since: "2026-09-08T00:00:00Z", until: "2026-09-19T00:00:00Z",
    });
    assert.ok(result.checkpoint);
  });

  test("an evicted event this server no longer remembers remains a gap instead of advancing the saved cursor", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(300 - i));
    pagedFeed(ids);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 100 }, "token");
    forgetRememberedGithubEvents(); // as a restart does
    // 101 new events push out the 100 already read and one that was not.
    const arrivals = Array.from({ length: 101 }, (_, i) => String(401 - i));
    pagedFeed([...arrivals, ...ids.slice(0, 199)]);
    const missing = await listGithubRepositoryActivity({ ...repo, per_page: 100, cursor: first.nextCursor }, "token");
    assert.equal(missing.coverage.gap?.reason, "snapshot_events_missing");
    assert.deepEqual(missing.coverage.gap?.missingEventIds, ["101"]);
    assert.deepEqual(missing.eventIds, []);
    assert.equal(missing.resumeCursor, null);
    assert.equal(missing.nextCursor, null);
    assert.equal(missing.checkpoint, null);
  });

  test("uses only the canonical Link's page number and never forwards its path or other parameters", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
      if (url === "https://api.github.com/repos/acme/widgets/events?per_page=100&page=2") {
        return json([event("1")]);
      }
      assert.equal(url, "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1");
      return json([event("2")], '<https://api.github.com/repositories/999/events?per_page=1&page=2&redirect=https%3A%2F%2Fattacker.example&access_token=untrusted>; rel="next"');
    }) as typeof fetch;
    const result = await listGithubRepositoryActivity(repo, "secret");
    assert.deepEqual(result.eventIds, ["1", "2"]);
    assert.deepEqual(calls, [
      "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1",
      "https://api.github.com/repos/acme/widgets/events?per_page=100&page=2",
      "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1",
    ]);
  });

  const invalidLinks = [
    ["foreign host", "https://attacker.example/repositories/380744866/events?per_page=100&page=2"],
    ["lookalike host", "https://api.github.com.attacker.example/repositories/380744866/events?per_page=100&page=2"],
    ["plain HTTP", "http://api.github.com/repositories/380744866/events?per_page=100&page=2"],
    ["different port", "https://api.github.com:444/repositories/380744866/events?per_page=100&page=2"],
    ["different named repository", "https://api.github.com/repos/acme/other/events?per_page=100&page=2"],
    ["different repository owner", "https://api.github.com/repos/other/widgets/events?per_page=100&page=2"],
    ["different resource", "https://api.github.com/repositories/380744866/issues?per_page=100&page=2"],
    ["missing repository ID", "https://api.github.com/repositories//events?per_page=100&page=2"],
    ["nonnumeric repository ID", "https://api.github.com/repositories/other/events?per_page=100&page=2"],
    ["negative repository ID", "https://api.github.com/repositories/-1/events?per_page=100&page=2"],
    ["extra route segment", "https://api.github.com/repositories/380744866/events/other?per_page=100&page=2"],
    ["encoded path separator", "https://api.github.com/repositories/380744866%2Fevents?per_page=100&page=2"],
    ["repeated page", "https://api.github.com/repositories/380744866/events?per_page=100&page=1"],
    ["skipped page", "https://api.github.com/repositories/380744866/events?per_page=100&page=3"],
    ["page past retention bound", "https://api.github.com/repositories/380744866/events?per_page=100&page=4"],
    ["fractional page", "https://api.github.com/repositories/380744866/events?per_page=100&page=2.5"],
    ["nonnumeric page", "https://api.github.com/repositories/380744866/events?per_page=100&page=second"],
    ["missing page", "https://api.github.com/repositories/380744866/events?per_page=100"],
  ];
  for (const [reason, target] of invalidLinks) {
    test(`rejects ${reason} in a canonical continuation before making another request`, async () => {
      let calls = 0;
      globalThis.fetch = (async (input, init) => {
        calls += 1;
        assert.equal(String(input), "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
        return json([event("1")], `<${target}>; rel="next"`);
      }) as typeof fetch;
      await assert.rejects(listGithubRepositoryActivity(repo, "secret"), /invalid activity continuation/);
      assert.equal(calls, 1);
    });
  }

  test("refuses a fourth provider page without acknowledging any of the collected activity", async () => {
    const calls = pagedFeed(Array.from({ length: 400 }, (_, i) => String(400 - i)));
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /invalid activity continuation/);
    assert.deepEqual(calls, [1, 2, 3]);
  });

  test("uses the existing Connection token and keeps event detail bounded with source links", async () => {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-secret");
      assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2022-11-28");
      assert.equal(init?.method, "GET");
      return json([
        event("3", undefined, "PullRequestReviewEvent", {
          action: "submitted", pull_request: { number: 12, title: "Ship", html_url: "https://github.com/acme/widgets/pull/12", body: "x".repeat(100_000) },
          review: { id: 1, state: "approved", body: "x".repeat(100_000) },
        }),
        event("2", undefined, "PushEvent", { head: "abc", before: "def", ref: "refs/heads/main", commits: [{ message: "x".repeat(100_000) }] }),
      ]);
    }) as typeof fetch;
    const result = await githubProvider.invokeTool("list_repository_activity", repo, {
      authMode: "apikey", config: { apiKey: "github-secret" }, companyId: "co", connectionId: "conn",
    }) as Awaited<ReturnType<typeof listGithubRepositoryActivity>>;
    assert.equal(result.events[1].pull_request?.number, 12);
    assert.equal(result.events[1].review?.state, "approved");
    assert.equal(result.events[0].head, "abc");
    assert.ok(JSON.stringify(result).length < 5000);
    assert.deepEqual(result.eventIds, ["2", "3"]);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.snapshotComplete, true);
    assert.ok(result.checkpoint);
    assert.equal(result.coverage.maximumDelaySeconds, 21600);
  });

  test("resumes stable IDs despite newly prepended events and checkpoints delayed arrivals without duplicates", async () => {
    feed(["3", "2", "1"]);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
    assert.deepEqual(first.eventIds, ["1"]);
    assert.ok(first.nextCursor);
    feed(["4", "3", "2", "1"]);
    const second = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
    assert.deepEqual(second.eventIds, ["2"]);
    const replay = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
    assert.deepEqual(replay.eventIds, second.eventIds);
    const last = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: second.nextCursor }, "token");
    assert.deepEqual(last.eventIds, ["3"]);
    assert.ok(last.checkpoint);
    assert.equal(last.coverage.snapshotComplete, true);
    // A newly visible event can have an older timestamp/position than the checkpoint anchor.
    feed(["5", "4", "3", "2", "late", "1"]);
    const nextScan = await listGithubRepositoryActivity({ ...repo, checkpoint: last.checkpoint }, "token");
    assert.deepEqual(nextScan.eventIds, ["late", "4", "5"]);
    assert.equal(nextScan.coverage.checkpointStatus, "resumed");
    const unchanged = await listGithubRepositoryActivity({ ...repo, checkpoint: nextScan.checkpoint }, "token");
    assert.deepEqual(unchanged.eventIds, []);
    assert.ok(unchanged.checkpoint);
  });

  test("missing snapshot IDs and evicted checkpoint anchors report gaps without advancing progress", async () => {
    feed(["3", "2", "1"]);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
    forgetRememberedGithubEvents(); // as a restart does
    feed(["3", "1"]);
    const missing = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
    assert.equal(missing.coverage.gap?.reason, "snapshot_events_missing");
    assert.deepEqual(missing.coverage.gap?.missingEventIds, ["2"]);
    assert.deepEqual(missing.events, []);
    assert.equal(missing.nextCursor, null);
    assert.equal(missing.checkpoint, null);
    feed(["3", "2", "1"]);
    const initial = await listGithubRepositoryActivity(repo, "token");
    feed(["6", "5", "4"]);
    const evicted = await listGithubRepositoryActivity({ ...repo, checkpoint: initial.checkpoint }, "token");
    assert.equal(evicted.coverage.gap?.reason, "checkpoint_anchor_missing");
    assert.equal(evicted.checkpoint, null);
  });

  test("resumes halfway through a batch from the last recorded processed event", async () => {
    feed(["4", "3", "2", "1"]);
    const batch = await listGithubRepositoryActivity({ ...repo, per_page: 2 }, "token");
    assert.deepEqual(batch.eventIds, ["1", "2"]);
    feed(["5", "4", "3", "2", "1"]);
    const resumed = await listGithubRepositoryActivity({ ...repo, per_page: 2, cursor: batch.resumeCursor, afterEventId: "1" }, "token");
    assert.deepEqual(resumed.eventIds, ["2", "3"]);
    assert.equal(resumed.coverage.processedBefore, 1);
    await assert.rejects(listGithubRepositoryActivity({ ...repo, per_page: 2, cursor: batch.resumeCursor, afterEventId: "4" }, "token"), /saved batch/);
  });

  test("an expired checkpoint reports retention loss even when its anchor is still present", async () => {
    feed(["1"]);
    const first = await listGithubRepositoryActivity(repo, "token");
    Date.now = () => originalNow() + 31 * 86_400_000;
    const expired = await listGithubRepositoryActivity({ ...repo, checkpoint: first.checkpoint }, "token");
    assert.equal(expired.coverage.gap?.reason, "checkpoint_expired");
    assert.deepEqual(expired.events, []);
  });

  test("an initially empty checkpoint cannot claim continuity when the feed reaches its retention cap", async () => {
    feed([]);
    const empty = await listGithubRepositoryActivity(repo, "token");
    globalThis.fetch = (async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return json(Array.from({ length: 100 }, (_, i) => event(String(300 - (page - 1) * 100 - i))),
        page < 3 ? `<https://api.github.com/repos/acme/widgets/events?per_page=100&page=${page + 1}>; rel="next"` : undefined);
    }) as typeof fetch;
    const capped = await listGithubRepositoryActivity({ ...repo, checkpoint: empty.checkpoint }, "token");
    assert.equal(capped.coverage.gap?.reason, "unanchored_feed_at_capacity");
    assert.equal(capped.coverage.retainedFeedAtCapacity, true);
    assert.equal(capped.checkpoint, null);
  });

  test("date filters bind a checkpoint's scope and empty feeds retain honest coverage", async () => {
    feed([]);
    const empty = await listGithubRepositoryActivity(repo, "token");
    assert.equal(empty.coverage.complete, false);
    assert.equal(empty.coverage.newestScannedAt, null);
    globalThis.fetch = (async () => json([event("1", "2026-09-19T12:00:00Z", "FutureEvent", { action: "published" })])) as typeof fetch;
    const args = { ...repo, since: "2026-09-19T00:00:00Z", until: "2026-09-20T00:00:00Z" };
    const first = await listGithubRepositoryActivity(args, "token");
    assert.equal(first.events[0].type, "FutureEvent");
    assert.equal(first.events[0].action, "published");
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity({ ...repo, checkpoint: first.checkpoint }, "token"), /scope unchanged/);
    await assert.rejects(listGithubRepositoryActivity({ ...args, owner: "other", checkpoint: first.checkpoint }, "token"), /scope unchanged/);
    await assert.rejects(listGithubRepositoryActivity({ ...args, checkpoint: first.checkpoint }, "token", "other-connection"), /scope unchanged/);
    assert.equal(calls, 0);
  });

  test("restarts a scan if the feed shifts while collecting provider pages", async () => {
    let firstPageCalls = 0;
    globalThis.fetch = (async (input) => {
      const page = new URL(String(input)).searchParams.get("page");
      if (page === "2") return json([event("1")]);
      firstPageCalls += 1;
      return json((firstPageCalls === 1 ? ["3", "2"] : ["4", "3", "2"]).map((id) => event(id)),
        '<https://api.github.com/repos/acme/widgets/events?per_page=100&page=2>; rel="next"');
    }) as typeof fetch;
    const result = await listGithubRepositoryActivity(repo, "token");
    assert.deepEqual(result.eventIds, ["1", "2", "3", "4"]);
    assert.equal(firstPageCalls, 4);
    assert.equal(result.coverage.atomicProviderSnapshot, false);
  });

  test("rejects invalid arguments, untrusted continuation URLs and malformed provider data", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity({ ...repo, owner: ".." }, "token"), /must not/);
    await assert.rejects(listGithubRepositoryActivity({ ...repo, since: "yesterday" }, "token"));
    await assert.rejects(listGithubRepositoryActivity({ ...repo, cursor: "bad" }, "token"), /Invalid GitHub activity continuation/);
    assert.equal(calls, 0);
    globalThis.fetch = (async () => json({ message: "unexpected" })) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /coverage could not be established/);
    globalThis.fetch = (async () => json([event("1", "invalid")])) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /coverage could not be established/);
    globalThis.fetch = (async () => json([], '<https://attacker.example/events?page=2>; rel="next"')) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /invalid activity continuation/);
  });
});

// 2026-10-03: a daily GitHub Routine on a self-hosted model never finished a
// scan of OneUptime's feed, which sat at GitHub's 300-event cap. New events
// pushed the oldest out while the Run read from the newest end, so the tail of
// its snapshot vanished before it got there and the gap stopped the scan.
test("a scan of a busy feed at capacity finishes while new events push old ones out", async () => {
  let newest = 300;
  let ids = Array.from({ length: 300 }, (_, i) => String(newest - i));
  globalThis.fetch = (async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    return json(ids.slice((page - 1) * 100, page * 100).map((id) => event(id)),
      page * 100 < ids.length
        ? `<https://api.github.com/repositories/380744866/events?per_page=100&page=${page + 1}>; rel="next"`
        : undefined);
  }) as typeof fetch;
  const arrive = (count: number) => {
    const fresh = Array.from({ length: count }, (_, i) => String(newest + count - i));
    newest += count;
    ids = [...fresh, ...ids].slice(0, 300);
  };
  const read: string[] = [];
  let result = await listGithubRepositoryActivity({ ...repo, per_page: 50 }, "token");
  assert.deepEqual(result.eventIds.slice(0, 3), ["1", "2", "3"], "the events about to leave come first");
  read.push(...result.eventIds);
  while (result.nextCursor) {
    arrive(20);
    result = await listGithubRepositoryActivity({ ...repo, per_page: 50, cursor: result.nextCursor }, "token");
    assert.equal(result.coverage.gap, null);
    read.push(...result.eventIds);
  }
  assert.ok(result.checkpoint, "the scan completed");
  assert.deepEqual(read, Array.from({ length: 300 }, (_, i) => String(i + 1)));
  // The events that arrived meanwhile are the next scan's.
  const next = await listGithubRepositoryActivity({ ...repo, per_page: 100, checkpoint: result.checkpoint }, "token");
  assert.equal(next.coverage.gap, null);
  assert.deepEqual(next.eventIds, Array.from({ length: 100 }, (_, i) => String(i + 301)));
});

// The same morning a five-event-per-page scan still lost events: a burst of new
// activity pushed out the next unread ones before the Run reached them.
test("a scan returns an event this server read before GitHub's feed dropped it", async () => {
  feed(["3", "2", "1"]);
  const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
  assert.deepEqual(first.eventIds, ["1"]);
  // A burst of activity pushes "2" and "1" out of the feed.
  feed(["6", "5", "4", "3"]);
  const second = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
  assert.equal(second.coverage.gap, null);
  assert.deepEqual(second.eventIds, ["2"]);
  assert.equal(second.events[0].id, "2");
  assert.equal(second.events[0].actor, "octocat");
  assert.equal(second.coverage.rememberedEvents, 1);
  const last = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: second.nextCursor }, "token");
  assert.deepEqual(last.eventIds, ["3"]);
  assert.equal(last.coverage.rememberedEvents, 0);
  assert.ok(last.checkpoint, "the scan completed");
  // Another Connection's scan of the same repository never uses this one's copies.
  feed(["3", "2", "1"]);
  const elsewhere = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token", "other-connection");
  forgetRememberedGithubEvents(); // as a restart does
  await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
  feed(["6", "5", "4", "3"]);
  const gap = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: elsewhere.nextCursor }, "token", "other-connection");
  assert.equal(gap.coverage.gap?.reason, "snapshot_events_missing");
});

// 2026-10-03: a self-hosted model copied a 300-ID cursor wrong after a dozen
// pages; the checksum rejected it, and the Run lost its whole scan.
describe("short continuation references", () => {
  test("a scan's cursors stay short however many events it holds", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(9_900_000_300 - i));
    pagedFeed(ids);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 50 }, "token");
    assert.match(first.nextCursor!, /^gha3\.[a-f0-9]{20}$/);
    assert.ok((await fullToken(first.nextCursor!)).length > 1000, "the value it stands for is long");
    const second = await listGithubRepositoryActivity({ ...repo, per_page: 50, cursor: first.nextCursor }, "token");
    assert.deepEqual(second.eventIds, [...ids].reverse().slice(50, 100));
    assert.equal(second.nextCursor!.length, 25);
  });

  test("a reference this server never issued is rejected before reading GitHub", async () => {
    await invalidContinuation({ ...repo, cursor: `gha3.${"0".repeat(20)}` });
    await invalidContinuation({ ...repo, checkpoint: `gha3.${"0".repeat(20)}` });
    await invalidContinuation({ ...repo, cursor: `gha3.${"0".repeat(19)}` });
  });

  test("a stored value that does not match its reference is rejected", async () => {
    feed(["3", "2", "1"]);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
    const other = await listGithubRepositoryActivity({ ...repo, per_page: 2 }, "token");
    const forged = `gha3.${"f".repeat(20)}`;
    await memoryContinuationStore.save(forged, await fullToken(other.nextCursor!), "direct");
    await invalidContinuation({ ...repo, per_page: 1, cursor: forged });
    // The genuine reference still works.
    feed(["3", "2", "1"]);
    const resumed = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
    assert.deepEqual(resumed.eventIds, ["2"]);
  });

  test("a full value saved before short references still resumes", async () => {
    feed(["3", "2", "1"]);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
    const resumed = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: await fullToken(first.nextCursor!) }, "token");
    assert.deepEqual(resumed.eventIds, ["2"]);
    assert.match(resumed.nextCursor!, /^gha3\./);
  });
});
