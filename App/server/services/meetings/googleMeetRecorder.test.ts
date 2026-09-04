import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import type { Locator, Page } from "playwright-core";

import {
  admissionCutoff,
  createGoogleMeetRecorder,
  disclosedNotetakerName,
  isGoogleMeetConferenceUrl,
  joinGoogleMeetAsGuest,
} from "./googleMeetRecorder.js";

class FakeFfmpeg extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  qWrites = 0;
  stdinStopError: Error | null = null;
  private closed = false;

  constructor(private readonly audio = Buffer.from("webm-opus-audio")) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("q")) {
        this.qWrites += 1;
        if (this.stdinStopError) this.stdin.emit("error", this.stdinStopError);
        this.finish(0);
      }
    });
  }

  emitAudio(bytes: Buffer): void {
    this.stdout.write(bytes);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.finish(null, signal);
    return true;
  }

  fail(message: string): void {
    this.stderr.write(message);
    this.finish(1);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    if (code === 0) this.stdout.write(this.audio);
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }
}

type RecorderHarnessOptions = {
  joinGuest?: () => Promise<void>;
  waitForEnd?: () => Promise<void>;
  ffmpeg?: FakeFfmpeg;
  failUnload?: boolean;
  maxRecordingBytes?: number;
  /** Read per join, so a test can prove the cap is not frozen at construction. */
  readMaxRecordingBytes?: () => number;
  /** Refuse `module-null-source`, the way a PulseAudio build without it would. */
  noSilentSource?: boolean;
};

function recorderHarness(options: RecorderHarnessOptions = {}) {
  const commands: Array<{ command: string; args: string[] }> = [];
  const ffmpegCommands: Array<{ command: string; args: string[] }> = [];
  const ffmpeg = options.ffmpeg ?? new FakeFfmpeg();
  const page = { kind: "dedicated-meet-page" };
  const lifecycle = { contextClosed: 0, browserClosed: 0 };
  const warnings: string[] = [];
  let launchOptions: Record<string, unknown> | null = null;
  let contextOptions: Record<string, unknown> | null = null;
  let now = 1_000;

  const context = {
    newPage: async () => page,
    close: async () => {
      lifecycle.contextClosed += 1;
    },
  };
  const browser = {
    newContext: async (received: Record<string, unknown>) => {
      contextOptions = received;
      return context;
    },
    close: async () => {
      lifecycle.browserClosed += 1;
    },
  };

  const recorder = createGoogleMeetRecorder({
    loadLauncher: async () => ({
      launch: async (received) => {
        launchOptions = received;
        return browser;
      },
    }),
    launchOptions: async () => ({
      args: ["--existing"],
      ignoreDefaultArgs: ["--enable-automation"],
      env: { EXISTING: "yes" },
    }),
    contextOptions: async () => ({ locale: "en-GB" }),
    initScript: async () => "",
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (options.failUnload && args[0] === "unload-module") {
        throw new Error("PulseAudio refused to unload module");
      }
      if (options.noSilentSource && args[1] === "module-null-source") {
        throw new Error("Module initialization failed");
      }
      return args[0] === "load-module"
        ? { stdout: "41\n", stderr: "" }
        : { stdout: "", stderr: "" };
    },
    spawnProcess: (command, args) => {
      ffmpegCommands.push({ command, args });
      return ffmpeg as unknown as ChildProcessWithoutNullStreams;
    },
    joinGuest: async () => {
      if (options.joinGuest) await options.joinGuest();
    },
    waitForEnd: async () => {
      if (options.waitForEnd) await options.waitForEnd();
      now = 4_000;
    },
    now: () => now,
    randomToken: () => "fixed123",
    maxRecordingBytes: () =>
      options.readMaxRecordingBytes?.() ?? options.maxRecordingBytes ?? 1024 * 1024,
    warn: (message) => warnings.push(message),
  });

  return {
    commands,
    ffmpegCommands,
    ffmpeg,
    lifecycle,
    recorder,
    warnings,
    getLaunchOptions: () => launchOptions,
    getContextOptions: () => contextOptions,
  };
}

function joinArgs(signal = new AbortController().signal) {
  return {
    companyId: "company-1",
    meetingId: "meeting-1",
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "Genosyn",
    scheduledEndAt: new Date(Date.now() + 10 * 60_000),
    signal,
    onJoined: async () => undefined,
  };
}

