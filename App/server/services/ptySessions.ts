import { randomUUID } from "node:crypto";
import * as nodePty from "node-pty";

/**
 * In-process registry of pty-backed sessions used by the in-app installer
 * and sign-in surfaces. The flow is the same for both:
 *
 *   1. Route handler calls `createPtySession(...)` with the argv + env.
 *   2. The browser polls `/status?session=<id>` for new output bytes and the
 *      exit state — keeping this poll-based avoids dragging a second
 *      WebSocket surface in next to the workspace-chat one.
 *   3. The browser sends keystrokes back via `/input` (paste-back of a code,
 *      ENTER to advance a prompt, etc.).
 *
 * Sessions self-destruct 60s after exit so a polling client always gets one
 * "yes it ended" response before the record is gone. A periodic sweep also
 * clears anything older than the hard ceiling, so a closed tab can't leak a
 * pty forever.
 */
export type SessionKind = "install" | "login";

type Session = {
  id: string;
  kind: SessionKind;
  /** Provider this session is for ("claude-code" | "codex" | …). */
  provider: string;
  /** Who started it — used to gate `/status` reads to the same company. */
  companyId: string;
  /** Employee dir owning the credentials this login produces. */
  employeeId: string;
  pty: nodePty.IPty;
  /** Append-only output buffer; the browser reads slices via `since`. */
  output: string;
  /** Hard cap on `output` so a runaway CLI can't OOM the server. */
  outputCap: number;
  /** True once `output` hit `outputCap`; we stop appending after that. */
  truncated: boolean;
  exitCode: number | null;
  exitedAt: number | null;
  startedAt: number;
};

const SESSIONS = new Map<string, Session>();

/** Hard ceiling on per-session output. 256 KB easily covers any sane login
 * flow (typically <4 KB) without being so generous a stuck CLI could
 * accumulate a meaningful fraction of the heap. */
const OUTPUT_CAP_BYTES = 256 * 1024;

/** Drop sessions this many ms after exit. */
const POST_EXIT_TTL_MS = 60_000;

/** Drop sessions this many ms after start regardless of exit — this is the
 * "tab was closed mid-login" floor that prevents leaks. */
const HARD_TTL_MS = 30 * 60 * 1000;

let sweeperStarted = false;
function ensureSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of SESSIONS.entries()) {
      const expired =
        (s.exitedAt !== null && now - s.exitedAt > POST_EXIT_TTL_MS) ||
        now - s.startedAt > HARD_TTL_MS;
      if (!expired) continue;
      try {
        s.pty.kill();
      } catch {
        // pty already gone
      }
      SESSIONS.delete(id);
    }
  }, 15_000).unref();
}

export type CreateSessionArgs = {
  kind: SessionKind;
  provider: string;
  companyId: string;
  employeeId: string;
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
};

export class PtySpawnError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly cause: Error,
  ) {
    super(`Failed to spawn ${cmd}: ${cause.message}`);
    this.name = "PtySpawnError";
  }
}

export function createPtySession(args: CreateSessionArgs): Session {
  ensureSweeper();
  const id = randomUUID();
  // 80×24 is the universal default. Some CLIs render their OAuth URL on a
  // single line that wraps if the column count is too small; 120 keeps the
  // URL on one line for the regex extractor on the client.
  let pty: nodePty.IPty;
  try {
    pty = nodePty.spawn(args.cmd, args.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: args.cwd,
      env: args.env as { [key: string]: string },
    });
  } catch (err) {
    // node-pty's posix_spawnp throws synchronously on ENOENT (cmd not found
    // on PATH) or EACCES. We translate to a typed error so the route layer
    // can return a clean 500 with the underlying cause instead of crashing
    // the server.
    throw new PtySpawnError(args.cmd, err instanceof Error ? err : new Error(String(err)));
  }
  const session: Session = {
    id,
    kind: args.kind,
    provider: args.provider,
    companyId: args.companyId,
    employeeId: args.employeeId,
    pty,
    output: "",
    outputCap: OUTPUT_CAP_BYTES,
    truncated: false,
    exitCode: null,
    exitedAt: null,
    startedAt: Date.now(),
  };
  pty.onData((chunk) => {
    if (session.truncated) return;
    if (session.output.length + chunk.length > session.outputCap) {
      session.output = session.output + chunk.slice(0, session.outputCap - session.output.length);
      session.output += "\r\n[output truncated — install/login still running]\r\n";
      session.truncated = true;
      return;
    }
    session.output += chunk;
  });
  pty.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    session.exitedAt = Date.now();
  });
  SESSIONS.set(id, session);
  return session;
}

export function getPtySession(id: string): Session | null {
  return SESSIONS.get(id) ?? null;
}

export function killPtySession(id: string): void {
  const s = SESSIONS.get(id);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    // already dead
  }
  // Don't delete from the map yet — let the sweeper do it after the post-exit
  // grace period so a polling client gets one "exited" response.
}

/** Public view of a session for `/status` responses. */
export type SessionView = {
  sessionId: string;
  kind: SessionKind;
  provider: string;
  /** Output starting at `since`. The client passes back its own running total. */
  output: string;
  /** Total output length so far — the client uses this to advance `since`. */
  totalBytes: number;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
};

export function viewSession(s: Session, since: number): SessionView {
  const safeSince = Math.max(0, Math.min(since, s.output.length));
  return {
    sessionId: s.id,
    kind: s.kind,
    provider: s.provider,
    output: s.output.slice(safeSince),
    totalBytes: s.output.length,
    truncated: s.truncated,
    exited: s.exitedAt !== null,
    exitCode: s.exitCode,
  };
}

export function writeToSession(id: string, data: string): boolean {
  const s = SESSIONS.get(id);
  if (!s || s.exitedAt !== null) return false;
  try {
    s.pty.write(data);
    return true;
  } catch {
    return false;
  }
}
