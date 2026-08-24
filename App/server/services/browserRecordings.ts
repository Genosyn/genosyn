import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Run } from "../db/entities/Run.js";
import {
  browserRecordingFile,
  browserRecordingRunDir,
  browserRecordingsCompanyDir,
} from "./paths.js";

export type BrowserRecordingStatus = "recording" | "finalizing" | "ready" | "failed";

export type BrowserRecordingInfo = {
  id: string;
  status: BrowserRecordingStatus;
  startedAt: string | null;
  finishedAt: string | null;
  mimeType: "video/mp4";
  sizeBytes: number;
  filename: string;
};

type EncoderResult = { ok: true } | { ok: false; warning: string };

export type BrowserRecordingEncoder = {
  writeFrame(frame: Buffer): boolean;
  finish(): Promise<EncoderResult>;
  abort(): Promise<void>;
};

export type BrowserRecordingEncoderFactory = (args: {
  partPath: string;
  width: number;
  height: number;
  framesPerSecond: number;
}) => Promise<BrowserRecordingEncoder>;

export type BrowserRecordingPartialValidator = (partPath: string) => Promise<boolean>;

export type BrowserRecordingFinishResult = {
  recording: BrowserRecordingInfo | null;
  warning: string | null;
};

type ActiveRecording = {
  session: BrowserSession;
  encoder: BrowserRecordingEncoder;
  startedAt: string;
  latestFrame: Buffer | null;
  frameCount: number;
  timer: NodeJS.Timeout | null;
  status: "recording" | "finalizing";
  finishing: Promise<BrowserRecordingFinishResult> | null;
};

type PersistedRecording = BrowserRecordingInfo;

/** Low fixed cadence: enough to preserve transient page states without high CPU/storage cost. */
export const BROWSER_RECORDING_FPS = 4;
export const BROWSER_RECORDING_MAX_WIDTH = 1280;
export const BROWSER_RECORDING_MAX_HEIGHT = 800;
export const BROWSER_RECORDING_MAX_BITRATE_BITS_PER_SECOND = 400_000;
export const BROWSER_RECORDING_MAX_RUN_SECONDS = 6 * 60 * 60;
/**
 * A maximum-length Routine contributes at most 1.08 GB of H.264 payload at
 * the enforced 400 kbit/s ceiling. Two GiB leaves ample room for fragmented
 * MP4 overhead while retaining a hard per-session storage bound.
 */
export const BROWSER_RECORDING_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const FRAME_INTERVAL_MS = 1000 / BROWSER_RECORDING_FPS;
const MAX_JPEG_BYTES = 8 * 1024 * 1024;
const FFMPEG_FINISH_TIMEOUT_MS = 5_000;
const STDERR_LIMIT = 4_096;
const activeRecordings = new Map<string, ActiveRecording>();
const beginPromises = new Map<string, Promise<BrowserRecordingInfo | null>>();
const beginScopes = new Map<string, Pick<BrowserSession, "companyId" | "runId">>();
// Sessions whose capture is being thrown away because the Run, Routine, or
// Company that owns it is going away. This is cancellation, not privacy: a
// recording is never withheld from the humans allowed to watch it.
const abandonPromises = new Map<string, Promise<void>>();
const abandonedSessionIds = new Set<string>();
const frozenSessionIds = new Set<string>();
// Deletion tombstones intentionally live until process restart. Company and
// Run ids are immutable UUIDs, so retaining the tiny keys closes the window
// where an already-running model could recreate an artifact after its owning
// resource was removed.
const deletingCompanyIds = new Set<string>();
const deletingEmployeeIds = new Set<string>();
const deletingRoutineIds = new Set<string>();
const deletingRunIds = new Set<string>();
const finalizingRunIds = new Map<string, number>();
const RUN_FINALIZING_TOMBSTONE_TTL_MS = 7 * 60 * 60 * 1000;

function runFinalizing(runId: string): boolean {
  const expiresAt = finalizingRunIds.get(runId);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  finalizingRunIds.delete(runId);
  return false;
}

function deletionBlocked(
  session: Pick<BrowserSession, "companyId" | "runId">,
  allowFinalizingRun = false,
): boolean {
  return (
    deletingCompanyIds.has(session.companyId) ||
    (session.runId !== null &&
      (deletingRunIds.has(session.runId) ||
        (!allowFinalizingRun && runFinalizing(session.runId))))
  );
}

/** Prevent browser-session creation from racing resource deletion. */
export function browserSessionCreationBlocked(companyId: string, runId: string | null): boolean {
  return (
    deletingCompanyIds.has(companyId) ||
    (runId !== null && (deletingRunIds.has(runId) || runFinalizing(runId)))
  );
}

