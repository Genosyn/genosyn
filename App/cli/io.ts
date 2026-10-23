import os from "node:os";

/**
 * Everything the CLI touches outside its own memory, behind one seam.
 *
 * `runCli` never reaches for `process` directly: the real program passes
 * {@link processIo}, and the tests pass an in-memory double with their own
 * environment, terminal-ness, clock, stdin and `fetch`. That is what lets the
 * suite drive every command — including the end-to-end round trip against a
 * real in-process server — without spawning a process per assertion.
 */

export type OutputStream = {
  write(chunk: string | Uint8Array): unknown;
  isTTY?: boolean;
  columns?: number;
};

export type CliIo = {
  env: Record<string, string | undefined>;
  stdout: OutputStream;
  stderr: OutputStream;
  /** Whether stdin is a terminal (a person could type), rather than a pipe or file. */
  stdinIsTTY: boolean;
  /** All of stdin, read to its end. Only called when a command asks for it explicitly. */
  readStdin(): Promise<Buffer>;
  fetch: typeof globalThis.fetch;
  homedir: string;
  cwd: string;
  platform: NodeJS.Platform;
  now(): number;
  /** Ask a question at the terminal and read the answer. */
  prompt(question: string): Promise<string>;
  /** Ask for a secret at the terminal without echoing what is typed. */
  promptSecret(question: string): Promise<string>;
};

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function promptLine(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Read a line from the terminal in raw mode, echoing nothing — not even
 * asterisks, so the key's length stays private too. Ctrl-C aborts with the
 * conventional 130.
 */
async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return promptLine(question);
  process.stderr.write(question);
  return new Promise<string>((resolve) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (result: string | null) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
      if (result === null) {
        process.exitCode = 130;
        process.exit(130);
      }
      resolve(result);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish(value);
          return;
        }
        if (character === "\u0003") {
          finish(null);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });
}

/** The real terminal, environment and network. */
export function processIo(): CliIo {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: () => readAll(process.stdin),
    fetch: globalThis.fetch.bind(globalThis),
    homedir: os.homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    now: () => Date.now(),
    prompt: promptLine,
    promptSecret: promptHidden,
  };
}
