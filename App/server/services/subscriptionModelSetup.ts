import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { CodexAppServer } from "./agent/codexAppServer.js";
import { verifyCodexModel } from "./codexModelSetup.js";
import {
  CODEX_CONFIG_OVERRIDES,
  prepareCodexRuntime,
  withSubscriptionModelLock,
} from "./codexSubscription.js";
import { ModelSetupError, modelSetupFailure } from "./modelCatalog.js";

/** Verify a changed ChatGPT model using the existing credential and refresh lock. */
export async function editSubscriptionModel(
  previous: AIModel,
  requestedModel: string,
): Promise<void> {
  try {
    await withSubscriptionModelLock(previous.id, AbortSignal.timeout(60_000), async () => {
      const lease = await prepareCodexRuntime(previous.id);
      let server: CodexAppServer | null = null;
      try {
        if (
          lease.model.employeeId !== previous.employeeId ||
          lease.model.model !== previous.model
        ) {
          throw new ModelSetupError(
            "This AI Model changed while it was being tested. Please try again.",
            409,
          );
        }
        server = await CodexAppServer.start({
          cwd: lease.home.workspace,
          env: lease.env,
          configOverrides: [...CODEX_CONFIG_OVERRIDES],
        });
        const verifiedModel = await verifyCodexModel(server, lease.home.workspace, requestedModel);
        await server.close();
        server = null;
        // Save only the verified ID. The lease owns credential refresh and
        // persists it after this comparison, without restoring stale tokens.
        const updated = await AppDataSource.getRepository(AIModel).update(
          {
            id: previous.id,
            employeeId: previous.employeeId,
            provider: "openai",
            authMode: "subscription",
            model: lease.model.model,
            configJson: lease.model.configJson,
          },
          {
            model: verifiedModel,
            connectedAt: new Date(),
            ...(verifiedModel !== lease.model.model
              ? { contextWindow: null, contextWindowSource: null }
              : {}),
          },
        );
        if (updated.affected !== 1) {
          throw new ModelSetupError(
            "This AI Model changed while it was being tested. Please try again.",
            409,
          );
        }
      } finally {
        await server?.close().catch(() => undefined);
        // Includes refresh-token persistence and removal of the private home,
        // on success, failed verification, and concurrent credential changes.
        await lease.finish();
      }
    });
  } catch (error) {
    throw modelSetupFailure(error, "test this ChatGPT AI Model");
  }
}

/**
 * Ask a connected ChatGPT AI Model for a real reply with its saved sign-in, and
 * change nothing: the same isolated turn `editSubscriptionModel` verifies with,
 * under the same lock, without saving a model. A model left on the workspace
 * default is tested on whatever that default is today, and stays on "auto".
 * The lease still persists a sign-in Codex refreshed during the test, as every
 * turn's does.
 */
export async function testSubscriptionModel(model: AIModel): Promise<void> {
  try {
    await withSubscriptionModelLock(model.id, AbortSignal.timeout(60_000), async () => {
      const lease = await prepareCodexRuntime(model.id);
      let server: CodexAppServer | null = null;
      try {
        server = await CodexAppServer.start({
          cwd: lease.home.workspace,
          env: lease.env,
          configOverrides: [...CODEX_CONFIG_OVERRIDES],
        });
        await verifyCodexModel(server, lease.home.workspace, lease.model.model);
        await server.close();
        server = null;
      } finally {
        await server?.close().catch(() => undefined);
        await lease.finish();
      }
    });
  } catch (error) {
    throw modelSetupFailure(error, "test this ChatGPT AI Model");
  }
}
