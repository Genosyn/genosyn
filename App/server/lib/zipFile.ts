import type { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough, type Readable } from "node:stream";
import unzipper from "unzipper";

/**
 * Reading a zip file on disk without leaving anything open on it.
 *
 * `unzipper.Open.file` reads through file streams that nobody listens to for
 * errors — the central directory's, a zip64 archive's two records', and one
 * for every entry read — and it can answer before the directory's has even
 * opened: an archive that lists no files needs nothing from it. A stream
 * error nobody listens for is an uncaught exception, which stops the App. So
 * a file that went missing or could not be read while a backup was restored
 * or an EPUB imported took the server down, the read waiting on it never
 * settling, and removing a file whose directory had just been read could do
 * the same.
 *
 * Here every file stream is this module's own. Each has a listener, an error
 * fails the read waiting on it and every read after it with a
 * {@link ZipReadError}, and each is closed, its open settled, before
 * {@link readZipFile} returns. unzipper is only handed streams that cannot
 * fail: it passes one stream's errors on to a parser that stops listening once
 * it has what it needs, which would throw too.
 *
 * It lives in `lib/` because backups (checking and restoring an archive) and
 * Resources (an EPUB's chapters) both read zip files.
 */

/** What the central directory says about one entry. */
export type ZipEntry = Readonly<Pick<unzipper.File, "path" | "type" | "uncompressedSize">>;

/** A zip file being read: what it lists, and a way to read each entry. */
export type ZipFile = {
  /** Every entry the central directory lists, in its order. */
  entries: ZipEntry[];
  /** One entry's bytes. */
  read(entry: ZipEntry): Promise<Buffer>;
  /**
   * Write one entry to a new file at `dest`, closed once this settles. A
   * destination that can't be written fails with its own error, not a
   * {@link ZipReadError}: a full disk is not the zip's doing.
   */
  extract(entry: ZipEntry, dest: string, options?: { mode?: number }): Promise<void>;
};

/**
 * The zip could not be read: it is not one, it is damaged, or the file went
 * missing or failed underneath. The original error is its `cause`.
 */
export class ZipReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ZipReadError";
  }
}

/**
 * Open the zip file at `abs` and hand it to `use`. Whatever `use` returns is
 * returned once every stream opened on the file has closed; reading through
 * the {@link ZipFile} after `use` has settled is not supported.
 */
export async function readZipFile<T>(abs: string, use: (zip: ZipFile) => Promise<T>): Promise<T> {
  const streams = new Set<fs.ReadStream>();
  /** The first stream failure, which every read from then on fails with. */
  let failure: ZipReadError | null = null;
  /** Fails each read waiting right now; a failure while none is changes nothing. */
  const waiting = new Set<(err: ZipReadError) => void>();
  const fail = (err: unknown) => {
    failure ??= new ZipReadError(err);
    for (const stop of waiting) stop(failure);
  };

  const source = {
    size: async () => (await fs.promises.stat(abs)).size,
    stream: (start: number, length?: number): Readable => {
      // The same byte range `Open.file` asks for.
      const file = fs.createReadStream(abs, { start, end: length ? start + length : undefined });
      streams.add(file);
      file.on("error", fail).once("close", () => streams.delete(file));
      // unzipper is handed this, which can't fail. It destroys an entry's
      // stream once it has read the entry, which closes the file's too.
      const handed = new PassThrough().once("close", () => file.destroy());
      return file.pipe(handed);
    },
  };

  /**
   * `pending`, unless a stream on the file fails first. Each wait races its
   * own promise: one shared for the whole file would keep every race ever run
   * against it until it settled, an entry's worth for each one restored.
   */
  const orFailure = async <R>(pending: Promise<R>): Promise<R> => {
    let stop!: (err: ZipReadError) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = reject;
    });
    if (failure) stop(failure);
    else waiting.add(stop);
    try {
      return await Promise.race([pending, stopped]);
    } finally {
      waiting.delete(stop);
    }
  };

  /** `reading`, failed as a {@link ZipReadError} — at once, if a stream on the file fails. */
  const unreadable = async <R>(reading: () => Promise<R>): Promise<R> => {
    try {
      return await orFailure(reading());
    } catch (err) {
      throw err instanceof ZipReadError ? err : new ZipReadError(err);
    }
  };

  const extract = async (entry: ZipEntry, dest: string, options?: { mode?: number }) => {
    let input: Readable;
    try {
      input = (entry as unzipper.File).stream();
    } catch (err) {
      throw new ZipReadError(err);
    }
    const output = fs.createWriteStream(dest, options);
    // Piped by hand rather than through `pipeline`, which fails each side with
    // the other's error: here an error is the side's own.
    const written = new Promise<void>((resolve, reject) => {
      input.on("error", (err) => reject(new ZipReadError(err)));
      output.on("error", reject).once("close", resolve);
    });
    input.pipe(output);
    try {
      await orFailure(written);
    } finally {
      input.destroy();
      await closeStream(output);
    }
  };

  try {
    const directory = await unreadable(() => unzipper.Open.custom(source));
    return await use({
      entries: directory.files,
      read: (entry) => unreadable(() => (entry as unzipper.File).buffer()),
      extract,
    });
  } finally {
    await Promise.all([...streams].map(closeStream));
  }
}

/** Close a stream and wait until it has — once an open still under way has finished. */
function closeStream(
  stream: EventEmitter & { readonly closed: boolean; destroy(): void },
): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
    stream.destroy();
  });
}