describe("Google Meet URL and disclosure boundary", () => {
  test("accepts only canonical, encrypted meet.google.com call links", () => {
    assert.equal(isGoogleMeetConferenceUrl("https://meet.google.com/abc-defg-hij"), true);
    assert.equal(
      isGoogleMeetConferenceUrl("https://MEET.GOOGLE.COM/abc-defg-hij?authuser=0"),
      true,
    );
    assert.equal(isGoogleMeetConferenceUrl("http://meet.google.com/abc-defg-hij"), false);
    assert.equal(
      isGoogleMeetConferenceUrl("https://meet.google.com.evil.test/abc-defg-hij"),
      false,
    );
    assert.equal(isGoogleMeetConferenceUrl("https://meet.google.com/landing"), false);
    assert.equal(isGoogleMeetConferenceUrl("not a url"), false);
    // A Workspace "nicknamed" meeting. `conferenceForEvent` has always labelled
    // these `meet`, so the calendar armed them and then the driver refused the
    // very link the policy had accepted — a whole class of invite that could
    // never be joined and never said why.
    assert.equal(isGoogleMeetConferenceUrl("https://meet.google.com/lookup/northwind-standup"), true);
    assert.equal(isGoogleMeetConferenceUrl("https://meet.google.com/lookup/"), false);
    assert.equal(isGoogleMeetConferenceUrl("https://meet.google.com/lookup/a/b"), false);
    assert.equal(isGoogleMeetConferenceUrl("https://meet.google.com/_meet/settings"), false);
  });

  test("makes the recording role visible and bounds Meet's guest name", () => {
    assert.equal(
      disclosedNotetakerName(" Genosyn  Notes "),
      "Genosyn Notes (AI notetaker — recording)",
    );
    assert.match(disclosedNotetakerName("x".repeat(200)), /AI notetaker — recording/);
    assert.ok(disclosedNotetakerName("x".repeat(200)).length <= 100);
    assert.equal(disclosedNotetakerName("Acme recording notetaker"), "Acme recording notetaker");
    assert.match(
      disclosedNotetakerName(`${"x".repeat(120)} recording notetaker`),
      /AI notetaker — recording/,
    );
  });
});

describe("Google Meet guest lobby", () => {
  test("discloses recording, disables devices, asks to join, and waits for admission", async () => {
    let admitted = false;
    const filled: string[] = [];
    const clicked: string[] = [];

    const locator = (name: string, visible: () => boolean, text = "") =>
      ({
        first() {
          return this;
        },
        isVisible: async () => visible(),
        click: async () => {
          clicked.push(name);
          if (name === "ask") admitted = true;
        },
        fill: async (value: string) => {
          filled.push(value);
        },
        innerText: async () => text,
      }) as unknown as Locator;

    const hidden = locator("hidden", () => false);
    const page = {
      setDefaultTimeout: () => undefined,
      goto: async () => null,
      getByRole: (_role: string, options: { name?: RegExp }) => {
        const pattern = options.name?.source ?? "";
        if (pattern.includes("your name")) return locator("name", () => true);
        if (pattern.includes("turn off microphone")) return locator("microphone", () => true);
        if (pattern.includes("turn off camera")) return locator("camera", () => true);
        if (pattern.includes("ask to join")) return locator("ask", () => true);
        if (pattern.includes("leave call")) return locator("leave", () => admitted);
        return hidden;
      },
      locator: (selector: string) =>
        selector === "body" ? locator("body", () => true, "") : hidden,
      isClosed: () => false,
    } as unknown as Page;

    await joinGoogleMeetAsGuest(page, joinArgs());

    assert.deepEqual(filled, ["Genosyn (AI notetaker — recording)"]);
    assert.deepEqual(clicked, ["microphone", "camera", "ask"]);
    assert.equal(admitted, true);
  });

  test("reports when the host denies admission", async () => {
    let asked = false;
    const locator = (visible: () => boolean, text = "", click?: () => void) =>
      ({
        first() {
          return this;
        },
        isVisible: async () => visible(),
        click: async () => click?.(),
        fill: async () => undefined,
        innerText: async () => text,
      }) as unknown as Locator;
    const hidden = locator(() => false);
    const page = {
      setDefaultTimeout: () => undefined,
      goto: async () => null,
      getByRole: (_role: string, options: { name?: RegExp }) => {
        const pattern = options.name?.source ?? "";
        if (pattern.includes("your name")) return locator(() => true);
        if (pattern.includes("ask to join")) {
          return locator(
            () => true,
            "",
            () => {
              asked = true;
            },
          );
        }
        return hidden;
      },
      locator: (selector: string) =>
        selector === "body"
          ? locator(() => true, asked ? "Your request to join was denied" : "")
          : hidden,
      isClosed: () => false,
    } as unknown as Page;

    await assert.rejects(joinGoogleMeetAsGuest(page, joinArgs()), /host denied/);
  });
});

