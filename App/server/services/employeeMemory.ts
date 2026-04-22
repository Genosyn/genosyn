import { MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";

/**
 * Memory & recall helpers that live in one place so chat turns and routine
 * runs stay in lockstep. Both surfaces prepend the same `## Memory` and
 * `## Recent activity` sections to the prompt so the AI behaves consistently
 * regardless of how it was triggered.
 */

const RECENT_JOURNAL_DAYS = 7;
const RECENT_JOURNAL_MAX_ENTRIES = 30;
const RECENT_JOURNAL_MAX_BYTES = 8 * 1024;
const MEMORY_MAX_BYTES = 8 * 1024;

export async function loadMemory(employeeId: string): Promise<EmployeeMemory[]> {
  return AppDataSource.getRepository(EmployeeMemory).find({
    where: { employeeId },
    order: { createdAt: "ASC" },
  });
}

export async function loadRecentJournal(
  employeeId: string,
  days = RECENT_JOURNAL_DAYS,
): Promise<JournalEntry[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return AppDataSource.getRepository(JournalEntry).find({
    where: { employeeId, createdAt: MoreThan(cutoff) },
    order: { createdAt: "DESC" },
    take: RECENT_JOURNAL_MAX_ENTRIES,
  });
}

/**
 * Render the `## Memory` block. Returns an empty string if the employee has
 * no memory items — callers should `.trim()` and skip empties rather than
 * printing an empty heading.
 */
export function renderMemoryBlock(items: EmployeeMemory[]): string {
  if (items.length === 0) return "";
  const lines: string[] = ["", "## Memory", ""];
  lines.push(
    "Durable facts and preferences you should keep in mind during every conversation and routine run. A teammate curated these explicitly — treat them as load-bearing.",
    "",
  );
  let bytes = 0;
  for (const item of items) {
    const entry = renderMemoryItem(item);
    if (bytes + entry.length > MEMORY_MAX_BYTES) {
      lines.push(
        `\n_…${items.length - lines.length} more memory items omitted to keep the prompt bounded. Use the memory tools if you need them._`,
      );
      break;
    }
    bytes += entry.length;
    lines.push(entry);
  }
  return lines.join("\n");
}

function renderMemoryItem(item: EmployeeMemory): string {
  const header = `- **${item.title.trim()}**`;
  const body = item.body.trim();
  if (!body) return header;
  // Indent the body so the bullet list reads cleanly.
  const indented = body
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return `${header}\n${indented}`;
}

/**
 * Render `## Recent activity` from the last ~7 days of journal entries.
 * Empty string if the employee has nothing logged — we prefer silence over
 * a "(no activity)" placeholder so the prompt stays short.
 */
export function renderRecentJournalBlock(entries: JournalEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = ["", "## Recent activity", ""];
  lines.push(
    "Your journal from the last few days — what you (or routines you own) actually did. Reason from this instead of re-asking the teammate what happened.",
    "",
  );
  let bytes = 0;
  let used = 0;
  for (const entry of entries) {
    const rendered = renderJournalLine(entry);
    if (bytes + rendered.length > RECENT_JOURNAL_MAX_BYTES) {
      lines.push(
        `\n_…${entries.length - used} older entries omitted to keep the prompt bounded. Use \`list_journal\` to read more._`,
      );
      break;
    }
    bytes += rendered.length;
    used += 1;
    lines.push(rendered);
  }
  return lines.join("\n");
}

function renderJournalLine(entry: JournalEntry): string {
  const when = entry.createdAt.toISOString().slice(0, 16).replace("T", " ");
  const kind = entry.kind.toUpperCase();
  const header = `- \`${when} · ${kind}\` ${entry.title.trim()}`;
  const body = entry.body.trim();
  if (!body) return header;
  const preview = body.length > 500 ? body.slice(0, 500) + "…" : body;
  const indented = preview
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return `${header}\n${indented}`;
}

export async function composeMemoryContext(employeeId: string): Promise<string> {
  const [memory, journal] = await Promise.all([
    loadMemory(employeeId),
    loadRecentJournal(employeeId),
  ]);
  const parts = [renderMemoryBlock(memory), renderRecentJournalBlock(journal)].filter(
    (p) => p.length > 0,
  );
  return parts.join("\n");
}
