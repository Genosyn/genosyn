import type { FlagMeaning, OptionValues, Token } from "./argv.js";
import { suggest } from "./argv.js";
import {
  cacheDir,
  loadConfig,
  requireBaseUrl,
  resolveConnection,
  type Connection,
  type LoadedConfig,
} from "./config.js";
import { usageError } from "./errors.js";
import type { HttpOptions } from "./http.js";
import type { CliIo } from "./io.js";
import { OperationIndex } from "./operations.js";
import { findOption, type OptionDef } from "./options.js";
import { colorEnabled, renderValue, selectPath } from "./output.js";
import { loadSpec, readCachedSpec, specCachePath, specTtlMs, type LoadedSpec } from "./spec.js";

/**
 * One run of the CLI: its options, and everything resolved lazily from
 * them — the config, the connection, the API description and the command
 * tree — so a command that needs none of it (help, version) touches nothing.
 */

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_PAGES = 100;

export class Context {
  private loadedConfig?: LoadedConfig;
  private resolvedConnection?: Connection;
  private loadedSpec?: LoadedSpec;
  private builtIndex?: OperationIndex;

  constructor(
    readonly io: CliIo,
    readonly options: OptionValues = new Map(),
  ) {}

  flag(name: string): boolean {
    return this.options.get(name) === true;
  }

  value(name: string): string | undefined {
    const value = this.options.get(name);
    return typeof value === "string" ? value : undefined;
  }

  /** Results as JSON: asked for, or stdout isn't a terminal (and `--table` didn't say otherwise). */
  get jsonOutput(): boolean {
    if (this.flag("json")) return true;
    if (this.flag("table")) return false;
    return !this.io.stdout.isTTY;
  }

  /** Errors and warnings as JSON lines: asked for, or stderr isn't a terminal. */
  get jsonErrors(): boolean {
    return this.flag("json") || !this.io.stderr.isTTY;
  }

  get color(): boolean {
    return colorEnabled(this.io.stdout, this.io.env, this.flag("no-color"));
  }

  get errorColor(): boolean {
    return colorEnabled(this.io.stderr, this.io.env, this.flag("no-color"));
  }

  get width(): number {
    const columns = this.io.stdout.columns;
    return columns && columns > 20 ? columns : 100;
  }

  style(): { color: boolean; width: number } {
    return { color: this.color, width: this.width };
  }

  /** Write to stdout as is. */
  write(text: string | Uint8Array): void {
    this.io.stdout.write(text);
  }

  /** A warning on stderr: a JSON line for programs, a `!` line for people. */
  warn(message: string): void {
    if (this.jsonErrors) this.io.stderr.write(`${JSON.stringify({ warning: { message } })}\n`);
    else this.io.stderr.write(`! ${message}\n`);
  }

  /**
   * Print a command's result: `--select` first, then JSON for programs, and
   * for people either the command's own sentence (`human`) or a table.
   */
  result(value: unknown, human?: string): void {
    const select = this.value("select");
    if (select !== undefined) {
      this.write(
        renderValue(selectPath(value, select), {
          json: this.jsonOutput,
          pretty: !!this.io.stdout.isTTY,
          color: this.color,
          width: this.width,
          columns: this.columns(),
          bareScalars: !this.flag("json"),
        }),
      );
      return;
    }
    if (!this.jsonOutput && human !== undefined) {
      this.write(human.endsWith("\n") ? human : `${human}\n`);
      return;
    }
    this.write(
      renderValue(value, {
        json: this.jsonOutput,
        pretty: !!this.io.stdout.isTTY,
        color: this.color,
        width: this.width,
        columns: this.columns(),
      }),
    );
  }

  columns(): string[] | undefined {
    const raw = this.value("columns");
    if (raw === undefined) return undefined;
    const columns = raw
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    return columns.length ? columns : undefined;
  }

  config(): LoadedConfig {
    if (!this.loadedConfig) {
      this.loadedConfig = loadConfig(this.io);
      for (const warning of this.loadedConfig.warnings) this.warn(warning);
    }
    return this.loadedConfig;
  }