/**
 * A Meet lobby that can be described rather than mocked call by call.
 *
 * `visible` is the set of controls currently on screen, keyed by the logical
 * name the driver's accessible-name pattern picks out; `body` is the page
 * text the driver scans for Meet's own status sentences. `onClick` lets a test
 * move the lobby on — admit the guest, close a dialog, refuse a request —
 * which is what makes the multi-pass behaviour testable at all.
 */
function fakeLobby(options: {
  visible: string[];
  body?: string;
  onClick?: (name: string, state: { visible: Set<string>; body: string }) => void;
  /** Runs once per pass of the lobby loop, which reads the body every time. */
  onPass?: (pass: number, state: { visible: Set<string>; body: string }) => void;
  failClicks?: Set<string>;
}) {
  const state = { visible: new Set(options.visible), body: options.body ?? "" };
  const clicks: string[] = [];
  const fills: string[] = [];
  const failed: string[] = [];
  let pass = 0;

  const control = (name: string) =>
    ({
      first() {
        return this;
      },
      isVisible: async () => state.visible.has(name),
      click: async () => {
        if (options.failClicks?.has(name)) {
          failed.push(name);
          options.failClicks.delete(name);
          throw new Error("element is not stable");
        }
        clicks.push(name);
        options.onClick?.(name, state);
      },
      fill: async (value: string) => {
        fills.push(value);
      },
      innerText: async () => {
        if (name === "__body__") {
          pass += 1;
          options.onPass?.(pass, state);
        }
        return state.body;
      },
    }) as unknown as Locator;

  const byPattern: Array<[RegExp, string]> = [
    [/your name/, "name"],
    [/accept all/, "consent"],
    [/got it/, "gotIt"],
    [/continue without/, "continueWithout"],
    [/join without/, "joinWithout"],
    [/dismiss/, "dismiss"],
    [/turn off microphone/, "microphone"],
    [/turn off camera/, "camera"],
    [/ask to join/, "ask"],
    [/join now/, "joinNow"],
    [/leave call/, "leave"],
  ];

  const page = {
    setDefaultTimeout: () => undefined,
    goto: async () => null,
    getByRole: (_role: string, roleOptions: { name?: RegExp }) => {
      const pattern = roleOptions.name?.source ?? "";
      for (const [match, name] of byPattern) {
        if (match.test(pattern)) return control(name);
      }
      return control("__absent__");
    },
    locator: (selector: string) =>
      selector === "body" ? control("__body__") : control("__absent__"),
    isClosed: () => false,
  } as unknown as Page;

  // `body` is read through innerText on a control that is never "visible",
  // which is exactly how the driver reads it.
  state.visible.add("__body__");
  return { page, state, clicks, fills, failed };
}

describe("the Google Meet admission window", () => {
  const at = (minutes: number) => new Date(60_000 * minutes);

  test("waits for the whole call, not an arbitrary five minutes", () => {
    // The dispatcher asks to join 30s *before* the start, so a flat five
    // minutes gave up at 4m30s past the hour — before a great many hosts have
    // finished their previous meeting.
    assert.equal(admissionCutoff({ scheduledEndAt: at(30) }, 0), 30 * 60_000);
  });

  test("never keeps a browser and a recording in a lobby indefinitely", () => {
    assert.equal(admissionCutoff({ scheduledEndAt: at(600) }, 0), 30 * 60_000);
  });

  test("still gives a nearly-over call the ordinary grace period", () => {
    assert.equal(admissionCutoff({ scheduledEndAt: at(1) }, 0), 5 * 60_000);
  });

  test("falls back to five minutes when nothing says when the call ends", () => {
    assert.equal(admissionCutoff({ scheduledEndAt: null }, 0), 5 * 60_000);
  });
});

