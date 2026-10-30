import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { RecruitingApplication } from "../db/entities/RecruitingApplication.js";
import { RecruitingOpening } from "../db/entities/RecruitingOpening.js";
import { Repository } from "../db/entities/Repository.js";
import { Resource } from "../db/entities/Resource.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { Todo } from "../db/entities/Todo.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { searchCompany, type CompanySearchResult, type SearchResultKind } from "./search.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/**
 * What the words mean.
 *
 * Every kind of row in company search is reached by its product noun, the
 * plural, a half-typed prefix, and the words people actually use for it
 * ("agent", "repo", "task"). The reported bug — a Dashboard called Revenue
 * invisible to "revenue dashboard" — was one instance of the same mistake:
 * search required every typed word inside the row's title. These tests hold
 * the whole table to the rule, not just the Dashboard that led us here.
 *
 * `shared/searchKinds.ts` owns the vocabulary; this file proves each surface
 * applies it to real rows, with the permissions, soft deletes, ranking, and
 * caps every other search path already has.
 */

/** The kind, the row's displayed label, and the words that name its kind. */
type Fixture = {
  kind: SearchResultKind;
  label: string;
  /** The first entry is the kind's own product noun. */
  qualifiers: readonly string[];
  id: string;
};

/**
 * A single realistic row per kind, all containing "revenue" in the title.
 *
 * Customers are deliberately "Revenue Holdings" rather than "Revenue
 * Customer": the word "customer" belongs to the qualifier, and letting it sit
 * in the title would hide whether the qualifier or the title did the work.
 * The Applicant is "Revenue Shortlist" for the same reason, and because a
 * name containing "app" would accidentally satisfy the short-prefix test
 * below through SQL's substring match.
 */
const FIXTURES: Record<string, Omit<Fixture, "id">> = {
  employee: {
    kind: "employee",
    label: "Revenue Operations",
    qualifiers: ["employee", "agent", "teammate", "worker", "staff", "bot", "ai"],
  },
  skill: { kind: "skill", label: "Revenue playbook", qualifiers: ["skill", "playbook"] },
  routine: {
    kind: "routine",
    label: "Revenue digest",
    qualifiers: ["routine", "cron", "schedule"],
  },
  channel: { kind: "channel", label: "#revenue-ops", qualifiers: ["channel", "chat"] },
  project: { kind: "project", label: "Revenue migration", qualifiers: ["project", "proj"] },
  todo: {
    kind: "todo",
    label: "Revenue migration checklist",
    qualifiers: ["todo", "task", "ticket"],
  },
  base: {
    kind: "base",
    label: "Revenue book",
    qualifiers: ["base", "table", "spreadsheet", "sheet", "database", "airtable"],
  },
  notebook: { kind: "notebook", label: "Revenue handbook", qualifiers: ["notebook", "noteb"] },
  note: {
    kind: "note",
    label: "Revenue memo",
    qualifiers: ["note", "doc", "document", "wiki", "page"],
  },
  resource: {
    kind: "resource",
    label: "Revenue field guide",
    qualifiers: ["resource", "library", "ebook"],
  },
  chart: {
    kind: "chart",
    label: "Revenue",
    qualifiers: ["chart", "graph", "visualization", "visualisation", "char"],
  },
  dashboard: { kind: "dashboard", label: "Revenue", qualifiers: ["dashboard", "dash"] },
  repository: { kind: "repository", label: "Revenue service", qualifiers: ["repository", "repo"] },
  pipeline: {
    kind: "pipeline",
    label: "Revenue automation",
    qualifiers: ["pipeline", "workflow", "pipe"],
  },
  customer: {
    kind: "customer",
    label: "Revenue Holdings",
    qualifiers: ["customer", "client", "cust"],
  },
  opening: {
    kind: "opening",
    label: "Revenue lead",
    qualifiers: ["opening", "job", "vacancy", "posting", "role"],
  },
  applicant: {
    kind: "applicant",
    label: "Revenue Shortlist",
    qualifiers: ["applicant", "candidate", "application"],
  },
};

