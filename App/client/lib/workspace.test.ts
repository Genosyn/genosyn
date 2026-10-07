import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { connectCompanySocket } from "./workspace";

/**
 * A company socket's handle can be closed anywhere in its connect sequence:
 * on a company switch, on unmount, and under React StrictMode, which closes
 * the first handle of every mount while its token is still being minted.
 * Wherever it lands, the closed handle must leave no connection behind and
 * say nothing more through `onStatus`. The provider shows that status as the
 * live socket's, and browser suites wait for it to read "open" before they
 * push a frame.
 */

type Status = "connecting" | "open" | "closed";

/** The browser's WebSocket without the network; each test drives its life. */
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  /** The state the socket was in at each `close()` call. */
  readonly closedFrom: number[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    sockets.push(this);
  }

  close() {
    this.closedFrom.push(this.readyState);
    if (this.readyState !== FakeWebSocket.CLOSED) this.readyState = FakeWebSocket.CLOSING;
  }

  send() {}

  /** The server accepted the upgrade. */
  accept() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** The connection ended, whichever side ended it. */
  end() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const sockets: FakeWebSocket[] = [];
/** Token requests in flight, each answered when the test says so. */
const mints: Array<(token: string) => void> = [];

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  sockets.length = 0;
  mints.length = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/companies/company/workspace/ws-token");
    const token = await new Promise<string>((resolve) => mints.push(resolve));
    return new Response(JSON.stringify({ token }));
  };
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  Object.assign(globalThis, { window: { location: { protocol: "http:", host: "app.test" } } });
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
  Reflect.deleteProperty(globalThis, "window");
});

/** Let answered token requests run through to whatever `open()` does next. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function connect() {
  const statuses: Status[] = [];
  const handle = connectCompanySocket("company", (status) => statuses.push(status));
  return { handle, statuses };
}

describe("connectCompanySocket", () => {
  test("StrictMode's mount, unmount and remount leave one connection, reported by the live handle", async () => {
    const first = connect();
    first.handle.close();
    const second = connect();
    mints[0]("first");
    mints[1]("second");
    await settle();
    assert.deepEqual(
      sockets.map((sock) => sock.url),
      ["ws://app.test/api/ws?token=second"],
      "the handle closed while minting opens nothing",
    );
    sockets[0].accept();
    assert.deepEqual(first.statuses, ["connecting"]);
    assert.deepEqual(second.statuses, ["connecting", "open"]);
    second.handle.close();
  });

  test("a socket still connecting when its handle closes hangs up once it opens, unreported", async () => {
    const { handle, statuses } = connect();
    mints[0]("token");
    await settle();
    const [sock] = sockets;
    handle.close();
    assert.deepEqual(sock.closedFrom, [], "closing it while connecting makes the browser warn");
    sock.accept();
    assert.deepEqual(sock.closedFrom, [FakeWebSocket.OPEN]);
    sock.end();
    assert.deepEqual(statuses, ["connecting"]);
  });

  test("an open handle that closes hangs up and reports nothing more", async () => {
    const { handle, statuses } = connect();
    mints[0]("token");
    await settle();
    const [sock] = sockets;
    sock.accept();
    handle.close();
    assert.deepEqual(sock.closedFrom, [FakeWebSocket.OPEN]);
    sock.end();
    mock.timers.tick(60_000);
    assert.deepEqual(statuses, ["connecting", "open"], "a successor's status is left standing");
    assert.equal(mints.length, 1, "a closed handle does not reconnect");
  });

  test("a connection that drops on its own is reported and retried with a fresh token", async () => {
    const { handle, statuses } = connect();
    mints[0]("first");
    await settle();
    sockets[0].accept();
    sockets[0].end();
    assert.deepEqual(statuses, ["connecting", "open", "closed"]);
    mock.timers.tick(1_000);
    assert.equal(mints.length, 2);
    mints[1]("second");
    await settle();
    assert.equal(sockets[1].url, "ws://app.test/api/ws?token=second");
    sockets[1].accept();
    assert.deepEqual(statuses, ["connecting", "open", "closed", "connecting", "open"]);
    handle.close();
  });
});
