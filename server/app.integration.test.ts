import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./database.js";
import { digest } from "./crypto.js";
import { signRequest } from "./hmac.js";
import { clearNonceStore, disconnectNonceStore } from "./nonce-store.js";

const app = createApp();

function signatureHeaders(
  siteId: string,
  secret: string,
  method: string,
  path: string,
  body: string,
  nonce = crypto.randomBytes(18).toString("base64url"),
  timestamp = Math.floor(Date.now() / 1000).toString(),
) {
  const bodyDigest = digest(body);
  return {
    "x-captcha-site-id": siteId,
    "x-captcha-timestamp": timestamp,
    "x-captcha-nonce": nonce,
    "x-captcha-content-sha256": bodyDigest,
    "x-captcha-signature": signRequest(secret, method, path, timestamp, nonce, bodyDigest),
  };
}

function rawPositionForTarget(motionMap: number[], target: number): number {
  let closest = 0;
  for (let index = 1; index < motionMap.length; index += 1) {
    if (Math.abs(motionMap[index] - target) < Math.abs(motionMap[closest] - target)) closest = index;
  }
  return closest;
}

async function setupSite() {
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
  return {
    adminToken,
    siteId: siteResponse.body.site.id as string,
    secret: siteResponse.body.secret as string,
  };
}

