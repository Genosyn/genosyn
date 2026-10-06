import type { Server } from "node:http";
import { createConnectApp } from "./app.js";
import type { ConnectConfig } from "./config.js";
import { createFlowStates } from "./flowState.js";
import { consoleLogger, type Logger } from "./log.js";
import { createProviders } from "./providers/index.js";
import { createSealer } from "./secrets.js";
import { createStore } from "./store/index.js";
import type { FlowStore } from "./store/types.js";
import { Throttle } from "./throttle.js";
import type { Fetch } from "./upstream.js";

export type RunningConnect = {
  server: Server;
  store: FlowStore;
  /** Stop accepting requests, finish the ones in flight, then release the store. */
  close(): Promise<void>;
};

const SWEEP_INTERVAL_MS = 60_000;

/** Build every dependency from configuration and start listening. */
export async function startConnect(
  config: ConnectConfig,
  options: { log?: Logger; fetch?: Fetch; store?: FlowStore } = {},
): Promise<RunningConnect> {
  const log = options.log ?? consoleLogger;
  const store = options.store ?? (await createStore(config.databaseUrl));
  const throttle = new Throttle();
  const providers = createProviders(config, { fetch: options.fetch });
  const app = createConnectApp({
    config,
    flows: createFlowStates(store, createSealer(config.secret)),
    providers,
    throttle,
    log,
  });

  const sweeper = setInterval(() => {
    throttle.sweep();
    store.sweep().catch(() => {
      log.warn("expired sign-in cleanup failed; retrying in a minute");
    });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(config.port, config.listenHost, () => resolve(listening));
    listening.once("error", reject);
  });

  const offered = [...providers.values()]
    .filter((provider) => provider.registration)
    .map((provider) => `${provider.id} (${provider.groups.map((group) => group.key).join(", ")})`);
  log.info(
    `listening on ${config.listenHost}:${config.port} as ${config.publicUrl}; ${store.name} store; ${
      offered.length > 0 ? `offering ${offered.join("; ")}` : "no providers configured yet"
    }`,
  );

  let closing: Promise<void> | null = null;
  return {
    server,
    store,
    close() {
      closing ??= (async () => {
        clearInterval(sweeper);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.close();
      })();
      return closing;
    },
  };
}
