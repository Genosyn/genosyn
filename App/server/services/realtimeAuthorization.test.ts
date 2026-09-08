import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { UserSession } from "../db/entities/UserSession.js";
import { Membership } from "../db/entities/Membership.js";
import { Channel } from "../db/entities/Channel.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  createUserSession,
  revokeCurrentUserSession,
  type UserSessionIdentity,
} from "./userSessions.js";
import {
  attachRealtime,
  broadcastToCompany,
  mintWsToken,
  revalidateWorkspaceSockets,
} from "./realtime.js";
import { realtimeHandshakeExpiry, type RealtimeAuthentication } from "./realtimeAuthorization.js";
import type { Request } from "express";

const servers: Server[] = [];
const clients = new Set<WebSocket>();
let user: User;
let channel: Channel;
const companyId = "realtime-company";

async function closeClients(): Promise<void> {
  await Promise.all(
    Array.from(clients, async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, "close");
      socket.terminate();
      await closed;
    }),
  );
  clients.clear();
}

before(async () => {
  await initTestDb();
  for (let index = 0; index < 2; index += 1) {
    const server = createServer();
    attachRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
  }
});
beforeEach(async () => {
  await closeClients();
  await resetTestDb();
  user = await insert(User, {
    email: "realtime@example.com",
    name: "Realtime Member",
    passwordHash: "fixture",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId, userId: user.id, role: "member" });
  channel = await insert(Channel, { companyId, name: "General", slug: "general", kind: "public" });
});
after(async () => {
  await closeClients();
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await closeTestDb();
});

function wsUrl(token: string, server = servers[0]): string {
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws?token=${encodeURIComponent(token)}`;
}

async function connect(identity: UserSessionIdentity, server = servers[0]) {
  return connectWithAuthentication({ kind: "session", identity }, server);
}

async function connectWithAuthentication(
  authentication: RealtimeAuthentication,
  server = servers[0],
) {
  const token = await mintWsToken(user.id, companyId, authentication);
  const socket = new WebSocket(wsUrl(token, server));
  clients.add(socket);
  const messages: Array<{ type: string; messageId?: string }> = [];
  await new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { type: string; messageId?: string };
      messages.push(message);
      if (message.type === "hello") resolve();
    });
    socket.once("error", reject);
  });
  return { socket, messages };
}

function nextEdit(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const listener = (data: Buffer) => {
      if ((JSON.parse(String(data)) as { type: string }).type !== "message.edit") return;
      socket.off("message", listener);
      resolve();
    };
    socket.on("message", listener);
  });
}

function publish(messageId: string): void {
  broadcastToCompany(companyId, {
    type: "message.edit",
    channelId: channel.id,
    messageId,
    content: "Updated message",
    editedAt: new Date().toISOString(),
  });
}

test("an authorized connection receives public-channel updates", async () => {
  const { socket, messages } = await connect(await createUserSession(user));
  const delivered = nextEdit(socket);
  publish("authorized");
  await delivered;
  assert.ok(messages.some((message) => message.messageId === "authorized"));
});

test("membership removal closes a connection before another public-channel update", async () => {
  const { socket, messages } = await connect(await createUserSession(user));
  await AppDataSource.getRepository(Membership).delete({ companyId, userId: user.id });
  const closed = once(socket, "close");
  publish("after-removal");
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(
    messages.some((message) => message.messageId === "after-removal"),
    false,
  );
});

test("logout closes that browser's realtime connection and preserves another sign-in", async () => {
  const first = await createUserSession(user);
  const second = await createUserSession(user);
  const one = await connect(first);
  const two = await connect(second, servers[1]);
  await revokeCurrentUserSession({ session: first } as Request);
  const closed = once(one.socket, "close");
  const delivered = nextEdit(two.socket);
  publish("after-logout");
  await Promise.all([closed, delivered]);
  assert.equal(
    one.messages.some((message) => message.messageId === "after-logout"),
    false,
  );
  assert.equal(two.socket.readyState, WebSocket.OPEN);
});

test("account revocation in the shared database closes idle sockets on separate servers", async () => {
  const one = await connect(await createUserSession(user));
  const two = await connect(await createUserSession(user), servers[1]);
  await AppDataSource.getRepository(User).increment({ id: user.id }, "sessionVersion", 1);
  const closed = [once(one.socket, "close"), once(two.socket, "close")];
  await revalidateWorkspaceSockets();
  for (const [code] of await Promise.all(closed)) assert.equal(code, 1008);
});

test("session expiry closes an established idle workspace connection", async () => {
  const identity = await createUserSession(user);
  const { socket } = await connect(identity);
  await AppDataSource.getRepository(UserSession).update(identity.userSessionId, {
    expiresAt: new Date(Date.now() - 1),
  });
  const closed = once(socket, "close");
  await revalidateWorkspaceSockets();
  assert.equal((await closed)[0], 1008);
});

test("API-key realtime access is preserved and ends when the key is revoked", async () => {
  const key = await insert(ApiKey, {
    companyId,
    userId: user.id,
    name: "Realtime key",
    prefix: "fixture",
    tokenHash: "realtime-test-key",
    revokedAt: null,
    expiresAt: null,
  });
  const { socket, messages } = await connectWithAuthentication({ kind: "api-key", keyId: key.id });
  const delivered = nextEdit(socket);
  publish("before-key-revocation");
  await delivered;
  await AppDataSource.getRepository(ApiKey).update(key.id, { revokedAt: new Date() });
  const closed = once(socket, "close");
  publish("after-key-revocation");
  assert.equal((await closed)[0], 1008);
  assert.equal(
    messages.some((message) => message.messageId === "after-key-revocation"),
    false,
  );
});

test("handshake state cannot outlive its originating sign-in", async () => {
  const identity = { ...(await createUserSession(user)), expiresAt: Date.now() + 10_000 };
  const authentication = { kind: "session" as const, identity };
  assert.equal(realtimeHandshakeExpiry(authentication), identity.expiresAt);
  await mintWsToken(user.id, companyId, authentication);
  const row = await AppDataSource.getRepository(AuthFlowState).findOneByOrFail({
    kind: "websocket",
  });
  assert.ok(row.expiresAt.getTime() <= identity.expiresAt);
});

test("a handshake issued before logout is rejected after its session is revoked", async () => {
  const identity = await createUserSession(user);
  const token = await mintWsToken(user.id, companyId, { kind: "session", identity });
  await revokeCurrentUserSession({ session: identity } as Request);
  const status = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(wsUrl(token));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("Revoked handshake was accepted"));
    });
    socket.once("error", reject);
  });
  assert.equal(status, 401);
});
