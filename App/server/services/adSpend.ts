import { MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import { Budget } from "../db/entities/Budget.js";
import type { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import type { IntegrationRuntimeContext } from "../integrations/types.js";
import { notifyBudgetExhaustedOnce } from "./companyPolicies.js";

/**
 * Host side of the ads authorized-spend ledger. The identity (connection,
 * employee, approval) is bound into the closure at the trusted call sites —
 * `invokeConnectionTool` and the ad-spend approval replay — so a provider
 * can name amounts but never widen whose ledger it writes to. Same design
 * as `makeConnectionCapabilityGate`.
 */
export function makeAdSpendLedger(args: {
  connection: IntegrationConnection;
  employeeId?: string;
  approvalId?: string;
}): NonNullable<IntegrationRuntimeContext["adSpend"]> {
  const { connection } = args;
  return {
    async authorizedInWindow(windowMs: number): Promise<number> {
      const cutoff = new Date(Date.now() - windowMs);
      // Mutations are rare and human-gated, so loading the window's rows
      // and summing in JS stays trivially cheap — and identical on sqlite
      // and postgres.
      const rows = await AppDataSource.getRepository(AdSpendEvent).find({
        where: { connectionId: connection.id, createdAt: MoreThan(cutoff) },
        select: ["amountMinor"],
      });
      return rows
        .filter((r) => r.amountMinor > 0)
        .reduce((sum, r) => sum + r.amountMinor, 0);
    },

    /**
     * The Budget envelopes (M53). All applicable enabled budgets must have
     * headroom — the tightest binds. Scope is resolved here in the closure
     * (company / this connection / this employee), never by the provider,
     * keeping the same identity discipline as `record`. Sums count positive
     * authorized deltas in the current UTC calendar month, currency-blind
     * exactly like the rolling caps.
     */
    async checkBudgets(amountMinor: number): Promise<string | null> {
      if (amountMinor <= 0) return null;
      const budgets = await AppDataSource.getRepository(Budget).find({
        where: { companyId: connection.companyId, enabled: true },
      });
      const applicable = budgets.filter(
        (b) =>
          (b.connectionId === null || b.connectionId === connection.id) &&
          (b.employeeId === null || (args.employeeId !== undefined && b.employeeId === args.employeeId)),
      );
      if (applicable.length === 0) return null;
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const rows = await AppDataSource.getRepository(AdSpendEvent).find({
        where: { companyId: connection.companyId, createdAt: MoreThan(monthStart) },
        select: ["amountMinor", "connectionId", "employeeId"],
      });
      const increases = rows.filter((r) => r.amountMinor > 0);
      for (const budget of applicable) {
        const spent = increases
          .filter(
            (r) =>
              (budget.connectionId === null || r.connectionId === budget.connectionId) &&
              (budget.employeeId === null || r.employeeId === budget.employeeId),
          )
          .reduce((sum, r) => sum + r.amountMinor, 0);
        if (spent + amountMinor > budget.amountMinor) {
          void notifyBudgetExhaustedOnce(budget).catch(() => undefined);
          return (
            `Refused by the budget "${budget.name}": this month's envelope holds ` +
            `${budget.amountMinor - spent} of ${budget.amountMinor} minor units and the change needs ${amountMinor}. ` +
            "Ask a human to raise the budget (a Decision is the right way), or wait for the month to roll over. Do not retry."
          );
        }
      }
      return null;
    },

    async record(event): Promise<void> {
      const repo = AppDataSource.getRepository(AdSpendEvent);
      await repo.save(
        repo.create({
          companyId: connection.companyId,
          connectionId: connection.id,
          employeeId: args.employeeId ?? "",
          platform: connection.provider,
          adAccountRef: event.adAccountRef ?? "",
          campaignRef: event.campaignRef ?? "",
          toolName: event.toolName,
          mutationKind: event.mutationKind,
          amountMinor: Math.round(event.amountMinor),
          currency: event.currency,
          approvalId: args.approvalId ?? null,
          summary: event.summary ?? null,
        }),
      );
    },
  };
}
