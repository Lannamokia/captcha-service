import nodeCrypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateTextChallenges, signedRequestHeaders } from "./credential-tools";

describe("admin credential tools", () => {
  it("generates 100 unique six-character mixed challenges", () => {
    const values = generateTextChallenges();
    expect(values).toHaveLength(100);
    expect(new Set(values).size).toBe(100);
    expect(values.every((value) => /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6}$/.test(value))).toBe(true);
  });

  it("produces headers compatible with the server HMAC protocol", async () => {
    const secret = "a-secret-with-at-least-32-characters";
    const body = JSON.stringify({ challengeType: "text" });
    const path = "/admin-api/test/sites/site-1/sessions";
    const headers = await signedRequestHeaders("site-1", secret, "POST", path, body);
    const digest = nodeCrypto.createHash("sha256").update(body).digest("base64url");
    const canonical = ["POST", path, headers["x-captcha-timestamp"], headers["x-captcha-nonce"], digest].join("\n");
    const signature = nodeCrypto.createHmac("sha256", secret).update(canonical).digest("base64url");

    expect(headers["x-captcha-content-sha256"]).toBe(digest);
    expect(headers["x-captcha-signature"]).toBe(signature);
    expect(headers["x-captcha-nonce"]).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