describe("Google Meet lobby interstitials", () => {
  test("closes the no-microphone dialog that used to block every click", async () => {
    // The dialog is modal. Meet raises it after the SPA has rendered, so the
    // old one-shot check ran too early to see it and every later click landed
    // on the scrim — the notetaker sat there until the deadline and then
    // reported that Meet had never offered it a button.
    const lobby = fakeLobby({
      visible: ["continueWithout", "name", "ask"],
      onClick: (name, state) => {
        if (name === "continueWithout") state.visible.delete("continueWithout");
        if (name === "ask") state.visible.add("leave");
      },
    });

    await joinGoogleMeetAsGuest(lobby.page, joinArgs());

    assert.deepEqual(lobby.clicks, ["continueWithout", "ask"]);
    assert.deepEqual(lobby.fills, ["Genosyn (AI notetaker — recording)"]);
  });

  test("dismisses an interstitial that arrives after the page did", async () => {
    // Meet is a single-page app. The old code checked for consent and "Got it"
    // exactly once, immediately after `goto` — while the lobby was still
    // blank — so anything Google rendered a moment later stayed on screen
    // over the join button for the rest of the join window.
    const lobby = fakeLobby({
      visible: ["name"],
      onPass: (pass, state) => {
        if (pass === 2) state.visible.add("gotIt");
      },
      onClick: (name, state) => {
        if (name === "gotIt") {
          state.visible.delete("gotIt");
          state.visible.add("ask");
        }
        if (name === "ask") state.visible.add("leave");
      },
    });

    await joinGoogleMeetAsGuest(lobby.page, joinArgs());

    assert.deepEqual(lobby.clicks, ["gotIt", "ask"]);
  });

  test("asks again when Meet reports that nobody responded", async () => {
    // Meet expires an unanswered request after a couple of minutes and offers
    // to ask again. Treating that as terminal is what made a late host mean no
    // notetaker at all.
    const lobby = fakeLobby({
      visible: ["name", "ask"],
      onClick: (name, state) => {
        if (name !== "ask") return;
        state.body = state.body.includes("No one responded")
          ? ""
          : "No one responded to your request to join";
        if (!state.body) state.visible.add("leave");
      },
    });

    await joinGoogleMeetAsGuest(lobby.page, joinArgs());

    assert.deepEqual(
      lobby.clicks.filter((name) => name === "ask"),
      ["ask", "ask"],
    );
  });

  test("a click that loses a race with Meet's re-render costs a pass, not the call", async () => {
    const lobby = fakeLobby({
      visible: ["name", "ask"],
      failClicks: new Set(["ask"]),
      onClick: (name, state) => {
        if (name === "ask") state.visible.add("leave");
      },
    });

    await joinGoogleMeetAsGuest(lobby.page, joinArgs());

    assert.deepEqual(lobby.failed, ["ask"]);
    assert.deepEqual(lobby.clicks, ["ask"]);
  });

  test("recognises a guest who is already in the call", async () => {
    const lobby = fakeLobby({ visible: ["leave", "name", "ask"] });

    await joinGoogleMeetAsGuest(lobby.page, joinArgs());

    assert.deepEqual(lobby.clicks, []);
    assert.deepEqual(lobby.fills, []);
  });

  test("reports a call that ended before anybody admitted the guest", async () => {
    const lobby = fakeLobby({
      visible: ["name", "ask"],
      body: "This meeting has ended",
    });

    await assert.rejects(joinGoogleMeetAsGuest(lobby.page, joinArgs()), /ended before/);
  });

  test("reports a meeting that does not allow guests, with the fix in the sentence", async () => {
    const lobby = fakeLobby({
      visible: [],
      body: "You need to sign in to join this video call",
    });

    await assert.rejects(joinGoogleMeetAsGuest(lobby.page, joinArgs()), /Allow guests/);
  });

  test("stops as soon as a Member asks it to", async () => {
    const controller = new AbortController();
    controller.abort();
    const lobby = fakeLobby({ visible: ["name", "ask"] });

    await assert.rejects(
      joinGoogleMeetAsGuest(lobby.page, joinArgs(controller.signal)),
      /was stopped/,
    );
  });
});

