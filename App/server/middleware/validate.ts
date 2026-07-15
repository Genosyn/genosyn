import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

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
