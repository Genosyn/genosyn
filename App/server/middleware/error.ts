import { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // eslint-disable-next-line no-console
  console.error("[error]", err);
  const candidateStatus =
    err && typeof err === "object" && "status" in err && typeof err.status === "number"
      ? err.status
      : 500;
  const status =
    Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
      ? candidateStatus
      : 500;
  // Expected 4xx errors are safe API feedback. Unexpected server failures may
  // include SQL, filesystem paths, credentials, or upstream response bodies;
  // keep their detail in operator logs only.
  const message = status < 500 && err instanceof Error ? err.message : "Internal server error";
  res.status(status).json({ error: message });
}
