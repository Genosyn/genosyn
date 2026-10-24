import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";

import { captureGoogleMeetCaptions, joinGoogleMeetAsGuest } from "./googleMeetRecorder.js";

const conferenceUrl = "https://meet.google.com/abc-defg-hij";
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
]
  .filter((value): value is string => Boolean(value))
  .find((value) => existsSync(value));

function joinArgs(signal: AbortSignal) {
  return {
    companyId: "company-browser-test",
    meetingId: "meeting-browser-test",
    conferenceUrl,
    displayName: "Genosyn",
    scheduledEndAt: new Date(Date.now() + 10 * 60_000),
    signal,
    onJoined: async () => undefined,
  };
}

async function serveFixture(page: Page, html: string): Promise<void> {
  // Every request is intercepted: these tests never contact a live meeting.
  await page.context().route("**/*", async (route) => {
    if (route.request().url() === conferenceUrl) {
      await route.fulfill({ contentType: "text/html", body: html });
    } else {
      await route.abort();
    }
  });
}

/**
 * Meet's guest pages as they are now: an Ask to join button named for the
 * devices the guest brings, a waiting room that already offers Leave call,
 * and a name field that counts the keystrokes it receives.
 */
function guestFixture(requireSecondAsk: boolean): string {
  return `<!doctype html><html lang="en"><body><main>Loading Meet</main>
    <script>
      const main = document.querySelector("main");
      const choices = [];
      let name = "";
      let asked = 0;
      let keystrokes = 0;
      function record(choice) {
        choices.push(choice);
        document.body.dataset.choices = JSON.stringify(choices);
      }
      function waiting() {
        main.innerHTML = "<p>Please wait until a meeting host brings you into the call</p>" +
          '<button aria-label="Leave call">call_end</button>';
      }
      function devices(stage) {
        main.innerHTML = '<button id="enable">Use microphone and camera</button>' +
          (stage === "before-name"
            ? '<a href="#" id="continue">Continue without microphone and camera</a>'
            : '<button id="continue">Continue without microphone and camera</button>');
        document.querySelector("#enable").onclick = () => record("enabled-devices");
        document.querySelector("#continue").onclick = (event) => {
          event.preventDefault();
          record(stage + ":without-devices");
          if (stage === "before-name" || ${requireSecondAsk}) prejoin();
          else waiting();
        };
      }
      function prejoin() {
        main.innerHTML = '<label>Your name<input></label>' +
          '<button id="ask" aria-label="Ask to join without microphone &amp; camera">Ask to join</button>' +
          '<button id="present">Ask to present</button>';
        document.querySelector("input").value = name;
        document.querySelector("input").addEventListener("keydown", () => {
          keystrokes += 1;
          document.body.dataset.keystrokes = String(keystrokes);
        });
        document.querySelector("#present").onclick = () => record("present");
        document.querySelector("#ask").onclick = () => {
          name = document.querySelector("input").value;
          document.body.dataset.guestName = name;
          asked += 1;
          record("ask");
          if (asked === 1) devices("after-ask");
          else waiting();
        };
      }
      setTimeout(() => devices("before-name"), 100);
    </script></body></html>`;
}

for (const requireSecondAsk of [false, true]) {
  test(
    `Chromium completes delayed device prompts and waits for admission${requireSecondAsk ? " after asking again" : ""}`,
    { timeout: 60_000 },
    async (t) => {
      if (!executablePath) {
        t.skip("No Chromium executable is available for the Google Meet guest test");
        return;
      }
      const browser = await chromium.launch({ headless: true, executablePath });
      const controller = new AbortController();
      let joining: Promise<void> | undefined;
      try {
        const context = await browser.newContext({ permissions: [], serviceWorkers: "block" });
        const page = await context.newPage();
        await serveFixture(page, guestFixture(requireSecondAsk));
        let admitted = false;
        joining = joinGoogleMeetAsGuest(page, joinArgs(controller.signal)).then(() => {
          admitted = true;
        });
        await Promise.race([
          page
            .getByText("Please wait until a meeting host brings you into the call")
            .waitFor({ timeout: 30_000 }),
          joining.then(() => assert.fail("The guest resolved before host admission")),
        ]);
        // Several lobby passes with Leave call on screen, and still waiting.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        assert.equal(admitted, false);
        assert.equal(
          await page.locator("body").getAttribute("data-guest-name"),
          "Genosyn (AI notetaker — recording)",
        );
        // Typed, the way Meet's not-a-bot check expects a person to.
        assert.ok(
          Number(await page.locator("body").getAttribute("data-keystrokes")) >=
            "Genosyn (AI notetaker — recording)".length,
        );
        assert.deepEqual(
          JSON.parse((await page.locator("body").getAttribute("data-choices")) ?? "[]"),
          [
            "before-name:without-devices",
            "ask",
            "after-ask:without-devices",
            ...(requireSecondAsk ? ["ask"] : []),
          ],
        );

        await page.locator("main").evaluate((element) => {
          element.innerHTML =
            '<button aria-label="Raise hand (ctrl + alt + h)">back_hand</button>' +
            '<button aria-label="Leave call">call_end</button>';
        });
        await joining;
        assert.equal(admitted, true);
      } finally {
        controller.abort();
        await joining?.catch(() => undefined);
        await browser.close();
      }
    },
  );
}

