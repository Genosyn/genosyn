import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_OPENING_FORM,
  RESUME_EXTENSIONS,
  RESUME_MAX_BYTES,
  type OpeningFormSettings,
  type OpeningQuestion,
  type OpeningQuestionKind,
} from "../../shared/recruiting.js";
import {
  EMPTY_APPLICATION,
  EMPTY_FILTERS,
  answersPayload,
  applyByLabel,
  distinctValues,
  filterOpenings,
  formatBytes,
  groupByDepartment,
  hasActiveFilters,
  hexToRgba,
  newSubmissionId,
  parseBootstrap,
  postedLabel,
  resumeFileProblem,
  validateApplication,
  type ApplicationValues,
  type OpeningFilters,
} from "./lib.js";
import type { CareersBootstrap, PublicOpening, PublicOpeningCard, PublicSite } from "./types.js";

/**
 * The careers site's own logic (`client/careers-site/lib.ts`): everything a
 * candidate's browser decides before a request reaches the server. These pin
 * that the page reads the data the server wrote into it and survives a broken
 * block; that dates read in the visitor's own calendar days; that filters and
 * groups find the Openings a person would expect; that every submit carries a
 * real version-4 UUID even off HTTPS; and that the form's checks mark the
 * same fields, under the same keys, as the server's answer would.
 */

function card(
  fields: Partial<PublicOpeningCard> & Pick<PublicOpeningCard, "slug">,
): PublicOpeningCard {
  return {
    title: "Opening",
    summary: "",
    department: "",
    location: "",
    workplace: "onsite",
    employmentType: "full_time",
    visibility: "public",
    meta: "",
    compensation: null,
    publishedAt: null,
    applyBy: null,
    url: `https://acme.example/careers/openings/${fields.slug}`,
    ...fields,
  };
}

const BACKEND = card({
  slug: "backend-engineer",
  title: "Backend Engineer",
  summary: "Build the API in TypeScript.",
  department: "Engineering",
  location: "Berlin",
  workplace: "hybrid",
  employmentType: "full_time",
});
const DESIGNER = card({
  slug: "product-designer",
  title: "Product Designer",
  summary: "Shape how candidates meet us.",
  department: "Design",
  location: "Zürich",
  workplace: "remote",
  employmentType: "contract",
});
const INTERN = card({
  slug: "data-intern",
  title: "Data Intern",
  summary: "Learn SQL with the data team.",
  department: "Engineering",
  location: "Berlin",
  workplace: "onsite",
  employmentType: "internship",
});
const OFFICE = card({
  slug: "office-manager",
  title: "Office Manager",
  summary: "Keep the office running.",
  department: "",
  location: "London",
  workplace: "onsite",
  employmentType: "part_time",
});
const SALES = card({
  slug: "account-executive",
  title: "Account Executive",
  summary: "Close new business.",
  department: "Sales",
  location: "New York",
  workplace: "remote",
  employmentType: "full_time",
});
const OPENINGS = [BACKEND, DESIGNER, INTERN, OFFICE, SALES];

function filters(fields: Partial<OpeningFilters>): OpeningFilters {
  return { ...EMPTY_FILTERS, ...fields };
}

const SITE: PublicSite = {
  companySlug: "acme",
  name: "Acme",
  headline: "Build what comes next",
  intro: "A small team.",
  websiteUrl: "https://acme.example",
  privacyPolicyUrl: "https://acme.example/privacy",
  accentColor: "#4f46e5",
  logoUrl: null,
  visibility: "public",
  url: "https://genosyn.example/careers/acme",
  apiPath: "/api/careers/acme",
  viewer: { member: false, name: "", email: "" },
};

