import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  DEFAULT_CONFIRMATION_EMAIL_BODY,
  DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
  DEFAULT_REJECTION_EMAIL_BODY,
  DEFAULT_REJECTION_EMAIL_SUBJECT,
  DEFAULT_SCREENING_INSTRUCTIONS,
  EMAIL_TEMPLATE_PLACEHOLDERS,
  RECRUITING_STAGES,
  SCORE_LABELS,
  renderEmailTemplate,
  type RecruitingStage,
  type ScoreLabel,
} from "../../shared/recruiting.js";
import {
  SOURCE_LABELS,
  TONE_CLASSES,
  addCandidate,
  describeApplicantEmail,
  describeEvent,
  recruitingApi,
  sampleEmailValues,
  scoreBarClass,
  scoreLabelText,
  scoreTone,
  screenSummary,
  screeningInstructionsEdit,
  shortAgo,
  stageLabel,
  stageTone,
  type ApplicationSummary,
  type TimelineEvent,
  type Tone,
} from "./recruiting.js";

/**
 * The small decisions every Recruiting screen makes the same way
 * (`client/lib/recruiting.ts`): what a stage, a score, a screen status and a
 * timeline line are called, and how they are colored. These pin that a
 * failed or missing AI screen never reads as a low score, that each stage and
 * score label has its own tone, that every kind of timeline event reads as a
 * sentence, and that the email preview fills every placeholder the server
 * fills — plus the two calls that build their own requests.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Recorded = { url: string; init: RequestInit | undefined };

/** Answer every request with `status` and `body`, keeping what was asked. */
function stubFetch(status: number, body: string): Recorded[] {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return calls;
}

describe("stages", () => {
  test("each stage has its label and tone", () => {
    assert.deepEqual(
      RECRUITING_STAGES.map((stage) => [stage, stageLabel(stage), stageTone(stage)]),
      [
        ["applied", "Applied", "info"],
        ["screening", "Screening", "accent"],
        ["interview", "Interview", "warn"],
        ["offer", "Offer", "good"],
        ["hired", "Hired", "good"],
        ["rejected", "Rejected", "bad"],
        ["withdrawn", "Withdrawn", "neutral"],
      ],
    );
  });

  test("a stage this release does not know reads as written", () => {
    assert.equal(stageLabel("archived" as RecruitingStage), "archived");
  });

  test("every tone a badge can take has classes", () => {
    const tones = new Set<Tone>([
      ...RECRUITING_STAGES.map(stageTone),
      ...[...SCORE_LABELS, null].map(scoreTone),
    ]);
    for (const tone of tones) {
      assert.equal(typeof TONE_CLASSES[tone], "string", tone);
      assert.notEqual(TONE_CLASSES[tone].trim(), "", tone);
    }
  });
});

describe("scores", () => {
  test("each score label has its words, tone and bar color", () => {
    const labels: Array<ScoreLabel | null> = [...SCORE_LABELS, null];
    assert.deepEqual(
      labels.map((label) => [label, scoreLabelText(label), scoreTone(label), scoreBarClass(label)]),
      [
        ["strong", "Strong match", "good", "bg-emerald-500"],
        ["good", "Good match", "accent", "bg-indigo-500"],
        ["possible", "Possible match", "warn", "bg-amber-500"],
        ["weak", "Weak match", "bad", "bg-rose-500"],
        [null, "Not scored", "neutral", "bg-slate-300"],
      ],
    );
  });
});

function screenOf(
  screenStatus: ApplicationSummary["screenStatus"],
  score: number | null,
  scoreLabel: ScoreLabel | null,
): ReturnType<typeof screenSummary> {
  return screenSummary({ screenStatus, score, scoreLabel });
}

