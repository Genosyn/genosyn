import { buildOpenApiDocument } from "../../openapi/spec.js";
import {
  buildOperationCatalogue,
  type OpenApiDocumentLike,
  type OperationCatalogue,
} from "./catalogue.js";

/**
 * The operation catalogue of the Express app the server listens with.
 *
 * Kept apart from `catalogue.ts` because the API reference it reads imports
 * every router — this server's own among them — so only code that runs after
 * the app is built reaches it, and everything else stays free of that cycle.
 *
 * Built once per app, like the reference: routes never change while the
 * process runs. The first build walks the whole router stack, synchronously,
 * which is why the server warms it before it starts listening.
 */

const catalogues = new WeakMap<object, OperationCatalogue>();

export function operationCatalogue(app: object): OperationCatalogue {
  let catalogue = catalogues.get(app);
  if (!catalogue) {
    catalogue = buildOperationCatalogue(
      buildOpenApiDocument(app) as unknown as OpenApiDocumentLike,
    );
    catalogues.set(app, catalogue);
  }
  return catalogue;
}
