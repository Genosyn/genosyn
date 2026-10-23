import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../../server/app.js";
import { errorHandler } from "../../server/middleware/error.js";
import { stopCron } from "../../server/services/cron.js";
import { setPublicUrl } from "../../server/services/publicUrl.js";
import {
  stopRoutineQueue,
  waitForRoutineQueueIdle,
} from "../../server/services/routineQueue.js";
import { stopStanddowns } from "../../server/services/standdowns.js";
import { withTestInstanceSecrets } from "../../server/test/apiAccess.js";
import { closeTestDb, initTestDb } from "../../server/test/dbHarness.js";

/**
 * The real App — `createApp()`, its session, origin and API-key middleware
 * and every router — on an in-memory database and a free loopback port, for
 * the CLI's end-to-end tests. The Routine queue is held so a Run started from
 * the CLI stays queued instead of reaching for an AI Model.
 */

export type TestServer = { baseUrl: string; close: () => Promise<void> };

export async function startTestServer(): Promise<TestServer> {
  const restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  stopRoutineQueue();
  await setPublicUrl("http://genosyn.example.test");
  const app = createApp();
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    close: async () => {
      await waitForRoutineQueueIdle();
      stopRoutineQueue();
      stopCron();
      stopStanddowns();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await closeTestDb();
      restoreSecrets();
    },
  };
}

/** `fetch` that remembers each request's method and path. */
export function recordingFetch(): { fetch: typeof globalThis.fetch; seen: string[] } {
  const seen: string[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return globalThis.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
