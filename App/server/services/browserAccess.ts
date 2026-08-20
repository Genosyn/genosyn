import { In } from "typeorm";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Run } from "../db/entities/Run.js";
import { Routine } from "../db/entities/Routine.js";
import { releasePage } from "./browserChromium.js";
import { closeBrowserSession } from "./browserSessions.js";

/** Re-evaluate the live Browser policy behind an already-minted session. */
export async function browserAccessEnabledForSession(
  session: BrowserSession,
  employee: AIEmployee,
): Promise<boolean> {
  if (config.security.multiTenant && !config.agent.browserEnabledInMultiTenant) return false;
  // A session bound to someone's own computer answers to that browser's
  // policy as well as the employee's, re-read on every call. Revoking a grant
  // has to stop the Run that is already using it, not merely the next one.
  if (session.memberBrowserId) {
    const { memberBrowserUsableForSession } = await import("./memberBrowsers.js");
    const verdict = await memberBrowserUsableForSession(session, employee);
    if (!verdict.ok) return false;
  }
  if (!session.runId) return employee.browserEnabled;
  const run = await AppDataSource.getRepository(Run).findOneBy({ id: session.runId });
  if (!run || run.status !== "running") return false;
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: run.routineId,
    employeeId: employee.id,
  });
  if (!routine) return false;
  return routine.browserEnabledOverride ?? employee.browserEnabled;
}

export async function closeBrowserSessionForPolicy(sessionId: string): Promise<void> {
  await releasePage(sessionId, "manual");
  // releasePage closes rows that own a runtime. Pending/restored sessions may
  // have no process-local runtime, so close the durable row explicitly too.
  await closeBrowserSession(sessionId, "manual");
}

/** Close every active session whose current employee/Routine policy now denies Browser. */
export async function revokeDisabledBrowserSessionsForEmployee(employeeId: string): Promise<void> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId });
  if (!employee) return;
  const sessions = await AppDataSource.getRepository(BrowserSession).find({
    where: { employeeId, status: In(["pending", "live"]) },
  });
  for (const session of sessions) {
    if (!(await browserAccessEnabledForSession(session, employee))) {
      await closeBrowserSessionForPolicy(session.id);
    }
  }
}

export async function closeAllBrowserSessionsForEmployee(employeeId: string): Promise<void> {
  const sessions = await AppDataSource.getRepository(BrowserSession).find({
    where: { employeeId, status: In(["pending", "live"]) },
  });
  for (const session of sessions) await closeBrowserSessionForPolicy(session.id);
}
