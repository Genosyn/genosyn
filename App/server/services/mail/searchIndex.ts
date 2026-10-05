import { AppDataSource } from "../../db/datasource.js";
import type { ParsedMailQuery } from "./searchQuery.js";

/**
 * A full-text index over the mirrored mailbox, for SQLite installs.
 *
 * Mail search used to test every term with `LIKE` against every message body,
 * so a word that matched nothing read the whole mailbox — 2.5 GB and two
 * seconds on a 420K-message account, with the synchronous driver holding every
 * other request for all of it. This keeps an FTS5 index with one document per
 * thread — its messages' subjects, senders, recipients, snippets, and bodies —
 * so a search is a lookup rather than a scan.
 *
 * The index lives in the connection's `temp` schema, never in `app.sqlite`.
 * Migrations here are generated from entities, which cannot express FTS5
 * tables or triggers, and an index that is never persisted never needs one:
 * nothing in the database file, its backups, or its migrations knows it
 * exists. It is rebuilt from the mirror in the background after every boot —
 * about half a minute for 220K threads, in slices that hold the event loop for
 * milliseconds — and search keeps the old `LIKE` filters until it is ready.
 * TEMP triggers, scoped to the same connection, queue every thread a write
 * touches; the sweep re-indexes queued threads within seconds.
 *
 * Postgres keeps the `LIKE` filters: its queries do not block the event loop.
 */

type Statement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  pluck(toggle?: boolean): Statement;
};
type Handle = {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
  readonly inTransaction: boolean;
};

/** Per-message body text indexed; bounds one thread's re-index at 100 messages. */
const BODY_CHARS = 100_000;
/** Threads re-indexed per statement, and how long one slice may hold the loop. */
const BATCH_THREADS = 8;
const SLICE_MS = 15;
/** How often an idle sweep looks for threads that writes have queued. */
const IDLE_SWEEP_MS = 2_000;

/**
 * One trigger per write that can change what a thread says. Each only queues
 * the thread: re-indexing reads every message in it, which is work for the
 * sweep rather than for whatever write — a mailbox disconnect deleting 400K
 * rows, say — fired the trigger. SQLite forbids schema-qualified names inside
 * a trigger body; a TEMP trigger resolves unqualified ones in `temp` first.
 */
const TRIGGERS = `
CREATE TEMP TRIGGER mail_search_message_insert AFTER INSERT ON main.mail_messages BEGIN
  INSERT OR IGNORE INTO mail_search_queue(threadId) VALUES (NEW.threadId);
END;
CREATE TEMP TRIGGER mail_search_message_update
AFTER UPDATE OF threadId, subject, snippet, fromName, fromEmail, toEmails, ccEmails, bodyText
ON main.mail_messages BEGIN
  INSERT OR IGNORE INTO mail_search_queue(threadId) VALUES (NEW.threadId);
  INSERT OR IGNORE INTO mail_search_queue(threadId) VALUES (OLD.threadId);
END;
CREATE TEMP TRIGGER mail_search_message_delete AFTER DELETE ON main.mail_messages BEGIN
  INSERT OR IGNORE INTO mail_search_queue(threadId) VALUES (OLD.threadId);
END;
CREATE TEMP TRIGGER mail_search_thread_delete AFTER DELETE ON main.mail_threads BEGIN
  DELETE FROM mail_search WHERE rowid = OLD.rowid;
  DELETE FROM mail_search_queue WHERE threadId = OLD.id;
END;`;

const DROP_TRIGGERS = `
DROP TRIGGER IF EXISTS temp.mail_search_message_insert;
DROP TRIGGER IF EXISTS temp.mail_search_message_update;
DROP TRIGGER IF EXISTS temp.mail_search_message_delete;
DROP TRIGGER IF EXISTS temp.mail_search_thread_delete;`;

const DROP_TABLES = `
DROP TABLE IF EXISTS temp.mail_search;
DROP TABLE IF EXISTS temp.mail_search_queue;`;

let ready = false;
let buildStartedAt = 0;
/** Bumped on every (re)build so a sweep from a closed connection stops. */
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function handle(): Handle {
  return (AppDataSource.driver as unknown as { databaseConnection: Handle }).databaseConnection;
}

/** Whether search can use the index rather than its `LIKE` filters. */
export function mailSearchIndexReady(): boolean {
  return ready;
}

/**
 * (Re)build the index on the current connection: create it empty, install the
 * triggers, queue every thread, and start the background sweep. Call after
 * migrations — a migration that rebuilds `mail_messages` drops its triggers —
 * and again whenever the DataSource is re-initialized. A no-op on Postgres.
 */
export function bootMailSearchIndex(): void {
  stopMailSearchIndex();
  if (AppDataSource.options.type !== "better-sqlite3" || !AppDataSource.isInitialized) return;
  try {
    const db = handle();
    db.exec(DROP_TABLES);
    db.exec(
      `CREATE VIRTUAL TABLE temp.mail_search USING fts5(
         subject, sender, recipients, body,
         content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`,
    );
    db.exec(`CREATE TABLE temp.mail_search_queue (threadId TEXT PRIMARY KEY) WITHOUT ROWID`);
    db.exec(TRIGGERS);
    db.exec(
      `INSERT OR IGNORE INTO temp.mail_search_queue(threadId) SELECT id FROM main.mail_threads`,
    );
  } catch (err) {
    // A filesystem with no room for SQLite's temp file, say. Search keeps
    // working through its LIKE filters.
    // eslint-disable-next-line no-console
    console.error("[mail] search index unavailable; search falls back to scanning:", err);
    stopMailSearchIndex();
    return;
  }
  buildStartedAt = Date.now();
  const mine = generation;
  const sweep = () => {
    timer = null;
    if (mine !== generation) return;
    let more: boolean;
    try {
      more = indexQueuedThreads(SLICE_MS);
    } catch (err) {
      // The connection closed under us (a restore) or the temp schema is gone.
      // eslint-disable-next-line no-console
      console.error("[mail] search index sweep failed; search falls back to scanning:", err);
      stopMailSearchIndex();
      return;
    }
    timer = more ? setTimeout(sweep, 0) : setTimeout(sweep, IDLE_SWEEP_MS);
    timer.unref?.();
  };
  timer = setTimeout(sweep, 0);
  timer.unref?.();
}