describe("screenSummary", () => {
  test("shows a scored Application's number and label", () => {
    assert.deepEqual(screenOf("scored", 72, "good"), { text: "72 · Good match", tone: "accent" });
    assert.deepEqual(screenOf("scored", 91, "strong"), { text: "91 · Strong match", tone: "good" });
    assert.deepEqual(screenOf("scored", 0, "weak"), { text: "0 · Weak match", tone: "bad" });
  });

  test("never shows a number while a screen is waiting, running or has failed", () => {
    assert.deepEqual(screenOf("queued", null, null), {
      text: "Waiting to be scored",
      tone: "neutral",
    });
    assert.deepEqual(screenOf("running", null, null), { text: "Scoring now", tone: "info" });
    assert.deepEqual(screenOf("failed", null, null), { text: "Could not be scored", tone: "warn" });
    // Not even an older score: a failed screen is not a low one.
    assert.deepEqual(screenOf("failed", 12, "weak"), { text: "Could not be scored", tone: "warn" });
    assert.deepEqual(screenOf("queued", 72, "good"), {
      text: "Waiting to be scored",
      tone: "neutral",
    });
  });

  test("reads a scored status without a score as not scored, with no number", () => {
    assert.deepEqual(screenOf("scored", null, null), { text: "— · Not scored", tone: "neutral" });
  });

  test("shows a score given outside the screen, and Not scored when there is none", () => {
    assert.deepEqual(screenOf("none", 64, "good"), { text: "64 · Good match", tone: "accent" });
    assert.deepEqual(screenOf("none", null, null), { text: "Not scored", tone: "neutral" });
  });
});

describe("SOURCE_LABELS", () => {
  test("names where each Application came from", () => {
    assert.deepEqual(SOURCE_LABELS, {
      careers_site: "Careers site",
      internal: "Internal",
      manual: "Added by a Member",
      sourced: "Sourced by AI",
    });
  });
});

describe("shortAgo", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const ago = (seconds: number) =>
    shortAgo(new Date(now.getTime() - seconds * 1000).toISOString(), now);

  test("is a dash with no time at all", () => {
    assert.equal(shortAgo(null, now), "—");
  });

  test("says now for the last minute, and for a clock slightly ahead", () => {
    assert.equal(ago(0), "now");
    assert.equal(ago(59), "now");
    assert.equal(ago(-300), "now");
  });

  test("counts whole minutes, hours and days", () => {
    assert.equal(ago(60), "1m");
    assert.equal(ago(59 * 60 + 59), "59m");
    assert.equal(ago(3_600), "1h");
    assert.equal(ago(23 * 3_600 + 59 * 60), "23h");
    assert.equal(ago(86_400), "1d");
    assert.equal(ago(29 * 86_400 + 23 * 3_600), "29d");
  });

  test("shows the date from thirty days on", () => {
    const then = new Date(now.getTime() - 30 * 86_400 * 1000);
    const label = shortAgo(then.toISOString(), now);
    assert.equal(label, then.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    assert.doesNotMatch(label, /^(now|\d+[mhd])$/);
  });
});

function event(kind: TimelineEvent["kind"], fields: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "evt_1",
    kind,
    actorKind: "member",
    actorName: "Grace Hopper",
    actorUserId: "user_1",
    actorEmployeeId: null,
    fromStage: null,
    toStage: null,
    body: "",
    meta: {},
    occurredAt: "2026-10-21T12:00:00.000Z",
    ...fields,
  };
}

/** Every kind of timeline event; `satisfies` fails to compile when a kind is added or dropped. */
const EVENT_KINDS = {
  applied: true,
  added: true,
  stage_changed: true,
  note: true,
  scored: true,
  screen_failed: true,
  email_sent: true,
  email_failed: true,
  email_skipped: true,
  criteria_drafted: true,
} satisfies Record<TimelineEvent["kind"], true>;

