import { ConfigError, loadConfig } from "./config.js";
import { consoleLogger } from "./log.js";
import { startConnect } from "./server.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    consoleLogger.error(error.message);
    process.exit(1);
  }
  throw error;
}

if (config.secretIsEphemeral) {
  consoleLogger.info(
    "CONNECT_SECRET is not set; this process seals sign-ins with a key of its own. Give every replica the same CONNECT_SECRET when running more than one.",
  );
}

const running = await startConnect(config).catch((error: unknown) => {
  // A code such as EADDRINUSE says what went wrong without echoing anything
  // configured.
  const code = (error as { code?: unknown } | null)?.code;
  consoleLogger.error(
    `could not start: ${error instanceof Error ? error.name : "unknown error"}${
      typeof code === "string" ? ` (${code})` : ""
    }`,
  );
  process.exit(1);
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    consoleLogger.info(`${signal} received; finishing open requests`);
    // A stuck keep-alive connection must not hold a rollout hostage.
    setTimeout(() => process.exit(0), 10_000).unref();
    void running.close().then(() => process.exit(0));
  });
}
