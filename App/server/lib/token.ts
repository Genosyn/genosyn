import crypto from "node:crypto";

export function generateToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("hex");
}