describe("Google Meet recorder lifecycle", () => {
  test("isolates audio and browser state, records mono Opus, and cleans everything up", async () => {
    const harness = recorderHarness();
    let joined = 0;
    const result = await harness.recorder.join({
      ...joinArgs(),
      onJoined: async () => {
        joined += 1;
      },
    });

    assert.equal(joined, 1);
    assert.deepEqual(result, {
      bytes: Buffer.from("webm-opus-audio"),
      mime: "audio/webm",
      durationMs: 3_000,
    });
    assert.equal(harness.lifecycle.contextClosed, 1);
    assert.equal(harness.lifecycle.browserClosed, 1);
    // Two devices, both private to this call and both unloaded again: the null
    // sink Chrome plays into, and the null source it captures from.
    assert.deepEqual(
      harness.commands.map(({ command, args }) => [command, args[0], args[1]]),
      [
        ["pactl", "load-module", "module-null-sink"],
        ["pactl", "load-module", "module-null-source"],
        ["pactl", "unload-module", "41"],
        ["pactl", "unload-module", "41"],
      ],
    );

    const ffmpeg = harness.ffmpegCommands[0];
    assert.equal(ffmpeg.command, "ffmpeg");
    assert.ok(ffmpeg.args.includes("libopus"));
    assert.ok(ffmpeg.args.includes("webm"));
    assert.deepEqual(
      ffmpeg.args.slice(ffmpeg.args.indexOf("-ac"), ffmpeg.args.indexOf("-ac") + 2),
      ["-ac", "1"],
    );

    const launch = harness.getLaunchOptions();
    assert.ok(launch);
    assert.deepEqual(launch.args, ["--existing", "--autoplay-policy=no-user-gesture-required"]);
    assert.deepEqual(launch.ignoreDefaultArgs, ["--enable-automation", "--mute-audio"]);
    assert.equal((launch.env as Record<string, string>).EXISTING, "yes");
    assert.match((launch.env as Record<string, string>).PULSE_SINK, /^genosyn_meeting_/);
    // Capture is pinned to the silent source. Left to PulseAudio's default,
    // Chrome would capture the monitor of the sink it is playing into.
    assert.equal(
      (launch.env as Record<string, string>).PULSE_SOURCE,
      `${(launch.env as Record<string, string>).PULSE_SINK}_mic`,
    );
    assert.deepEqual(harness.getContextOptions(), {
      locale: "en-US",
      serviceWorkers: "allow",
      permissions: ["microphone"],
      acceptDownloads: false,
    });
  });

  test("returns a finalised partial recording when aborted after admission", async () => {
    const controller = new AbortController();
    const harness = recorderHarness({
      waitForEnd: async () => {
        controller.abort();
      },
    });

    const result = await harness.recorder.join(joinArgs(controller.signal));

    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(result.bytes, Buffer.from("webm-opus-audio"));
    assert.equal(harness.lifecycle.contextClosed, 1);
    assert.equal(harness.lifecycle.browserClosed, 1);
    assert.equal(harness.commands.at(-1)?.args[0], "unload-module");
  });

  test("keeps finalised partial audio when the post-admission wait rejects from abort", async () => {
    const controller = new AbortController();
    const abortReason = new Error("The App is shutting down.");
    const harness = recorderHarness({
      waitForEnd: async () => {
        controller.abort(abortReason);
        throw abortReason;
      },
    });

    const result = await harness.recorder.join(joinArgs(controller.signal));

    assert.deepEqual(result.bytes, Buffer.from("webm-opus-audio"));
    assert.equal(harness.lifecycle.contextClosed, 1);
    assert.equal(harness.commands.at(-1)?.args[0], "unload-module");
  });

  test("cleans browser, ffmpeg, and PulseAudio after a lobby failure", async () => {
    const harness = recorderHarness({
      joinGuest: async () => {
        throw new Error("host denied admission");
      },
    });

    await assert.rejects(harness.recorder.join(joinArgs()), /host denied admission/);
    assert.equal(harness.lifecycle.contextClosed, 1);
    assert.equal(harness.lifecycle.browserClosed, 1);
    assert.equal(harness.commands.at(-1)?.args[0], "unload-module");
  });

  test("preserves finalized audio and logs a meeting-scoped cleanup failure", async () => {
    const harness = recorderHarness({ failUnload: true });

    const result = await harness.recorder.join(joinArgs());

    assert.deepEqual(result.bytes, Buffer.from("webm-opus-audio"));
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], /meeting-1/);
    assert.match(harness.warnings[0], /PulseAudio refused to unload module/);
  });

  test("finalises and returns a bounded partial recording at the size threshold", async () => {
    const ffmpeg = new FakeFfmpeg(Buffer.alloc(4, 0x7f));
    const harness = recorderHarness({
      ffmpeg,
      maxRecordingBytes: 100,
      waitForEnd: async () => {
        // Five bytes are reserved at this injected limit. Reaching 95 asks
        // ffmpeg to write its four-byte stand-in trailer and exit normally.
        ffmpeg.emitAudio(Buffer.alloc(95, 0x1a));
        await new Promise<void>(() => undefined);
      },
    });

    const result = await harness.recorder.join(joinArgs());

    assert.equal(ffmpeg.qWrites, 1);
    assert.equal(result.bytes.length, 99);
    assert.ok(result.bytes.length <= 100);
    assert.equal(harness.lifecycle.contextClosed, 1);
    assert.equal(harness.lifecycle.browserClosed, 1);
    assert.equal(harness.commands.at(-1)?.args[0], "unload-module");
  });

  test("contains an ffmpeg stdin EPIPE emitted while requesting stop", async () => {
    const ffmpeg = new FakeFfmpeg();
    ffmpeg.stdinStopError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const harness = recorderHarness({ ffmpeg });

    const result = await harness.recorder.join(joinArgs());

    assert.equal(ffmpeg.qWrites, 1);
    assert.deepEqual(result.bytes, Buffer.from("webm-opus-audio"));
    assert.equal(harness.lifecycle.contextClosed, 1);
    assert.equal(harness.lifecycle.browserClosed, 1);
    assert.equal(harness.commands.at(-1)?.args[0], "unload-module");
  });

  test("reports an early ffmpeg failure and still removes every allocated resource", async () => {
    const ffmpeg = new FakeFfmpeg();
    const harness = recorderHarness({
      ffmpeg,
      joinGuest: async () => {
        ffmpeg.emitAudio(Buffer.from("valid-looking partial output"));
        ffmpeg.fail("PulseAudio source disappeared");
        await new Promise<void>(() => undefined);
      },
    });

    await assert.rejects(
      harness.recorder.join(joinArgs()),
      /ffmpeg stopped before the meeting ended.*PulseAudio source disappeared/,
    );
    assert.equal(harness.lifecycle.contextClosed, 1);
    assert.equal(harness.lifecycle.browserClosed, 1);
    assert.equal(harness.commands.at(-1)?.args[0], "unload-module");
  });

  test("joins without a silent microphone when PulseAudio has no null source", async () => {
    // `module-null-source` is not in every PulseAudio build. A deployment
    // without it should still get a notetaker — it just falls back to
    // dismissing Meet's device dialog instead of satisfying it.
    const harness = recorderHarness({ noSilentSource: true });

    const result = await harness.recorder.join(joinArgs());

    assert.equal(result.mime, "audio/webm");
    const launch = harness.getLaunchOptions();
    assert.equal((launch?.env as Record<string, string>).PULSE_SOURCE, undefined);
    assert.deepEqual((harness.getContextOptions() as { permissions: string[] }).permissions, []);
    assert.equal(
      harness.warnings.some((message) => /silent microphone/.test(message)),
      true,
    );
    // The sink is still created and still cleaned up; only the source is gone.
    assert.deepEqual(
      harness.commands.map(({ args }) => [args[0], args[1]]),
      [
        ["load-module", "module-null-sink"],
        ["load-module", "module-null-source"],
        ["unload-module", "41"],
      ],
    );
  });

  test("reads the recording cap on every join instead of freezing it at boot", async () => {
    // `createGoogleMeetRecorder` builds its dependencies with a spread, and a
    // spread *calls* a getter and keeps the number. The cap is an
    // operator-editable runtime setting, so it has to be read per join —
    // otherwise every recording for the life of the process uses whatever the
    // Admin → Runtime value happened to be when the module first loaded.
    let cap = 1024 * 1024;
    const harness = recorderHarness({ readMaxRecordingBytes: () => cap });

    assert.equal((await harness.recorder.join(joinArgs())).mime, "audio/webm");

    cap = 1;
    await assert.rejects(harness.recorder.join(joinArgs()), /greater than one/);
  });

  test("an already-aborted request allocates nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = recorderHarness();

    await assert.rejects(
      harness.recorder.join(joinArgs(controller.signal)),
      /stopped before it could join/,
    );
    assert.equal(harness.commands.length, 0);
    assert.equal(harness.ffmpegCommands.length, 0);
  });
});