describe("company search kind qualifiers", () => {
  let companyId: string;
  let fixtures: Fixture[];
  let notebookId: string;

  beforeEach(async () => {
    const company = await insert(Company, {
      name: "Northwind",
      slug: "northwind",
      ownerId: "owner-1",
    });
    companyId = company.id;

    const employee = await insert(AIEmployee, {
      companyId,
      name: "Revenue Operations",
      slug: "revenue-operations",
      role: "Operations",
    });
    const notebook = await insert(Notebook, {
      companyId,
      title: "Revenue handbook",
      slug: "revenue-handbook",
    });
    notebookId = notebook.id;
    const project = await insert(Project, {
      companyId,
      name: "Revenue migration",
      slug: "revenue-migration",
      key: "REV",
      accessMode: "open",
    });
    const opening = await insert(RecruitingOpening, {
      companyId,
      title: "Revenue lead",
      slug: "revenue-lead",
      department: "Revenue",
    });

    const rows = {
      employee,
      skill: await insert(Skill, {
        employeeId: employee.id,
        name: "Revenue playbook",
        slug: "revenue-playbook",
      }),
      routine: await insert(Routine, {
        employeeId: employee.id,
        name: "Revenue digest",
        slug: "revenue-digest",
        cronExpr: "0 9 * * *",
      }),
      channel: await insert(Channel, {
        companyId,
        kind: "public",
        name: "revenue-ops",
        slug: "revenue-ops",
        topic: "Revenue and pipeline",
      }),
      project,
      todo: await insert(Todo, {
        projectId: project.id,
        number: 1,
        title: "Revenue migration checklist",
      }),
      base: await insert(Base, {
        companyId,
        name: "Revenue book",
        slug: "revenue-book",
        description: "Quarterly revenue tables",
      }),
      notebook,
      note: await insert(Note, {
        companyId,
        notebookId: notebook.id,
        title: "Revenue memo",
        slug: "revenue-memo",
      }),
      resource: await insert(Resource, {
        companyId,
        title: "Revenue field guide",
        slug: "revenue-field-guide",
      }),
      chart: await insert(Chart, {
        companyId,
        title: "Revenue",
        slug: "revenue",
        description: "Quarterly revenue trend",
      }),
      dashboard: await insert(Dashboard, {
        companyId,
        title: "Revenue",
        slug: "revenue",
        description: "Quarterly revenue trend",
      }),
      repository: await insert(Repository, {
        companyId,
        name: "Revenue service",
        slug: "revenue-service",
        description: "Revenue billing code",
        gitUrl: "https://example.test/revenue-service.git",
      }),
      pipeline: await insert(Pipeline, {
        companyId,
        name: "Revenue automation",
        slug: "revenue-automation",
        description: "Revenue workflow",
      }),
      customer: await insert(Customer, {
        companyId,
        name: "Revenue Holdings",
        slug: "revenue-holdings",
        email: "revenue@holdings.test",
        domain: "holdings.test",
      }),
      opening,
      applicant: await insert(RecruitingApplication, {
        companyId,
        openingId: opening.id,
        candidateName: "Revenue Shortlist",
        candidateEmail: "shortlist@example.test",
        stageChangedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    } as const;

    fixtures = Object.entries(FIXTURES).map(([key, fixture]) => ({
      ...fixture,
      id: rows[key as keyof typeof rows].id,
    }));
  });

  async function search(
    query: string,
    opts: {
      role?: Role;
      financeAccess?: FinanceAccess | undefined;
      userId?: string;
    } = {},
  ): Promise<CompanySearchResult[]> {
    return searchCompany({
      companyId,
      userId: opts.userId ?? "owner-1",
      role: opts.role ?? "owner",
      financeAccess: opts.financeAccess ?? "full",
      query,
    });
  }

  function ofKind(results: CompanySearchResult[], kind: SearchResultKind): CompanySearchResult[] {
    return results.filter((result) => result.kind === kind);
  }

  function assertFinds(results: CompanySearchResult[], fixture: Fixture, query: string): void {
    assert.ok(
      ofKind(results, fixture.kind).some((result) => result.id === fixture.id),
      `${query} should find ${fixture.kind} "${fixture.label}"`,
    );
  }

  /**
   * The bug from the screenshot, at every width of the word: the phrase must
   * work in either order, singular or plural, and while "dashboard" is still
   * being typed.
   */
  test("finds the Dashboard called Revenue for every way of typing the phrase", async () => {
    const dashboard = fixtures.find((fixture) => fixture.kind === "dashboard");
    assert.ok(dashboard);
    for (const query of [
      "revenue dashboard",
      "dashboard revenue",
      "revenue dashboards",
      "dashboards revenue",
      "revenue dash",
      "revenue dashb",
      "revenue dashbo",
      "REVENUE DASHBOARD",
      "  revenue   dashboard  ",
    ]) {
      assertFinds(await search(query), dashboard, query);
    }
  });

  test("every kind answers to its product noun and the words people use for it", async () => {
    for (const fixture of fixtures) {
      for (const qualifier of fixture.qualifiers) {
        const query = `revenue ${qualifier}`;
        assertFinds(await search(query), fixture, query);
      }
    }
  });

  test("every kind answers to its plural and as-you-type prefix", async () => {
    const variants: Partial<Record<SearchResultKind, string[]>> = {
      employee: ["employees", "empl"],
      skill: ["skills", "skil"],
      routine: ["routines", "rout"],
      channel: ["channels", "chan"],
      project: ["projects", "proj"],
      todo: ["todos"],
      base: ["bases"],
      notebook: ["notebooks", "noteb"],
      note: ["notes"],
      resource: ["resources", "reso"],
      chart: ["charts", "char"],
      dashboard: ["dashboards", "dash"],
      repository: ["repositories", "repo"],
      pipeline: ["pipelines", "pipe"],
      customer: ["customers", "cust"],
      opening: ["openings", "open"],
      applicant: ["applicants", "appl"],
    };
    for (const fixture of fixtures) {
      for (const variant of variants[fixture.kind] ?? []) {
        const query = `revenue ${variant}`;
        assertFinds(await search(query), fixture, query);
      }
    }
  });

  test("a kind word on its own lists that kind", async () => {
    for (const fixture of fixtures) {
      const noun = fixture.qualifiers[0];
      const hits = await search(noun);
      assertFinds(hits, fixture, noun);
    }
  });

  test("a phrase made only of kind words lists that kind", async () => {
    const employee = fixtures.find((fixture) => fixture.kind === "employee");
    assert.ok(employee);
    for (const query of ["ai employee", "ai employees", "ai agent"]) {
      assertFinds(await search(query), employee, query);
    }
  });

  test("a kind word on its own does not list another kind", async () => {
    // The Chart and the Dashboard share the title "Revenue"; only the list
    // named by the query may answer.
    assert.deepEqual(ofKind(await search("dashboard"), "chart"), []);
    assert.deepEqual(ofKind(await search("chart"), "dashboard"), []);
  });

  test("a row named for the kind itself leads a kind-only search", async () => {
    await insert(Dashboard, {
      companyId,
      title: "Dashboard",
      slug: "dashboard",
      description: "",
    });
    const hits = ofKind(await search("dashboard"), "dashboard");
    assert.equal(hits[0]?.label, "Dashboard");
    // The rows whose titles do not contain the word keep their old score.
    assert.ok(hits.some((hit) => hit.label === "Revenue"));
  });

  test("short prefixes stay ordinary title words instead of selecting a kind", async () => {
    // Three letters are not enough to mean Project, Channel, Note, Task,
    // Resource, Repository, or Application. The extra word must still narrow
    // the title, so a row called just "Revenue" must not appear.
    const cases: Array<[SearchResultKind, string]> = [
      ["project", "revenue pro"],
      ["channel", "revenue cha"],
      ["chart", "revenue cha"],
      ["note", "revenue not"],
      ["notebook", "revenue not"],
      ["todo", "revenue tas"],
      ["resource", "revenue res"],
      ["repository", "revenue rep"],
      ["applicant", "revenue app"],
      ["dashboard", "revenue das"],
    ];
    for (const [kind, query] of cases) {
      assert.deepEqual(ofKind(await search(query), kind), [], `${query} must not select ${kind}`);
    }
  });

  test("the remaining words still narrow the title", async () => {
    for (const query of [
      "revenue zebra dashboard",
      "revenue zebra chart",
      "zebra repositories",
      "revenue board notes",
    ]) {
      const hits = await search(query);
      assert.equal(
        hits.some((hit) => ["dashboard", "chart", "repository", "note"].includes(hit.kind)),
        false,
        query,
      );
    }
  });

  test("matches a description when the title does not carry the word", async () => {
    const rows: Array<[SearchResultKind, string, string]> = [
      ["base", "Finance book", "Revenue tables"],
      ["chart", "Quarterly trend", "Revenue by month"],
      ["dashboard", "Board pack", "Revenue summary"],
      ["repository", "Billing", "Revenue service"],
      ["pipeline", "Monthly close", "Revenue workflow"],
    ];
    for (const [kind, name, description] of rows) {
      if (kind === "base")
        await insert(Base, {
          companyId,
          name,
          slug: name.toLowerCase().replace(/ /g, "-"),
          description,
        });
      if (kind === "chart")
        await insert(Chart, {
          companyId,
          title: name,
          slug: name.toLowerCase().replace(/ /g, "-"),
          description,
        });
      if (kind === "dashboard")
        await insert(Dashboard, {
          companyId,
          title: name,
          slug: name.toLowerCase().replace(/ /g, "-"),
          description,
        });
      if (kind === "repository")
        await insert(Repository, {
          companyId,
          name,
          slug: name.toLowerCase().replace(/ /g, "-"),
          description,
          gitUrl: "",
        });
      if (kind === "pipeline")
        await insert(Pipeline, {
          companyId,
          name,
          slug: name.toLowerCase().replace(/ /g, "-"),
          description,
        });
    }

    for (const [kind, name] of rows) {
      const hits = ofKind(await search(`revenue ${kind}`), kind);
      assert.ok(
        hits.some((hit) => hit.label === name),
        `revenue ${kind} should find the description of ${name}`,
      );
    }

    // Secondary columns rank below a title hit, never above it.
    assert.deepEqual(
      ofKind(await search("revenue dashboard"), "dashboard").map((hit) => hit.label),
      ["Revenue", "Board pack"],
    );
  });

  test("kind words do not dilute a title match", async () => {
    await insert(Dashboard, {
      companyId,
      title: "Revenue board",
      slug: "revenue-board",
      description: "",
    });
    await insert(Dashboard, {
      companyId,
      title: "Long revenue dashboard history",
      slug: "long-history",
      description: "",
    });

    assert.deepEqual(
      ofKind(await search("revenue dashboard"), "dashboard").map((hit) => hit.label),
      ["Revenue", "Revenue board", "Long revenue dashboard history"],
    );
  });

  test("finds employees by role, openings by department, and customers by email", async () => {
    await insert(AIEmployee, {
      companyId,
      name: "Ada",
      slug: "ada",
      role: "Revenue lead",
    });
    await insert(RecruitingOpening, {
      companyId,
      title: "Founding account executive",
      slug: "founding-ae",
      department: "Revenue",
    });
    const customer = await insert(Customer, {
      companyId,
      name: "Acme",
      slug: "acme",
      email: "revenue@acme.test",
    });

    const employeeHits = ofKind(await search("revenue employee"), "employee");
    assert.ok(employeeHits.some((hit) => hit.label === "Ada"));

    const openingHits = ofKind(await search("revenue opening"), "opening");
    assert.ok(openingHits.some((hit) => hit.label === "Founding account executive"));

    const customerHits = ofKind(await search("revenue customer"), "customer");
    assert.ok(customerHits.some((hit) => hit.id === customer.id));
  });

  test("caps each kind at five results, keeping the strongest matches", async () => {
    for (let i = 1; i <= 7; i += 1) {
      await insert(Dashboard, {
        companyId,
        title: `Revenue board ${i}`,
        slug: `revenue-board-${i}`,
        description: "",
      });
    }
    const hits = ofKind(await search("revenue dashboard"), "dashboard");
    assert.equal(hits.length, 5);
    // All are prefix matches; the exact "Revenue" still leads.
    assert.equal(hits[0].label, "Revenue");
    assert.ok(
      hits.slice(1).every((hit) => /^Revenue board \d+$/.test(hit.label)),
      "the remaining four are boards, whichever order recency put them in",
    );
  });

  test("the response cap never crowds out AI Employees", async () => {
    // Five matching rows in each of eight kinds is well past the 30-result
    // cap. Employees lead, so they must survive it.
    for (let i = 1; i <= 4; i += 1) {
      await insert(Dashboard, {
        companyId,
        title: `Revenue board ${i}`,
        slug: `board-${i}`,
        description: "",
      });
      await insert(Chart, {
        companyId,
        title: `Revenue chart ${i}`,
        slug: `chart-${i}`,
        description: "",
      });
      await insert(Base, {
        companyId,
        name: `Revenue base ${i}`,
        slug: `base-${i}`,
        description: "",
      });
      await insert(Repository, {
        companyId,
        name: `Revenue repo ${i}`,
        slug: `repo-${i}`,
        gitUrl: "",
      });
      await insert(Pipeline, {
        companyId,
        name: `Revenue pipeline ${i}`,
        slug: `pipeline-${i}`,
        description: "",
      });
      await insert(Notebook, { companyId, title: `Revenue notebook ${i}`, slug: `notebook-${i}` });
      await insert(Resource, { companyId, title: `Revenue resource ${i}`, slug: `resource-${i}` });
    }

    const hits = await search("revenue");
    assert.equal(hits.length, 30);
    assert.equal(hits[0].kind, "employee", "the employee leads the capped response");

    const perKind = new Map<string, number>();
    for (const hit of hits) perKind.set(hit.kind, (perKind.get(hit.kind) ?? 0) + 1);
    assert.ok(
      [...perKind.values()].every((count) => count <= 5),
      "no kind contributes more than five",
    );
  });

  test("archived notes, channels, and customers stay out", async () => {
    await insert(Note, {
      companyId,
      notebookId,
      title: "Archived revenue memo",
      slug: "archived-revenue-memo",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insert(Channel, {
      companyId,
      kind: "public",
      name: "archived-revenue",
      slug: "archived-revenue",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insert(Customer, {
      companyId,
      name: "Archived Revenue Holdings",
      slug: "archived-revenue-holdings",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });

    assert.equal(
      ofKind(await search("revenue notes"), "note").some((hit) => hit.label.includes("Archived")),
      false,
    );
    assert.equal(
      ofKind(await search("revenue channels"), "channel").some((hit) =>
        hit.label.includes("archived"),
      ),
      false,
    );
    assert.equal(
      ofKind(await search("revenue customers"), "customer").some((hit) =>
        hit.label.includes("Archived"),
      ),
      false,
    );
  });

  test("projects and their todos follow project access", async () => {
    const assigned = await insert(Project, {
      companyId,
      name: "Revenue assigned",
      slug: "revenue-assigned",
      key: "ASN",
      accessMode: "restricted",
    });
    const hidden = await insert(Project, {
      companyId,
      name: "Revenue hidden",
      slug: "revenue-hidden",
      key: "HID",
      accessMode: "restricted",
    });
    await insert(ProjectMember, {
      projectId: assigned.id,
      memberKind: "user",
      userId: "member-1",
      accessLevel: "read",
    });
    await insert(Todo, { projectId: assigned.id, number: 1, title: "Revenue assigned task" });
    await insert(Todo, { projectId: hidden.id, number: 1, title: "Revenue hidden task" });

    const memberProjects = ofKind(
      await search("revenue project", { role: "member", userId: "member-1" }),
      "project",
    ).map((hit) => hit.label);
    assert.deepEqual(memberProjects.sort(), ["Revenue assigned", "Revenue migration"]);

    const memberTodos = ofKind(
      await search("revenue task", { role: "member", userId: "member-1" }),
      "todo",
    ).map((hit) => hit.label);
    assert.deepEqual(memberTodos.sort(), ["Revenue assigned task", "Revenue migration checklist"]);

    const ownerProjects = ofKind(await search("revenue project"), "project").map(
      (hit) => hit.label,
    );
    assert.deepEqual(ownerProjects.sort(), [
      "Revenue assigned",
      "Revenue hidden",
      "Revenue migration",
    ]);
    assert.ok(
      ofKind(await search("revenue task"), "todo").some(
        (hit) => hit.label === "Revenue hidden task",
      ),
    );
  });

  test("channels follow channel membership and skip DMs", async () => {
    const privateChannel = await insert(Channel, {
      companyId,
      kind: "private",
      name: "revenue-private",
      slug: "revenue-private",
    });
    await insert(Channel, {
      companyId,
      kind: "private",
      name: "revenue-hidden",
      slug: "revenue-hidden",
    });
    const group = await insert(Channel, {
      companyId,
      kind: "group",
      name: "Revenue group",
    });
    await insert(Channel, {
      companyId,
      kind: "dm",
      name: "Revenue DM",
    });
    for (const channelId of [privateChannel.id, group.id]) {
      await insert(ChannelMember, {
        channelId,
        memberKind: "user",
        userId: "member-1",
      });
    }

    const labels = ofKind(
      await search("revenue channel", { role: "member", userId: "member-1" }),
      "channel",
    ).map((hit) => hit.label);
    assert.deepEqual(labels.sort(), ["#revenue-ops", "#revenue-private", "Revenue group"]);
  });

  test("a Member with Finance None finds the account, never the customer", async () => {
    const domainAccount = await insert(Customer, {
      companyId,
      name: "Acme",
      slug: "acme",
      domain: "revenue.acme.test",
    });
    const account = ofKind(
      await search("revenue account", {
        role: "member",
        userId: "member-1",
        financeAccess: "none",
      }),
      "account",
    );
    assert.deepEqual(account.map((hit) => hit.label).sort(), ["Acme", "Revenue Holdings"]);
    assert.ok(
      account.some((hit) => hit.id === domainAccount.id),
      "matched by its domain",
    );
    assert.equal(
      account.find((hit) => hit.id === domainAccount.id)?.path,
      `/revenue/accounts/${domainAccount.id}`,
    );

    // The Customers page is closed, so neither its row nor its link leaks.
    const customer = ofKind(
      await search("revenue customer", {
        role: "member",
        userId: "member-1",
        financeAccess: "none",
      }),
      "customer",
    );
    assert.deepEqual(customer, []);
  });
});