describe("describeEvent", () => {
  test("tells how the candidate arrived", () => {
    const candidate = {
      actorKind: "candidate" as const,
      actorName: "Ada Lovelace",
      actorUserId: null,
    };
    assert.equal(
      describeEvent(event("applied", { ...candidate, meta: { source: "careers_site" } })),
      "Ada Lovelace applied through the careers site",
    );
    assert.equal(
      describeEvent(event("applied", { ...candidate, meta: { source: "internal" } })),
      "Ada Lovelace applied as a Member",
    );
    assert.equal(
      describeEvent(event("applied", candidate)),
      "Ada Lovelace applied through the careers site",
    );
    assert.equal(describeEvent(event("added")), "Grace Hopper added this candidate");
  });

  test("names both stages of a move", () => {
    assert.equal(
      describeEvent(event("stage_changed", { fromStage: "screening", toStage: "interview" })),
      "Grace Hopper moved them from Screening to Interview",
    );
    assert.equal(
      describeEvent(event("stage_changed", { fromStage: "offer", toStage: "rejected" })),
      "Grace Hopper moved them from Offer to Rejected",
    );
  });

  test("gives a score only when the event carries a number", () => {
    const screener = { actorKind: "employee" as const, actorName: "Screener", actorUserId: null };
    assert.equal(
      describeEvent(event("scored", { ...screener, meta: { score: 72 } })),
      "Screener scored them 72",
    );
    assert.equal(
      describeEvent(event("scored", { ...screener, meta: { score: 0 } })),
      "Screener scored them 0",
    );
    assert.equal(
      describeEvent(event("scored", { ...screener, meta: { score: null } })),
      "Screener scored them",
    );
    assert.equal(
      describeEvent(event("scored", { ...screener, meta: { score: "72" } })),
      "Screener scored them",
    );
    assert.equal(describeEvent(event("scored", screener)), "Screener scored them");
  });

  test("words notes, failed screens, emails and drafted criteria", () => {
    assert.equal(
      describeEvent(event("note", { body: "Strong portfolio." })),
      "Grace Hopper wrote a note",
    );
    assert.equal(
      describeEvent(event("screen_failed", { actorKind: "system", actorName: "Genosyn" })),
      "The AI screen could not finish",
    );
    assert.equal(
      describeEvent(
        event("email_sent", { body: "We received your application for Senior Backend Engineer" }),
      ),
      "Emailed the candidate: We received your application for Senior Backend Engineer",
    );
    assert.equal(
      describeEvent(event("email_failed", { body: "550 mailbox unavailable" })),
      "An email to the candidate failed",
    );
    assert.equal(describeEvent(event("email_skipped")), "An email to the candidate was not sent");
    assert.equal(
      describeEvent(event("criteria_drafted", { actorKind: "employee", actorName: "Screener" })),
      "Screener drafted the Opening's criteria",
    );
  });

  test("reads every kind of event as a sentence", () => {
    for (const kind of Object.keys(EVENT_KINDS) as Array<TimelineEvent["kind"]>) {
      const sentence = describeEvent(event(kind, { fromStage: "applied", toStage: "screening" }));
      assert.equal(typeof sentence, "string", kind);
      assert.ok(sentence.length > 0, kind);
    }
  });
});