  /** Forget the loaded config after a command rewrote it. */
  configChanged(): void {
    this.loadedConfig = undefined;
    this.resolvedConnection = undefined;
  }

  connection(): Connection {
    this.resolvedConnection ??= resolveConnection(
      this.config().config,
      { profile: this.value("profile"), url: this.value("url"), company: this.value("company") },
      this.io.env,
    );
    return this.resolvedConnection;
  }

  timeoutMs(): number {
    const raw = this.value("timeout") ?? this.io.env.GENOSYN_TIMEOUT?.trim();
    if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_SECONDS * 1000;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw usageError(`--timeout takes a number of seconds above zero, not "${raw}".`);
    }
    return Math.round(seconds * 1000);
  }

  maxPages(): number {
    const raw = this.value("max-pages");
    if (raw === undefined) return DEFAULT_MAX_PAGES;
    const pages = Number(raw);
    if (!Number.isInteger(pages) || pages < 1) {
      throw usageError(`--max-pages takes a whole number of at least 1, not "${raw}".`);
    }
    return pages;
  }

  http(): HttpOptions {
    const verbose = this.flag("verbose");
    return {
      fetch: this.io.fetch,
      timeoutMs: this.timeoutMs(),
      now: () => this.io.now(),
      log: verbose ? (line: string) => this.io.stderr.write(`${line}\n`) : undefined,
    };
  }

  /** The API description: memoized for the run; `refresh` revalidates with the server. */
  async spec(refresh = false): Promise<LoadedSpec> {
    if (this.loadedSpec && !refresh) return this.loadedSpec;
    const baseUrl = requireBaseUrl(this.connection());
    const loaded = await loadSpec({
      baseUrl,
      cacheDirectory: cacheDir(this.io),
      http: this.http(),
      ttlMs: specTtlMs(this.io.env),
      refresh: refresh || (this.flag("refresh") && !this.loadedSpec),
    });
    if (loaded.staleReason) {
      const minutes = Math.max(1, Math.round((this.io.now() - loaded.fetchedAt) / 60_000));
      this.warn(`${loaded.staleReason} Using the API description cached ${minutes} min ago.`);
    }
    this.loadedSpec = loaded;
    this.builtIndex = undefined;
    return loaded;
  }

  async index(refresh = false): Promise<OperationIndex> {
    const spec = await this.spec(refresh);
    this.builtIndex ??= new OperationIndex(spec.document);
    return this.builtIndex;
  }

  /** Whether this run's description came from the cache rather than the server just now. */
  specFromCache(): boolean {
    return this.loadedSpec?.source === "cache";
  }

  /** The cached command tree without any network, for listing areas in help; or nothing. */
  cachedIndex(): { index: OperationIndex; baseUrl: string } | undefined {
    try {
      const baseUrl = this.connection().baseUrl;
      if (!baseUrl) return undefined;
      const cached = readCachedSpec(specCachePath(cacheDir(this.io), baseUrl), baseUrl);
      return cached ? { index: new OperationIndex(cached.document), baseUrl } : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Meaning of a flag when only the CLI's own options are allowed. */
export function optionMeaning(
  options: readonly OptionDef[],
): (token: Extract<Token, { type: "flag" }>) => FlagMeaning {
  return (token) => {
    const option = findOption(options, token.name, token.short);
    return option ? { kind: "option", option } : { kind: "unknown" };
  };
}

/** The error for an option a command doesn't take, with near misses. */
export function unknownOption(
  options: readonly OptionDef[],
  where: string,
  hint?: string,
): (token: Extract<Token, { type: "flag" }>) => never {
  return (token) => {
    const names = options.map((option) => option.name);
    const close = token.short ? [] : suggest(token.name, names);
    throw usageError(
      `Unknown option ${token.raw.split("=")[0]} for ${where}.`,
      close.length
        ? `Did you mean ${close.map((name) => `--${name}`).join(", ")}?${hint ? ` ${hint}` : ""}`
        : hint,
    );
  };
}
