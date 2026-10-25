import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DATA_ROOM_CHECKLISTS, readinessScore } from "../../../shared/dataRooms.js";
import {
  CHUNK_CHARS,
  chunkText,
  normalizeForQuote,
  selectExcerpts,
  tokenize,
  verifyQuote,
  type RetrievalDocument,
} from "./retrieval.js";

function doc(id: string, title: string, text: string): RetrievalDocument {
  return { id, title, folderName: null, text, summary: null };
}

/** Filler that shares no words with the questions below. */
function filler(words: number, seed: string): string {
  return Array.from({ length: words }, (_, index) => `${seed}${index % 97}`).join(" ");
}

describe("tokenize", () => {
  test("folds case and accents, drops stopwords, and stems plurals", () => {
    assert.deepEqual(tokenize("What were the Revenues in Zürich?"), ["revenue", "zurich"]);
    assert.deepEqual(tokenize("ARR grew 2025"), ["arr", "grew", "2025"]);
  });
});

describe("chunkText", () => {
  test("covers the whole text in overlapping passages no longer than a chunk", () => {
    const text = filler(2_000, "w");
    const chunks = chunkText("d1", text);
    assert.ok(chunks.length > 1);
    assert.equal(chunks[0].start, 0);
    assert.equal(chunks[chunks.length - 1].end, text.length);
    for (let index = 1; index < chunks.length; index++) {
      assert.ok(chunks[index].start < chunks[index - 1].end, "neighbours overlap");
    }
    for (const chunk of chunks) assert.ok(chunk.text.length <= CHUNK_CHARS);
  });
});

describe("selectExcerpts", () => {
  test("passes small documents whole", () => {
    const excerpts = selectExcerpts({
      documents: [doc("a", "Deck", "Our ARR is 2.4M."), doc("b", "Empty", "   ")],
      question: "What is ARR?",
      budgetChars: 10_000,
    });
    assert.equal(excerpts.length, 1, "a document with no text is left out");
    assert.deepEqual(excerpts[0].passages, ["Our ARR is 2.4M."]);
    assert.equal(excerpts[0].whole, true);
  });

  test("picks the passages that answer the question when the documents do not fit", () => {
    const answer =
      "Net revenue retention was 128 percent in fiscal 2025, driven by seat expansion.";
    const model = `${filler(800, "x")} ${answer} ${filler(800, "y")}`;
    const excerpts = selectExcerpts({
      documents: [doc("model", "Financial model", model), doc("deck", "Deck", filler(3_000, "z"))],
      question: "What was net revenue retention?",
      budgetChars: 3_000,
    });
    const shown = excerpts.flatMap((excerpt) => excerpt.passages).join(" ");
    assert.ok(shown.includes(answer));
    assert.ok(shown.length <= 3_000 + 400, "stays close to the budget");
    assert.equal(excerpts[0].documentId, "model");
  });

  test("always includes the document the guest was reading", () => {
    const excerpts = selectExcerpts({
      documents: [
        doc("deck", "Pitch deck", filler(3_000, "p")),
        doc("terms", "Revenue terms", `Revenue ${filler(3_000, "r")}`),
      ],
      question: "What revenue terms apply?",
      focusDocumentId: "deck",
      budgetChars: 2_000,
    });
    assert.ok(excerpts.some((excerpt) => excerpt.documentId === "deck"));
  });

  test("falls back to the opening of each document when nothing matches", () => {
    const excerpts = selectExcerpts({
      documents: [doc("a", "A", filler(2_000, "a")), doc("b", "B", filler(2_000, "b"))],
      question: "Hello?",
      budgetChars: 2_000,
    });
    assert.deepEqual(
      excerpts.map((excerpt) => excerpt.documentId),
      ["a", "b"],
    );
    for (const excerpt of excerpts) assert.equal(excerpt.passages.length, 1);
  });
});

describe("verifyQuote", () => {
  const passage =
    "The Company’s “annual recurring revenue” was $2.4 million — up 80%\nyear over year.";

  test("finds an exact quote across line breaks, curly quotes and dashes", () => {
    assert.equal(
      verifyQuote('"annual recurring revenue" was $2.4 million - up 80% year over year', [passage]),
      true,
    );
    assert.equal(verifyQuote("THE COMPANY'S", [passage]), true);
  });

  test("refuses what is not there, what is too short, and stitched quotes", () => {
    assert.equal(verifyQuote("annual recurring revenue was $3 million", [passage]), false);
    assert.equal(verifyQuote("was $2", [passage]), false);
    assert.equal(verifyQuote("annual recurring … year over year", [passage]), false);
    assert.equal(verifyQuote("annual recurring ... year over year", [passage]), false);
  });

  test("normalizes the same way on both sides", () => {
    assert.equal(normalizeForQuote("  A\u00a0B\u200b—C  "), "a b-c");
  });
});

describe("readinessScore", () => {
  test("counts covered fully, partly covered half, essential items double, and silence as missing", () => {
    const checklist = DATA_ROOM_CHECKLISTS.other;
    assert.deepEqual(
      checklist.map((item) => item.importance),
      ["essential", "expected"],
    );
    assert.equal(readinessScore("other", []), 0);
    assert.equal(readinessScore("other", [{ key: "overview", status: "present" }]), 67);
    assert.equal(
      readinessScore("other", [
        { key: "overview", status: "present" },
        { key: "supporting", status: "partial" },
      ]),
      83,
    );
    assert.equal(
      readinessScore("other", [
        { key: "overview", status: "present" },
        { key: "supporting", status: "present" },
        { key: "not-on-the-list", status: "present" },
      ]),
      100,
    );
  });

  test("every purpose's checklist has distinct keys and at least one essential item", () => {
    for (const [purpose, checklist] of Object.entries(DATA_ROOM_CHECKLISTS)) {
      const keys = checklist.map((item) => item.key);
      assert.equal(new Set(keys).size, keys.length, purpose);
      assert.ok(
        checklist.some((item) => item.importance === "essential"),
        purpose,
      );
    }
  });
});
