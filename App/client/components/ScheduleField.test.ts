import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ScheduleField } from "./ScheduleField.js";
import { ScheduleTimeZone } from "./ScheduleTimeZone.js";

const h = React.createElement;
const noop = () => undefined;

// `Select` measures its menu in a layout effect, which React warns does
// nothing on the server. True, beside the point here, and repeated for every
// render that draws one, so it would bury any warning that matters.
const consoleError = console.error.bind(console);
mock.method(console, "error", (...args: unknown[]) => {
  if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
});

function render(props: { timeZone?: string | null }, wrapZone?: string | null): string {
  const field = h(ScheduleField, { value: "0 9 * * *", onChange: noop, ...props });
  return renderToStaticMarkup(
    wrapZone === undefined ? field : h(ScheduleTimeZone, { timeZone: wrapZone }, field),
  );
}

describe("ScheduleField previews", () => {
  test("labels the times with the company's time zone when one is provided", () => {
    const markup = render({}, "Europe/Berlin");
    assert.match(markup, /Next: [^<]*\d:\d\d\s?[AP]M/);
    assert.match(markup, /\(Europe\/Berlin\)/);
    assert.doesNotMatch(markup, /server time/);
  });

  test("keeps saying server time when nothing names a zone", () => {
    for (const markup of [render({}), render({}, ""), render({}, null), render({ timeZone: "" })]) {
      assert.match(markup, /\(server time\)/);
    }
  });

  test("an explicit zone beats the surrounding one, and null opts out of it", () => {
    assert.match(render({ timeZone: "Asia/Tokyo" }, "Europe/Berlin"), /\(Asia\/Tokyo\)/);
    assert.match(render({ timeZone: null }, "Europe/Berlin"), /\(server time\)/);
  });

  test("a zone this browser does not know reads as server time instead of throwing", () => {
    assert.match(render({}, "Mars/Base"), /\(server time\)/);
  });

  test("points at Settings only where the company's zone is what the schedule follows", () => {
    // A company's Routines: the label says where to change the clock.
    assert.match(render({}, "Europe/Berlin"), /Change it in Settings → Company/);
    assert.match(render({}, ""), /Pick a time zone in Settings → Company/);
    // A Pipeline or a Revenue Signal reads server time whatever the company
    // picks, so sending its author to Settings would be a false lead.
    const elsewhere = render({});
    assert.doesNotMatch(elsewhere, /Settings → Company/);
    assert.match(elsewhere, /server time, the clock of the machine running Genosyn/);
    assert.doesNotMatch(render({ timeZone: "Asia/Tokyo" }), /Settings → Company/);
  });
});
