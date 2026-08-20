import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import type { Locator, Page } from "playwright-core";

import {
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
    maxRecordingBytes: options.maxRecordingBytes ?? 1024 * 1024,
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
    assert.deepEqual(
      harness.commands.map(({ command, args }) => [command, args[0]]),
      [
        ["pactl", "load-module"],
        ["pactl", "unload-module"],
      ],
    );
    assert.deepEqual(harness.commands[1].args, ["unload-module", "41"]);

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
    assert.deepEqual(harness.getContextOptions(), {
      locale: "en-US",
      serviceWorkers: "allow",
      permissions: [],
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