/** The JSON escaping the server applies inside `<script id="careers-bootstrap">`. */
function scriptSafe(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

describe("parseBootstrap", () => {
  test("reads the page data the server wrote, exactly", () => {
    const home: CareersBootstrap = {
      kind: "home",
      basePath: "/careers/acme",
      site: SITE,
      openings: [BACKEND, SALES],
      opening: null,
      signInUrl: "",
    };
    assert.deepEqual(parseBootstrap(JSON.stringify(home)), home);

    const opening: PublicOpening = {
      ...BACKEND,
      description: "## The role\nShip it.",
      headcount: 2,
      accepting: true,
      status: "open",
      form: DEFAULT_OPENING_FORM,
      questions: [],
    };
    const page: CareersBootstrap = {
      kind: "opening",
      basePath: "",
      site: SITE,
      openings: [],
      opening,
      signInUrl: "",
    };
    assert.deepEqual(parseBootstrap(JSON.stringify(page)), page);
  });

  test("undoes the escaping that keeps the block from closing its own script tag", () => {
    const bootstrap: CareersBootstrap = {
      kind: "home",
      basePath: "/careers/acme",
      site: { ...SITE, name: "R&D <Labs>", intro: "</script><script>alert(1)</script>\u2028next" },
      openings: [],
      opening: null,
      signInUrl: "",
    };
    const text = scriptSafe(bootstrap);
    assert.doesNotMatch(text, /<|>|&/);
    assert.deepEqual(parseBootstrap(text), bootstrap);
  });

  test("fills what a block leaves out, or gets wrong, with safe defaults", () => {
    assert.deepEqual(parseBootstrap('{"kind":"not_found"}'), {
      kind: "not_found",
      basePath: "",
      site: null,
      openings: [],
      opening: null,
      signInUrl: "/login",
    });
    assert.deepEqual(
      parseBootstrap(
        JSON.stringify({
          kind: "members_only",
          basePath: 7,
          site: null,
          openings: "many",
          opening: null,
          signInUrl: null,
        }),
      ),
      {
        kind: "members_only",
        basePath: "",
        site: null,
        openings: [],
        opening: null,
        signInUrl: "/login",
      },
    );
  });

  test("keeps only the fields the site knows", () => {
    const parsed = parseBootstrap(
      JSON.stringify({ kind: "home", basePath: "", secret: "x", openings: [] }),
    );
    assert.deepEqual(Object.keys(parsed ?? {}).sort(), [
      "basePath",
      "kind",
      "opening",
      "openings",
      "signInUrl",
      "site",
    ]);
  });

  test("is null when there is no block, or it is not page data", () => {
    for (const text of [
      null,
      undefined,
      "",
      "not json",
      "{",
      '{"kind":"home"',
      "null",
      "42",
      "true",
      '"home"',
      "[]",
      "{}",
      '{"kind":3}',
      '{"kind":null}',
      '{"basePath":"/careers/acme"}',
    ]) {
      assert.equal(parseBootstrap(text), null, String(text));
    }
  });
});

/** An instant at a wall-clock time in the visitor's own timezone. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

describe("postedLabel", () => {
  const now = at(2026, 10, 21, 9, 30);
  const posted = (date: Date) => postedLabel(date.toISOString(), now);

  test("says today for anything posted on the visitor's calendar day, or later", () => {
    assert.equal(posted(at(2026, 10, 21, 0, 5)), "Posted today");
    assert.equal(posted(at(2026, 10, 21, 23, 55)), "Posted today");
    assert.equal(posted(at(2026, 10, 25)), "Posted today");
  });

  test("counts calendar days, not hours", () => {
    assert.equal(posted(at(2026, 10, 20, 23, 59)), "Posted yesterday");
    assert.equal(posted(at(2026, 10, 20, 0, 1)), "Posted yesterday");
    assert.equal(posted(at(2026, 10, 19)), "Posted 2 days ago");
    assert.equal(posted(at(2026, 10, 15)), "Posted 6 days ago");
  });

  test("switches to weeks from seven days, and to the date from four weeks", () => {
    assert.equal(posted(at(2026, 10, 14)), "Posted 1 week ago");
    assert.equal(posted(at(2026, 10, 8)), "Posted 1 week ago");
    assert.equal(posted(at(2026, 10, 7)), "Posted 2 weeks ago");
    assert.equal(posted(at(2026, 9, 24)), "Posted 3 weeks ago");
    assert.equal(posted(at(2026, 9, 23)), "Posted Sep 23");
    assert.equal(posted(at(2026, 3, 3)), "Posted Mar 3");
  });

  test("adds the year only to a date from another year", () => {
    assert.equal(posted(at(2025, 12, 30)), "Posted Dec 30, 2025");
  });

  test("counts whole days across a daylight-saving change", () => {
    // Europe springs forward on 29 March 2026 and the United States on 8 March:
    // one of those days is 23 hours long wherever the test runs in either.
    assert.equal(
      postedLabel(at(2026, 3, 28).toISOString(), at(2026, 3, 30, 9)),
      "Posted 2 days ago",
    );
    assert.equal(postedLabel(at(2026, 3, 7).toISOString(), at(2026, 3, 9, 9)), "Posted 2 days ago");
    assert.equal(
      postedLabel(at(2026, 10, 24).toISOString(), at(2026, 10, 26, 9)),
      "Posted 2 days ago",
    );
  });

  test("says nothing without a usable date", () => {
    assert.equal(postedLabel(null, now), "");
    assert.equal(postedLabel("", now), "");
    assert.equal(postedLabel("last Tuesday", now), "");
  });
});

describe("applyByLabel", () => {
  test("spells out the closing date in the visitor's calendar", () => {
    assert.equal(applyByLabel(at(2026, 3, 3).toISOString()), "Apply by March 3, 2026");
    // The editor sends the end of the chosen day.
    assert.equal(
      applyByLabel(new Date(2026, 10, 30, 23, 59, 59).toISOString()),
      "Apply by November 30, 2026",
    );
  });

  test("is null for an Opening with no closing date", () => {
    assert.equal(applyByLabel(null), null);
    assert.equal(applyByLabel(""), null);
    assert.equal(applyByLabel("soon"), null);
  });
});

describe("filterOpenings", () => {
  test("lists every Opening, in order, when nothing is filtered", () => {
    assert.deepEqual(filterOpenings(OPENINGS, EMPTY_FILTERS), OPENINGS);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "  \t " })), OPENINGS);
    assert.deepEqual(filterOpenings([], filters({ query: "anything" })), []);
  });

  test("keeps only the Openings that match every chosen filter", () => {
    assert.deepEqual(filterOpenings(OPENINGS, filters({ department: "Engineering" })), [
      BACKEND,
      INTERN,
    ]);
    assert.deepEqual(
      filterOpenings(OPENINGS, filters({ department: "Engineering", workplace: "onsite" })),
      [INTERN],
    );
    assert.deepEqual(
      filterOpenings(OPENINGS, filters({ location: "Berlin", employmentType: "internship" })),
      [INTERN],
    );
    assert.deepEqual(filterOpenings(OPENINGS, filters({ workplace: "remote" })), [DESIGNER, SALES]);
    assert.deepEqual(
      filterOpenings(OPENINGS, filters({ workplace: "remote", employmentType: "full_time" })),
      [SALES],
    );
    assert.deepEqual(
      filterOpenings(OPENINGS, filters({ department: "Design", location: "Berlin" })),
      [],
    );
  });

  test("matches every word of the search against title, summary, department and location", () => {
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "typescript" })), [BACKEND]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "DESIGNER" })), [DESIGNER]);
    // "engineer" is in one title and in the Engineering department.
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "engineer" })), [BACKEND, INTERN]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "berlin data" })), [INTERN]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "  new   york " })), [SALES]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "berlin sales" })), []);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "astronaut" })), []);
  });

  test("matches the workplace and employment type as the site words them", () => {
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "remote" })), [DESIGNER, SALES]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "full-time" })), [BACKEND, SALES]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "on-site" })), [INTERN, OFFICE]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "part-time" })), [OFFICE]);
  });

  test("ignores accents and case on both sides", () => {
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "zurich" })), [DESIGNER]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "ZÜRICH" })), [DESIGNER]);
    assert.deepEqual(filterOpenings(OPENINGS, filters({ query: "Berlín" })), [BACKEND, INTERN]);
  });

  test("combines the search with the filters", () => {
    assert.deepEqual(
      filterOpenings(OPENINGS, filters({ query: "engineer", workplace: "hybrid" })),
      [BACKEND],
    );
  });
});

describe("hasActiveFilters", () => {
  test("is true as soon as any filter or the search is set", () => {
    assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
    assert.deepEqual(EMPTY_FILTERS, {
      query: "",
      department: "",
      location: "",
      workplace: "",
      employmentType: "",
    });
    for (const fields of [
      { query: "x" },
      { department: "Design" },
      { location: "Berlin" },
      { workplace: "remote" as const },
      { employmentType: "contract" as const },
    ]) {
      assert.equal(hasActiveFilters(filters(fields)), true, JSON.stringify(fields));
    }
  });
});

describe("distinctValues", () => {
  test("lists each non-empty value once, sorted, for a filter's choices", () => {
    assert.deepEqual(distinctValues(OPENINGS, "department"), ["Design", "Engineering", "Sales"]);
    assert.deepEqual(distinctValues(OPENINGS, "location"), [
      "Berlin",
      "London",
      "New York",
      "Zürich",
    ]);
    assert.deepEqual(distinctValues(OPENINGS, "workplace"), ["hybrid", "onsite", "remote"]);
    assert.deepEqual(distinctValues(OPENINGS, "employmentType"), [
      "contract",
      "full_time",
      "internship",
      "part_time",
    ]);
    assert.deepEqual(distinctValues([], "department"), []);
  });

  test("sorts the way a person reads, not by character code", () => {
    assert.deepEqual(
      distinctValues(
        [card({ slug: "a", department: "Engineering" }), card({ slug: "b", department: "design" })],
        "department",
      ),
      ["design", "Engineering"],
    );
  });
});

describe("groupByDepartment", () => {
  test("groups by department alphabetically, with the unnamed group last", () => {
    assert.deepEqual(groupByDepartment(OPENINGS), [
      { department: "Design", openings: [DESIGNER] },
      { department: "Engineering", openings: [BACKEND, INTERN] },
      { department: "Sales", openings: [SALES] },
      { department: "", openings: [OFFICE] },
    ]);
  });

  test("keeps each group's Openings in the order they came", () => {
    const later = card({ slug: "staff-engineer", department: "Engineering" });
    assert.deepEqual(
      groupByDepartment([INTERN, later, BACKEND]).map((group) =>
        group.openings.map((item) => item.slug),
      ),
      [["data-intern", "staff-engineer", "backend-engineer"]],
    );
  });

  test("puts a department written with stray spaces in the same group", () => {
    const spaced = card({ slug: "ux-writer", department: "  Design " });
    assert.deepEqual(groupByDepartment([DESIGNER, spaced]), [
      { department: "Design", openings: [DESIGNER, spaced] },
    ]);
  });

  test("gives a site whose Openings name no department one untitled group", () => {
    const first = card({ slug: "first" });
    const second = card({ slug: "second", department: "   " });
    assert.deepEqual(groupByDepartment([first, second]), [
      { department: "", openings: [first, second] },
    ]);
    assert.deepEqual(groupByDepartment([]), []);
  });
});

/** A stand-in for `crypto` with only `getRandomValues`, as on a plain-HTTP page. */
function fixedRandom(byte: (index: number) => number) {
  const requested: number[] = [];
  const random = {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      requested.push(bytes.length);
      for (let index = 0; index < bytes.length; index++) bytes[index] = byte(index);
      return array;
    },
  };
  return { random, requested };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newSubmissionId", () => {
  test("lays sixteen random bytes out as a version-4 UUID", () => {
    const counting = fixedRandom((index) => index);
    assert.equal(newSubmissionId(counting.random), "00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.deepEqual(counting.requested, [16]);
  });

  test("forces the version and variant bits whatever the random bytes were", () => {
    assert.equal(
      newSubmissionId(fixedRandom(() => 0xff).random),
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
    );
    assert.equal(
      newSubmissionId(fixedRandom(() => 0x00).random),
      "00000000-0000-4000-8000-000000000000",
    );
    for (let seed = 0; seed < 256; seed += 17) {
      assert.match(
        newSubmissionId(fixedRandom((index) => (seed * 31 + index * 7) & 0xff).random),
        UUID_V4,
      );
    }
  });

  test("uses the platform's random source by default, a fresh id every time", () => {
    const ids = new Set<string>();
    for (let count = 0; count < 500; count++) {
      const id = newSubmissionId();
      assert.match(id, UUID_V4);
      ids.add(id);
    }
    assert.equal(ids.size, 500);
  });
});

