import type { Request } from "express";

export function params(req: Request): Record<string, string> {
  return req.params as unknown as Record<string, string>;
}