async function createSession(siteId: string, secret: string, options: { level: "low" | "medium" | "high"; credentialFailure: boolean }) {
  const path = `/v1/sites/${siteId}/sessions`;
  const body = JSON.stringify({
    usernameDigest: "u".repeat(43),
    action: "login",
    parentOrigin: "https://login.example.com",
    policyVersion: 7,
    level: options.level,
    credentialFailure: options.credentialFailure,
    theme: "light",
    brandColor: "#147d92",
  });
  const response = await request(app).post(path)
    .set(signatureHeaders(siteId, secret, "POST", path, body))
    .set("content-type", "application/json")
    .send(body);
  expect(response.status).toBe(201);
  const iframeUrl = new URL(response.body.iframeUrl);
  return {
    response,
    sessionId: iframeUrl.searchParams.get("session")!,
    widgetToken: new URLSearchParams(iframeUrl.hash.slice(1)).get("token")!,
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
  it("reports PostgreSQL and Redis dependency health", async () => {
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: "ok", database: "healthy", redis: "healthy" });
  });

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
    const managementOrigin = new URL(config.PUBLIC_BASE_URL).origin;
    expect(siteResponse.body.site).toMatchObject({
      allowedOrigins: ["https://login.example.com"],
      adminOrigin: managementOrigin,
      effectiveAllowedOrigins: ["https://login.example.com", managementOrigin],
    });
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
    expect(new URL(sessionResponse.body.iframeUrl).searchParams.has("token")).toBe(false);

    const expiredHeaders = signatureHeaders(
      siteId,
      secret,
      "POST",
      path,
      body,
      crypto.randomBytes(18).toString("base64url"),
      Math.floor(Date.now() / 1000 - 120).toString(),
    );
    const expiredSignature = await request(app).post(path).set(expiredHeaders).set("content-type", "application/json").send(body);
    expect(expiredSignature.status).toBe(401);
    expect(expiredSignature.body.error).toBe("SIGNATURE_EXPIRED");

    const frame = await request(app).get(new URL(sessionResponse.body.iframeUrl).pathname + new URL(sessionResponse.body.iframeUrl).search);
    expect(frame.status).toBe(200);
    expect(frame.headers["content-security-policy"]).toContain("frame-ancestors 'self' https://login.example.com");

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

    const adminOriginBody = JSON.stringify({ ...JSON.parse(body), parentOrigin: managementOrigin });
    const adminOriginSession = await request(app).post(path)
      .set(signatureHeaders(siteId, secret, "POST", path, adminOriginBody))
      .set("content-type", "application/json")
      .send(adminOriginBody);
    expect(adminOriginSession.status).toBe(201);

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

  it("uses an active text asset, limits challenge attempts, and redeems concurrently only once", async () => {
    const { adminToken, siteId, secret } = await setupSite();
    const digitsOnly = await request(app)
      .post("/admin-api/assets")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ kind: "text_wordlist", label: "Digits only", payload: "123456" });
    expect(digitsOnly.status).toBe(400);
    const lettersOnly = await request(app)
      .post("/admin-api/assets")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ kind: "text_wordlist", label: "Letters only", payload: "ABCDEF" });
    expect(lettersOnly.status).toBe(400);
    const asset = await request(app)
      .post("/admin-api/assets")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ kind: "text_wordlist", label: "Login mixed", payload: "A2B3C4" });
    expect(asset.status).toBe(201);

    const { sessionId, widgetToken } = await createSession(siteId, secret, { level: "low", credentialFailure: true });
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
    expect(evaluate.body.decision).toBe("text");

    const verify = await request(app)
      .post(`/v1/widget/sessions/${sessionId}/verify`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({ answer: "a2b3c4" });
    expect(verify.status).toBe(200);

    const redeemPath = "/v1/verifications/redeem";
    const redeemBody = JSON.stringify({ sessionRef: sessionId, token: verify.body.completionToken });
    const [first, second] = await Promise.all([
      request(app).post(redeemPath).set(signatureHeaders(siteId, secret, "POST", redeemPath, redeemBody)).set("content-type", "application/json").send(redeemBody),
      request(app).post(redeemPath).set(signatureHeaders(siteId, secret, "POST", redeemPath, redeemBody)).set("content-type", "application/json").send(redeemBody),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
  });

  it("completes the high-risk slider flow while persisting only its summary", async () => {
    const { adminToken, siteId, secret } = await setupSite();
    const background = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const asset = await request(app)
      .post("/admin-api/assets")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ kind: "slider_background", label: "Grid", payload: background });
    expect(asset.status).toBe(201);
    const { sessionId, widgetToken } = await createSession(siteId, secret, { level: "high", credentialFailure: false });
    const evaluate = await request(app)
      .post(`/v1/widget/sessions/${sessionId}/evaluate`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({
        wasmAvailable: false,
        webdriver: true,
        plugins: 0,
        languages: 0,
        hardwareConcurrency: 0,
        touchPoints: 0,
        visibilityChanges: 8,
        elapsedMs: 20,
      });
    expect(evaluate.status).toBe(200);
    expect(evaluate.body.decision).toBe("slider");
    expect(evaluate.body.backgroundImage).toMatch(/^data:image\/webp;base64,/);
    expect(evaluate.body.pieceImage).toMatch(/^data:image\/png;base64,/);
    expect(evaluate.body.holeCount).toBeGreaterThanOrEqual(3);
    expect(evaluate.body.target).toBeUndefined();
    expect(evaluate.body.motionMap).toHaveLength(evaluate.body.sliderMax + 1);
    const pending = await prisma.widgetSession.findUnique({ where: { id: sessionId } });
    const target = pending!.slider_target!;
    const rawTarget = rawPositionForTarget(evaluate.body.motionMap as number[], target);
    const fractions = [0, 0.04, 0.12, 0.25, 0.42, 0.61, 0.78, 0.9, 0.97, 1];
    const trajectory = fractions.map((fraction, index) => ({
      x: Math.round(rawTarget * fraction),
      y: 10 + (index % 3),
      t: index * 100,
    }));
    const verify = await request(app)
      .post(`/v1/widget/sessions/${sessionId}/verify`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({ answer: rawTarget, trajectory });
    expect(verify.status).toBe(200);
    const stored = await prisma.widgetSession.findUnique({ where: { id: sessionId } });
    expect(stored?.challenge_digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored?.challenge_attempts).toBe(1);
    expect(JSON.parse(stored!.slider_motion_profile!)).toEqual(evaluate.body.motionMap);
  });

  it("creates slider background assets through the authenticated batch endpoint", async () => {
    const { adminToken } = await setupSite();
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const response = await request(app)
      .post("/admin-api/assets/batch")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ assets: [
        { kind: "slider_background", label: "Landscape A", payload: image },
        { kind: "slider_background", label: "Landscape B", payload: image },
      ] });
    expect(response.status).toBe(201);
    expect(response.body.count).toBe(2);
    expect(response.body.assets).toHaveLength(2);
    expect(await prisma.challengeAsset.count({ where: { kind: "slider_background" } })).toBe(2);
    expect(await prisma.securityEvent.findFirst({ where: { action: "asset.batch_create" } })).not.toBeNull();
  });

  it("switches a slider session to the accessible text fallback", async () => {
    const { adminToken, siteId, secret } = await setupSite();
    await request(app)
      .post("/admin-api/assets")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ kind: "text_wordlist", label: "Accessible mixed", payload: "Z9Y8X7" });
    const { sessionId, widgetToken } = await createSession(siteId, secret, { level: "high", credentialFailure: false });
    const fallback = await request(app)
      .post(`/v1/widget/sessions/${sessionId}/accessibility-fallback`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({});
    expect(fallback.status).toBe(200);
    expect(fallback.body.decision).toBe("text");
    const verify = await request(app)
      .post(`/v1/widget/sessions/${sessionId}/verify`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({ answer: "z9y8x7" });
    expect(verify.status).toBe(200);
  });

  it("tests a site secret through complete text and slider flows with concrete browser scoring", async () => {
    const { adminToken, siteId, secret } = await setupSite();
    await request(app)
      .post("/admin-api/assets")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ kind: "text_wordlist", label: "Credential test", payload: "A2B3C4" });

    const invalidPath = `/admin-api/test/sites/${siteId}/sessions`;
    const invalidBody = JSON.stringify({
      usernameDigest: "u".repeat(43),
      action: "login",
      parentOrigin: new URL(config.PUBLIC_BASE_URL).origin,
      policyVersion: 1,
      level: "high",
      credentialFailure: false,
      theme: "light",
      brandColor: "#147d92",
      challengeType: "text",
    });
    const invalidSecret = await request(app).post(invalidPath)
      .set("authorization", `Bearer ${adminToken}`)
      .set(signatureHeaders(siteId, "incorrect-secret-with-at-least-32-characters", "POST", invalidPath, invalidBody))
      .set("content-type", "application/json")
      .send(invalidBody);
    expect(invalidSecret.status).toBe(401);
    expect(invalidSecret.body.error).toBe("INVALID_SIGNATURE");

    for (const challengeType of ["text", "slider"] as const) {
      const path = `/admin-api/test/sites/${siteId}/sessions`;
      const body = JSON.stringify({ ...JSON.parse(invalidBody), challengeType });
      const created = await request(app).post(path)
        .set("authorization", `Bearer ${adminToken}`)
        .set(signatureHeaders(siteId, secret, "POST", path, body))
        .set("content-type", "application/json")
        .send(body);
      expect(created.status).toBe(201);

      const iframeUrl = new URL(created.body.iframeUrl);
      const sessionId = iframeUrl.searchParams.get("session")!;
      const widgetToken = new URLSearchParams(iframeUrl.hash.slice(1)).get("token")!;
      const evaluate = await request(app)
        .post(`/v1/widget/sessions/${sessionId}/evaluate`)
        .set("authorization", `Bearer ${widgetToken}`)
        .send({ wasmAvailable: true, webdriver: false, plugins: 3, languages: 2, hardwareConcurrency: 8, touchPoints: 0, visibilityChanges: 0, elapsedMs: 500 });
      expect(evaluate.status).toBe(200);
      expect(evaluate.body.decision).toBe(challengeType);
      expect(evaluate.body.diagnostic).toEqual({ score: 100, deductions: [] });

      let verifyBody: { answer: string | number; trajectory?: Array<{ x: number; y: number; t: number }> } = { answer: "a2b3c4" };
      if (challengeType === "slider") {
        expect(evaluate.body.target).toBeUndefined();
        const pending = await prisma.widgetSession.findUnique({ where: { id: sessionId } });
        const target = pending!.slider_target!;
        const rawTarget = rawPositionForTarget(evaluate.body.motionMap as number[], target);
        const fractions = [0, 0.04, 0.12, 0.25, 0.42, 0.61, 0.78, 0.9, 0.97, 1];
        verifyBody = {
          answer: rawTarget,
          trajectory: fractions.map((fraction, index) => ({ x: Math.round(rawTarget * fraction), y: 10 + (index % 3), t: index * 100 })),
        };
      }
      const verify = await request(app)
        .post(`/v1/widget/sessions/${sessionId}/verify`)
        .set("authorization", `Bearer ${widgetToken}`)
        .send(verifyBody);
      expect(verify.status).toBe(200);

      const redeemPath = "/v1/verifications/redeem";
      const redeemBody = JSON.stringify({ sessionRef: sessionId, token: verify.body.completionToken });
      const redeem = await request(app).post(redeemPath)
        .set(signatureHeaders(siteId, secret, "POST", redeemPath, redeemBody))
        .set("content-type", "application/json")
        .send(redeemBody);
      expect(redeem.status).toBe(200);
      expect(redeem.body.success).toBe(true);
    }
  });

  it("locks a challenge session after five rejected answers", async () => {
    const { siteId, secret } = await setupSite();
    const { sessionId, widgetToken } = await createSession(siteId, secret, { level: "low", credentialFailure: true });
    await request(app)
      .post(`/v1/widget/sessions/${sessionId}/evaluate`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({ wasmAvailable: true, webdriver: false, plugins: 3, languages: 2, hardwareConcurrency: 8, touchPoints: 0, visibilityChanges: 0, elapsedMs: 500 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await request(app)
        .post(`/v1/widget/sessions/${sessionId}/verify`)
        .set("authorization", `Bearer ${widgetToken}`)
        .send({ answer: "wrong" });
      expect(rejected.status).toBe(400);
    }
    const stored = await prisma.widgetSession.findUnique({ where: { id: sessionId } });
    expect(stored?.state).toBe("failed");
    expect(stored?.challenge_attempts).toBe(5);
  });

  it("locks a challenge session after five concurrent rejected answers", async () => {
    const { siteId, secret } = await setupSite();
    const { sessionId, widgetToken } = await createSession(siteId, secret, { level: "low", credentialFailure: true });
    await request(app)
      .post(`/v1/widget/sessions/${sessionId}/evaluate`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({ wasmAvailable: true, webdriver: false, plugins: 3, languages: 2, hardwareConcurrency: 8, touchPoints: 0, visibilityChanges: 0, elapsedMs: 500 });
    const rejected = await Promise.all(Array.from({ length: 5 }, () => request(app)
      .post(`/v1/widget/sessions/${sessionId}/verify`)
      .set("authorization", `Bearer ${widgetToken}`)
      .send({ answer: "wrong" })));
    expect(rejected.every((response) => response.status === 400)).toBe(true);
    const stored = await prisma.widgetSession.findUnique({ where: { id: sessionId } });
    expect(stored?.state).toBe("failed");
    expect(stored?.challenge_attempts).toBe(5);
  });
});
