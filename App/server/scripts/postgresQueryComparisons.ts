import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Migrated Postgres column types, keyed by entity class name then property name. */
export type EntityColumnTypes = ReadonlyMap<string, ReadonlyMap<string, string>>;

const TEXT_TYPES = new Set(["character varying", "text", "character"]);
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const COMPARISON = /([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*(?:=|<>|!=)\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
// Query builder calls that name an entity class next to the alias they introduce.
const ALIASES = [
  /\.(?:inner|left)Join(?:AndSelect)?\(\s*([A-Z]\w*)\s*,\s*["'`](\w+)["'`]/g,
  /\.(?:inner|left)JoinAndMap(?:One|Many)\(\s*["'`][^"'`]+["'`]\s*,\s*([A-Z]\w*)\s*,\s*["'`](\w+)["'`]/g,
  /\.from\(\s*([A-Z]\w*)\s*,\s*["'`](\w+)["'`]/g,
  /createQueryBuilder\(\s*([A-Z]\w*)\s*,\s*["'`](\w+)["'`]/g,
  /\(\s*([A-Z]\w*)\s*\)\s*\.createQueryBuilder\(\s*["'`](\w+)["'`]/g,
];
const REPOSITORY_VARIABLE =
  /(?:const|let|var)\s+(\w+)\s*=\s*[\w.]*getRepository\(\s*([A-Z]\w*)\s*\)/g;
const REPOSITORY_QUERY = /\b(\w+)\s*\.createQueryBuilder\(\s*["'`](\w+)["'`]/g;

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["migrations", "node_modules", "test"].includes(entry.name))
        files.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Postgres has no `uuid = character varying` operator, while SQLite compares
 * both as text. Query builder conditions that compare a uuid primary key with a
 * varchar reference column therefore pass locally and fail every time on
 * Postgres. Report each `alias.column` comparison whose aliases resolve, within
 * the same file, to entities whose migrated column types are uuid and text.
 */
export async function findUuidTextComparisons(
  serverRoot: string,
  columnTypes: EntityColumnTypes,
): Promise<string[]> {
  const findings: string[] = [];
  for (const file of await sourceFiles(serverRoot)) {
    const source = await readFile(file, "utf8");
    const aliases = new Map<string, Set<string>>();
    const addAlias = (alias: string, entity: string) => {
      if (!columnTypes.has(entity)) return;
      aliases.set(alias, (aliases.get(alias) ?? new Set()).add(entity));
    };
    for (const pattern of ALIASES) {
      for (const [, entity, alias] of source.matchAll(pattern)) addAlias(alias, entity);
    }
    const repositories = new Map<string, string>();
    for (const [, variable, entity] of source.matchAll(REPOSITORY_VARIABLE))
      repositories.set(variable, entity);
    for (const [, variable, alias] of source.matchAll(REPOSITORY_QUERY)) {
      const entity = repositories.get(variable);
      if (entity) addAlias(alias, entity);
    }
    const typesOf = (alias: string, column: string) =>
      [...(aliases.get(alias) ?? [])].flatMap((entity) => {
        const type = columnTypes.get(entity)?.get(column);
        return type ? [type] : [];
      });
    for (const literal of source.matchAll(STRING_LITERAL)) {
      for (const comparison of literal[0].matchAll(COMPARISON)) {
        const [text, leftAlias, leftColumn, rightAlias, rightColumn] = comparison;
        const left = typesOf(leftAlias, leftColumn);
        const right = typesOf(rightAlias, rightColumn);
        const mismatched = left.some((a) =>
          right.some(
            (b) => (a === "uuid" && TEXT_TYPES.has(b)) || (b === "uuid" && TEXT_TYPES.has(a)),
          ),
        );
        if (!mismatched) continue;
        const offset = (literal.index ?? 0) + (comparison.index ?? 0);
        const line = source.slice(0, offset).split("\n").length;
        findings.push(`${path.relative(serverRoot, file)}:${line} ${text}`);
      }
    }
  }
  return findings;
}
