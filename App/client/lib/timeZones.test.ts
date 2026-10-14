import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FALLBACK_TIME_ZONES,
  browserTimeZone,
  groupTimeZones,
  listTimeZones,
  timeZoneRegion,
} from "./timeZones";

describe("listTimeZones", () => {
  test("offers the browser's database, sorted and without repeats, with UTC", () => {
    const zones = listTimeZones();
    for (const zone of ["Europe/Berlin", "America/New_York", "Asia/Tokyo", "UTC"]) {
      assert.ok(zones.includes(zone), zone);
    }
    assert.deepEqual(
      zones,
      [...zones].sort((a, b) => a.localeCompare(b)),
    );
    assert.equal(new Set(zones).size, zones.length);
  });

  test("keeps a name the browser's own list leaves out, once", () => {
    // The company saved a spelling this browser does not list; the picker must
    // still be able to show it as the current value.
    const zones = listTimeZones(["Europe/Berlin", "Custom/Saved", null, undefined, ""]);
    assert.equal(zones.filter((zone) => zone === "Custom/Saved").length, 1);
    assert.equal(zones.filter((zone) => zone === "Europe/Berlin").length, 1);
    assert.ok(!zones.includes(""));
  });

  test("falls back to a short list of common zones when the browser cannot enumerate", (t) => {
    t.mock.method(Intl, "supportedValuesOf", () => {
      throw new TypeError("Intl.supportedValuesOf is not a function");
    });
    const zones = listTimeZones(["Africa/Accra"]);
    for (const zone of FALLBACK_TIME_ZONES) assert.ok(zones.includes(zone), zone);
    assert.ok(zones.includes("Africa/Accra"), "the company's own zone is still offered");
    assert.ok(zones.length < 100);
    // Everything offered is something the browser can really format in.
    for (const zone of zones) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone);
    }
  });
});

describe("groupTimeZones", () => {
  test("groups by region in order, with UTC and other bare names last", () => {
    const groups = groupTimeZones([
      "UTC",
      "Europe/Berlin",
      "America/Argentina/Buenos_Aires",
      "Asia/Tokyo",
      "America/New_York",
      "Europe/Paris",
      "GMT",
    ]);
    assert.deepEqual(
      groups.map((group) => group.region),
      ["America", "Asia", "Europe", "Other"],
    );
    assert.deepEqual(groups[0].zones, ["America/Argentina/Buenos_Aires", "America/New_York"]);
    assert.deepEqual(groups[2].zones, ["Europe/Berlin", "Europe/Paris"]);
    assert.deepEqual(groups[3].zones, ["UTC", "GMT"]);
  });

  test("names a zone's region by what comes before its first slash", () => {
    assert.equal(timeZoneRegion("America/Argentina/Buenos_Aires"), "America");
    assert.equal(timeZoneRegion("Etc/GMT+5"), "Etc");
    assert.equal(timeZoneRegion("UTC"), "Other");
  });

  test("covers everything the full list offers", () => {
    const zones = listTimeZones();
    const grouped = groupTimeZones(zones).flatMap((group) => group.zones);
    assert.deepEqual([...grouped].sort(), [...zones].sort());
  });
});

describe("browserTimeZone", () => {
  test("is a zone the browser can format in, or null", () => {
    const zone = browserTimeZone();
    if (zone !== null) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }));
    }
  });
});
