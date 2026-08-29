import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { Browser, BrowserContext, Page } from "playwright-core";

import { getMeetingsSettings } from "../runtimeSettings.js";
import {
  chromeMaskInitScript,
  chromeContextOptions,
  chromiumLaunchOptions,
  loadChromiumLauncher,
} from "../browserProfile.js";
import { registerMeetingRecorder } from "./recorder.js";

const MEET_CODE_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i;
const MAX_DISPLAY_NAME_LENGTH = 100;
const ADMISSION_TIMEOUT_MS = 5 * 60_000;
const UI_POLL_MS = 500;
const MEETING_POLL_MS = 1_000;

export type GoogleMeetJoinArgs = {
  companyId: string;
  meetingId: string;
  conferenceUrl: string;
  displayName: string;
  scheduledEndAt: Date | null;
  signal: AbortSignal;
  onJoined(): Promise<void>;
};

export type GoogleMeetRecording = {
  bytes: Buffer;
  mime: "audio/webm";
  durationMs: number;
};

type CommandResult = { stdout: string; stderr: string };

type GoogleMeetRecorderDependencies = {
  loadLauncher(): Promise<{
    launch(options: Record<string, unknown>): Promise<unknown>;
  }>;
  launchOptions(): Promise<Record<string, unknown>>;
  contextOptions(): Promise<Record<string, unknown>>;
  initScript(): Promise<string>;
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  spawnProcess(command: string, args: string[]): ChildProcessWithoutNullStreams;
  joinGuest(page: Page, args: GoogleMeetJoinArgs): Promise<void>;
  waitForEnd(page: Page, args: GoogleMeetJoinArgs): Promise<void>;
  now(): number;
  randomToken(): string;
  maxRecordingBytes: number;
  warn(message: string): void;
};

const defaultDependencies: GoogleMeetRecorderDependencies = {
  loadLauncher: () => loadChromiumLauncher("Google Meet recording requires Chrome."),
  launchOptions: chromiumLaunchOptions,
  contextOptions: chromeContextOptions,
  initScript: chromeMaskInitScript,
  runCommand: runCommand,
  spawnProcess: (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }),
  joinGuest: joinGoogleMeetAsGuest,
  waitForEnd: waitForGoogleMeetToEnd,
  now: Date.now,
  randomToken: () => randomUUID().slice(0, 8),
  // A getter, not a value: the defaults object is built once at module load,
  // and the cap is an operator-editable runtime setting.
  get maxRecordingBytes(): number {
    return getMeetingsSettings().maxRecordingBytes;
  },
  warn: (message) => {
    // eslint-disable-next-line no-console
    console.warn(message);
  },
};

/**
 * Accept only canonical Google Meet links. In particular, a lookalike host,
 * clear-text URL, arbitrary Google page, or URL carrying credentials is never
 * handed to the privileged browser/audio path.
 */
export function isGoogleMeetConferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "meet.google.com" &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === "" &&
      MEET_CODE_RE.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** A guest name that makes the recorder's role unambiguous to everybody. */
