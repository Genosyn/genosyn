/* eslint-disable no-console */

/**
 * One line per event. Nothing that reaches a logger may carry a query string,
 * a request body, a header, or an upstream response: those are where
 * authorization codes, refresh tokens and client secrets live.
 */
export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export const consoleLogger: Logger = {
  info: (message) => console.log(`[connect] ${message}`),
  warn: (message) => console.warn(`[connect] ${message}`),
  error: (message) => console.error(`[connect] ${message}`),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
