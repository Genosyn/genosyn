import { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // eslint-disable-next-line no-console
  console.error("[error]", err);
  const message = err instanceof Error ? err.message : "Internal error";
  res.status(500).json({ error: message });
}