export function disclosedNotetakerName(displayName: string): string {
  const clean = displayName.replace(/\s+/g, " ").trim() || "Genosyn";
  const suffix = " (AI notetaker — recording)";
  const bounded = clean.slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (/notetaker/i.test(bounded) && /record/i.test(bounded)) {
    return bounded;
  }
  return `${clean.slice(0, MAX_DISPLAY_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Make an isolated Google Meet recorder. Dependencies are injectable so the
 * lifecycle and cleanup paths can be covered without a real call or sound
 * server.
 */
export function createGoogleMeetRecorder(overrides: Partial<GoogleMeetRecorderDependencies> = {}): {
  readonly id: "notetaker";
  canJoin(conferenceUrl: string): boolean;
  join(args: GoogleMeetJoinArgs): Promise<GoogleMeetRecording>;
} {
  const dependencies = { ...defaultDependencies, ...overrides };

  return {
    id: "notetaker",
    canJoin: isGoogleMeetConferenceUrl,
    async join(args) {
      if (!isGoogleMeetConferenceUrl(args.conferenceUrl)) {
        throw new Error(
          "The built-in notetaker can only join canonical https://meet.google.com meeting links.",
        );
      }
      if (args.signal.aborted) {
        throw new Error("The notetaker was stopped before it could join the meeting.");
      }
      if (args.scheduledEndAt && args.scheduledEndAt.getTime() <= dependencies.now()) {
        throw new Error("The meeting's scheduled end time has already passed.");
      }

      let sink: PulseAudioSink | null = null;
      let capture: FfmpegCapture | null = null;
      let browser: Browser | null = null;
      let context: BrowserContext | null = null;
      let joinedAt = 0;
      let recordingBytes: Buffer | null = null;
      let primaryError: unknown = null;
      const cleanupErrors: Error[] = [];

      try {
        sink = await createPulseAudioSink(args.meetingId, dependencies);
        capture = startFfmpegCapture(
          sink.monitorSource,
          dependencies.spawnProcess,
          dependencies.maxRecordingBytes,
        );

        const launcher = await dependencies.loadLauncher();
        const baseLaunchOptions = await dependencies.launchOptions();
        const inheritedArgs = Array.isArray(baseLaunchOptions.args)
          ? baseLaunchOptions.args.filter((value): value is string => typeof value === "string")
          : [];
        const inheritedIgnoredArguments = Array.isArray(baseLaunchOptions.ignoreDefaultArgs)
          ? baseLaunchOptions.ignoreDefaultArgs.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        const inheritedEnvironment = isStringRecord(baseLaunchOptions.env)
          ? baseLaunchOptions.env
          : {};

        browser = (await launcher.launch({
          ...baseLaunchOptions,
          args: [...inheritedArgs, "--autoplay-policy=no-user-gesture-required"],
          // Playwright normally mutes browser playback because most automation
          // consumes pixels, not sound. Playback is the recording source here.
          ignoreDefaultArgs: [...new Set([...inheritedIgnoredArguments, "--mute-audio"])],
          env: {
            ...stringEnvironment(process.env),
            ...inheritedEnvironment,
            PULSE_SINK: sink.name,
          },
        })) as Browser;

        context = await browser.newContext({
          ...(await dependencies.contextOptions()),
          // The guest-lobby controls below are selected by their accessible
          // English labels. Keep this disposable automation context stable
          // regardless of the company's employee-browser locale.
          locale: "en-US",
          // This exception is scoped to this disposable, unauthenticated
          // context. The employee browser's service-worker boundary stays
          // untouched.
          serviceWorkers: "allow",
          permissions: [],
          acceptDownloads: false,
        });
        const maskScript = await dependencies.initScript();
        if (maskScript) await context.addInitScript({ content: maskScript });
        const page = await context.newPage();

        const admissionResult = await Promise.race([
          dependencies.joinGuest(page, args).then(() => "joined" as const),
          capture.sizeLimitReached().then(() => "size-limit" as const),
          capture.unexpectedExit(),
        ]);
        if (admissionResult === "size-limit") {
          throw new Error(
            "The recording size limit was reached before the notetaker was admitted.",
          );
        }
        joinedAt = dependencies.now();
        await args.onJoined();

        await Promise.race([
          dependencies.waitForEnd(page, args),
          capture.sizeLimitReached(),
          capture.unexpectedExit(),
        ]);
      } catch (err) {
        primaryError = err;
      } finally {
        // Finalise audio first. On App shutdown the dispatcher has a short
        // grace window, and the WebM trailer is the one cleanup result that
        // cannot be reconstructed after process exit.
        if (capture) {
          try {
            recordingBytes = await capture.stop(args.signal.aborted);
          } catch (err) {
            cleanupErrors.push(actionError("finish the Google Meet WebM recording", err));
          }
        }
        const browserCloseTimeout = args.signal.aborted ? 750 : 10_000;
        if (context) {
          try {
            await promiseWithTimeout(
              context.close(),
              browserCloseTimeout,
              "Closing the dedicated Google Meet browser context timed out.",
            );
          } catch (err) {
            cleanupErrors.push(actionError("close the dedicated Google Meet browser context", err));
          }
        }
        if (browser) {
          try {
            await promiseWithTimeout(
              browser.close(),
              browserCloseTimeout,
              "Closing the dedicated Google Meet browser timed out.",
            );
          } catch (err) {
            cleanupErrors.push(actionError("close the dedicated Google Meet browser", err));
          }
        }
        if (sink) {
          try {
            const removing = removePulseAudioSink(sink, dependencies.runCommand);
            if (args.signal.aborted) {
              await promiseWithTimeout(
                removing,
                750,
                "Removing the meeting's PulseAudio device timed out.",
              );
            } else {
              await removing;
            }
          } catch (err) {
            cleanupErrors.push(actionError("remove the meeting's PulseAudio device", err));
          }
        }
      }

      const hasFinalizedPartialRecording = joinedAt > 0 && Boolean(recordingBytes?.length);
      if (
        primaryError &&
        !(hasFinalizedPartialRecording && isAbortDrivenError(primaryError, args.signal))
      ) {
        throw errorWithCleanup(primaryError, cleanupErrors);
      }
      if (cleanupErrors.length > 0) {
        if (!recordingBytes) {
          throw errorWithCleanup(cleanupErrors[0], cleanupErrors.slice(1));
        }
        dependencies.warn(
          `[meetings] Google Meet recorder cleanup failed for ${args.meetingId}: ${cleanupErrors
            .map((error) => error.message)
            .join("; ")}`,
        );
      }
      if (!recordingBytes) {
        throw new Error("The Google Meet recorder finished without producing audio.");
      }

      return {
        bytes: recordingBytes,
        mime: "audio/webm",
        durationMs: joinedAt === 0 ? 0 : Math.max(0, dependencies.now() - joinedAt),
      };
    },
  };
}

export const googleMeetRecorder = createGoogleMeetRecorder();

/** Register the stock-image Google Meet driver during meeting-service boot. */
export function registerBuiltInMeetingRecorder(): void {
  registerMeetingRecorder(googleMeetRecorder);
}

type PulseAudioSink = {
  name: string;
  monitorSource: string;
  moduleId: string;
};

async function createPulseAudioSink(
  meetingId: string,
  dependencies: Pick<GoogleMeetRecorderDependencies, "runCommand" | "randomToken">,
): Promise<PulseAudioSink> {
  const meetingPart = meetingId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "meeting";
  const name = `genosyn_meeting_${meetingPart}_${dependencies.randomToken().replace(/[^a-zA-Z0-9]/g, "")}`;
  let result: CommandResult;
  try {
    result = await dependencies.runCommand("pactl", [
      "load-module",
      "module-null-sink",
      `sink_name=${name}`,
      "rate=48000",
      "channels=2",
      `sink_properties=device.description=Genosyn_${meetingPart}`,
    ]);
  } catch (err) {
    const cleanupError = await removePulseAudioSinkByName(name, dependencies.runCommand);
    throw new Error(
      `The notetaker could not create its isolated audio device. Ensure PulseAudio and pactl are installed and running. ${errorMessage(err)}${
        cleanupError ? ` Cleanup also failed: ${cleanupError.message}` : ""
      }`,
      { cause: err },
    );
  }

  const moduleId = result.stdout.trim();
  if (!/^\d+$/.test(moduleId)) {
    const cleanupError = await removePulseAudioSinkByName(name, dependencies.runCommand);
    throw new Error(
      `PulseAudio did not return a module id while creating the meeting audio device${
        result.stderr.trim() ? `: ${result.stderr.trim()}` : "."
      }${cleanupError ? ` Cleanup also failed: ${cleanupError.message}` : ""}`,
    );
  }
  return { name, monitorSource: `${name}.monitor`, moduleId };
}

async function removePulseAudioSink(
  sink: PulseAudioSink,
  run: GoogleMeetRecorderDependencies["runCommand"],
): Promise<void> {
  await run("pactl", ["unload-module", sink.moduleId]);
}

/** Recover the unique module when `pactl load-module` did not return its id. */
async function removePulseAudioSinkByName(
  name: string,
  run: GoogleMeetRecorderDependencies["runCommand"],
): Promise<Error | null> {
  try {
    const listed = await run("pactl", ["list", "short", "modules"]);
    const row = listed.stdout
      .split(/\r?\n/)
      .find((line) => line.includes("module-null-sink") && line.includes(`sink_name=${name}`));
    const moduleId = row?.match(/^\s*(\d+)\b/)?.[1];
    if (moduleId) await run("pactl", ["unload-module", moduleId]);
    return null;
  } catch (err) {
    return actionError("remove the partially-created PulseAudio device", err);
  }
}

type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

class FfmpegCapture {
  private output = Buffer.alloc(0);
  private outputBytes = 0;
  private readonly errorOutput: Buffer[] = [];
  private errorOutputBytes = 0;
  private readonly exit: Promise<ProcessExit>;
  private readonly sizeLimit: Promise<void>;
  private resolveSizeLimit: () => void = () => undefined;
  private readonly stopAtBytes: number;
  private settled = false;
  private stopping = false;
  private sizeLimited = false;
  private overflowError: Error | null = null;
  private stdinError: Error | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxBytes: number,
  ) {
    // Node normally delivers pipe data in <=64 KiB chunks and WebM's final
    // cluster/trailer is small. Half a MiB leaves ample room for both at the
    // stock 25 MiB limit without sacrificing much useful call audio. Tiny
    // injected limits keep a proportional reserve so this path is testable.
    const finalizationReserve = Math.max(1, Math.min(512 * 1024, Math.floor(maxBytes * 0.05)));
    this.stopAtBytes = maxBytes - finalizationReserve;
    this.sizeLimit = new Promise((resolve) => {
      this.resolveSizeLimit = resolve;
    });

    child.stdout.on("data", (chunk: Buffer | string) => this.appendOutput(chunk));
    // ffmpeg can close its input pipe just before Node delivers the child
    // `close` event. A simultaneous Stop/shutdown would otherwise turn the
    // resulting EPIPE into an unhandled stream error and crash the App.
    child.stdin.on("error", (error) => {
      this.stdinError ??= error;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      this.errorOutput.push(bytes);
      this.errorOutputBytes += bytes.length;
      while (this.errorOutputBytes > 64 * 1024) {
        const removed = this.errorOutput.shift();
        if (removed) this.errorOutputBytes -= removed.length;
      }
    });
    this.exit = new Promise((resolve) => {
      child.once("error", (error) => {
        this.settled = true;
        resolve({ code: null, signal: null, error });
      });
      child.once("close", (code, signal) => {
        this.settled = true;
        resolve({ code, signal, error: null });
      });
    });
  }

  unexpectedExit(): Promise<never> {
    return this.exit.then((exit) => {
      if (this.stopping) return new Promise<never>(() => undefined);
      throw this.exitError(exit, "ffmpeg stopped before the meeting ended");
    });
  }

  /** Resolves when output reaches the clean-finalization threshold. */
  sizeLimitReached(): Promise<void> {
    return this.sizeLimit;
  }

  async stop(fast = false): Promise<Buffer> {
    this.requestStop();

    let exit = await raceWithTimeout(this.exit, fast ? 2_000 : 5_000);
    if (!exit) {
      this.child.kill("SIGINT");
      exit = await raceWithTimeout(this.exit, fast ? 500 : 2_000);
    }
    if (!exit) {
      this.child.kill("SIGKILL");
      exit = await raceWithTimeout(this.exit, fast ? 250 : 1_000);
    }
    if (!exit) {
      throw new Error("ffmpeg did not exit after SIGKILL; its recording could not be finalised.");
    }
    if (exit.error || exit.code !== 0) {
      throw this.exitError(exit, "ffmpeg could not finalise the recording");
    }
    if (this.overflowError) throw this.overflowError;

    if (this.outputBytes === 0) {
      throw new Error(
        "ffmpeg produced an empty recording. Check that Chrome can play audio through PulseAudio.",
      );
    }
    // A view avoids Buffer.concat's second full-size allocation. The retained
    // backing allocation never exceeds maxBytes, so concurrent meetings have
    // a predictable memory ceiling while the public result remains a Buffer.
    return this.output.subarray(0, this.outputBytes);
  }

  private appendOutput(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const required = this.outputBytes + bytes.length;
    if (required > this.maxBytes) {
      this.overflowError = new Error(
        `ffmpeg exceeded the ${this.maxBytes}-byte recording limit while finalising.`,
      );
      this.signalSizeLimit();
      return;
    }

    this.ensureOutputCapacity(required);
    bytes.copy(this.output, this.outputBytes);
    this.outputBytes = required;
    if (this.outputBytes >= this.stopAtBytes) this.signalSizeLimit();
  }

  private ensureOutputCapacity(required: number): void {
    if (required <= this.output.length) return;
    let capacity = this.output.length || Math.min(this.maxBytes, 64 * 1024);
    while (capacity < required) capacity = Math.min(this.maxBytes, capacity * 2);
    const next = Buffer.allocUnsafe(capacity);
    this.output.copy(next, 0, 0, this.outputBytes);
    this.output = next;
  }

  private signalSizeLimit(): void {
    if (this.sizeLimited) return;
    this.sizeLimited = true;
    this.resolveSizeLimit();
    this.requestStop();
  }

  private requestStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.settled) return;
    this.child.stdin.write("q\n");
    this.child.stdin.end();
  }

  private exitError(exit: ProcessExit, summary: string): Error {
    const stderrDetail =
      this.errorOutput.length > 0 ? Buffer.concat(this.errorOutput).toString("utf8").trim() : "";
    const detail = [
      stderrDetail,
      this.stdinError?.message ? `stdin: ${this.stdinError.message}` : "",
    ]
      .filter(Boolean)
      .join(". ");
    const status = exit.error
      ? exit.error.message
      : exit.signal
        ? `terminated by ${exit.signal}`
        : `exited with status ${exit.code ?? "unknown"}`;
    return new Error(`${summary}: ${status}${detail ? `. ${detail}` : ""}`);
  }
}

function startFfmpegCapture(
  monitorSource: string,
  spawnProcess: GoogleMeetRecorderDependencies["spawnProcess"],
  maxBytes: number,
): FfmpegCapture {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new Error("The meeting recording byte limit must be an integer greater than one.");
  }
  const child = spawnProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-thread_queue_size",
    "1024",
    "-f",
    "pulse",
    "-i",
    monitorSource,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-application",
    "voip",
    "-b:a",
    "32k",
    "-f",
    "webm",
    "pipe:1",
  ]);
  return new FfmpegCapture(child, maxBytes);
}

/** Drive Meet's unsigned guest lobby and resolve only after admission. */
export async function joinGoogleMeetAsGuest(page: Page, args: GoogleMeetJoinArgs): Promise<void> {
  page.setDefaultTimeout(10_000);
  try {
    await withAbortSignal(
      page.goto(args.conferenceUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }),
      args.signal,
      "The notetaker was stopped while it was opening Google Meet.",
    );
  } catch (err) {
    throw new Error(`The notetaker could not open the Google Meet lobby. ${errorMessage(err)}`, {
      cause: err,
    });
  }

  await clickFirstVisible([
    page.getByRole("button", { name: /accept all/i }),
    page.getByRole("button", { name: /got it/i }),
  ]);

  const cutoff = Math.min(
    Date.now() + ADMISSION_TIMEOUT_MS,
    args.scheduledEndAt?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  const nameInput = await waitForFirstVisible(
    [
      page.getByRole("textbox", { name: /your name|name/i }),
      page.locator('input[placeholder*="name" i]'),
    ],
    cutoff,
    args.signal,
  );
  if (!nameInput) {
    if (args.signal.aborted) {
      throw new Error("The notetaker was stopped while it was preparing to join.");
    }
    if (Date.now() >= cutoff) {
      throw new Error("The Google Meet join window closed before the guest lobby was ready.");
    }
    const body = await bodyText(page);
    if (/sign in to join|you can.?t join this (?:video )?call|not allowed to join/i.test(body)) {
      throw new Error(
        "Google Meet requires an account or has disabled guest access for this call. Allow guests, then retry the notetaker.",
      );
    }
    throw new Error("The Google Meet guest name field did not appear before the join deadline.");
  }
  await nameInput.fill(disclosedNotetakerName(args.displayName));

  // A granted media permission is never needed: the bot contributes no audio
  // or video. These clicks handle Meet sessions that render the devices on by
  // default despite the context granting no camera/microphone permissions.
  await clickFirstVisible([
    page.getByRole("button", { name: /turn off microphone|disable microphone/i }),
    page.locator('[aria-label*="microphone" i][data-is-muted="false"]'),
  ]);
  await clickFirstVisible([
    page.getByRole("button", { name: /turn off camera|disable camera/i }),
    page.locator('[aria-label*="camera" i][data-is-muted="false"]'),
  ]);

  const joinButton = await waitForFirstVisible(
    [
      page.getByRole("button", { name: /ask to join/i }),
      page.getByRole("button", { name: /join now/i }),
    ],
    cutoff,
    args.signal,
  );
  if (!joinButton) {
    if (args.signal.aborted) {
      throw new Error("The notetaker was stopped before it could ask to join.");
    }
    throw new Error("Google Meet never offered the guest notetaker a button to ask to join.");
  }
  await joinButton.click();

  for (;;) {
    if (args.signal.aborted) {
      throw new Error("The notetaker was stopped while it was waiting for admission.");
    }
    if (Date.now() >= cutoff) {
      throw new Error(
        "Nobody admitted the notetaker before the join window closed. Admit the disclosed notetaker from the Google Meet lobby.",
      );
    }
    if (page.isClosed())
      throw new Error("Google Meet closed while the notetaker was waiting for admission.");

    if (
      await anyVisible([
        page.getByRole("button", { name: /leave call/i }),
        page.locator('[aria-label*="leave call" i], [data-tooltip*="leave call" i]'),
      ])
    ) {
      return;
    }

    const body = await bodyText(page);
    if (/request to join (?:was )?denied|you were denied|can.?t join this call/i.test(body)) {
      throw new Error("The Google Meet host denied the notetaker's request to join.");
    }
    if (/no one responded|ask to join again/i.test(body)) {
      throw new Error(
        "Nobody admitted the notetaker. Ask the meeting host to admit it, then retry.",
      );
    }
    if (/meeting has ended|this meeting is no longer available/i.test(body)) {
      throw new Error("The Google Meet call ended before the notetaker was admitted.");
    }
    await delayUntil(UI_POLL_MS, args.signal);
  }
}

/** Wait until Meet ends, the schedule expires, or the dispatcher aborts. */
export async function waitForGoogleMeetToEnd(page: Page, args: GoogleMeetJoinArgs): Promise<void> {
  for (;;) {
    if (args.signal.aborted || page.isClosed()) return;
    const remaining = args.scheduledEndAt
      ? args.scheduledEndAt.getTime() - Date.now()
      : Number.POSITIVE_INFINITY;
    if (remaining <= 0) return;

    const body = await bodyText(page);
    if (
      /you left the meeting|meeting has ended|you were removed from the meeting|return to home screen/i.test(
        body,
      )
    ) {
      return;
    }
    try {
      const current = new URL(page.url());
      if (current.hostname !== "meet.google.com" || !MEET_CODE_RE.test(current.pathname)) return;
    } catch {
      return;
    }

    await delayUntil(Math.min(MEETING_POLL_MS, remaining), args.signal);
  }
}

async function waitForFirstVisible(
  locators: ReturnType<Page["locator"]>[],
  cutoff: number,
  signal: AbortSignal,
): Promise<ReturnType<Page["locator"]> | null> {
  for (;;) {
    if (signal.aborted || Date.now() >= cutoff) return null;
    for (const locator of locators) {
      const candidate = locator.first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await delayUntil(UI_POLL_MS, signal);
  }
}

async function clickFirstVisible(locators: ReturnType<Page["locator"]>[]): Promise<boolean> {
  for (const locator of locators) {
    const candidate = locator.first();
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return true;
    }
  }
  return false;
}

async function anyVisible(locators: ReturnType<Page["locator"]>[]): Promise<boolean> {
  for (const locator of locators) {
    if (
      await locator
        .first()
        .isVisible()
        .catch(() => false)
    )
      return true;
  }
  return false;
}

async function bodyText(page: Page): Promise<string> {
  return page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
}

async function delayUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim();
          reject(
            new Error(`${command} failed: ${error.message}${detail ? `. ${detail}` : ""}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error(message));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error(message));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", aborted);
        reject(err);
      },
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function actionError(action: string, err: unknown): Error {
  return new Error(`Could not ${action}: ${errorMessage(err)}`, { cause: err });
}

function errorWithCleanup(primary: unknown, cleanupErrors: Error[]): Error {
  const cleanup = cleanupErrors.map((error) => error.message).join("; ");
  return new Error(`${errorMessage(primary)}${cleanup ? ` Cleanup also failed: ${cleanup}` : ""}`, {
    cause: primary,
  });
}

function isAbortDrivenError(err: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (err === signal.reason) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return /abort|stopp(?:ed|ing)|shutting down/i.test(errorMessage(err));
}