describe("hexToRgba", () => {
  test("tints the accent color at the given opacity", () => {
    assert.equal(hexToRgba("#4f46e5", 0.08), "rgba(79, 70, 229, 0.08)");
    assert.equal(hexToRgba("#4F46E5", 1), "rgba(79, 70, 229, 1)");
    assert.equal(hexToRgba(" #ffffff ", 0.35), "rgba(255, 255, 255, 0.35)");
    assert.equal(hexToRgba("#000000", 0), "rgba(0, 0, 0, 0)");
  });

  test("falls back to the default accent for anything but #rrggbb, which is all the server sends", () => {
    assert.equal(hexToRgba("#abc", 0.5), "rgba(79, 70, 229, 0.5)");
    assert.equal(hexToRgba("indigo", 0.2), "rgba(79, 70, 229, 0.2)");
    assert.equal(hexToRgba("", 0.2), "rgba(79, 70, 229, 0.2)");
  });
});

describe("formatBytes", () => {
  test("sizes a file in bytes, kilobytes or megabytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1 KB");
    assert.equal(formatBytes(1536), "2 KB");
    assert.equal(formatBytes(250 * 1024), "250 KB");
    // Just under a megabyte rounds up to one, never to "1024 KB".
    assert.equal(formatBytes(1024 * 1024 - 1), "1.0 MB");
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
    assert.equal(formatBytes(5.5 * 1024 * 1024), "5.5 MB");
    assert.equal(formatBytes(RESUME_MAX_BYTES), "10.0 MB");
  });
});