describe("screeningInstructionsEdit", () => {
  const NO_PRINCIPLES = "No principles of your own — the fairness rule still applies";

  test("offers nothing to save while the default is untouched", () => {
    assert.deepEqual(
      screeningInstructionsEdit({
        draft: DEFAULT_SCREENING_INSTRUCTIONS,
        saved: DEFAULT_SCREENING_INSTRUCTIONS,
        usingDefault: true,
      }),
      {
        dirty: false,
        problem: null,
        canSave: false,
        canRestore: false,
        countLabel: "4 instructions",
      },
    );
    // Trailing spaces and blank lines are not a change.
    assert.equal(
      screeningInstructionsEdit({
        draft: `${DEFAULT_SCREENING_INSTRUCTIONS}   \n\n`,
        saved: DEFAULT_SCREENING_INSTRUCTIONS,
        usingDefault: true,
      }).dirty,
      false,
    );
  });

  test("counts an added principle and lets it be saved", () => {
    assert.deepEqual(
      screeningInstructionsEdit({
        draft: `${DEFAULT_SCREENING_INSTRUCTIONS}\nValue open source work like paid work.`,
        saved: DEFAULT_SCREENING_INSTRUCTIONS,
        usingDefault: true,
      }),
      {
        dirty: true,
        problem: null,
        canSave: true,
        canRestore: false,
        countLabel: "5 instructions",
      },
    );
  });

  test("offers Restore default once the company has its own", () => {
    const own = "- Weigh shipped work over credentials.";
    assert.deepEqual(screeningInstructionsEdit({ draft: own, saved: own, usingDefault: false }), {
      dirty: false,
      problem: null,
      canSave: false,
      canRestore: true,
      countLabel: "1 instruction",
    });
  });

  test("says the fairness rule still applies when the box is emptied", () => {
    assert.deepEqual(
      screeningInstructionsEdit({
        draft: "  \n ",
        saved: DEFAULT_SCREENING_INSTRUCTIONS,
        usingDefault: true,
      }),
      { dirty: true, problem: null, canSave: true, canRestore: false, countLabel: NO_PRINCIPLES },
    );
  });

  test("refuses principles over 4,000 characters or 30 lines", () => {
    const long = screeningInstructionsEdit({
      draft: "a".repeat(4_001),
      saved: DEFAULT_SCREENING_INSTRUCTIONS,
      usingDefault: true,
    });
    assert.equal(long.problem, "Keep the instructions under 4,000 characters.");
    assert.equal(long.canSave, false);

    const many = screeningInstructionsEdit({
      draft: Array.from({ length: 31 }, (_, index) => `Principle ${index + 1}`).join("\n"),
      saved: DEFAULT_SCREENING_INSTRUCTIONS,
      usingDefault: true,
    });
    assert.equal(many.problem, "Keep it to 30 instructions or fewer, one per line.");
    assert.equal(many.canSave, false);
    assert.equal(many.countLabel, "30 instructions");
  });
});

describe("sampleEmailValues", () => {
  test("previews with a sample candidate and the company's own name and site", () => {
    assert.deepEqual(sampleEmailValues("Acme", "https://acme.example/careers"), {
      first_name: "Ada",
      full_name: "Ada Lovelace",
      opening_title: "Senior Backend Engineer",
      company_name: "Acme",
      opening_url: "https://acme.example/careers/openings/senior-backend-engineer",
    });
  });

  test("fills every placeholder the server fills, so no default previews with a gap", () => {
    const values = sampleEmailValues("Acme", "https://acme.example/careers");
    assert.deepEqual(Object.keys(values).sort(), [...EMAIL_TEMPLATE_PLACEHOLDERS].sort());
    for (const template of [
      DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
      DEFAULT_CONFIRMATION_EMAIL_BODY,
      DEFAULT_REJECTION_EMAIL_SUBJECT,
      DEFAULT_REJECTION_EMAIL_BODY,
    ]) {
      assert.doesNotMatch(renderEmailTemplate(template, values), /\{\{|\}\}/);
    }
    assert.equal(
      renderEmailTemplate(DEFAULT_CONFIRMATION_EMAIL_SUBJECT, values),
      "We received your application for Senior Backend Engineer",
    );
  });
});

describe("recruitingApi", () => {
  test("links a resume for viewing and for download", () => {
    const api = recruitingApi("co_1");
    assert.equal(
      api.resumeUrl("app_9"),
      "/api/companies/co_1/recruiting/applications/app_9/resume",
    );
    assert.equal(
      api.resumeUrl("app_9", true),
      "/api/companies/co_1/recruiting/applications/app_9/resume?download=1",
    );
  });

  test("asks for Applications with only the filters that are set", async () => {
    const calls = stubFetch(200, JSON.stringify({ rows: [], total: 0 }));
    const api = recruitingApi("co_1");
    await api.applications({
      openingId: "op_1",
      stage: "active",
      q: "",
      sort: "score",
      limit: 50,
      offset: 0,
    });
    await api.applications();
    await api.applications({ q: "rust engineer", screenStatus: "failed" });
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "/api/companies/co_1/recruiting/applications?openingId=op_1&stage=active&sort=score&limit=50&offset=0",
        "/api/companies/co_1/recruiting/applications",
        "/api/companies/co_1/recruiting/applications?q=rust+engineer&screenStatus=failed",
      ],
    );
  });

  test("asks for Openings with only the filters that are set", async () => {
    const calls = stubFetch(200, JSON.stringify({ rows: [] }));
    const api = recruitingApi("co_1");
    await api.openings();
    await api.openings({ status: "open", q: "" });
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "/api/companies/co_1/recruiting/openings",
        "/api/companies/co_1/recruiting/openings?status=open",
      ],
    );
  });
});

