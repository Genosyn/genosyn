import { maskSecret } from "../../lib/secret.js";
import type { IntegrationProvider } from "../types.js";

const BREX_API = "https://api.brex.com";

export type BrexConfig = {
  userToken: string;
};

export type BrexMoney = {
  amount: number;
  currency: string | null;
};

export type BrexCashAccount = {
  id: string;
  name: string;
  status?: string | null;
  current_balance: BrexMoney;
  available_balance: BrexMoney;
  account_number: string;
  routing_number: string;
  primary: boolean;
};

export type BrexCashTransaction = {
  id: string;
  description: string;
  amount: BrexMoney | null;
  initiated_at_date: string;
  posted_at_date: string;
  type?: string | null;
  transfer_id?: string | null;
};

type BrexPage<T> = {
  next_cursor?: string | null;
  items: T[];
};

export type BrexCashAccountSummary = {
  id: string;
  name: string;
  status: string | null;
  primary: boolean;
  accountNumberLast4: string;
  currentBalance: BrexMoney;
  availableBalance: BrexMoney;
};

async function brexGet<T>(
  userToken: string,
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(path, BREX_API);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${userToken}`,
    },
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail =
      (parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : null) ??
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : null) ??
      (typeof parsed === "string" && parsed.trim() ? parsed.trim() : null) ??
      `Brex ${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return parsed as T;
}

export function summarizeBrexCashAccount(account: BrexCashAccount): BrexCashAccountSummary {
  return {
    id: account.id,
    name: account.name,
    status: account.status ?? null,
    primary: account.primary,
    accountNumberLast4: account.account_number.slice(-4),
    currentBalance: account.current_balance,
    availableBalance: account.available_balance,
  };
}

export async function listBrexCashAccounts(userToken: string): Promise<BrexCashAccount[]> {
  const accounts: BrexCashAccount[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await brexGet<BrexPage<BrexCashAccount>>(userToken, "/v2/accounts/cash", {
      limit: 100,
      cursor,
    });
    accounts.push(...(page.items ?? []));
    const next = page.next_cursor ?? undefined;
    if (!next) break;
    if (seenCursors.has(next)) throw new Error("Brex returned a repeated account cursor");
    seenCursors.add(next);
    cursor = next;
  }
  return accounts;
}

export async function getBrexCashTransactionsPage(
  userToken: string,
  accountId: string,
  options: {
    cursor?: string;
    limit?: number;
    postedAtStart?: string;
  } = {},
): Promise<BrexPage<BrexCashTransaction>> {
  return brexGet<BrexPage<BrexCashTransaction>>(
    userToken,
    `/v2/transactions/cash/${encodeURIComponent(accountId)}`,
    {
      cursor: options.cursor,
      limit: options.limit ?? 100,
      posted_at_start: options.postedAtStart,
    },
  );
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export const brexProvider: IntegrationProvider = {
  catalog: {
    provider: "brex",
    name: "Brex",
    category: "Payments",
    tagline: "Cash accounts, balances, and settled transactions.",
    description:
      "Connect your Brex account with a user token from Brex Developer → Settings. Grant accounts.cash.readonly and transactions.cash.readonly so Genosyn can sync settled Brex Cash transactions into Finance.",
    icon: "CreditCard",
    authMode: "apikey",
    fields: [
      {
        key: "userToken",
        label: "User token",
        type: "password",
        placeholder: "bxt_…",
        required: true,
        hint: "Use a read-only token with Cash Accounts and Cash Transactions access.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_cash_accounts",
      description:
        "List Brex Cash accounts and their current and available balances. Account and routing numbers are masked or omitted.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_cash_transactions",
      description: "List one page of settled transactions for a Brex Cash account.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "Brex Cash account id." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string", description: "Pagination cursor from the prior page." },
          postedAtStart: {
            type: "string",
            description: "Optional RFC 3339 lower bound for the posted date.",
          },
        },
        required: ["accountId"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const userToken = (input.userToken ?? "").trim();
    if (!userToken) throw new Error("User token is required");
    const accounts = await listBrexCashAccounts(userToken);
    if (accounts.length === 0) {
      throw new Error(
        "Brex returned no Cash accounts. Check that the token has accounts.cash.readonly access.",
      );
    }
    const primary = accounts.find((account) => account.primary) ?? accounts[0];
    await getBrexCashTransactionsPage(userToken, primary.id, { limit: 1 });
    return {
      config: { userToken } satisfies BrexConfig,
      accountHint: `${primary.name} · ${maskSecret(userToken)}`,
    };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as BrexConfig;
    try {
      const accounts = await listBrexCashAccounts(cfg.userToken);
      const primary = accounts.find((account) => account.primary) ?? accounts[0];
      if (!primary) throw new Error("Brex returned no Cash accounts");
      await getBrexCashTransactionsPage(cfg.userToken, primary.id, { limit: 1 });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as BrexConfig;
    const input = (args as Record<string, unknown>) ?? {};
    if (name === "list_cash_accounts") {
      const accounts = await listBrexCashAccounts(cfg.userToken);
      return { items: accounts.map(summarizeBrexCashAccount) };
    }
    if (name === "list_cash_transactions") {
      const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
      if (!accountId) throw new Error("accountId is required");
      let postedAtStart: string | undefined;
      if (typeof input.postedAtStart === "string" && input.postedAtStart.trim()) {
        const parsed = new Date(input.postedAtStart);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error("postedAtStart must be an RFC 3339 date-time");
        }
        postedAtStart = parsed.toISOString();
      }
      return getBrexCashTransactionsPage(cfg.userToken, accountId, {
        limit: clampInt(input.limit, 1, 100, 50),
        cursor: typeof input.cursor === "string" ? input.cursor : undefined,
        postedAtStart,
      });
    }
    throw new Error(`Unknown Brex tool: ${name}`);
  },
};
