import fs from "node:fs";
import path from "node:path";

/**
 * Which Node major a repository asks for, when that is newer than the Node
 * Genosyn itself runs on.
 *
 * The OneUptime repository requires Node 26 while the Genosyn image ships
 * Node 22, so an AI Employee's tests and builds stopped at the engine check
 * and its audit reported the fix as untestable. A newer Node runs through npx
 * without changing the runtime Genosyn depends on, so a work session is told
 * how instead of being left to guess.
 */
export type RepositoryNodeRequirement = {
  /** The lowest major the repository accepts. */
  major: number;
  /** The version or range as the repository wrote it. */
  spec: string;
  /** Where it was found. */
  source: "package.json engines.node" | ".nvmrc" | ".node-version";
};

export function repositoryNodeRequirement(
  directory: string,
  runtimeMajor: number = Number(process.versions.node.split(".")[0]),
): RepositoryNodeRequirement | null {
  const declared: Array<[RepositoryNodeRequirement["source"], string | null]> = [
    ["package.json engines.node", enginesNode(directory)],
    [".nvmrc", firstLine(directory, ".nvmrc")],
    [".node-version", firstLine(directory, ".node-version")],
  ];
  for (const [source, spec] of declared) {
    if (!spec) continue;
    const major = minimumNodeMajor(spec);
    if (major === null) continue;
    return major > runtimeMajor ? { major, spec, source } : null;
  }
  return null;
}

/**
 * The lowest Node major a version or range accepts, such as ">=26", "^26.1.0",
 * "26.x", "v26.2.0" or ">=20 <27". Of alternatives joined by "||", the lowest
 * decides, because any one of them is enough. Aliases such as "lts/*" are
 * unknown.
 */
export function minimumNodeMajor(spec: string): number | null {
  const lowest = spec
    .split("||")
    .map((alternative) => {
      const match = /(>=|>|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(
        alternative.trim(),
      );
      if (!match) return null;
      const major = Number(match[2]);
      // ">26" excludes every 26.x.y only when written as a bare major.
      return match[1] === ">" && match[3] === undefined ? major + 1 : major;
    })
    .filter((major): major is number => major !== null && Number.isFinite(major));
  return lowest.length > 0 ? Math.min(...lowest) : null;
}

/** The section a work session reads when the repository needs a newer Node. */
export function nodeRequirementNote(requirement: RepositoryNodeRequirement): string {
  const npx = `npx -y -p node@${requirement.major} --`;
  return [
    "### Node version",
    `This repository asks for Node ${requirement.spec} (${requirement.source}), but this environment runs Node ${process.versions.node}. Run its Node commands with that version through npx, for example \`${npx} npm test\` or \`${npx} npm run build\`. The first use downloads that Node. Do not change the repository's Node requirement to fit the environment; if the download is refused, report that Node ${requirement.major} is unavailable here.`,
  ].join("\n");
}

function enginesNode(directory: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      engines?: { node?: unknown };
    };
    const value = pkg.engines?.node;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function firstLine(directory: string, file: string): string | null {
  try {
    const line = fs.readFileSync(path.join(directory, file), "utf8").split(/\r?\n/)[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}
