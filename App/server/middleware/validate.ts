import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodType, ZodTypeDef } from "zod";

/**
 * Validate a request body against a zod schema at the API boundary.
 *
 * The parsed result *replaces* `req.body`, so a handler reading `req.body` sees
 * the parsed value — defaults filled in, transforms applied.
 *
 * That replacement is the whole point. `.default()` and `.transform()` exist
 * only on a schema's output, so a handler reading the raw input silently
 * ignores them: a defaulted field arrives `undefined`, and a `.transform()` may
 * as well not be there. This used to hand the parsed value back on a separate
 * `req.validated` property, which meant every handler that read `req.body` —
 * all but seven of them — quietly got the unparsed input instead.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
    }
    req.body = parsed.data;
    next();
  };
}

/** Validate and replace route params using the same boundary semantics as bodies. */
export function validateParams<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
    }
    req.params = parsed.data as Request["params"];
    next();
  };
}

/**
 * Validate and replace the query string, same boundary semantics again.
 *
 * Query values arrive as strings, so these schemas lean on `z.coerce`,
 * `.transform()` and `.default()` — which makes replacing `req.query`
 * load-bearing rather than tidy: a handler reading the raw query gets `"200"`
 * where the schema promised `200`, and `undefined` where it promised a default.
 *
 * Typed over input *and* output, unlike its two siblings. `ZodSchema<T>` is
 * `ZodType<T, ZodTypeDef, T>`, which is fine for a body that parses to its own
 * shape and wrong here by construction: a query schema's whole job is to turn
 * `"true"` into `true`.
 */
export function validateQuery<Out, In = unknown>(schema: ZodType<Out, ZodTypeDef, In>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
    }
    req.query = parsed.data as Request["query"];
    next();
  };
}