/** Close the creation/intake boundary before a Run's terminal session snapshot. */
export function markBrowserRecordingRunFinalizing(runId: string): void {
  finalizingRunIds.set(runId, Date.now() + RUN_FINALIZING_TOMBSTONE_TTL_MS);
}

/** Release once the Run row is durably terminal (or gone). */
export function releaseBrowserRecordingRunFinalizing(runId: string): void {
  finalizingRunIds.delete(runId);
}

export function browserRunCreationBlocked(args: {
  companyId?: string;
  employeeId: string;
  routineId: string;
}): boolean {
  return (
    (args.companyId !== undefined && deletingCompanyIds.has(args.companyId)) ||
    deletingEmployeeIds.has(args.employeeId) ||
    deletingRoutineIds.has(args.routineId)
  );
}

/** Install authority-level tombstones before a deletion snapshots child Runs. */
export function markBrowserRecordingRoutineDeleting(routineId: string): void {
  deletingRoutineIds.add(routineId);
}

export function markBrowserRecordingEmployeeDeleting(employeeId: string): void {
  deletingEmployeeIds.add(employeeId);
}

async function probeFragmentedMp4(partPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=stream_index",
        "-read_intervals",
        "%+#1",
        "-of",
        "csv=p=0",
        partPath,
      ],
      { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "", LANG: "C" } },
    );
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(valid);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < 128) output += chunk.toString("utf8").slice(0, 128);
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0 && output.trim().length > 0));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 3_000);
    if (typeof timer.unref === "function") timer.unref();
  });
}

let partialValidator: BrowserRecordingPartialValidator = probeFragmentedMp4;

function assertSafeId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid browser recording id");
}

function recordingPaths(session: Pick<BrowserSession, "id" | "companyId" | "runId">): {
  directory: string;
  finalPath: string;
  partPath: string;
  metadataPath: string;
  /** Written by builds that withheld recordings. Only ever removed now. */
  legacyRestrictedMarkerPath: string;
} {
  if (!session.runId) throw new Error("Browser recording requires a Run");
  assertSafeId(session.companyId);
  assertSafeId(session.runId);
  assertSafeId(session.id);
  const finalPath = browserRecordingFile(session.companyId, session.runId, session.id);
  return {
    directory: browserRecordingRunDir(session.companyId, session.runId),
    finalPath,
    partPath: `${finalPath}.part`,
    legacyRestrictedMarkerPath: `${finalPath}.restricted`,
    metadataPath: path.join(
      browserRecordingRunDir(session.companyId, session.runId),
      `${session.id}.json`,
    ),
  };
}

