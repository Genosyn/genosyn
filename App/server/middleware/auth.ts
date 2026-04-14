import { Request, Response, NextFunction } from "express";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership, Role } from "../db/entities/Membership.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    user?: User;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const uid = req.session?.userId as string | undefined;
  if (!uid) return res.status(401).json({ error: "Unauthorized" });
  const user = await AppDataSource.getRepository(User).findOneBy({ id: uid });
  if (!user) {
    req.session = null;
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.userId = user.id;
  req.user = user;
  next();
}

export async function requireCompanyMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const companyId = req.params.cid ?? req.params.companyId;
  if (!companyId) return res.status(400).json({ error: "Missing company id" });
  if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
  const m = await AppDataSource.getRepository(Membership).findOneBy({
    companyId,
    userId: req.userId,
  });
  if (!m) return res.status(403).json({ error: "Forbidden" });
  (req as Request & { role: Role }).role = m.role;
  next();
}

export function roleAtLeast(role: Role, candidate: Role): boolean {
  const order: Role[] = ["member", "admin", "owner"];
  return order.indexOf(candidate) >= order.indexOf(role);
}