const TYPE_PROBLEM = "Use a PDF, Word document, OpenDocument, RTF or plain text file.";

describe("resumeFileProblem", () => {
  test("accepts every resume type the site offers, by extension, in any case", () => {
    for (const extension of RESUME_EXTENSIONS) {
      assert.equal(resumeFileProblem({ name: `resume${extension}`, size: 2048 }), null, extension);
      assert.equal(
        resumeFileProblem({ name: `RESUME${extension.toUpperCase()}`, size: 2048 }),
        null,
        extension,
      );
    }
    assert.equal(resumeFileProblem({ name: "Ada Lovelace – CV.v2.Docx", size: 2048 }), null);
  });

  test("refuses any other file by its last extension", () => {
    for (const name of [
      "resume",
      "resume.",
      "resume.pages",
      "portrait.png",
      "resume.pdf.exe",
      "resume.zip",
    ]) {
      assert.equal(resumeFileProblem({ name, size: 2048 }), TYPE_PROBLEM, name);
    }
  });

  test("refuses an empty file and one over 10 MB", () => {
    assert.equal(resumeFileProblem({ name: "resume.pdf", size: 0 }), "That file is empty.");
    assert.equal(resumeFileProblem({ name: "resume.pdf", size: RESUME_MAX_BYTES }), null);
    assert.equal(
      resumeFileProblem({ name: "resume.pdf", size: RESUME_MAX_BYTES + 1 }),
      "Keep the resume under 10 MB.",
    );
  });

  test("names the wrong type before the size", () => {
    assert.equal(resumeFileProblem({ name: "portrait.png", size: 0 }), TYPE_PROBLEM);
    assert.equal(
      resumeFileProblem({ name: "portrait.png", size: RESUME_MAX_BYTES + 1 }),
      TYPE_PROBLEM,
    );
  });
});

