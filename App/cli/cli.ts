import { tokenize, walk, type Token } from "./argv.js";
import { commandArea, commandCall } from "./commands/call.js";
import { commandLogin, commandLogout, commandProfiles, commandWhoami } from "./commands/auth.js";
import {
  commandAreas,
  commandDescribe,
  commandOps,
  commandSearch,
  commandSpec,
  commandVersion,
  resolveOperationRef,
} from "./commands/discover.js";
import { Context, optionMeaning, unknownOption } from "./context.js";
import { asCliError, CliError, errorPayload, humanError, usageError } from "./errors.js";
import { areaHelp, builtinHelp, globalHelp, operationHelp, topicHelp } from "./help.js";
import type { CliIo } from "./io.js";
import {
  DISCOVERY_OPTIONS,
  GLOBAL_OPTIONS,
  LOGIN_OPTIONS,
  VERSION_OPTION,
  type OptionDef,
} from "./options.js";
import { paint } from "./output.js";
import { nodeVersionProblem } from "./version.js";

/**
 * `genosyn-api`: the command line for Genosyn's REST API.
 *
 * `runCli` takes the arguments and an {@link CliIo} and returns the exit code
 * (see `errors.ts` for the table). The built-in commands are fixed; every
 * other first word is an area from the server's API description, so the
 * tree grows with the server.
 */

type Builtin = {
  options: readonly OptionDef[];
  run: (context: Context, words: string[]) => Promise<void>;
};

const INCLUDE_ALL = DISCOVERY_OPTIONS.filter((option) => option.name === "include-all");

const BUILTINS: Record<string, Builtin> = {
  login: { options: [...GLOBAL_OPTIONS, ...LOGIN_OPTIONS], run: commandLogin },
  logout: { options: GLOBAL_OPTIONS, run: commandLogout },
  profiles: { options: GLOBAL_OPTIONS, run: commandProfiles },
  whoami: { options: GLOBAL_OPTIONS, run: commandWhoami },
  areas: { options: [...GLOBAL_OPTIONS, ...INCLUDE_ALL], run: commandAreas },
  ops: { options: [...GLOBAL_OPTIONS, ...DISCOVERY_OPTIONS], run: commandOps },
  search: { options: [...GLOBAL_OPTIONS, ...INCLUDE_ALL], run: commandSearch },
  describe: { options: GLOBAL_OPTIONS, run: commandDescribe },
  spec: { options: GLOBAL_OPTIONS, run: commandSpec },
  version: { options: GLOBAL_OPTIONS, run: commandVersion },
};

const ALIASES: Record<string, string> = {
  profile: "profiles",
  operations: "ops",
  "list-operations": "ops",
  "list-areas": "areas",
  find: "search",
  show: "describe",
  "who-am-i": "whoami",
  me: "whoami",
};

async function help(context: Context, words: string[]): Promise<void> {
  const style = context.style();
  if (words.length === 0) {
    const cached = context.cachedIndex();
    context.write(globalHelp(style, cached?.index, cached?.baseUrl));
    return;
  }
  const [first, ...rest] = words;
  const command = ALIASES[first] ?? first;
  if (rest.length === 0) {
    const text = builtinHelp(command, style) ?? topicHelp(command, style);
    if (text) {
      context.write(text);
      return;
    }
  }
  if (command === "call" && rest.length === 1) {
    const { index, operation } = await resolveOperationRef(context, rest);
    context.write(operationHelp(index, operation, style));
    return;
  }
  const index = await context.index();
  const area = index.area(first);
  if (area && rest.length === 0) {
    context.write(areaHelp(index, area, style, context.flag("include-all")));
    return;
  }
  const { index: resolved, operation } = await resolveOperationRef(context, words);
  context.write(operationHelp(resolved, operation, style));
}

async function dispatch(context: Context, command: string, rest: Token[]): Promise<void> {
  const name = ALIASES[command] ?? command;
  if (name === "help") {
    const parsed = walk(rest, optionMeaning([...GLOBAL_OPTIONS, ...INCLUDE_ALL]), {
      onUnknown: unknownOption(GLOBAL_OPTIONS, "help"),
      into: context.options,
    });
    await help(
      context,
      parsed.words.map((word) => word.value),
    );
    return;
  }
  if (name === "call") {
    await commandCall(context, rest);
    return;
  }
  const builtin = BUILTINS[name];
  if (builtin) {
    const parsed = walk(rest, optionMeaning(builtin.options), {
      onUnknown: unknownOption(builtin.options, name),
      into: context.options,
    });
    const words = parsed.words.map((word) => word.value);
    if (context.flag("help")) {
      context.write(builtinHelp(name, context.style()) as string);
      return;
    }
    await builtin.run(context, words);
    return;
  }
  await commandArea(context, command, rest);
}

/** Write an error to stderr the way the caller reads errors, and return its exit code. */
export function reportError(context: Context, thrown: unknown): number {
  const error = asCliError(thrown);
  if (context.jsonErrors) {
    context.io.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
  } else {
    context.io.stderr.write(
      humanError(error, (text) => paint("red", text, context.errorColor)),
    );
  }
  if (error.kind === "internal" && context.flag("verbose")) {
    const cause = (error as CliError & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.stack) context.io.stderr.write(`${cause.stack}\n`);
  }
  return error.exitCode;
}

/** Run the CLI with `argv` (without node and the script) and return the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const context = new Context(io);
  try {
    const problem = nodeVersionProblem(process.versions.node);
    if (problem) throw usageError(problem, "Install a current Node.js LTS from https://nodejs.org.");
    const first = walk(tokenize(argv), optionMeaning([...GLOBAL_OPTIONS, VERSION_OPTION]), {
      stopAtWord: true,
      onUnknown: unknownOption(
        [...GLOBAL_OPTIONS, VERSION_OPTION],
        "genosyn-api",
        "Operation parameters go after the operation: genosyn-api call <operationId> --name value.",
      ),
      into: context.options,
    });
    if (!first.stoppedAt) {
      if (context.flag("version")) {
        await commandVersion(context, []);
        return 0;
      }
      await help(context, []);
      return 0;
    }
    if (context.flag("version")) {
      throw usageError("--version goes alone: genosyn-api --version");
    }
    await dispatch(context, first.stoppedAt, first.rest);
    return 0;
  } catch (error) {
    return reportError(context, error);
  }
}