function baseInfo(
  session: Pick<BrowserSession, "id">,
  status: BrowserRecordingStatus,
  startedAt: string | null,
  finishedAt: string | null,
  sizeBytes = 0,
): BrowserRecordingInfo {
  return {
    id: session.id,
    status,
    startedAt,
    finishedAt,
    mimeType: "video/mp4",
    sizeBytes,
    filename: `${session.id}.mp4`,
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function writeMetadata(session: BrowserSession, info: BrowserRecordingInfo): Promise<void> {
  const paths = recordingPaths(session);
  await ensurePrivateDirectory(paths.directory);
  const temporary = `${paths.metadataPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600).catch(() => undefined);
  await fs.rename(temporary, paths.metadataPath);
}

async function readMetadata(session: BrowserSession): Promise<PersistedRecording | null> {
  try {
    // `status` is read as a plain string: a file on disk may have been written
    // by a build whose union differs from this one's.
    const value = JSON.parse(
      await fs.readFile(recordingPaths(session).metadataPath, "utf8"),
    ) as Partial<Omit<PersistedRecording, "status">> & { status?: string };
    const statuses: BrowserRecordingStatus[] = ["recording", "finalizing", "ready", "failed"];
    // Builds that withheld recordings deleted the bytes before writing this
    // status, so there is nothing left to publish — report the honest terminal
    // state instead of a status this build no longer has.
    const status = value.status === "restricted" ? "failed" : value.status;
    if (value.id !== session.id || !statuses.includes(status as BrowserRecordingStatus)) {
      return null;
    }
    return baseInfo(
      session,
      status as BrowserRecordingStatus,
      typeof value.startedAt === "string" ? value.startedAt : null,
      typeof value.finishedAt === "string" ? value.finishedAt : null,
      typeof value.sizeBytes === "number" && value.sizeBytes >= 0 ? value.sizeBytes : 0,
    );
  } catch {
    return null;
  }
}

async function statSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function removeFiles(paths: ReturnType<typeof recordingPaths>): Promise<void> {
  await Promise.all([
    fs.rm(paths.finalPath, { force: true }),
    fs.rm(paths.partPath, { force: true }),
    fs.rm(paths.legacyRestrictedMarkerPath, { force: true }),
  ]);
}

function capDimension(value: number, maximum: number): number {
  const safe = Number.isFinite(value) ? Math.floor(value) : 1;
  const bounded = Math.max(2, Math.min(maximum, safe));
  // libx264's yuv420p planes require even dimensions.
  return bounded % 2 === 0 ? bounded : bounded - 1;
}

function createFfmpegEncoder(args: {
  partPath: string;
  width: number;
  height: number;
  framesPerSecond: number;
}): Promise<BrowserRecordingEncoder> {
  return new Promise((resolve, reject) => {
    const width = capDimension(args.width, BROWSER_RECORDING_MAX_WIDTH);
    const height = capDimension(args.height, BROWSER_RECORDING_MAX_HEIGHT);
    const videoFilter = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      "setsar=1",
    ].join(",");
    const child = spawn(
      ffmpegExecutable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        String(args.framesPerSecond),
        "-vcodec",
        "mjpeg",
        "-i",
        "pipe:0",
        "-vf",
        videoFilter,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "30",
        "-maxrate",
        String(BROWSER_RECORDING_MAX_BITRATE_BITS_PER_SECOND),
        "-bufsize",
        String(BROWSER_RECORDING_MAX_BITRATE_BITS_PER_SECOND * 2),
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(args.framesPerSecond * 2),
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "-fs",
        String(BROWSER_RECORDING_MAX_FILE_BYTES),
        "-y",
        args.partPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "", LANG: "C" } },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8").slice(0, STDERR_LIMIT);
    });
    let settled = false;
    const rejectSpawn = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", rejectSpawn);
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.off("error", rejectSpawn);
      resolve(childEncoder(child, () => stderr));
    });
  });
}

function childEncoder(child: ChildProcess, stderr: () => string): BrowserRecordingEncoder {
  let backpressured = false;
  let finishRequested = false;
  child.stdin?.on("error", () => {
    // Completion is reported by the child process itself. A broken pipe while
    // it exits must never become an uncaught process-level stream error.
  });
  child.stdin?.on("drain", () => {
    backpressured = false;
  });
  // Attach immediately: ffmpeg can exit before a Run reaches terminal state,
  // and `close`/`error` events are not replayed to late listeners.
  const completion = new Promise<EncoderResult>((resolve) => {
    let resolved = false;
    const finish = (result: EncoderResult) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    child.once("close", (code, signal) => {
      // `-fs` exits cleanly when its byte limit is reached. A zero exit before
      // we close stdin therefore means the capture ended early, not that a
      // complete recording is ready to publish.
      if (code === 0 && finishRequested) finish({ ok: true });
      else {
        const detail = stderr().trim();
        finish({
          ok: false,
          warning:
            detail ||
            (code === 0
              ? "ffmpeg stopped before browser recording finalization"
              : `ffmpeg exited with ${signal ?? `code ${String(code)}`}`),
        });
      }
    });
    child.once("error", (error) => finish({ ok: false, warning: error.message }));
  });
  const waitForClose = (): Promise<EncoderResult> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve({ ok: false, warning: "ffmpeg did not finish before the recording deadline" });
      }, FFMPEG_FINISH_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      completion.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  return {
    writeFrame(frame) {
      if (backpressured || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
        return false;
      }
      try {
        // A false return still means this frame was accepted; only later
        // frames need to wait for `drain`.
        if (!child.stdin.write(frame)) backpressured = true;
        return true;
      } catch {
        return false;
      }
    },
    async finish() {
      finishRequested = true;
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      return waitForClose();
    },
    async abort() {
      if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForClose().catch(() => undefined);
    },
  };
}

let encoderFactory: BrowserRecordingEncoderFactory = createFfmpegEncoder;
let ffmpegExecutable = "ffmpeg";

/** Test seam: avoids making unit tests depend on an ffmpeg installation. */
export function setBrowserRecordingEncoderFactoryForTests(
  factory: BrowserRecordingEncoderFactory | null,
): void {
  encoderFactory = factory ?? createFfmpegEncoder;
}

export function setBrowserRecordingFfmpegExecutableForTests(executable: string | null): void {
  ffmpegExecutable = executable ?? "ffmpeg";
}

export function setBrowserRecordingPartialValidatorForTests(
  validator: BrowserRecordingPartialValidator | null,
): void {
  partialValidator = validator ?? probeFragmentedMp4;
}

export function browserRecordingProcessStateForTests(): { frozen: number; active: number } {
  return { frozen: frozenSessionIds.size, active: activeRecordings.size };
}

/** Clear process-local state between isolated service tests. */
export async function resetBrowserRecordingsForTests(): Promise<void> {
  await Promise.all([...beginPromises.values()].map((promise) => promise.catch(() => null)));
  await Promise.all([...abandonPromises.values()].map((promise) => promise.catch(() => null)));
  await Promise.all(
    [...activeRecordings.values()].map(async (active) => {
      if (active.timer) clearInterval(active.timer);
      await active.encoder.abort().catch(() => undefined);
    }),
  );
  activeRecordings.clear();
  beginPromises.clear();
  beginScopes.clear();
  abandonPromises.clear();
  abandonedSessionIds.clear();
  frozenSessionIds.clear();
  deletingCompanyIds.clear();
  deletingEmployeeIds.clear();
  deletingRoutineIds.clear();
  deletingRunIds.clear();
  finalizingRunIds.clear();
  encoderFactory = createFfmpegEncoder;
  ffmpegExecutable = "ffmpeg";
  partialValidator = probeFragmentedMp4;
}

function writeLatestFrame(active: ActiveRecording): void {
  if (active.status !== "recording" || !active.latestFrame) return;
  if (active.encoder.writeFrame(active.latestFrame)) active.frameCount += 1;
}

async function beginImpl(
  session: BrowserSession,
  allowFinalizingRun: boolean,
): Promise<BrowserRecordingInfo | null> {
  if (
    !session.runId ||
    abandonedSessionIds.has(session.id) ||
    frozenSessionIds.has(session.id) ||
    deletionBlocked(session, allowFinalizingRun)
  ) {
    return null;
  }
  const currentSession = await AppDataSource.getRepository(BrowserSession).findOneBy({
    id: session.id,
    runId: session.runId,
    status: In(["pending", "live"]),
  });
  if (
    !currentSession ||
    abandonedSessionIds.has(session.id) ||
    frozenSessionIds.has(session.id) ||
    deletionBlocked(session, allowFinalizingRun)
  ) {
    return null;
  }
  session = currentSession;
  if (!session.runId) return null;
  const existing = await readMetadata(session);
  // Do not retry-spawn an unavailable encoder on every browser action.
  if (existing) return existing;
  const run = await AppDataSource.getRepository(Run).findOne({
    where: { id: session.runId },
    select: { id: true, status: true },
  });
  if (
    !run ||
    run.status !== "running" ||
    abandonedSessionIds.has(session.id) ||
    frozenSessionIds.has(session.id) ||
    deletionBlocked(session, allowFinalizingRun)
  ) {
    return null;
  }
  const paths = recordingPaths(session);
  const startedAt = session.startedAt?.toISOString() ?? new Date().toISOString();
  let encoder: BrowserRecordingEncoder | null = null;
  try {
    await ensurePrivateDirectory(paths.directory);
    await removeFiles(paths);
    await fs.writeFile(paths.partPath, "", { mode: 0o600 });
    await fs.chmod(paths.partPath, 0o600).catch(() => undefined);
    encoder = await encoderFactory({
      partPath: paths.partPath,
      width: capDimension(session.viewportWidth, BROWSER_RECORDING_MAX_WIDTH),
      height: capDimension(session.viewportHeight, BROWSER_RECORDING_MAX_HEIGHT),
      framesPerSecond: BROWSER_RECORDING_FPS,
    });
    const runStillRunning = await AppDataSource.getRepository(Run).existsBy({
      id: session.runId,
      status: "running",
    });
    if (
      !runStillRunning ||
      abandonedSessionIds.has(session.id) ||
      frozenSessionIds.has(session.id) ||
      deletionBlocked(session, allowFinalizingRun)
    ) {
      await encoder.abort();
      await removeFiles(paths);
      return null;
    }
    const active: ActiveRecording = {
      session,
      encoder,
      startedAt,
      latestFrame: null,
      frameCount: 0,
      timer: null,
      status: "recording",
      finishing: null,
    };
    active.timer = setInterval(() => writeLatestFrame(active), FRAME_INTERVAL_MS);
    if (typeof active.timer.unref === "function") active.timer.unref();
    activeRecordings.set(session.id, active);
    const info = baseInfo(session, "recording", startedAt, null);
    await writeMetadata(session, info);
    return info;
  } catch {
    const active = activeRecordings.get(session.id);
    if (active?.timer) clearInterval(active.timer);
    activeRecordings.delete(session.id);
    await encoder?.abort().catch(() => undefined);
    await removeFiles(paths).catch(() => undefined);
    const info = baseInfo(session, "failed", startedAt, new Date().toISOString());
    await writeMetadata(session, info).catch(() => undefined);
    return info;
  }
}

/** Start a Run-scoped recording before the first browser action. Non-fatal. */
export async function beginBrowserRecording(
  session: BrowserSession,
  options: { allowFinalizingRun?: boolean } = {},
): Promise<BrowserRecordingInfo | null> {
  const allowFinalizingRun = options.allowFinalizingRun === true;
  if (deletionBlocked(session, allowFinalizingRun) || frozenSessionIds.has(session.id)) return null;
  const active = activeRecordings.get(session.id);
  if (active) return baseInfo(session, active.status, active.startedAt, null);
  const pending = beginPromises.get(session.id);
  if (pending) return pending;
  beginScopes.set(session.id, { companyId: session.companyId, runId: session.runId });
  const promise = beginImpl(session, allowFinalizingRun).finally(() => {
    beginPromises.delete(session.id);
    beginScopes.delete(session.id);
  });
  beginPromises.set(session.id, promise);
  return promise;
}

export function browserRecordingDemand(sessionId: string): boolean {
  return activeRecordings.get(sessionId)?.status === "recording";
}

/**
 * Stop accepting frames synchronously while preserving clean bytes already
 * captured. Used before the last password scan so no frame can arrive between
 * the scan and encoder finalization.
 */
export function freezeBrowserRecording(sessionId: string): void {
  const active = activeRecordings.get(sessionId);
  frozenSessionIds.add(sessionId);
  if (!active) return;
  active.status = "finalizing";
  if (active.timer) clearInterval(active.timer);
  active.timer = null;
}

/** Clear a freeze tombstone after tearing down a non-Run browser session. */
export function clearBrowserRecordingFreeze(sessionId: string): void {
  frozenSessionIds.delete(sessionId);
}

/** Accept one JPEG from the existing CDP screencast. */
export function acceptBrowserRecordingFrame(sessionId: string, base64Jpeg: string): void {
  const active = activeRecordings.get(sessionId);
  if (!active || active.status !== "recording" || abandonedSessionIds.has(sessionId)) return;
  try {
    const frame = Buffer.from(base64Jpeg, "base64");
    if (frame.length === 0 || frame.length > MAX_JPEG_BYTES) return;
    active.latestFrame = frame;
    if (active.frameCount === 0) writeLatestFrame(active);
  } catch {
    // A malformed CDP frame must not affect the browser action or Run.
  }
}

/** Stop extending a recording after its browser closes, without finalizing it. */
export function pauseBrowserRecording(sessionId: string): void {
  const active = activeRecordings.get(sessionId);
  if (!active?.timer) return;
  clearInterval(active.timer);
  active.timer = null;
}

/**
 * Throw away a capture whose owning Run, Routine, or Company is being deleted.
 * The in-memory flag is set before the first await so no later CDP frame can
 * enter the encoder while deletion is in progress.
 */
async function abandonImpl(sessionId: string): Promise<void> {
  let active = activeRecordings.get(sessionId);
  const session =
    active?.session ??
    (await AppDataSource.getRepository(BrowserSession).findOneBy({ id: sessionId }));
  if (!session?.runId) {
    abandonedSessionIds.delete(sessionId);
    frozenSessionIds.delete(sessionId);
    return;
  }
  const abandoned = baseInfo(
    session,
    "failed",
    active?.startedAt ?? session.startedAt?.toISOString() ?? null,
    new Date().toISOString(),
  );
  // Persist before waiting for a pending spawn or ffmpeg shutdown, so a crash
  // mid-teardown still leaves a terminal status behind the deleted bytes.
  await writeMetadata(session, abandoned).catch(() => undefined);
  await beginPromises.get(sessionId)?.catch(() => undefined);
  active = activeRecordings.get(sessionId);
  if (active?.timer) clearInterval(active.timer);
  if (active) active.status = "finalizing";
  if (active?.finishing) {
    await active.finishing.catch(() => undefined);
  } else {
    await active?.encoder.abort().catch(() => undefined);
    // A terminal finalizer may have started while abort was in flight.
    await active?.finishing?.catch(() => undefined);
  }
  const paths = recordingPaths(session);
  await removeFiles(paths).catch(() => undefined);
  await writeMetadata(session, abandoned).catch(() => undefined);
  if (activeRecordings.get(sessionId) === active) activeRecordings.delete(sessionId);
}

function abandonBrowserRecording(sessionId: string): Promise<void> {
  // Synchronous: both frame intake and a racing begin observe this before any
  // DB, encoder, or filesystem work can yield.
  abandonedSessionIds.add(sessionId);
  const existing = abandonPromises.get(sessionId);
  if (existing) return existing;
  const promise = abandonImpl(sessionId).finally(() => abandonPromises.delete(sessionId));
  abandonPromises.set(sessionId, promise);
  return promise;
}

async function finishActive(active: ActiveRecording): Promise<BrowserRecordingFinishResult> {
  if (active.finishing) return active.finishing;
  const promise = (async () => {
    active.status = "finalizing";
    if (active.timer) clearInterval(active.timer);
    active.timer = null;
    if (active.frameCount === 0) writeLatestFrame(active);
    const session = active.session;
    const paths = recordingPaths(session);
    await writeMetadata(session, baseInfo(session, "finalizing", active.startedAt, null)).catch(
      () => undefined,
    );
    const result = await active.encoder.finish().catch(
      (): EncoderResult => ({
        ok: false,
        warning: "ffmpeg could not finish the browser recording",
      }),
    );
    if (abandonedSessionIds.has(session.id)) {
      await removeFiles(paths).catch(() => undefined);
      const abandoned = baseInfo(session, "failed", active.startedAt, new Date().toISOString());
      await writeMetadata(session, abandoned).catch(() => undefined);
      return { recording: abandoned, warning: null };
    }
    const partSize = await statSize(paths.partPath);
    if (result.ok && active.frameCount > 0 && partSize > 0) {
      await fs.chmod(paths.partPath, 0o600).catch(() => undefined);
      await fs.rename(paths.partPath, paths.finalPath);
      await fs.chmod(paths.finalPath, 0o600).catch(() => undefined);
      const ready = baseInfo(
        session,
        "ready",
        active.startedAt,
        new Date().toISOString(),
        await statSize(paths.finalPath),
      );
      await writeMetadata(session, ready).catch(() => undefined);
      return { recording: ready, warning: null };
    }
    await removeFiles(paths).catch(() => undefined);
    const failed = baseInfo(session, "failed", active.startedAt, new Date().toISOString());
    await writeMetadata(session, failed).catch(() => undefined);
    return {
      recording: failed,
      warning: result.ok ? "no browser frames were captured" : result.warning,
    };
  })().catch(async (error: unknown): Promise<BrowserRecordingFinishResult> => {
    await removeFiles(recordingPaths(active.session)).catch(() => undefined);
    const failed = baseInfo(active.session, "failed", active.startedAt, new Date().toISOString());
    await writeMetadata(active.session, failed).catch(() => undefined);
    return {
      recording: failed,
      warning:
        error instanceof Error ? error.message : "the browser recording file could not be saved",
    };
  });
  const tracked = promise.finally(() => {
    if (activeRecordings.get(active.session.id) === active) {
      activeRecordings.delete(active.session.id);
    }
    frozenSessionIds.delete(active.session.id);
  });
  active.finishing = tracked;
  return tracked;
}

export async function finishBrowserRecording(
  session: BrowserSession,
): Promise<BrowserRecordingFinishResult> {
  await beginPromises.get(session.id)?.catch(() => undefined);
  if (abandonedSessionIds.has(session.id)) {
    await abandonBrowserRecording(session.id);
    frozenSessionIds.delete(session.id);
    return { recording: await readMetadata(session), warning: null };
  }
  const active = activeRecordings.get(session.id);
  if (active) return finishActive(active);
  frozenSessionIds.delete(session.id);
  return { recording: await readMetadata(session), warning: null };
}

async function recoverOneUnsafe(session: BrowserSession): Promise<BrowserRecordingInfo | null> {
  const existing = await readMetadata(session);
  const paths = recordingPaths(session);
  await fs.rm(paths.legacyRestrictedMarkerPath, { force: true }).catch(() => undefined);
  const active = activeRecordings.get(session.id);
  if (active) return (await finishActive(active)).recording;
  // Every frame that reached ffmpeg was already cleared for playback, so an
  // interrupted capture is a question of file integrity, not of whether the
  // bytes may be shown. Publish whatever survived and is playable.
  const finalSize = await statSize(paths.finalPath);
  if (finalSize > 0) {
    const ready = baseInfo(
      session,
      "ready",
      existing?.startedAt ?? session.startedAt?.toISOString() ?? null,
      existing?.finishedAt ?? new Date().toISOString(),
      finalSize,
    );
    await fs.chmod(paths.finalPath, 0o600).catch(() => undefined);
    await writeMetadata(session, ready).catch(() => undefined);
    return ready;
  }
  const partSize = await statSize(paths.partPath);
  if (partSize > 0) {
    if (!(await partialValidator(paths.partPath).catch(() => false))) {
      await fs.rm(paths.partPath, { force: true }).catch(() => undefined);
      const failed = baseInfo(
        session,
        "failed",
        existing?.startedAt ?? session.startedAt?.toISOString() ?? null,
        new Date().toISOString(),
      );
      await writeMetadata(session, failed).catch(() => undefined);
      return failed;
    }
    await fs.chmod(paths.partPath, 0o600).catch(() => undefined);
    await fs.rename(paths.partPath, paths.finalPath);
    const ready = baseInfo(
      session,
      "ready",
      existing?.startedAt ?? session.startedAt?.toISOString() ?? null,
      new Date().toISOString(),
      partSize,
    );
    await writeMetadata(session, ready).catch(() => undefined);
    return ready;
  }
  if (existing?.status === "failed") {
    return existing;
  }
  if (!existing && !session.startedAt) return null;
  const failed = baseInfo(
    session,
    "failed",
    existing?.startedAt ?? session.startedAt?.toISOString() ?? null,
    new Date().toISOString(),
  );
  await writeMetadata(session, failed).catch(() => undefined);
  return failed;
}

async function recoverOne(session: BrowserSession): Promise<BrowserRecordingInfo | null> {
  try {
    return await recoverOneUnsafe(session);
  } catch {
    const paths = recordingPaths(session);
    // A rename may have succeeded before a later chmod/metadata operation
    // failed. Preserve that valid final file so listing (or the next boot) can
    // still surface it as ready; otherwise remove the leftovers and converge
    // the metadata to a terminal failure.
    const finalSize = await statSize(paths.finalPath);
    if (finalSize > 0) {
      const ready = baseInfo(
        session,
        "ready",
        session.startedAt?.toISOString() ?? null,
        new Date().toISOString(),
        finalSize,
      );
      await writeMetadata(session, ready).catch(() => undefined);
      return ready;
    }
    await removeFiles(paths).catch(() => undefined);
    const failed = baseInfo(
      session,
      "failed",
      session.startedAt?.toISOString() ?? null,
      new Date().toISOString(),
    );
    await writeMetadata(session, failed).catch(() => undefined);
    return failed;
  }
}

export async function recoverBrowserRecordingsForRun(runId: string): Promise<void> {
  const sessions = await AppDataSource.getRepository(BrowserSession).findBy({ runId });
  await Promise.all(
    sessions.filter((session) => session.runId).map((session) => recoverOne(session)),
  );
}

export async function listBrowserRecordingsForRun(runId: string): Promise<BrowserRecordingInfo[]> {
  const [sessions, run] = await Promise.all([
    AppDataSource.getRepository(BrowserSession).find({
      where: { runId },
      order: { createdAt: "ASC", id: "ASC" },
    }),
    AppDataSource.getRepository(Run).findOne({
      where: { id: runId },
      select: { id: true, status: true },
    }),
  ]);
  const terminal = run !== null && run.status !== "running";
  const infos = await Promise.all(
    sessions.map(async (session) => {
      if (abandonedSessionIds.has(session.id)) {
        const persisted = await readMetadata(session);
        return baseInfo(
          session,
          "failed",
          persisted?.startedAt ?? session.startedAt?.toISOString() ?? null,
          persisted?.finishedAt ?? session.closedAt?.toISOString() ?? null,
        );
      }
      const active = activeRecordings.get(session.id);
      if (active) {
        if (terminal) {
          // A terminal Run must never retain a process-local encoder. This can
          // only happen after an exceptional finalizer/CAS race; terminalize it
          // here rather than polling `recording` forever.
          const finished = await finishActive(active).catch(() => null);
          return finished?.recording ?? (await readMetadata(session));
        }
        return baseInfo(session, active.status, active.startedAt, null);
      }
      const persisted = await readMetadata(session);
      if (persisted) {
        if (persisted.status === "ready") {
          const sizeBytes = await statSize(recordingPaths(session).finalPath);
          if (sizeBytes > 0 || !terminal) return { ...persisted, sizeBytes };
          return recoverOne(session);
        }
        if (terminal && (persisted.status === "recording" || persisted.status === "finalizing")) {
          return recoverOne(session);
        }
        return persisted;
      }
      // A file without durable ready/finalizing metadata has no privacy-scan
      // attestation. Terminal Runs converge it through fail-closed recovery;
      // active Runs simply hide it until metadata is durably written.
      return terminal ? recoverOne(session) : null;
    }),
  );
  return infos.filter((info): info is BrowserRecordingInfo => info !== null);
}

export async function getBrowserRecordingFile(
  session: BrowserSession,
): Promise<{ path: string; info: BrowserRecordingInfo } | null> {
  if (!session.runId) return null;
  const info = (await listBrowserRecordingsForRun(session.runId)).find(
    (candidate) => candidate.id === session.id,
  );
  if (!info || info.status !== "ready") return null;
  const filePath = recordingPaths(session).finalPath;
  if ((await statSize(filePath)) <= 0) return null;
  return { path: filePath, info };
}

type RecordingScope = Pick<BrowserSession, "companyId" | "runId">;

async function quiesceRecordings(matches: (scope: RecordingScope) => boolean): Promise<void> {
  for (;;) {
    const starts = [...beginPromises.entries()]
      .filter(([sessionId]) => {
        const scope = beginScopes.get(sessionId);
        return scope ? matches(scope) : false;
      })
      .map(([, promise]) => promise.catch(() => null));
    if (starts.length > 0) await Promise.all(starts);

    const actives = [...activeRecordings.values()].filter((active) => matches(active.session));
    if (actives.length === 0) {
      const stillStarting = [...beginScopes.values()].some(matches);
      if (!stillStarting) return;
      continue;
    }
    await Promise.all(
      actives.map(async (active) => {
        abandonedSessionIds.add(active.session.id);
        if (active.timer) clearInterval(active.timer);
        active.timer = null;
        active.status = "finalizing";
        if (active.finishing) {
          await active.finishing.catch(() => undefined);
        } else {
          await active.encoder.abort().catch(() => undefined);
          if (activeRecordings.get(active.session.id) === active) {
            activeRecordings.delete(active.session.id);
          }
        }
      }),
    );
  }
}

async function closeRecordingSessions(sessions: BrowserSession[]): Promise<void> {
  if (sessions.length === 0) return;
  for (const session of sessions) abandonedSessionIds.add(session.id);
  const { closeBrowserSession } = await import("./browserSessions.js");
  await Promise.all(
    sessions.map((session) => closeBrowserSession(session.id, "manual").catch(() => undefined)),
  );
}

export async function deleteBrowserRecordingsForRunIds(runIds: string[]): Promise<void> {
  const uniqueRunIds = [...new Set(runIds.filter(Boolean))];
  if (uniqueRunIds.length === 0) return;
  // This must happen before the first await. A racing first browser action or
  // session creation sees the tombstone synchronously and cannot recreate the
  // artifact tree after this function removes it.
  for (const runId of uniqueRunIds) deletingRunIds.add(runId);
  const repo = AppDataSource.getRepository(BrowserSession);
  const sessions = await repo.findBy({
    runId: In(uniqueRunIds),
  });
  await closeRecordingSessions(sessions);
  await Promise.all(
    [...abandonPromises.values()].map((promise) => promise.catch(() => undefined)),
  );
  const runIdSet = new Set(uniqueRunIds);
  await quiesceRecordings((scope) => scope.runId !== null && runIdSet.has(scope.runId));
  // A create that entered just before the tombstone may commit after the first
  // snapshot. Its post-save check also self-deletes, while this second pass
  // closes it immediately if it became visible here first.
  const lateSessions = await repo.findBy({ runId: In(uniqueRunIds) });
  await closeRecordingSessions(
    lateSessions.filter((session) => !sessions.some((candidate) => candidate.id === session.id)),
  );
  const companyRunPairs = new Set(
    [...sessions, ...lateSessions]
      .filter((session): session is BrowserSession & { runId: string } => !!session.runId)
      .map((session) => `${session.companyId}\0${session.runId}`),
  );
  await Promise.all(
    [...companyRunPairs].map((pair) => {
      const [companyId, runId] = pair.split("\0");
      return fs.rm(browserRecordingRunDir(companyId, runId), { recursive: true, force: true });
    }),
  );
  await repo.delete({ runId: In(uniqueRunIds) });
  for (const session of [...sessions, ...lateSessions]) abandonedSessionIds.delete(session.id);
  for (const session of [...sessions, ...lateSessions]) frozenSessionIds.delete(session.id);
}

export async function deleteBrowserRecordingsForCompany(companyId: string): Promise<void> {
  deletingCompanyIds.add(companyId);
  const repo = AppDataSource.getRepository(BrowserSession);
  const sessions = await repo.findBy({ companyId });
  await closeRecordingSessions(sessions);
  await Promise.all(
    [...abandonPromises.values()].map((promise) => promise.catch(() => undefined)),
  );
  await quiesceRecordings((scope) => scope.companyId === companyId);
  const lateSessions = await repo.findBy({ companyId });
  await closeRecordingSessions(
    lateSessions.filter((session) => !sessions.some((candidate) => candidate.id === session.id)),
  );
  await quiesceRecordings((scope) => scope.companyId === companyId);
  await fs.rm(browserRecordingsCompanyDir(companyId), { recursive: true, force: true });
  await repo.delete({ companyId });
  for (const session of [...sessions, ...lateSessions]) abandonedSessionIds.delete(session.id);
  for (const session of [...sessions, ...lateSessions]) frozenSessionIds.delete(session.id);
}