/** Stop sweeping and send search back to its `LIKE` filters. */
export function stopMailSearchIndex(): void {
  generation += 1;
  ready = false;
  if (timer) clearTimeout(timer);
  timer = null;
  // Mail writes must never depend on an index nobody is maintaining: with
  // the triggers left in place, a temp volume that filled up would fail the
  // very writes that queue threads for it.
  if (AppDataSource.options.type !== "better-sqlite3" || !AppDataSource.isInitialized) return;
  try {
    handle().exec(DROP_TRIGGERS);
  } catch {
    // The connection is going away, and the triggers with it.
  }
}

/**
 * Re-index queued threads for up to `budgetMs`, a few threads per statement.
 * Returns whether work remains. A boot queues every thread, so the first time
 * the queue runs dry the index is complete and search may use it. Exported
 * for the sweep and for tests.
 */
export function indexQueuedThreads(budgetMs: number): boolean {
  const db = handle();
  // Never interleave with a transaction the app has open on this connection:
  // our writes would join it, and its rollback would undo them.
  if (db.inTransaction) return true;
  const take = db.prepare(`SELECT threadId FROM temp.mail_search_queue LIMIT ?`).pluck();
  const threads = db.prepare(
    `SELECT rowid AS rowid FROM main.mail_threads WHERE id IN (SELECT value FROM json_each(?))`,
  );
  const indexed = db.prepare(`SELECT 1 FROM temp.mail_search WHERE rowid = ?`);
  const remove = db.prepare(`DELETE FROM temp.mail_search WHERE rowid = ?`);
  const insert = db.prepare(
    `INSERT INTO temp.mail_search(rowid, subject, sender, recipients, body)
     SELECT t.rowid,
            group_concat(m.subject, ' '),
            group_concat(m.fromName || ' ' || m.fromEmail, ' '),
            group_concat(m.toEmails || ' ' || m.ccEmails, ' '),
            group_concat(m.snippet || ' ' || substr(m.bodyText, 1, ${BODY_CHARS}), ' ')
       FROM main.mail_threads t
       JOIN main.mail_messages m ON m.threadId = t.id
      WHERE t.id IN (SELECT value FROM json_each(?))
      GROUP BY t.rowid`,
  );
  const dequeue = db.prepare(
    `DELETE FROM temp.mail_search_queue WHERE threadId IN (SELECT value FROM json_each(?))`,
  );
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const ids = take.all(BATCH_THREADS) as string[];
    if (ids.length === 0) {
      if (!ready) {
        ready = true;
        const seconds = Math.round((Date.now() - buildStartedAt) / 1000);
        // eslint-disable-next-line no-console
        console.log(`[mail] search index ready in ${seconds}s`);
      }
      return false;
    }
    const list = JSON.stringify(ids);
    db.transaction(() => {
      for (const { rowid } of threads.all(list) as Array<{ rowid: number }>) {
        // FTS5 cannot use an index for `rowid IN (...)`; one probe per thread can.
        if (indexed.get(rowid)) remove.run(rowid);
      }
      insert.run(list);
      dequeue.run(list);
    })();
    if (Date.now() >= deadline) return true;
  }
}

/** Scripts written without spaces between words, which the tokenizer cannot split. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * One search value as an FTS5 phrase, or null when the index cannot answer it
 * the way the `LIKE` filters would: punctuation alone, or text in a script
 * written without spaces, which the tokenizer would read as one long word.
 *
 * A single word also matches as a prefix — `invo` finds "invoice" — once its
 * last word is three letters or more; a shorter prefix matches most of the
 * mailbox and costs a walk of the whole index. A value with spaces is a phrase
 * the user quoted, and matches those words in order.
 */
function phrase(value: string): string | null {
  const words = value.match(WORD);
  if (!words || UNSPACED_SCRIPT.test(value)) return null;
  const quoted = `"${value.replace(/"/g, '""')}"`;
  if (/\s/.test(value.trim())) return quoted;
  return words[words.length - 1].length >= 3 ? `${quoted}*` : quoted;
}

/**
 * The FTS5 query for a search's text filters — free-text terms, `from:`,
 * `to:`, and `subject:` — or null when search should use its `LIKE` filters:
 * the index is not ready, the query has no text filter, or one of its values
 * is something the index cannot answer.
 */
export function mailSearchMatch(parsed: ParsedMailQuery): string | null {
  if (!ready) return null;
  const parts: string[] = [];
  for (const term of parsed.terms) {
    const p = phrase(term);
    if (p === null) return null;
    parts.push(p);
  }
  const columns: Array<[string, string | undefined]> = [
    ["sender", parsed.from],
    ["recipients", parsed.to],
    ["subject", parsed.subject],
  ];
  for (const [column, value] of columns) {
    if (!value) continue;
    const p = phrase(value);
    if (p === null) return null;
    parts.push(`${column} : ${p}`);
  }
  return parts.length > 0 ? parts.join(" AND ") : null;
}
