import { z } from "zod";

export type ApiModelProvider = "anthropic" | "openai";
export type CatalogModel = { id: string; label: string; createdAt: number };
export type ModelCatalog = {
  models: CatalogModel[];
  recommendedModel: string;
  source: "recent-compatible-model" | "provider-default";
};

/** Safe, actionable errors only: SDK messages can contain the submitted key. */
export class ModelSetupError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "ModelSetupError";
  }
}

export function modelSetupFailure(
  error: unknown,
  operation = "test this AI Model",
): ModelSetupError {
  if (error instanceof ModelSetupError) return error;
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = detail.status;
  if (status === 401 || status === 403) {
    return new ModelSetupError(
      "The AI Model rejected this credential. Check the key and its model access, then try again.",
    );
  }
  if (status === 429) {
    return new ModelSetupError(
      "The AI Model could not respond because of billing, quota, or a rate limit. Check your account and try again.",
    );
  }
  if (status === 400 || status === 404) {
    return new ModelSetupError(
      "This model is not available for AI Employee work with this credential. Choose another model or check its access.",
    );
  }
  if (
    detail.name === "AbortError" ||
    detail.name === "TimeoutError" ||
    detail.name === "APIUserAbortError"
  ) {
    return new ModelSetupError(
      `We could not ${operation} before the request timed out. Please try again.`,
      504,
    );
  }
  return new ModelSetupError(
    `We could not ${operation}. Check your connection and try again.`,
    502,
  );
}

const openAIPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(120),
      created: z.number().finite(),
      shutdown_date: z.string().nullish(),
    }),
  ),
});
const anthropicPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(120),
      display_name: z.string().optional(),
      created_at: z.string(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

/** The APIs do not publish a default. Rank live account-visible general models. */
export function rankCatalog(models: CatalogModel[]): CatalogModel[] {
  const unique = new Map(models.map((model) => [model.id, model]));
  const specialization = (id: string) =>
    /(?:^|-)(?:mini|nano|haiku|preview|beta)(?:-|$)/.test(id) ? 1 : 0;
  const snapshot = (id: string) => (/(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(id) ? 1 : 0);
  return [...unique.values()].sort(
    (a, b) =>
      b.createdAt - a.createdAt ||
      specialization(a.id) - specialization(b.id) ||
      snapshot(a.id) - snapshot(b.id) ||
      a.id.localeCompare(b.id),
  );
}

export function isGeneralOpenAIModel(id: string): boolean {
  return (
    /^(?:gpt-|o\d+(?:-|$))/.test(id) &&
    !/(?:^|-)(?:audio|realtime|search|image|instruct|embedding|moderation|transcribe|tts|deep-research|codex|preview)(?:-|$)/.test(
      id,
    )
  );
}

export async function discoverApiModels(
  provider: ApiModelProvider,
  apiKey: string,
): Promise<ModelCatalog> {
  const signal = AbortSignal.timeout(20_000);
  const models: CatalogModel[] = [];
  try {
    if (provider === "openai") {
      const page = openAIPage.parse(
        await catalogRequest(
          "https://api.openai.com/v1/models",
          {
            authorization: `Bearer ${apiKey}`,
          },
          signal,
        ),
      );
      for (const model of page.data) {
        if (!isGeneralOpenAIModel(model.id) || model.shutdown_date) continue;
        models.push({ id: model.id, label: model.id, createdAt: model.created * 1_000 });
      }
    } else {
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const url = new URL("https://api.anthropic.com/v1/models");
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("after_id", cursor);
        const page = anthropicPage.parse(
          await catalogRequest(
            url.toString(),
            {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            signal,
          ),
        );
        for (const model of page.data) {
          if (!model.id.startsWith("claude-") || /(?:^|-)(?:preview|beta)(?:-|$)/.test(model.id))
            continue;
          models.push({
            id: model.id,
            label: model.display_name || model.id,
            createdAt: Date.parse(model.created_at) || 0,
          });
        }
        if (!page.has_more) break;
        if (!page.last_id || seen.has(page.last_id) || pageNumber === 9) {
          throw new ModelSetupError(
            "The AI Model returned an incomplete model list. Try again or enter a model ID manually.",
            502,
          );
        }
        cursor = page.last_id;
        seen.add(cursor);
      }
    }
    const ranked = rankCatalog(models);
    if (!ranked.length)
      throw new ModelSetupError(
        "No compatible models were found for this key. Check model access or enter a model ID manually.",
      );
    return { models: ranked, recommendedModel: ranked[0].id, source: "recent-compatible-model" };
  } catch (error) {
    throw modelSetupFailure(error, "load the available AI Models");
  }
}

async function catalogRequest(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { headers, signal, redirect: "error" });
  if (!response.ok) {
    // Never read or echo the response body: invalid-key responses may echo it.
    await response.body?.cancel();
    throw { status: response.status };
  }
  return response.json();
}
