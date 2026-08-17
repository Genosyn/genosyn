import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";

const MAX_STDOUT_BUFFER = 32 * 1024 * 1024;
const MAX_STDERR_BUFFER = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_TERM_MS = 1_000;
const CLOSE_KILL_MS = 3_000;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

type JsonObject = Record<string, unknown>;
type JsonRpcId = number | string;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export type CodexAppServerOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Config overrides use the same `key=value` syntax as `codex -c`. */
  configOverrides?: string[];
  requestTimeoutMs?: number;
  onServerRequest?: ServerRequestHandler;
  /** Test seam; production resolves the pinned `@openai/codex` entry point. */
  entrypoint?: string;
};

export class CodexAppServerError extends Error {
  readonly code: number | string | null;
  readonly data: unknown;

  constructor(message: string, code: number | string | null = null, data?: unknown) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Minimal JSONL client for the official `codex app-server` protocol.
 *
 * The process is deliberately short-lived. Callers provide an isolated
 * `CODEX_HOME`, use ephemeral threads, and close the server after one login or
 * AI Employee turn. This class owns only transport concerns; credential
 * materialization and Genosyn tool dispatch live in the sibling services.
 */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly onServerRequest?: ServerRequestHandler;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notifications = new Set<NotificationHandler>();
  private readonly exits = new Set<(error: Error | null) => void>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private processExited = false;
  private exitError: Error | null = null;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  private constructor(child: ChildProcessWithoutNullStreams, options: CodexAppServerOptions) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onServerRequest = options.onServerRequest;
    this.exited = new Promise<void>((resolve) => {
      this.resolveExited = resolve;
    });
    this.attachProcessListeners();
  }

  static async start(options: CodexAppServerOptions): Promise<CodexAppServer> {
    const entrypoint = options.entrypoint ?? resolveCodexEntrypoint();
    const args = ["app-server", "--stdio", "--strict-config"];
    for (const override of options.configOverrides ?? []) {
      args.push("-c", override);
    }

    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const server = new CodexAppServer(child, options);

    try {
      const initialized = await server.request<{ codexHome?: string }>(
        "initialize",
        {
          clientInfo: {
            name: "genosyn",
            title: "Genosyn",
            version: process.env.APP_VERSION || "dev",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
        20_000,
      );
      if (options.env.CODEX_HOME) {
        const [expectedHome, reportedHome] = await Promise.all([
          fs.realpath(options.env.CODEX_HOME),
          typeof initialized.codexHome === "string"
            ? fs.realpath(initialized.codexHome)
            : Promise.resolve(""),
        ]);
        if (!reportedHome || reportedHome !== expectedHome) {
          throw new CodexAppServerError(
            "OpenAI Codex app-server did not honor Genosyn's isolated CODEX_HOME.",
            "CODEX_HOME_MISMATCH",
          );
        }
      }
      await server.notify("initialized");
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async request<T>(
    method: string,
    params: unknown = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    this.assertOpen();
    const id = this.nextId++;

    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexAppServerError(
            `OpenAI Codex app-server timed out waiting for ${method}.`,
            "TIMEOUT",
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    try {
      await this.writeMessage({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(asError(error));
      }
    }
    return response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.assertOpen();
    await this.writeMessage(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  onExit(handler: (error: Error | null) => void): () => void {
    this.exits.add(handler);
    if (this.processExited) queueMicrotask(() => handler(this.exitError));
    return () => this.exits.delete(handler);
  }

  stderrSummary(): string {
    return cleanDiagnostic(this.stderrBuffer);
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exited;
      return;
    }

    this.closed = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const terminate = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        signalChild(this.child, "SIGTERM");
      }
    }, CLOSE_TERM_MS);
    const force = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        signalChild(this.child, "SIGKILL");
      }
    }, CLOSE_KILL_MS);
    terminate.unref?.();
    force.unref?.();
    await this.exited;
    clearTimeout(terminate);
    clearTimeout(force);
  }

  private attachProcessListeners(): void {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = appendCapped(this.stderrBuffer, chunk, MAX_STDERR_BUFFER);
    });
    this.child.on("error", (error) => {
      this.fail(error);
      void this.close();
    });
    this.child.on("close", (code, signal) => {
      let error: Error | null = null;
      if (!this.closed) {
        const detail = this.stderrSummary();
        error = new CodexAppServerError(
          `OpenAI Codex app-server exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})${
            detail ? `: ${detail}` : "."
          }`,
          code,
        );
      }
      this.finalizeProcessExit(error);
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      this.failAndClose(
        new CodexAppServerError(
          "OpenAI Codex app-server emitted an oversized protocol message.",
          "MESSAGE_TOO_LARGE",
        ),
      );
      return;
    }

    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAndClose(
          new CodexAppServerError("OpenAI Codex app-server emitted invalid JSON.", "INVALID_JSON"),
        );
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(value: unknown): void {
    const message = asObject(value);
    if (!message) return;

    const id = rpcId(message.id);
    const method = typeof message.method === "string" ? message.method : null;
    if (id !== null && !method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = asObject(message.error);
      if (error) {
        pending.reject(
          new CodexAppServerError(
            typeof error.message === "string" ? error.message : "OpenAI Codex request failed.",
            typeof error.code === "number" || typeof error.code === "string" ? error.code : null,
            error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!method) return;
    if (id !== null) {
      void this.handleServerRequest(id, method, message.params);
      return;
    }
    for (const handler of this.notifications) {
      try {
        handler(method, message.params);
      } catch {
        // A UI/logging callback must never break the protocol reader.
      }
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.onServerRequest) {
      await this.writeMessage({
        id,
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      }).catch(() => undefined);
      return;
    }

    try {
      const result = await this.onServerRequest(method, params);
      await this.writeMessage({ id, result });
    } catch (error) {
      await this.writeMessage({
        id,
        error: {
          code: -32000,
          message: safeErrorMessage(error),
        },
      }).catch(() => undefined);
    }
  }

  private async writeMessage(message: JsonObject): Promise<void> {
    this.assertOpen();
    const line = `${JSON.stringify(message)}\n`;
    if (this.child.stdin.write(line)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(
          this.exitError ??
            new CodexAppServerError("OpenAI Codex app-server closed while writing a request."),
        );
      };
      const cleanup = () => {
        this.child.stdin.off("drain", onDrain);
        this.child.stdin.off("error", onError);
        this.child.stdin.off("close", onClose);
      };
      this.child.stdin.once("drain", onDrain);
      this.child.stdin.once("error", onError);
      this.child.stdin.once("close", onClose);
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw this.exitError ?? new CodexAppServerError("OpenAI Codex app-server is closed.");
    }
  }

  private fail(error: Error): void {
    this.exitError = this.exitError ?? error;
    this.rejectPending(this.exitError);
  }

  private failAndClose(error: Error): void {
    this.fail(error);
    void this.close();
  }

  private finalizeProcessExit(error: Error | null): void {
    if (this.processExited) return;
    this.processExited = true;
    this.closed = true;
    this.exitError = this.exitError ?? error;
    const reason =
      this.exitError ??
      new CodexAppServerError("OpenAI Codex app-server closed before the request completed.");
    this.rejectPending(reason);
    for (const handler of this.exits) {
      try {
        handler(this.exitError);
      } catch {
        // Exit observers are advisory.
      }
    }
    this.resolveExited();
  }

  private rejectPending(reason: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

function signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group already changed.
    }
  }
  child.kill(signal);
}

function resolveCodexEntrypoint(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("@openai/codex/bin/codex.js");
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function rpcId(value: unknown): JsonRpcId | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function appendCapped(current: string, next: string, cap: number): string {
  const combined = current + next;
  return combined.length <= cap ? combined : combined.slice(combined.length - cap);
}

/**
 * Keep the end of the stream, not the start: whether the server exited or a
 * sign-in failed, the lines that explain it are the ones Codex printed last.
 */
function cleanDiagnostic(value: string): string {
  const collapsed = value.replace(ANSI_ESCAPE, "").replace(/\s+/g, " ").trim();
  return collapsed.slice(Math.max(0, collapsed.length - 1_000));
}

function safeErrorMessage(error: unknown): string {
  return asError(error).message.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
