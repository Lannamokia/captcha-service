import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { prisma } from "./database.js";
import { digest } from "./crypto.js";
import { signRequest } from "./hmac.js";
import { clearNonceStore, disconnectNonceStore } from "./nonce-store.js";

const app = createApp();

function signatureHeaders(siteId: string, secret: string, method: string, path: string, body: string, nonce = crypto.randomBytes(18).toString("base64url")) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyDigest = digest(body);
  return {
    "x-captcha-site-id": siteId,
    "x-captcha-timestamp": timestamp,
    "x-captcha-nonce": nonce,
    "x-captcha-content-sha256": bodyDigest,
    "x-captcha-signature": signRequest(secret, method, path, timestamp, nonce, bodyDigest),
  };
}

beforeEach(async () => {
  await clearNonceStore();
  await prisma.widgetSession.deleteMany();
  await prisma.securityEvent.deleteMany();
  await prisma.challengeAsset.deleteMany();
  await prisma.site.deleteMany();
  await prisma.admin.deleteMany();
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), disconnectNonceStore()]);
});

describe("captcha service HTTP protocol", () => {
  it("enforces origin and nonce, then redeems a completion token once", async () => {
    const setup = await request(app).post("/admin-api/setup").send({
      username: "operator",
      password: "StrongPassword123!",
    });
    expect(setup.status).toBe(201);
    const adminToken = setup.body.token as string;

    const siteResponse = await request(app)
      .post("/admin-api/sites")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ name: "Main login", allowedOrigins: ["https://login.example.com"] });
    expect(siteResponse.status).toBe(201);
    const siteId = siteResponse.body.site.id as string;
    const secret = siteResponse.body.secret as string;

    const path = `/v1/sites/${siteId}/sessions`;
    const body = JSON.stringify({
      usernameDigest: "u".repeat(43),
      action: "login",
      parentOrigin: "https://login.example.com",
      policyVersion: 7,
      level: "low",
      credentialFailure: false,
      theme: "light",
      brandColor: "#147d92",
    });
    const nonce = crypto.randomBytes(18).toString("base64url");
    const headers = signatureHeaders(siteId, secret, "POST", path, body, nonce);
    const sessionResponse = await request(app).post(path).set(headers).set("content-type", "application/json").send(body);
    expect(sessionResponse.status).toBe(201);
    expect(sessionResponse.body.iframeUrl).toContain("#token=");

    const replay = await request(app).post(path).set(headers).set("content-type", "application/json").send(body);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("NONCE_REPLAY");

    const rejectedBody = JSON.stringify({ ...JSON.parse(body), parentOrigin: "https://attacker.example.com" });
    const rejected = await request(app).post(path)
      .set(signatureHeaders(siteId, secret, "POST", path, rejectedBody))
      .set("content-type", "application/json")
      .send(rejectedBody);
    expect(rejected.status).toBe(403);
    expect(rejected.body.error).toBe("ORIGIN_NOT_ALLOWED");

    const iframeUrl = new URL(sessionResponse.body.iframeUrl);
    const sessionId = iframeUrl.searchParams.get("session")!;
    const widgetToken = new URLSearchParams(iframeUrl.hash.slice(1)).get("token")!;
    const evaluate = await request(app)
      .post(`/v1/widget/sessions/${sessionId}/evaluate`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({
        wasmAvailable: true,
        webdriver: false,
        plugins: 3,
        languages: 2,
        hardwareConcurrency: 8,
        touchPoints: 0,
        visibilityChanges: 0,
        elapsedMs: 500,
      });
    expect(evaluate.status).toBe(200);
    expect(evaluate.body.decision).toBe("pass");

    const redeemPath = "/v1/verifications/redeem";
    const redeemBody = JSON.stringify({ sessionRef: sessionId, token: evaluate.body.completionToken });
    const redeem = await request(app).post(redeemPath)
      .set(signatureHeaders(siteId, secret, "POST", redeemPath, redeemBody))
      .set("content-type", "application/json")
      .send(redeemBody);
    expect(redeem.status).toBe(200);
    expect(redeem.body.success).toBe(true);

    const secondRedeem = await request(app).post(redeemPath)
      .set(signatureHeaders(siteId, secret, "POST", redeemPath, redeemBody))
      .set("content-type", "application/json")
      .send(redeemBody);
    expect(secondRedeem.status).toBe(400);
    expect(secondRedeem.body.success).toBe(false);
  });
});
