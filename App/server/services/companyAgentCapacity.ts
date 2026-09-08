import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { getAgentSettings } from "./runtimeSettings.js";
import { withSchedulerLease } from "./schedulerLeases.js";

const CAPACITY_LEASE_MS = 120_000;

export class CompanyAgentCapacityError extends Error {
  constructor() {
    super(
      "Your company is already using its available AI capacity. Please try again after some work finishes.",
    );
    this.name = "CompanyAgentCapacityError";
  }
}

/** Each full, restricted, or delegated turn owns one renewable database slot. */
export async function withCompanyAgentCapacity<T>(
  employeeId: string,
  signal: AbortSignal | undefined,
  fn: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!config.security.multiTenant) return fn(signal);
  if (config.db.driver !== "postgres") {
    throw new Error("Shared AI capacity requires Postgres.");
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOne({
    where: { id: employeeId },
    select: { id: true, companyId: true },
  });
  if (!employee) throw new Error("The AI Employee is no longer available.");
  const limit = getAgentSettings().maxConcurrentTurnsPerCompany;
  for (let slot = 0; slot < limit; slot += 1) {
    signal?.throwIfAborted();
    const admitted = await withSchedulerLease(
      `ai-capacity:${employee.companyId}:${slot}`,
      CAPACITY_LEASE_MS,
      async (lease) => {
        const combined = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
        combined.throwIfAborted();
        lease.assertHeld();
        const value = await fn(combined);
        lease.assertHeld();
        return { value };
      },
    );
    if (admitted !== null) return admitted.value;
  }
  // Never wait for a slot: a parent turn can be holding the last slot while
  // awaiting a delegated turn, which would otherwise deadlock both turns.
  throw new CompanyAgentCapacityError();
}
