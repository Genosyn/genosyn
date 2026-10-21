import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientRoot = path.join(appRoot, "client");
const sharedSelect = path.join(clientRoot, "components/ui/Select.tsx");
/**
 * The public careers site is its own bundle (`client/careers.html`) for
 * applicants, not Members: it never loads the App's components, and its few
 * short dropdowns stay native so phones show their own picker.
 */
const careersSite = path.join(clientRoot, "careers-site");

function tsxFiles(directory = clientRoot): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (absolutePath === careersSite) return [];
    if (entry.isDirectory()) return tsxFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [absolutePath] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("searchable dropdown coverage", () => {
  test("keeps native selects behind the shared searchable control", () => {
    const violations = tsxFiles()
      .filter((file) => file !== sharedSelect)
      .flatMap((file) => {
        const lines = withoutComments(fs.readFileSync(file, "utf8")).split("\n");
        return lines
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter(({ line }) => /<select\b/.test(line))
          .map(
            ({ lineNumber }) =>
              `${path.relative(appRoot, file).split(path.sep).join("/")}:${lineNumber}`,
          );
      });

    assert.deepEqual(
      violations,
      [],
      "Use client/components/ui/Select.tsx so every dropdown remains searchable",
    );
  });
});
