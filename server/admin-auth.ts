import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export interface AdminRequest extends Request {
  admin?: { id: string; username: string };
}

export function signAdminToken(admin: { id: string; username: string }) {
  return jwt.sign({ sub: admin.id, username: admin.username, scope: "admin" }, config.ADMIN_JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "8h",
    jwtid: crypto.randomUUID(),
  });
}

export function requireAdmin(req: AdminRequest, res: Response, next: NextFunction): void {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }
  try {
    const payload = jwt.verify(authorization.slice(7), config.ADMIN_JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (payload.scope !== "admin" || typeof payload.sub !== "string" || typeof payload.username !== "string") throw new Error();
    req.admin = { id: payload.sub, username: payload.username };
    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED" });
  }
}
