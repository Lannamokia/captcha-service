import crypto from "node:crypto";
import { config } from "./config.js";

const key = Buffer.from(crypto.hkdfSync(
  "sha256",
  config.SERVICE_MASTER_KEY,
  Buffer.alloc(0),
  Buffer.from("captcha-service/site-secret/v1"),
  32
));

export function encryptSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value: string): string {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Invalid encrypted secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

export function opaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function challengeDigest(value: string): string {
  return crypto.createHmac("sha256", key).update(value.toUpperCase()).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
