import type { AIModel } from "../db/entities/AIModel.js";
import { subscriptionModelBusy } from "./codexSubscription.js";
import { ModelSetupError } from "./modelCatalog.js";
import { verifyOpenCodeModel } from "./modelSetup.js";
import { isModelConnected } from "./providers.js";
import { testSubscriptionModel } from "./subscriptionModelSetup.js";

/**
 * Test connection: does this AI Model answer right now?
 *
 * "Connected" on a model card means a credential is on file, not that it works
 * today — a key can run out of credit, a ChatGPT sign-in can lapse, a server
 * you run can be asleep. This asks the model for the same small, harmless
 * reply it gave when it was connected, through the runtime its work uses, and
 * changes nothing: no credential, model, connection time or context window is
 * written. An API-key model answers on its keys in order, as a Run would send
 * it, so the test passes while any key works, and each key's health records
 * what the provider said, as it does for every request.
 *
 * A ChatGPT sign-in is used by one turn at a time; while a chat or Run holds
 * it, the test says so instead of queueing behind that work.
 */

export type ModelConnectionTest = {
  /** How long the model took to answer, in milliseconds. */
  elapsedMs: number;
};

export async function testModelConnection(
  model: AIModel,
  clock: () => number = Date.now,
): Promise<ModelConnectionTest> {
  if (!isModelConnected(model)) {
    throw new ModelSetupError("Finish connecting this AI Model before testing it.", 400);
  }
  const started = clock();
  if (model.authMode === "subscription") {
    if (subscriptionModelBusy(model.id)) {
      throw new ModelSetupError(
        "This AI Model is answering a chat or Run right now. Test it again once that work finishes.",
        409,
      );
    }
    await testSubscriptionModel(model);
  } else {
    await verifyOpenCodeModel(model);
  }
  return { elapsedMs: Math.max(0, Math.round(clock() - started)) };
}
