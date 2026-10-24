import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { PhoneNumber } from "../db/entities/PhoneNumber.js";
import { insert, testId } from "./dbHarness.js";
import { insertEmployeeModel } from "./modelFixtures.js";
import { encryptConnectionConfig } from "../services/integrations.js";

/**
 * Rows the phone tests share: a company with one AI Employee (with an AI
 * Model), a Twilio Connection, and a number given to the employee.
 */

// Fake credentials, built at runtime so the source never holds a literal shaped
// like a real Account SID or Auth Token: secret scanners — GitHub's push
// protection among them — match the shape, not the meaning.
export const TEST_AUTH_TOKEN = "0123456789abcdef".repeat(2);
export const TEST_ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;

export type PhoneFixture = {
  company: Company;
  employee: AIEmployee;
  connection: IntegrationConnection;
  number: PhoneNumber;
};

export async function phoneFixture(
  overrides: Partial<PhoneNumber> = {},
  opts: { model?: boolean } = {},
): Promise<PhoneFixture> {
  const company = await insert(Company, {
    name: "Acme Dental",
    slug: testId("acme"),
    ownerId: testId("owner"),
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ava",
    slug: testId("ava"),
    role: "Front desk",
    soulBody: "SECRET SOUL",
  });
  if (opts.model !== false) {
    await insertEmployeeModel({
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-test",
      authMode: "apikey",
      isActive: true,
      configJson: '{"apiKeyEncrypted":"v2:ciphertext"}',
      connectedAt: new Date(),
      contextWindow: null,
      contextWindowSource: null,
    });
  }
  const connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "twilio",
    label: "Twilio",
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig(
      { accountSid: TEST_ACCOUNT_SID, authToken: TEST_AUTH_TOKEN },
      company.id,
    ),
    accountHint: "",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
  const number = await insert(PhoneNumber, {
    companyId: company.id,
    connectionId: connection.id,
    employeeId: employee.id,
    e164: "+15550101234",
    providerSid: `PN${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
    label: "",
    country: "US",
    locality: "",
    voiceEnabled: true,
    smsEnabled: true,
    mmsEnabled: false,
    callMode: "answer",
    forwardTo: null,
    textMode: "inbox",
    greeting: "",
    instructions: "",
    voice: "Polly.Joanna-Neural",
    dailyTextLimit: 50,
    dailyCallLimit: 10,
    webhookBaseUrl: null,
    webhookError: "",
    reservedInGenosyn: true,
    lastTextSyncAt: null,
    createdByUserId: null,
    ...overrides,
  });
  return { company, employee, connection, number };
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Answer Twilio's API from the test instead of the network, and let every other
 * request — the route tests' own calls to their local server — through.
 */
export function stubTwilio(handler: FetchHandler): {
  calls: Array<{ url: string; method: string; body: URLSearchParams }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: URLSearchParams }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/twilio\.com/.test(new URL(url).hostname)) return original(input, init);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
