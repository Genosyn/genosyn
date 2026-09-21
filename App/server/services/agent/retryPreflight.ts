import { AppDataSource } from "../../db/datasource.js";
import { Run } from "../../db/entities/Run.js";
import { deadToolNames, toolGrantRequirements } from "./tools/grantDead.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import {
  EmployeeFinanceGrant,
  FINANCE_ACCESS_RANK,
} from "../../db/entities/EmployeeFinanceGrant.js";
import {
  EmployeeRevenueGrant,
  REVENUE_ACCESS_RANK,
} from "../../db/entities/EmployeeRevenueGrant.js";
import { resolveMcpToken } from "../mcpTokens.js";
import type { ToolRegistry } from "./tools/toolRegistry.js";
import {
  captureRecoveryGrants,
  recoveryGrantsCover,
  resolveRecoveryScope,
} from "./workRecoveryScope.js";

export const NATIVE_CODING_CAPABILITY = "$native_coding";
const NON_WORK_TOOLS = new Set([
  "find_tools",
  "call_tool",
  "get_runtime_diagnostics",
  "get_parallel_work_result",
]);

export class RetryPreflightError extends Error {
  readonly name = "RetryPreflightError";
  readonly category = "authorization";
  readonly phase = "preflight";
  constructor(
    message: string,
    readonly missingTools: string[] = [],
  ) {
    super(`Retry preflight failed: ${message}`);
  }
}

type Requirements = { tools: string[]; grants: string[] };
function readRequirements(value: string | null): Requirements {
  if (!value) return { tools: [], grants: [] };
  try {
    const parsed = JSON.parse(value) as Requirements;
    if (
      !Array.isArray(parsed.tools) ||
      !Array.isArray(parsed.grants) ||
      parsed.tools.some((name) => typeof name !== "string") ||
      parsed.grants.some((grant) => typeof grant !== "string")
    )
      throw new Error();
    return parsed;
  } catch {
    throw new RetryPreflightError("Saved capability requirements could not be verified.");
  }
}

export type RetryCapabilityRecorder = {
  record(names: string[]): Promise<string[]>;
  check(names: string[]): Promise<void>;
  flush(): Promise<void>;
};

/** Required capabilities are checked before any provider turn or worker starts. */
export async function prepareRetryCapabilities(args: {
  token: string;
  employeeId: string;
  registry: ToolRegistry;
  nativeCoding: boolean;
  requiredTools?: string[];
  inherited?: RetryCapabilityRecorder;
}): Promise<RetryCapabilityRecorder> {
  const check = async (names: string[]) => {
    if (!names.length) return;
    let dead: Set<string>;
    try {
      dead = await deadToolNames(args.employeeId, true);
    } catch {
      throw new RetryPreflightError("Current Grants could not be verified.");
    }
    const missing = [...new Set(names)].filter((name) =>
      name === NATIVE_CODING_CAPABILITY
        ? !args.nativeCoding
        : !args.registry.resolve(name) || dead.has(name),
    );
    const families = new Set(
      names.flatMap(toolGrantRequirements).map((requirement) => requirement.family),
    );
    const levels = new Map<string, number>();
    try {
      if (families.has("mail"))
        levels.set(
          "mail",
          Math.max(
            -1,
            ...(
              await AppDataSource.getRepository(EmployeeMailAccountGrant).findBy({
                employeeId: args.employeeId,
              })
            ).map((grant) => MAIL_ACCESS_RANK[grant.accessLevel]),
          ),
        );
      if (families.has("finance"))
        levels.set(
          "finance",
          Math.max(
            -1,
            ...(
              await AppDataSource.getRepository(EmployeeFinanceGrant).findBy({
                employeeId: args.employeeId,
              })
            ).map((grant) => FINANCE_ACCESS_RANK[grant.accessLevel]),
          ),
        );
      if (families.has("revenue"))
        levels.set(
          "revenue",
          Math.max(
            -1,
            ...(
              await AppDataSource.getRepository(EmployeeRevenueGrant).findBy({
                employeeId: args.employeeId,
              })
            ).map((grant) => REVENUE_ACCESS_RANK[grant.accessLevel]),
          ),
        );
    } catch {
      throw new RetryPreflightError("Current Grant levels could not be verified.");
    }
    for (const name of names) {
      for (const { family, rank } of toolGrantRequirements(name)) {
        const available = levels.get(family);
        if (available === undefined || !Number.isFinite(available) || available < rank) {
          missing.push(name);
        }
      }
    }
    if (missing.length)
      throw new RetryPreflightError(
        `Required tools are unavailable: ${[...new Set(missing)].join(", ")}.`,
        [...new Set(missing)],
      );
  };
  await check(args.requiredTools ?? []);
  if (args.inherited) {
    await args.inherited.record(args.requiredTools ?? []);
    return { ...args.inherited, check };
  }
  const scope = await resolveRecoveryScope(args.token, true);
  if (!scope && resolveMcpToken(args.token)?.runId) {
    throw new RetryPreflightError(
      "This Run's recovery identity or authority could not be verified.",
    );
  }
  const prior = scope?.runs.slice(1).map((run) => readRequirements(run.requiredToolsJson)) ?? [];
  await check(prior.flatMap((entry) => entry.tools));
  const grants = scope ? await captureRecoveryGrants(scope.companyId, scope.employeeId) : [];
  if (prior.some((entry) => !recoveryGrantsCover(JSON.stringify(entry.grants), grants))) {
    throw new RetryPreflightError("The previous attempt's Grant scope was reduced or changed.");
  }
  const current = readRequirements(scope?.runs[0]?.requiredToolsJson ?? null);
  const names = new Set([...current.tools, ...(args.requiredTools ?? [])]);
  const requiredGrants = new Set([...current.grants, ...grants]);
  let writes = Promise.resolve();
  const record = async (used: string[]) => {
    for (const name of used) if (!NON_WORK_TOOLS.has(name)) names.add(name);
    const observed = scope ? await captureRecoveryGrants(scope.companyId, scope.employeeId) : [];
    if (!scope?.runId) return observed;
    writes = writes.then(async () => {
      for (const grant of observed) requiredGrants.add(grant);
      const saved = await AppDataSource.getRepository(Run).update(
        { id: scope.runId!, status: "running" },
        {
          requiredToolsJson: JSON.stringify({
            tools: [...names].sort(),
            grants: [...requiredGrants].sort(),
          }),
        },
      );
      if (saved.affected !== 1) throw new RetryPreflightError("This Run no longer accepts work.");
    });
    await writes;
    return observed;
  };
  if (args.requiredTools?.length) await record(args.requiredTools);
  return { record, check, flush: () => writes };
}

/** Record before dispatch, including deferred tools reached through call_tool. */
export function recordRegistryCapabilities(
  registry: ToolRegistry,
  recorder: RetryCapabilityRecorder,
  observeGrants?: (grants: string[]) => Promise<void>,
): void {
  for (const tool of registry.all.values()) {
    if (NON_WORK_TOOLS.has(tool.name)) continue;
    const run = tool.run;
    tool.run = async (input) => {
      const grants = await recorder.record([tool.name]);
      await observeGrants?.(grants);
      return run(input);
    };
  }
}
