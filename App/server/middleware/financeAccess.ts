import type { Request, Response, NextFunction } from "express";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";

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

/**
 * The rule itself, over the two facts it depends on.
 *
 * Split out of {@link effectiveFinanceAccess} because two other callers have
 * to answer the same question without a per-company request to read it from:
 * the company list, which holds the `Membership` rows directly, and the
 * create route, which has just made the caller an owner. One rule in one
 * place beats the owner/admin exemption written down three times and drifting.
 */
export function financeAccessFor(
  role: Role | undefined,
  membershipAccess: FinanceAccess | undefined,
): FinanceAccess {
  if (role === "owner" || role === "admin") return "full";
  return membershipAccess ?? "none";
}

export function effectiveFinanceAccess(req: Request): FinanceAccess {
  return financeAccessFor(req.companyRole, req.membership?.financeAccess);
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
