import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Site } from "@prisma/client";
import { prisma } from "./database.js";
import { decryptSecret, digest, safeEqual } from "./crypto.js";
import { claimNonce } from "./nonce-store.js";

export interface RawRequest extends Request {
  rawBody?: Buffer;
  captchaSite?: Site;
}

export function canonicalRequest(method: string, path: string, timestamp: string, nonce: string, bodyDigest: string) {
  return [method.toUpperCase(), path, timestamp, nonce, bodyDigest].join("\n");
}

export function signRequest(secret: string, method: string, path: string, timestamp: string, nonce: string, bodyDigest: string) {
  return crypto.createHmac("sha256", secret)
    .update(canonicalRequest(method, path, timestamp, nonce, bodyDigest))
    .digest("base64url");
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export async function requireSiteSignature(req: RawRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const siteId = header(req, "x-captcha-site-id");
    const timestamp = header(req, "x-captcha-timestamp");
    const nonce = header(req, "x-captcha-nonce");
    const claimedDigest = header(req, "x-captcha-content-sha256");
    const signature = header(req, "x-captcha-signature");
    const routeSiteId = typeof req.params.siteId === "string" ? req.params.siteId : undefined;
    if (!siteId || !timestamp || !nonce || !claimedDigest || !signature || (routeSiteId && routeSiteId !== siteId)) {
      res.status(401).json({ error: "INVALID_SIGNATURE" });
      return;
    }
    const parsedTimestamp = Number(timestamp);
    if (!Number.isInteger(parsedTimestamp) || Math.abs(Date.now() / 1000 - parsedTimestamp) > 60) {
      res.status(401).json({ error: "SIGNATURE_EXPIRED" });
      return;
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      res.status(401).json({ error: "INVALID_NONCE" });
      return;
    }
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site || !site.active) {
      res.status(401).json({ error: "INVALID_SIGNATURE" });
      return;
    }
    const actualDigest = digest(req.rawBody || Buffer.alloc(0));
    if (!safeEqual(claimedDigest, actualDigest)) {
      res.status(401).json({ error: "INVALID_SIGNATURE" });
      return;
    }
    const path = req.originalUrl.split("?")[0];
    const expected = signRequest(decryptSecret(site.encrypted_secret), req.method, path, timestamp, nonce, claimedDigest);
    if (!safeEqual(signature, expected)) {
      res.status(401).json({ error: "INVALID_SIGNATURE" });
      return;
    }

    if (!(await claimNonce(site.id, nonce))) {
      res.status(409).json({ error: "NONCE_REPLAY" });
      return;
    }
    req.captchaSite = site;
    next();
  } catch {
    res.status(401).json({ error: "INVALID_SIGNATURE" });
  }
}