describe("addCandidate", () => {
  test("posts the fields that were filled in, with the resume under its own name", async () => {
    const calls = stubFetch(201, JSON.stringify({ id: "app_1", candidateName: "Ada Lovelace" }));
    const resume = new File(["%PDF-1.7 resume"], "Ada Lovelace.pdf", { type: "application/pdf" });
    const created = await addCandidate(
      "co_1",
      "op_1",
      {
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "",
        sourceDetail: "Met at a meetup",
      },
      resume,
    );
    assert.deepEqual(created, { id: "app_1", candidateName: "Ada Lovelace" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/companies/co_1/recruiting/openings/op_1/applications");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.credentials, "same-origin");
    const body = calls[0].init?.body;
    assert.ok(body instanceof FormData);
    assert.deepEqual([...body.keys()], ["name", "email", "sourceDetail", "resume"]);
    assert.equal(body.get("name"), "Ada Lovelace");
    assert.equal(body.get("sourceDetail"), "Met at a meetup");
    const file = body.get("resume");
    assert.ok(file instanceof File);
    assert.equal(file.name, "Ada Lovelace.pdf");
  });

  test("sends no resume part when there is no file", async () => {
    const calls = stubFetch(201, JSON.stringify({ id: "app_2" }));
    await addCandidate("co_1", "op_1", { name: "Grace Hopper", email: "grace@example.com" }, null);
    const body = calls[0].init?.body;
    assert.ok(body instanceof FormData);
    assert.equal(body.has("resume"), false);
  });

  test("explains a refusal with the first field's problem, then the error, then the status", async () => {
    const attempt = () =>
      addCandidate("co_1", "op_1", { name: "Ada", email: "ada" }, null).then(
        () => assert.fail("the request was refused"),
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    stubFetch(
      400,
      JSON.stringify({
        error: "Check the highlighted fields.",
        fields: {
          email: "Enter an email address, like ada@example.com.",
          name: "Enter your name.",
        },
      }),
    );
    assert.equal(await attempt(), "Enter an email address, like ada@example.com.");

    stubFetch(409, JSON.stringify({ error: "This Opening is closed.", fields: {} }));
    assert.equal(await attempt(), "This Opening is closed.");

    stubFetch(403, JSON.stringify({ error: "Only Members can add candidates." }));
    assert.equal(await attempt(), "Only Members can add candidates.");

    stubFetch(502, "<html>Bad gateway</html>");
    assert.equal(await attempt(), "Request failed (502)");

    stubFetch(500, JSON.stringify({}));
    assert.equal(await attempt(), "Request failed (500)");
  });
});

describe("describeApplicantEmail", () => {
  test("says whose wording an applicant email uses, and its subject", () => {
    assert.equal(
      describeApplicantEmail({ usingDefault: true, subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT }),
      `Default wording · “${DEFAULT_CONFIRMATION_EMAIL_SUBJECT}”`,
    );
    assert.equal(
      describeApplicantEmail({ usingDefault: false, subject: "  Thanks for applying!  " }),
      "Your wording · “Thanks for applying!”",
    );
  });

  test("leaves out an empty subject, and names unsaved changes", () => {
    assert.equal(describeApplicantEmail({ usingDefault: false, subject: " " }), "Your wording");
    assert.equal(
      describeApplicantEmail({ usingDefault: true, subject: "Hello", dirty: true }),
      "Default wording · “Hello” · unsaved changes",
    );
  });
});
