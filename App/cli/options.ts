/**
 * The CLI's own options, and the rule that keeps them apart from an
 * operation's parameters.
 *
 * An operation's parameters are flags too (`--title "Renewal"`), so a name
 * can mean either. The CLI's options always win the `--name` spelling; a
 * parameter that shares a name with one — `url`, `data`, `format`, `raw`,
 * `dryRun` exist today — is passed as `name=value`, which only ever means a
 * parameter. Help prints such a parameter in that form, so nobody has to
 * know the rule to follow it.
 */

export type OptionDef = {
  /** The long name, without dashes. */
  name: string;
  short?: string;
  /** The placeholder for its value; absent for a switch. */
  value?: string;
  description: string;
};

/** Options every command takes. */
export const GLOBAL_OPTIONS: readonly OptionDef[] = [
  { name: "help", short: "h", description: "Show help for the command" },
  { name: "json", description: "Print JSON (the default when stdout isn't a terminal)" },
  { name: "table", description: "Print tables and key-value lists, even into a pipe" },
  {
    name: "select",
    value: "path",
    description: "Print only part of the result: id, rows.0.title, rows.*.id",
  },
  { name: "columns", value: "a,b,…", description: "Choose a table's columns" },
  { name: "profile", short: "p", value: "name", description: "Use this saved profile" },
  { name: "url", value: "url", description: "Genosyn address or Base URL, over the profile's" },
  { name: "company", value: "id", description: "Company id, over the profile's" },
  {
    name: "timeout",
    value: "seconds",
    description: "Give up on a request after this long (default 60)",
  },
  { name: "refresh", description: "Re-download the API description first" },
  { name: "no-color", description: "Never color output (NO_COLOR works too)" },
  {
    name: "verbose",
    short: "v",
    description: "Log each request and response to stderr, keys redacted",
  },
];

/** Options of commands that call an operation: `call` and the area commands. */
export const REQUEST_OPTIONS: readonly OptionDef[] = [
  {
    name: "data",
    short: "d",
    value: "json|@file|-",
    description: "The request body: JSON, @file.json, or - to read stdin",
  },
  { name: "output", short: "o", value: "file", description: "Save the response body to a file" },
  { name: "raw", description: "Print the response body exactly as it arrived" },
  { name: "all", description: "Follow every page of a list and print all of it" },
  { name: "max-pages", value: "n", description: "Stop --all after this many pages (default 100)" },
  { name: "dry-run", description: "Print the request instead of sending it" },
];

/** Options only `login` takes. */
export const LOGIN_OPTIONS: readonly OptionDef[] = [
  { name: "with-token", description: "Read the API key from stdin instead of prompting" },
  { name: "no-verify", description: "Save without checking the key against the server" },
];

/** Options only the discovery commands take. */
export const DISCOVERY_OPTIONS: readonly OptionDef[] = [
  { name: "search", value: "text", description: "Only operations matching this text" },
  {
    name: "include-all",
    description: "Also list operations that don't take a key: public and browser-only ones",
  },
];

/** Accepted only before any command: `genosyn-api --version`. */
export const VERSION_OPTION: OptionDef = { name: "version", description: "Print the version" };

/** Names a parameter's `--flag` may not take, because an option has it. */
export const RESERVED_FLAG_NAMES: ReadonlySet<string> = new Set(
  [...GLOBAL_OPTIONS, ...REQUEST_OPTIONS].map((option) => option.name),
);

export function findOption(
  options: readonly OptionDef[],
  name: string,
  short: boolean,
): OptionDef | undefined {
  return options.find((option) => (short ? option.short === name : option.name === name));
}
