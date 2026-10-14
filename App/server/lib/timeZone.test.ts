import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TIME_ZONE_LENGTH, isValidTimeZone } from "./timeZone.js";

test("accepts the zone names a browser or an operator would send", () => {
  for (const zone of [
    "UTC",
    "Europe/Berlin",
    "America/New_York",
    "America/Argentina/Buenos_Aires",
    "America/Port-au-Prince",
    "Asia/Kolkata",
    // The legacy spelling Chrome and Firefox still report for the same place.
    "Asia/Calcutta",
    "Etc/GMT+5",
    "Pacific/Auckland",
  ]) {
    assert.equal(isValidTimeZone(zone), true, zone);
  }
});

test("rejects names this runtime cannot schedule in", () => {
  for (const zone of [
    "",
    "Mars/Base",
    "Europe/Atlantis",
    "Not a zone",
    // A fixed offset has no daylight saving and reads like a typo for a zone.
    "+01:00",
    "UTC+3",
    // Words other libraries treat as aliases for "the machine's own zone".
    "local",
    "system",
    "default",
    "Europe/Berlin\n",
    " Europe/Berlin",
    "Europe//Berlin",
    "Europe/Berlin/",
    "../Europe/Berlin",
    "x".repeat(MAX_TIME_ZONE_LENGTH + 1),
  ]) {
    assert.equal(isValidTimeZone(zone), false, JSON.stringify(zone));
  }
});

test("rejects anything that is not text", () => {
  for (const value of [undefined, null, 0, 1, true, {}, [], ["Europe/Berlin"]]) {
    assert.equal(isValidTimeZone(value), false, JSON.stringify(value));
  }
});

test("answers the same way the second time", () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(isValidTimeZone("Europe/Berlin"), true);
    assert.equal(isValidTimeZone("Europe/Atlantis"), false);
  }
});