test(
  "Chromium reports guest access blocked before a name or lobby request",
  { timeout: 60_000 },
  async (t) => {
    if (!executablePath) {
      t.skip("No Chromium executable is available for the Google Meet guest test");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const context = await browser.newContext({ permissions: [], serviceWorkers: "block" });
      const page = await context.newPage();
      await serveFixture(
        page,
        "<!doctype html><html lang='en'><body>You can't join this video call</body></html>",
      );
      await assert.rejects(
        joinGoogleMeetAsGuest(page, joinArgs(AbortSignal.timeout(5_000))),
        /Google Meet blocked the guest notetaker/,
      );
    } finally {
      await browser.close();
    }
  },
);

/**
 * Meet's captions as they render: a Captions region holding one child per
 * turn (a header with the speaker's name, then text Meet rewrites in place)
 * and, in the same region, the jump-to-latest control.
 */
const captionsFixture = `<!doctype html><html lang="en"><body>
  <button id="cc" aria-label="Turn on captions">closed_caption_off</button>
  <script>
    const cc = document.querySelector("#cc");
    cc.onclick = () => {
      cc.setAttribute("aria-label", "Turn off captions");
      const region = document.createElement("div");
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", "Captions");
      document.body.appendChild(region);
      const jump = document.createElement("div");
      jump.innerHTML = '<button aria-label="Jump to most recent captions">arrow_downward</button>';
      region.appendChild(jump);
      const turn = (speaker) => {
        const entry = document.createElement("div");
        entry.innerHTML = '<div><img alt=""><div><span></span></div></div><div></div>';
        entry.querySelector("span").textContent = speaker;
        region.insertBefore(entry, jump);
        return entry.lastElementChild;
      };
      const pat = turn("Pat Lee");
      pat.textContent = "We need";
      setTimeout(() => { pat.textContent = "We need SSO before we sign."; }, 900);
      setTimeout(() => {
        const sam = turn("Sam Rivera");
        sam.textContent = "I'll send pricing";
        setTimeout(() => sam.append(" on Friday."), 900);
      }, 1600);
      setTimeout(() => pat.parentElement.remove(), 3200);
    };
  </script></body></html>`;

test("Chromium reads Meet's captions as one final line per turn", { timeout: 60_000 }, async (t) => {
  if (!executablePath) {
    t.skip("No Chromium executable is available for the Google Meet captions test");
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await serveFixture(page, captionsFixture);
    await page.goto(conferenceUrl);

    const capture = captureGoogleMeetCaptions(page, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    const captions = await capture.stop();

    assert.equal(await page.locator("#cc").getAttribute("aria-label"), "Turn off captions");
    assert.deepEqual(
      captions.map(({ speaker, text }) => ({ speaker, text })),
      [
        // Revised in place, then scrolled away: its last reading survives.
        { speaker: "Pat Lee", text: "We need SSO before we sign." },
        { speaker: "Sam Rivera", text: "I'll send pricing on Friday." },
      ],
    );
    assert.ok(captions[0].startMs <= captions[1].startMs);
    assert.ok(captions[1].endMs >= captions[1].startMs);
  } finally {
    await browser.close();
  }
});
