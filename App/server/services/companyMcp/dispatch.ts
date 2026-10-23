import http from "node:http";
import type { Socket } from "node:net";
import { AsyncResource } from "node:async_hooks";
import { Duplex } from "node:stream";

/**
 * Calling the App's own HTTP API from inside the App, without a network.
 *
 * The Genosyn MCP server never reimplements an operation. A tool call becomes
 * an ordinary HTTP request — method, path, headers, body — handed to the very
 * Express app the server listens with, so every guard, validator, audit row
 * and side effect runs exactly as it does for a request from outside. The
 * request travels over an in-memory socket pair instead of a TCP port: one end
 * goes to a private `http.Server` wrapping the app (Node documents injecting
 * "any Duplex stream" through its `connection` event), the other to
 * `http.request`. Node's own parsers sit on both ends, so what the app sees is
 * byte for byte what it would see over loopback — without depending on which
 * port or interface the server happens to listen on.
 *
 * Two details keep the request faithful to the one it stands in for:
 *
 * - **Who it comes from.** The server end reports the outer request's remote
 *   address and TLS state, and the caller forwards its `X-Forwarded-*`
 *   headers, so `req.ip`, `req.protocol` and `req.secure` resolve exactly as
 *   they did for the MCP request, under the same `trust proxy` setting.
 * - **A clean context.** The connection is opened in an async scope created
 *   when this module loaded, so nothing the outer request carries in an
 *   AsyncLocalStorage — a transaction scope, an audit context — leaks into
 *   the inner one. A request from outside starts with none, and so does this.
 */

/** One end of an in-memory connection; whatever it writes, its peer reads. */
class PipeSocket extends Duplex {
  peer: PipeSocket | null = null;
  // The parts of `net.Socket` Express reads when it works out who is calling.
  remoteAddress?: string;
  remotePort?: number;
  remoteFamily?: string;
  localAddress?: string;
  localPort?: number;
  encrypted?: boolean;

  override _read(): void {
    // Data arrives when the peer writes; there is nothing to pull.
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const peer = this.peer;
    if (!peer || peer.destroyed) {
      callback(new Error("The in-process connection is closed"));
      return;
    }
    peer.push(chunk);
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      peer.peer = null;
      if (!peer.destroyed) peer.destroy();
    }
    callback(error);
  }

  // Socket options that mean nothing in memory. `http` calls some of them.
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

/** A connected pair: [client end, server end]. */
function socketPair(): [PipeSocket, PipeSocket] {
  const client = new PipeSocket();
  const server = new PipeSocket();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

/** Created at module load, outside any request: inner requests start from its empty context. */
const CLEAN_SCOPE = new AsyncResource("GenosynMcpInProcessRequest");

const servers = new WeakMap<object, http.Server>();

/** A server that never listens, wrapping `app`; connections are handed to it directly. */
function serverFor(app: http.RequestListener): http.Server {
  let server = servers.get(app);
  if (!server) {
    server = http.createServer(app);
    servers.set(app, server);
  }
  return server;
}

export type InProcessRequest = {
  method: string;
  /** The request target: path and query string, e.g. `/api/companies/<id>/tags?limit=5`. */
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** Who the request comes from, copied from the request it stands in for. */
  remote?: { address?: string; port?: number; family?: string; encrypted?: boolean };
  /** Give up after this long. */
  timeoutMs: number;
  /** Read at most this many response bytes; the rest is dropped and `truncated` set. */
  maxResponseBytes: number;
  /**
   * A tighter limit for one response, chosen from its headers once they
   * arrive — so a file too large to use is never read at all. 0 reads nothing.
   */
  responseLimit?: (headers: http.IncomingHttpHeaders) => number;
  signal?: AbortSignal;
};

export type InProcessResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The response was longer than `maxResponseBytes`, or still streaming when it was cut off. */
  truncated: boolean;
};

export class InProcessRequestError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "aborted" | "failed",
  ) {
    super(message);
    this.name = "InProcessRequestError";
  }
}

/**
 * Send one HTTP request to `app` in memory and collect its response.
 *
 * A response that streams without end — an event stream — is cut off at the
 * byte limit or the timeout; whatever arrived by then is returned, marked
 * `truncated`, when headers had already come back.
 */
export function requestInProcess(
  app: http.RequestListener,
  request: InProcessRequest,
): Promise<InProcessResponse> {
  if (request.signal?.aborted) {
    return Promise.reject(new InProcessRequestError("The request was cancelled", "aborted"));
  }
  const [client, serverEnd] = socketPair();
  serverEnd.remoteAddress = request.remote?.address;
  serverEnd.remotePort = request.remote?.port;
  serverEnd.remoteFamily = request.remote?.family;
  serverEnd.encrypted = request.remote?.encrypted || undefined;
  const server = serverFor(app);
  CLEAN_SCOPE.runInAsyncScope(() => server.emit("connection", serverEnd));

  return new Promise<InProcessResponse>((resolve, reject) => {
    let settled = false;
    let response: http.IncomingMessage | null = null;
    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;

    const finish = (outcome: { error?: InProcessRequestError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (response && (!outcome.error || outcome.error.code !== "aborted")) {
        // Headers arrived: hand back what came, cut short if need be.
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
          truncated: truncated || Boolean(outcome.error),
        });
      } else {
        reject(outcome.error ?? new InProcessRequestError("No response", "failed"));
      }
      outgoing.destroy();
      client.destroy();
    };

    const outgoing = http.request(
      {
        method: request.method,
        path: request.path,
        headers: {
          ...request.headers,
          connection: "close",
          "content-length": String(request.body?.length ?? 0),
        },
        createConnection: () => client as unknown as Socket,
      },
      (incoming) => {
        response = incoming;
        const limit = Math.max(
          0,
          Math.min(
            request.maxResponseBytes,
            request.responseLimit?.(incoming.headers) ?? request.maxResponseBytes,
          ),
        );
        if (limit === 0) {
          // Nothing of this one is wanted: answer with its headers alone.
          truncated = true;
          finish({});
          return;
        }
        incoming.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (received + chunk.length > limit) {
            chunks.push(chunk.subarray(0, Math.max(0, limit - received)));
            received = limit;
            truncated = true;
            finish({});
            return;
          }
          received += chunk.length;
          chunks.push(chunk);
        });
        incoming.on("end", () => finish({}));
        incoming.on("error", (error: Error) =>
          finish({ error: new InProcessRequestError(error.message, "failed") }),
        );
        incoming.on("close", () =>
          finish(
            incoming.complete
              ? {}
              : {
                  error: new InProcessRequestError(
                    "The connection closed before the response finished",
                    "failed",
                  ),
                },
          ),
        );
      },
    );
    outgoing.on("error", (error: Error) => {
      if (error instanceof InProcessRequestError) finish({ error });
      else finish({ error: new InProcessRequestError(error.message, "failed") });
    });

    const timer = setTimeout(
      () =>
        finish({
          error: new InProcessRequestError(
            `Genosyn did not answer within ${Math.round(request.timeoutMs / 1000)} seconds`,
            "timeout",
          ),
        }),
      request.timeoutMs,
    );
    const onAbort = () =>
      finish({ error: new InProcessRequestError("The request was cancelled", "aborted") });
    request.signal?.addEventListener("abort", onAbort, { once: true });

    outgoing.end(request.body);
  });
}
