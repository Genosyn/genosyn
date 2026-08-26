import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import type { Company } from "../../client/lib/api.js";
import { createCompanyAndSwitch } from "../../client/lib/companySwitch.js";

function company(slug = "new-company"): Company {
  return {
    id: "company-id",
    name: "New Company",
    slug,
    mission: "",
    vision: "",
    role: "owner",
    financeAccess: "full",
    requireTwoFactor: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createCompanyAndSwitch", () => {
  test("creates, refreshes, and then switches in that exact order", async () => {
    const events: string[] = [];
    const created = company();

    const result = await createCompanyAndSwitch({
      createCompany: async () => {
        events.push("create");
        return created;
      },
      refreshCompanies: async () => {
        events.push("refresh");
      },
      navigate: (destination) => {
        assert.equal(destination, "/c/new-company");
        events.push("switch");
      },
    });

    assert.equal(result, created);
    assert.deepEqual(events, ["create", "refresh", "switch"]);
  });

  test("does not refresh or switch while company creation is pending", async () => {
    const creation = deferred<Company>();
    const events: string[] = [];

    const switching = createCompanyAndSwitch({
      createCompany: () => creation.promise,
      refreshCompanies: async () => {
        events.push("refresh");
      },
      navigate: () => {
        events.push("switch");
      },
    });

    await Promise.resolve();
    assert.deepEqual(events, []);
    creation.resolve(company());
    await switching;
    assert.deepEqual(events, ["refresh", "switch"]);
  });

  test("does not switch while the company-list refresh is pending", async () => {
    const refresh = deferred<void>();
    const events: string[] = [];

    const switching = createCompanyAndSwitch({
      createCompany: async () => {
        events.push("create");
        return company("must-be-routable-first");
      },
      refreshCompanies: () => {
        events.push("refresh-started");
        return refresh.promise;
      },
      navigate: (destination) => {
        assert.equal(destination, "/c/must-be-routable-first");
        events.push("switch");
      },
    });

    await Promise.resolve();
    assert.deepEqual(events, ["create", "refresh-started"]);
    refresh.resolve(undefined);
    await switching;
    assert.deepEqual(events, ["create", "refresh-started", "switch"]);
  });

  test("waits for an asynchronous switch before resolving", async () => {
    const navigation = deferred<void>();
    let settled = false;

    const switching = createCompanyAndSwitch({
      createCompany: async () => company(),
      refreshCompanies: async () => undefined,
      navigate: () => navigation.promise,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    navigation.resolve(undefined);
    await switching;
    assert.equal(settled, true);
  });

  test("propagates creation failure without refreshing or switching", async () => {
    const expected = new Error("create failed");
    let refreshes = 0;
    let switches = 0;

    await assert.rejects(
      createCompanyAndSwitch({
        createCompany: async () => {
          throw expected;
        },
        refreshCompanies: async () => {
          refreshes += 1;
        },
        navigate: () => {
          switches += 1;
        },
      }),
      expected,
    );
    assert.equal(refreshes, 0);
    assert.equal(switches, 0);
  });

  test("propagates refresh failure without switching to an unroutable company", async () => {
    const expected = new Error("refresh failed");
    let switches = 0;

    await assert.rejects(
      createCompanyAndSwitch({
        createCompany: async () => company(),
        refreshCompanies: async () => {
          throw expected;
        },
        navigate: () => {
          switches += 1;
        },
      }),
      expected,
    );
    assert.equal(switches, 0);
  });

  test("propagates switch failure only after creation and refresh complete", async () => {
    const expected = new Error("switch failed");
    const events: string[] = [];

    await assert.rejects(
      createCompanyAndSwitch({
        createCompany: async () => {
          events.push("create");
          return company();
        },
        refreshCompanies: async () => {
          events.push("refresh");
        },
        navigate: () => {
          events.push("switch");
          throw expected;
        },
      }),
      expected,
    );
    assert.deepEqual(events, ["create", "refresh", "switch"]);
  });

  test("uses the exact collision-safe slug returned by the server", async () => {
    let destination = "";

    await createCompanyAndSwitch({
      createCompany: async () => company("new-company-2"),
      refreshCompanies: async () => undefined,
      navigate: (next) => {
        destination = next;
      },
    });

    assert.equal(destination, "/c/new-company-2");
  });

  test("preserves the onboarding suffix for first-company creation", async () => {
    let destination = "";

    await createCompanyAndSwitch({
      createCompany: async () => company("first-company"),
      refreshCompanies: async () => undefined,
      navigate: (next) => {
        destination = next;
      },
      suffix: "/onboarding",
    });

    assert.equal(destination, "/c/first-company/onboarding");
  });

  test("opens onboarding at the exact collision-safe slug returned by the server", async () => {
    let destination = "";

    await createCompanyAndSwitch({
      createCompany: async () => company("repeated-name-2"),
      refreshCompanies: async () => undefined,
      navigate: (next) => {
        destination = next;
      },
      suffix: "/onboarding",
    });

    assert.equal(destination, "/c/repeated-name-2/onboarding");
  });

  test("keeps both company-creation entry points wired to sequenced onboarding", () => {
    const appShell = readFileSync(
      new URL("../../client/components/AppShell.tsx", import.meta.url),
      "utf8",
    );
    const app = readFileSync(new URL("../../client/App.tsx", import.meta.url), "utf8");
    const onboarding = readFileSync(
      new URL("../../client/pages/Onboarding.tsx", import.meta.url),
      "utf8",
    );

    assert.match(appShell, /await createCompanyAndSwitch\(\{/);
    assert.match(appShell, /refreshCompanies: onCompaniesChanged/);
    assert.match(appShell, /navigate: \(destination\) =>/);
    assert.match(appShell, /suffix: "\/onboarding"/);
    assert.match(app, /onCompaniesChanged=\{refreshAuthenticatedState\}/);
    assert.match(app, /path="onboarding" element=\{<CompanyOnboarding/);
    assert.match(onboarding, /await createCompanyAndSwitch\(\{/);
    assert.match(onboarding, /refreshCompanies: onDone/);
    assert.match(onboarding, /suffix: "\/onboarding"/);
  });
});
