import {
  hydrateEstimates,
  issueEstimate,
  loadEstimateBySlug,
  resolveEstimateRecipient,
  sendEstimateEmail,
  type EstimateSendResult,
  type HydratedEstimate,
} from "./estimates.js";

export class EstimateActionError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
    this.name = "EstimateActionError";
  }
}

/** Issue / Mark sent uses the same transition as Finance, without delivery. */
export async function issueEstimateBySlug(
  companyId: string,
  estimateSlug: string,
): Promise<HydratedEstimate> {
  const estimate = await loadEstimateBySlug(companyId, estimateSlug);
  if (!estimate) throw new EstimateActionError("Estimate not found", 404);
  if (estimate.status !== "draft") {
    throw new EstimateActionError("Already issued", 409);
  }
  const [hydrated] = await hydrateEstimates(companyId, [estimate]);
  const issued = await issueEstimate(estimate, null);
  return { ...hydrated, ...issued };
}

/**
 * Match Finance's Send action using only the Customer's on-file address.
 * Validate delivery prerequisites before numbering a draft. Once issued, a
 * delivery error must still return the new slug so it can be read or retried.
 */
export async function sendEstimateBySlug(
  companyId: string,
  estimateSlug: string,
): Promise<{ estimate: HydratedEstimate; issued: boolean; send: EstimateSendResult }> {
  let estimate = await loadEstimateBySlug(companyId, estimateSlug);
  if (!estimate) throw new EstimateActionError("Estimate not found", 404);
  if (estimate.status === "void") {
    throw new EstimateActionError("Voided estimates cannot be sent", 409);
  }
  await resolveEstimateRecipient(companyId, estimate);
  // Prepare the response's relations before issuing or sending. A failed
  // read after delivery could otherwise hide a successful send behind an
  // error response and encourage a duplicate email.
  const [hydrated] = await hydrateEstimates(companyId, [estimate]);
  const issued = estimate.status === "draft";
  if (issued) estimate = await issueEstimate(estimate, null);
  let send: EstimateSendResult;
  try {
    send = await sendEstimateEmail(companyId, estimate, null);
  } catch (err) {
    send = { status: "failed", logId: "", errorMessage: (err as Error).message };
  }
  return { estimate: { ...hydrated, ...estimate }, issued, send };
}
