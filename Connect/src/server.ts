import type { Server } from "node:http";
import { createConnectApp } from "./app.js";
import type { ConnectConfig } from "./config.js";
import { consoleLogger, type Logger } from "./log.js";
import { createProviders } from "./providers/index.js";
import { createSealer } from "./secrets.js";
import { Throttle } from "./throttle.js";
import type { Fetch } from "./upstream.js";

export type RunningConnect = {
  server: Server;
  /** Stop accepting requests and finish the ones in flight. */
  close(): Promise<void>;
};

const SWEEP_INTERVAL_MS = 60_000;

/** Build every dependency from configuration and start listening. */
export async function startConnect(
  config: ConnectConfig,
  options: { log?: Logger; fetch?: Fetch } = {},
): Promise<RunningConnect> {
  const log = options.log ?? consoleLogger;
  const throttle = new Throttle();
  const providers = createProviders(config, { fetch: options.fetch });
  const app = createConnectApp({
    config,
    sealer: createSealer(config.secret),
    providers,
    throttle,
    log,
  });

  // Rate-limit buckets are the only memory this process keeps; idle ones go.
  const sweeper = setInterval(() => throttle.sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref();

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(config.port, config.listenHost, () => resolve(listening));
    listening.once("error", reject);
  });

  const offered = [...providers.values()]
    .filter((provider) => provider.registration)
    .map((provider) => `${provider.id} (${provider.groups.map((group) => group.key).join(", ")})`);
  log.info(
    `listening on ${config.listenHost}:${config.port} as ${config.publicUrl}; stateless; ${
      offered.length > 0 ? `offering ${offered.join("; ")}` : "no providers configured yet"
    }`,
  );

  let closing: Promise<void> | null = null;
  return {
    server,
    close() {
      closing ??= (async () => {
        clearInterval(sweeper);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}
