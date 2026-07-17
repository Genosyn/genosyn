import { MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import type { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import type { IntegrationRuntimeContext } from "../integrations/types.js";

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
