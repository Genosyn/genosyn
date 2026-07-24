import type { Request, Response, NextFunction } from "express";
import type { FinanceAccess } from "../db/entities/Membership.js";

/**
 * Per-member finance authorization (M33 A4). Reads the `financeAccess` level
 * resolved by `requireCompanyMember` (via `req.membership`) and gates the
 * finance surface by it.
 *
 * Owners and admins are always effectively `full` — the per-member level only
 * ever restricts regular members. When no membership is on the request (should
 * not happen behind `requireCompanyMember`) we fail closed to `none`.
 *
 * These are attached to finance routes by wrapping the finance router's verb
 * methods (see routes/finance.ts), so a GET needs at least `read` and every
 * mutation needs `full`, without every route repeating the guard.
 */
export function effectiveFinanceAccess(req: Request): FinanceAccess {
  if (req.companyRole === "owner" || req.companyRole === "admin") return "full";
  return req.membership?.financeAccess ?? "none";
}

export function requireFinanceRead(req: Request, res: Response, next: NextFunction): void {
  if (effectiveFinanceAccess(req) === "none") {
    res.status(403).json({ error: "You don't have access to this company's finances." });
    return;
  }
  next();
}

export function requireFinanceWrite(req: Request, res: Response, next: NextFunction): void {
  if (effectiveFinanceAccess(req) !== "full") {
    res.status(403).json({ error: "You have read-only finance access." });
    return;
  }
  next();
}
