import { randomUUID } from "node:crypto";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel, type Provider } from "../db/entities/AIModel.js";
import { refreshContextWindow } from "./agent/contextWindowRefresh.js";
import { recordAudit } from "./audit.js";
import { ModelSetupError } from "./modelCatalog.js";
import { createActiveModel, effectiveActiveId } from "./models.js";
import { isModelConnected } from "./providers.js";

/**
 * Reusing a company's AI Model.
 *
 * Every AI Employee owns its own `AIModel` row, so hiring a second employee
 * used to mean pasting the same API key again. Reuse closes that gap without
 * changing the ownership model: it copies a connected API-key or custom-endpoint
 * model from one AI Employee onto another **in the same company**, entirely on
 * the server. The browser names a source model and never sees a credential —
 * not the key, not its ciphertext, not the endpoint URL.
 *
 * The copy is an independent row. Removing it, or firing either employee, never
 * touches the other, and each employee can later move to a different model
 * without disturbing the rest of the team. What they share is the account the
 * provider bills, which is the point.
 *
 * What may not be copied is a ChatGPT subscription. That sign-in belongs to one
 * AI Employee's login (a managed session or a workspace access token), is
 * refreshed under a per-model lock, and the pinned Codex runtime serializes on
 * it — two rows holding one session would race each other's refresh.
 */

/** The auth modes a copy may carry. A subscription credential never does. */
export type ReusableAuthMode = "apikey" | "customEndpoint";

/**
 * One AI Model another AI Employee already runs on, shaped for the UI. Every
 * field is safe to show a Member: the host preview is the same host-only string
 * the model card already renders.
 */
export type ReusableModel = {
  /** The source AI Model's id, which is what a reuse call names. */
  id: string;
  employeeId: string;
  employeeName: string;
  provider: Provider;
  model: string;
  authMode: ReusableAuthMode;
  /** Host-only preview of a custom endpoint's base URL; null for an API key. */
  endpointHost: string | null;
  /** Whether it is that employee's active AI Model right now. */
  isActive: boolean;
};

/**
 * The `configJson` fields a copy carries, per auth mode. An allowlist rather
 * than "everything except": a row that ever held a subscription credential, or
 * a field added later, must not ride along into a different employee's row.
 */
const COPIED_CONFIG_KEYS: Record<ReusableAuthMode, readonly string[]> = {
  apikey: ["apiKeyEncrypted", "apiKeyPreview"],
  customEndpoint: [
    "baseURLEncrypted",
    "baseURLPreview",
    "modelId",
    "apiKeyEncrypted",
    "apiKeyPreview",
  ],
};

function parseConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function previewOf(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

/** Is this the shape of model a copy may carry — API key or custom endpoint? */
function reusableAuthMode(model: AIModel): ReusableAuthMode | null {
  if (
    model.authMode === "apikey" &&
    (model.provider === "anthropic" || model.provider === "openai")
  ) {
    return "apikey";
  }
  if (model.authMode === "customEndpoint" && model.provider === "custom") {
    return "customEndpoint";
  }
  return null;
}

/**
 * Two rows that would give the same answer: one provider, model and credential.
 * Compared on the masked previews already stored beside each secret, so nothing
 * is decrypted to find out.
 */
function credentialSignature(model: AIModel, config: Record<string, unknown>): string {
  return [
    model.provider,
    model.authMode,
    model.model,
    previewOf(config, "apiKeyPreview"),
    previewOf(config, "baseURLPreview"),
  ].join("\u0000");
}

/**
 * The company's reusable AI Models, best default first.
 *
 * Candidates are the connected API-key and custom-endpoint models of every
 * other AI Employee in the company. Rows that are the same credential collapse
 * to one entry, so a company whose whole team runs on one key is offered one
 * choice, not one per employee. The order is the company's own habit: the model
 * most employees share, then one that is somebody's active model, then the most
 * recently connected.
 */
export async function listReusableModels(
  companyId: string,
  options: { excludeEmployeeId?: string } = {},
): Promise<ReusableModel[]> {
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: { id: true, name: true },
  });
  if (employees.length === 0) return [];
  const nameById = new Map(employees.map((employee) => [employee.id, employee.name]));
  const rows = await AppDataSource.getRepository(AIModel).find({
    where: { employeeId: In([...nameById.keys()]) },
  });

  const activeByEmployee = new Map<string, string | null>();
  const byEmployee = new Map<string, AIModel[]>();
  for (const row of rows) {
    const list = byEmployee.get(row.employeeId);
    if (list) list.push(row);
    else byEmployee.set(row.employeeId, [row]);
  }
  for (const [employeeId, list] of byEmployee) {
    activeByEmployee.set(employeeId, effectiveActiveId(list));
  }

  type Candidate = { entry: ReusableModel; signature: string; connectedAt: number };
  const candidates: Candidate[] = [];
  for (const row of rows) {
    if (row.employeeId === options.excludeEmployeeId) continue;
    const authMode = reusableAuthMode(row);
    if (!authMode || !isModelConnected(row)) continue;
    const config = parseConfig(row.configJson);
    candidates.push({
      signature: credentialSignature(row, config),
      connectedAt: row.connectedAt?.getTime() ?? 0,
      entry: {
        id: row.id,
        employeeId: row.employeeId,
        employeeName: nameById.get(row.employeeId) ?? "",
        provider: row.provider,
        model: row.model,
        authMode,
        endpointHost:
          authMode === "customEndpoint" ? previewOf(config, "baseURLPreview") || null : null,
        isActive: activeByEmployee.get(row.employeeId) === row.id,
      },
    });
  }

  const sharedBy = new Map<string, number>();
  for (const candidate of candidates) {
    sharedBy.set(candidate.signature, (sharedBy.get(candidate.signature) ?? 0) + 1);
  }
  candidates.sort(
    (a, b) =>
      (sharedBy.get(b.signature) ?? 0) - (sharedBy.get(a.signature) ?? 0) ||
      Number(b.entry.isActive) - Number(a.entry.isActive) ||
      b.connectedAt - a.connectedAt ||
      a.entry.employeeName.localeCompare(b.entry.employeeName) ||
      a.entry.id.localeCompare(b.entry.id),
  );

  const seen = new Set<string>();
  const result: ReusableModel[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.signature)) continue;
    seen.add(candidate.signature);
    result.push(candidate.entry);
  }
  return result;
}

