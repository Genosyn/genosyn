import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    session?: { userId?: string } | null;
  }
}

declare module "cookie-session" {
  // cookie-session ships its own types; this file only augments Express.
}