const COMPLETE: ApplicationValues = {
  ...EMPTY_APPLICATION,
  name: "Ada Lovelace",
  email: "ada@example.com",
  consent: true,
};
const RESUME = { name: "ada-lovelace.pdf", size: 120_000 };

const ALL_REQUIRED: OpeningFormSettings = {
  phone: "required",
  location: "required",
  linkedin: "required",
  website: "required",
  resume: "required",
  coverLetter: "required",
};
const ALL_HIDDEN: OpeningFormSettings = {
  phone: "hidden",
  location: "hidden",
  linkedin: "hidden",
  website: "hidden",
  resume: "optional",
  coverLetter: "hidden",
};

function question(
  id: string,
  kind: OpeningQuestionKind,
  required: boolean,
  options: string[] = [],
): OpeningQuestion {
  return { id, label: `Question ${id}`, help: "", kind, required, options };
}

/** Check a complete application with some fields changed. */
function check(
  values: Partial<ApplicationValues>,
  form: OpeningFormSettings = DEFAULT_OPENING_FORM,
  questions: OpeningQuestion[] = [],
  resume: { name: string; size: number } | null = RESUME,
): Record<string, string> {
  return validateApplication({ ...COMPLETE, ...values }, form, questions, resume);
}

describe("validateApplication", () => {
  test("passes a complete application", () => {
    assert.deepEqual(check({}), {});
    assert.deepEqual(
      check(
        {
          phone: "+1 415 555 0100",
          location: "Berlin",
          linkedinUrl: "https://www.linkedin.com/in/ada",
          websiteUrl: "ada.dev",
          coverLetter: "I would like to build this with you.",
        },
        ALL_REQUIRED,
      ),
      {},
    );
  });

  test("marks every missing basic at once", () => {
    assert.deepEqual(validateApplication(EMPTY_APPLICATION, DEFAULT_OPENING_FORM, [], null), {
      name: "Enter your name.",
      email: "Enter an email address, like ada@example.com.",
      resume: "Attach your resume.",
      consent: "Agree to how your application will be used to continue.",
    });
  });

  test("treats a name of spaces as no name", () => {
    assert.deepEqual(check({ name: "   " }), { name: "Enter your name." });
  });

  test("accepts an email address, and nothing that only looks like one", () => {
    for (const email of ["ada@example.com", "  Ada.Lovelace+jobs@Example.co.uk ", "a@b.io"]) {
      assert.deepEqual(check({ email }), {}, email);
    }
    for (const email of [
      "",
      "ada",
      "ada@example",
      "ada@example.c",
      "ada@@example.com",
      "ada lovelace@example.com",
      "Ada <ada@example.com>",
      "ada@example.com, bob@example.com",
      "ada@example.com;bob@example.com",
      '"ada"@example.com',
      "ada@example.c0m",
    ]) {
      assert.deepEqual(
        check({ email }),
        { email: "Enter an email address, like ada@example.com." },
        email,
      );
    }
  });

  test("requires the standard fields the Opening requires, and only those", () => {
    const required = {
      phone: "This is required.",
      location: "This is required.",
      linkedin: "This is required.",
      website: "This is required.",
      coverLetter: "This is required.",
    };
    assert.deepEqual(check({}, ALL_REQUIRED), required);
    assert.deepEqual(
      check(
        { phone: "  ", location: "\n", linkedinUrl: " ", websiteUrl: "\t", coverLetter: "   " },
        ALL_REQUIRED,
      ),
      required,
    );
    assert.deepEqual(check({}, DEFAULT_OPENING_FORM), {});
    assert.deepEqual(check({}, ALL_HIDDEN, [], null), {});
  });

  test("checks a phone number has six digits whenever one is given", () => {
    for (const phone of ["+1 415 555 0100", "123456", "(030) 12-34", "+44 20 7946 0958"]) {
      assert.deepEqual(check({ phone }), {}, phone);
    }
    for (const phone of ["12345", "call me", "+1 (555)"]) {
      assert.deepEqual(
        check({ phone }),
        { phone: "Enter a phone number, like +1 415 555 0100." },
        phone,
      );
    }
  });

  test("checks the LinkedIn and website links whenever they are given", () => {
    for (const link of [
      "linkedin.com/in/ada",
      "https://www.linkedin.com/in/ada",
      "http://linkedin.com/in/ada",
      "  www.linkedin.com/in/ada  ",
    ]) {
      assert.deepEqual(check({ linkedinUrl: link, websiteUrl: link }), {}, link);
    }
    for (const link of [
      "ada",
      "linkedin dot com",
      "ftp://linkedin.com/in/ada",
      "javascript:alert(1)",
      "mailto:ada@example.com",
    ]) {
      assert.deepEqual(
        check({ linkedinUrl: link, websiteUrl: link }),
        {
          linkedin: "Enter a link, like https://www.linkedin.com/in/you.",
          website: "Enter a link, like https://example.com.",
        },
        link,
      );
    }
  });

  test("asks for a resume only when the Opening requires one, and checks any file given", () => {
    assert.deepEqual(check({}, DEFAULT_OPENING_FORM, [], null), { resume: "Attach your resume." });
    assert.deepEqual(check({}, { ...DEFAULT_OPENING_FORM, resume: "optional" }, [], null), {});
    assert.deepEqual(
      check({}, { ...DEFAULT_OPENING_FORM, resume: "optional" }, [], {
        name: "portrait.png",
        size: 2048,
      }),
      { resume: TYPE_PROBLEM },
    );
    assert.deepEqual(
      check({}, DEFAULT_OPENING_FORM, [], { name: "resume.pdf", size: RESUME_MAX_BYTES + 1 }),
      {
        resume: "Keep the resume under 10 MB.",
      },
    );
    assert.deepEqual(check({}, DEFAULT_OPENING_FORM, [], { name: "resume.pdf", size: 0 }), {
      resume: "That file is empty.",
    });
  });

  test("needs an answer to every required question, keyed the way the server keys it", () => {
    const questions = [
      question("why", "short_text", true),
      question("story", "long_text", true),
      question("tools", "multi_select", true, ["Go", "Rust"]),
      question("team", "single_select", true, ["Platform", "Product"]),
      question("visa", "yes_no", true),
      question("notes", "long_text", false),
    ];
    assert.deepEqual(
      check({ answers: { story: "   ", tools: [], team: "" } }, DEFAULT_OPENING_FORM, questions),
      {
        "answers.why": "This question needs an answer.",
        "answers.story": "This question needs an answer.",
        "answers.tools": "This question needs an answer.",
        "answers.team": "This question needs an answer.",
        "answers.visa": "This question needs an answer.",
      },
    );
    // "No" is an answer.
    assert.deepEqual(
      check(
        {
          answers: {
            why: "Mission",
            story: "Long story.",
            tools: ["Go"],
            team: "Product",
            visa: false,
          },
        },
        DEFAULT_OPENING_FORM,
        questions,
      ),
      {},
    );
  });

  test("checks a number answer is a number", () => {
    const questions = [question("years", "number", true), question("salary", "number", false)];
    for (const years of ["42", " 3.5 ", "-7", "0", "1e3"]) {
      assert.deepEqual(check({ answers: { years } }, DEFAULT_OPENING_FORM, questions), {}, years);
    }
    for (const years of ["forty", "12abc", "Infinity", "1,000"]) {
      assert.deepEqual(
        check({ answers: { years } }, DEFAULT_OPENING_FORM, questions),
        { "answers.years": "Answer with a number." },
        years,
      );
    }
    assert.deepEqual(
      check({ answers: { years: "5", salary: "a lot" } }, DEFAULT_OPENING_FORM, questions),
      { "answers.salary": "Answer with a number." },
    );
  });

  test("checks a link answer is a web address", () => {
    const questions = [question("portfolio", "url", true), question("blog", "url", false)];
    for (const portfolio of ["example.com/portfolio", "https://github.com/ada"]) {
      assert.deepEqual(
        check({ answers: { portfolio } }, DEFAULT_OPENING_FORM, questions),
        {},
        portfolio,
      );
    }
    for (const portfolio of ["my portfolio", "github", "ftp://example.com"]) {
      assert.deepEqual(
        check({ answers: { portfolio } }, DEFAULT_OPENING_FORM, questions),
        { "answers.portfolio": "Answer with a web address, like https://example.com." },
        portfolio,
      );
    }
  });

  test("needs the candidate's consent", () => {
    assert.deepEqual(check({ consent: false }), {
      consent: "Agree to how your application will be used to continue.",
    });
  });
});

describe("answersPayload", () => {
  test("sends numbers as numbers, yes/no as booleans and the rest as typed", () => {
    const questions = [
      question("why", "short_text", true),
      question("years", "number", true),
      question("budget", "number", false),
      question("visa", "yes_no", true),
      question("tools", "multi_select", false, ["Go", "Rust"]),
      question("team", "single_select", false, ["Platform", "Product"]),
      question("portfolio", "url", false),
      question("skipped", "long_text", false),
    ];
    assert.deepEqual(
      answersPayload(questions, {
        why: "Mission",
        years: " 3.50 ",
        budget: "   ",
        visa: false,
        tools: ["Go", "Rust"],
        team: "Product",
        portfolio: "example.com/ada",
        unasked: "dropped",
      }),
      {
        why: "Mission",
        years: 3.5,
        budget: null,
        visa: false,
        tools: ["Go", "Rust"],
        team: "Product",
        portfolio: "example.com/ada",
      },
    );
  });

  test("is empty when nothing was answered", () => {
    assert.deepEqual(answersPayload([question("why", "short_text", true)], {}), {});
    assert.deepEqual(answersPayload([], { stray: "x" }), {});
  });
});