export type ReusedModel = {
  model: AIModel;
  /** The AI Employee whose AI Model was copied. */
  source: { employeeId: string; employeeName: string };
};

/**
 * Connect `employee` to a copy of another AI Employee's AI Model and make the
 * copy their active one.
 *
 * The source must be a connected API-key or custom-endpoint model of an AI
 * Employee in the same company. Anything else — another company's row, a
 * ChatGPT subscription, a model with no credential yet, the employee's own —
 * is refused with a plain message and nothing is written. An unknown id and
 * another company's id answer identically, so the call cannot be used to probe
 * for rows outside the caller's company.
 *
 * No second model call is made: the credential was verified when the source
 * employee connected it, and the copy is a byte-for-byte copy of that
 * ciphertext. The context window is carried over (a number an operator typed in
 * for a local server belongs to the server, not the employee) and then probed
 * again the way a fresh connection would.
 */
export async function reuseModelForEmployee(options: {
  companyId: string;
  employee: AIEmployee;
  sourceModelId: string;
  actorUserId: string | null;
  /** Injectable so a test can observe the probe without a provider. */
  refresh?: (model: AIModel) => Promise<unknown>;
}): Promise<ReusedModel> {
  const { companyId, employee, sourceModelId, actorUserId } = options;
  if (employee.companyId !== companyId) throw new ModelSetupError("Employee not found", 404);

  const models = AppDataSource.getRepository(AIModel);
  const source = await models.findOneBy({ id: sourceModelId });
  const sourceEmployee = source
    ? await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: source.employeeId,
        companyId,
      })
    : null;
  if (!source || !sourceEmployee) throw new ModelSetupError("AI Model not found", 404);
  if (source.employeeId === employee.id) {
    throw new ModelSetupError(
      `${employee.name} already has this AI Model. Choose one from another AI Employee.`,
      400,
    );
  }
  if (source.authMode === "subscription") {
    throw new ModelSetupError(
      `${sourceEmployee.name} is signed in with ChatGPT, and a ChatGPT sign-in can't be shared. Connect ${employee.name} with an API key, or sign in with ChatGPT in their own Settings → Model.`,
      400,
    );
  }
  const authMode = reusableAuthMode(source);
  if (!authMode) {
    throw new ModelSetupError("This AI Model can't be reused for another AI Employee.", 400);
  }
  if (!isModelConnected(source)) {
    throw new ModelSetupError(
      `${sourceEmployee.name}'s AI Model isn't connected yet. Finish connecting it there first.`,
      400,
    );
  }

  const sourceConfig = parseConfig(source.configJson);
  const config: Record<string, unknown> = {};
  for (const key of COPIED_CONFIG_KEYS[authMode]) {
    if (sourceConfig[key] !== undefined) config[key] = sourceConfig[key];
  }

  const saved = await createActiveModel(
    models.create({
      id: randomUUID(),
      employeeId: employee.id,
      provider: source.provider,
      model: source.model,
      authMode,
      configJson: JSON.stringify(config),
      isActive: false,
      connectedAt: new Date(),
      contextWindow: source.contextWindow,
      contextWindowSource: source.contextWindowSource,
      maxConcurrentRuns: source.maxConcurrentRuns,
    }),
  );
  if (!saved) throw new ModelSetupError("This AI Employee no longer exists.", 409);

  await (options.refresh ?? refreshContextWindow)(saved);
  await recordAudit({
    companyId,
    actorUserId,
    action: "model.configure",
    targetType: "employee",
    targetId: employee.id,
    targetLabel: employee.name,
    metadata: {
      provider: saved.provider,
      model: saved.model,
      authMode: saved.authMode,
      reusedFromEmployeeId: sourceEmployee.id,
      reusedFromEmployee: sourceEmployee.name,
    },
  });
  return {
    model: saved,
    source: { employeeId: sourceEmployee.id, employeeName: sourceEmployee.name },
  };
}
