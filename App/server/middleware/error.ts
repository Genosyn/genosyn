import { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // eslint-disable-next-line no-console
  console.error("[error]", err);
  const message = err instanceof Error ? err.message : "Internal error";
  const status =
    err && typeof err === "object" && "status" in err && typeof err.status === "number"
      ? err.status
      : 500;
  res.status(status).json({ error: message });
}
