import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { prisma } from "./database.js";
import { type AdminRequest, requireAdmin, signAdminToken } from "./admin-auth.js";
import { challengeDigest, digest, encryptSecret, fingerprintSalt, opaqueToken, safeEqual, scopeMachineFingerprint } from "./crypto.js";
import { type RawRequest, requireSiteSignature } from "./hmac.js";
import {
  analyzeTrajectory,
  randomTextAnswer,
  isTextChallenge,
  scoreEnvironmentDetails,
  selectChallenge,
  type EnvironmentSignals,
  type EnvironmentScore,
  type ScoreDeduction,
  type TrajectoryPoint,
} from "./engine.js";
import { renderCaptchaPng } from "./captcha-image.js";
import { renderSliderPuzzle } from "./puzzle-image.js";
import { createMotionMap, mapMotionPosition } from "./motion-profile.js";
import {
  createIntegrityChallenge,
  validateIntegrityEvidence,
  type IntegrityChallenge,
  type IntegrityEvidence,
} from "./integrity-challenge.js";
import { pingNonceStore } from "./nonce-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../web");
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const originSchema = z.string().url().refine((value) => new URL(value).origin === value, "Expected an origin without path, query or fragment");
const adminOrigin = new URL(config.PUBLIC_BASE_URL).origin;

const sessionInput = z.object({
  usernameDigest: z.string().min(20).max(256),
  action: z.literal("login"),
  parentOrigin: originSchema,
  policyVersion: z.number().int().positive(),
  level: z.enum(["low", "medium", "high"]),
  credentialFailure: z.boolean(),
  theme: z.enum(["light", "dark"]).optional().default("light"),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default("#2563eb"),
});

const testSessionInput = sessionInput.extend({
  challengeType: z.enum(["text", "slider"]),
});

const evaluateInput = z.object({
  wasmAvailable: z.boolean(),
  webdriver: z.boolean(),
  plugins: z.number().int().min(0).max(100),
  languages: z.number().int().min(0).max(100),
  hardwareConcurrency: z.number().int().min(0).max(1024),
  touchPoints: z.number().int().min(0).max(100),
  visibilityChanges: z.number().int().min(0).max(1000),
  elapsedMs: z.number().min(0).max(600_000),
  fingerprintCapabilities: z.number().int().min(0).max(7).optional(),
  wasmReport: z.object({
    version: z.number().int().min(1).max(100),
    score: z.number().int().min(0).max(100),
    deductionMask: z.number().int().min(0).max(0x7fffffff),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    integrity: z.object({
      challengeId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      response: z.string().regex(/^[0-9a-f]{16}$/),
      frameDeltas: z.array(z.number().int().min(1).max(20_000)).min(1).max(64),
      trustedActivation: z.boolean(),
      focusState: z.boolean(),
    }),
  }).optional(),
});

const verifyInput = z.object({
  answer: z.union([z.string().max(32), z.number()]),
  trajectory: z.array(z.object({ x: z.number(), y: z.number(), t: z.number() })).max(500).optional(),
});

const textAssetInput = z.object({
    kind: z.literal("text_wordlist"),
    label: z.string().trim().min(1).max(100),
    payload: z.string().min(1).max(100_000).refine(
      (value) => {
        const entries = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        return entries.length > 0 && entries.every((item) => isTextChallenge(item));
      },
      "Text wordlists must contain one six-character uppercase alphanumeric challenge per line, with at least one letter and one digit",
    ),
  });

const sliderAssetInput = z.object({
  kind: z.literal("slider_background"),
  label: z.string().trim().min(1).max(100),
  payload: z.string().min(1).max(1_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
});

const assetCreateInput = z.discriminatedUnion("kind", [textAssetInput, sliderAssetInput]);

const assetBatchInput = z.object({
  assets: z.array(sliderAssetInput).min(1).max(40),
}).refine((value) => value.assets.reduce((sum, asset) => sum + asset.payload.length, 0) <= 14_000_000, "Batch payload is too large");

const assetUpdateInput = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  payload: z.string().min(1).max(1_000_000).optional(),
  active: z.boolean().optional(),
}).refine((value) => value.label !== undefined || value.payload !== undefined || value.active !== undefined, "At least one field is required");

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);
}

const deductionBits: Partial<Record<ScoreDeduction["factor"], number>> = {
  wasm_unavailable: 1 << 0,
  webdriver: 1 << 1,
  plugins_empty: 1 << 2,
  languages_empty: 1 << 3,
  hardware_concurrency_missing: 1 << 4,
  touch_points_invalid: 1 << 5,
  visibility_changes_high: 1 << 6,
  elapsed_too_fast: 1 << 7,
  audio_fingerprint_unavailable: 1 << 8,
  webgl_fingerprint_unavailable: 1 << 9,
  canvas_fingerprint_unavailable: 1 << 10,
};

function scoreDeductionMask(details: EnvironmentScore): number {
  return details.deductions.reduce((mask, item) => mask | (deductionBits[item.factor] || 0), 0);
}

function withDeductions(details: EnvironmentScore, additions: ScoreDeduction[]): EnvironmentScore {
  return {
    score: Math.max(0, details.score - additions.reduce((total, item) => total + item.points, 0)),
    deductions: [...details.deductions, ...additions],
  };
}

function parseIntegrityChallenge(value: string | null): IntegrityChallenge | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as IntegrityChallenge;
    const programLength = typeof parsed?.program === "string"
      ? Buffer.from(parsed.program, "base64url").length
      : 0;
    return parsed &&
      typeof parsed.id === "string" && /^[A-Za-z0-9_-]{22}$/.test(parsed.id) &&
      typeof parsed.program === "string" && programLength >= 8 && programLength <= 128 &&
      Number.isInteger(parsed.seed) && parsed.seed >= 0 && parsed.seed <= 0xffffffff &&
      Number.isInteger(parsed.sampleCount) && parsed.sampleCount >= 1 && parsed.sampleCount <= 64 &&
      Number.isInteger(parsed.minimumDurationMs) && parsed.minimumDurationMs >= 1 && parsed.minimumDurationMs <= 10_000
      ? parsed
      : null;
  } catch {
    return null;
  }
}

type StoredIntegrityChallenge = { challenge: IntegrityChallenge; serialized: string };

async function ensureIntegrityChallenge(sessionId: string, stored: string | null): Promise<StoredIntegrityChallenge> {
  const existing = parseIntegrityChallenge(stored);
  if (existing && stored) return { challenge: existing, serialized: stored };
  const created = createIntegrityChallenge();
  const serialized = JSON.stringify(created);
  const claimed = await prisma.widgetSession.updateMany({
    where: { id: sessionId, integrity_challenge: stored },
    data: { integrity_challenge: serialized },
  });
  if (claimed.count === 1) return { challenge: created, serialized };
  const current = await prisma.widgetSession.findUnique({ where: { id: sessionId }, select: { integrity_challenge: true } });
  const currentChallenge = parseIntegrityChallenge(current?.integrity_challenge || null);
  if (!currentChallenge || !current?.integrity_challenge) throw new Error("INTEGRITY_CHALLENGE_UNAVAILABLE");
  return { challenge: currentChallenge, serialized: current.integrity_challenge };
}

async function fingerprintHistoryDeductions(siteId: string, sessionId: string, fingerprint: string | null): Promise<ScoreDeduction[]> {
  if (!fingerprint) return [];
  const sessions = await prisma.widgetSession.findMany({
    where: {
      site_id: siteId,
      machine_fingerprint: fingerprint,
      id: { not: sessionId },
      created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    select: { username_digest: true, state: true },
    orderBy: { created_at: "desc" },
    take: 100,
  });
  const additions: ScoreDeduction[] = [];
  if (new Set(sessions.map((item) => item.username_digest)).size >= 4) {
    additions.push({ factor: "fingerprint_account_churn", points: 20 });
  }
  if (sessions.filter((item) => item.state === "failed" || item.state === "expired").length >= 3) {
    additions.push({ factor: "fingerprint_failure_history", points: 15 });
  }
  return additions;
}

function bearer(req: Request): string | null {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

async function requireWidgetSession(req: Request, res: Response) {
  const token = bearer(req);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!token || !id) {
    res.status(401).json({ error: "INVALID_SESSION" });
    return null;
  }
  const session = await prisma.widgetSession.findUnique({ where: { id }, include: { site: true } });
  if (!session || !safeEqual(session.token_digest, digest(token))) {
    res.status(401).json({ error: "INVALID_SESSION" });
    return null;
  }
  if (session.expires_at <= new Date()) {
    await prisma.widgetSession.updateMany({ where: { id, state: { not: "redeemed" } }, data: { state: "expired" } });
    res.status(410).json({ error: "SESSION_EXPIRED" });
    return null;
  }
  return session;
}

async function completeSession(id: string, challengeSummary?: string, riskScore?: number): Promise<string | null> {
  const completionToken = opaqueToken();
  const completed = await prisma.widgetSession.updateMany({
    where: { id, state: "pending" },
    data: {
      state: "completed",
      completion_digest: digest(completionToken),
      completed_at: new Date(),
      challenge_digest: challengeSummary,
      risk_score: riskScore,
    },
  });
  return completed.count === 1 ? completionToken : null;
}

async function textChallenge() {
  const assets = await prisma.challengeAsset.findMany({
    where: { kind: "text_wordlist", active: true },
    select: { payload: true },
  });
  const candidates = assets.flatMap((asset) => asset.payload.split(/\r?\n/).map((item) => item.trim()));
  const answer = randomTextAnswer(candidates);
  return {
    answerDigest: challengeDigest(answer),
    imageData: `data:image/png;base64,${(await renderCaptchaPng(answer)).toString("base64")}`,
  };
}

async function sliderBackground(): Promise<string | undefined> {
  const assets = await prisma.challengeAsset.findMany({
    where: { kind: "slider_background", active: true },
    select: { payload: true },
  });
  return assets.length ? assets[crypto.randomInt(0, assets.length)].payload : undefined;
}

function validAssetPayload(kind: string, payload: string): boolean {
  if (kind === "text_wordlist") {
    const entries = payload.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return entries.length > 0 && entries.every((item) => isTextChallenge(item));
  }
  if (kind === "slider_background") {
    return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(payload);
  }
  return false;
}

function configuredOrigins(value: string): string[] {
  return JSON.parse(value) as string[];
}

function effectiveOrigins(value: string): string[] {
  return [...new Set([...configuredOrigins(value), adminOrigin])];
}

function serializeSite(site: { id: string; name: string; allowed_origins: string; active: boolean; created_at?: Date; updated_at?: Date }) {
  const allowedOrigins = configuredOrigins(site.allowed_origins);
  return {
    id: site.id,
    name: site.name,
    allowedOrigins,
    adminOrigin,
    effectiveAllowedOrigins: effectiveOrigins(site.allowed_origins),
    active: site.active,
    createdAt: site.created_at,
    updatedAt: site.updated_at,
  };
}

function frameAncestors(origin: string) {
  return `frame-ancestors 'self' ${origin}`;
}

function sessionCreationResponse(session: { id: string; expires_at: Date }, token: string) {
  const iframeUrl = new URL("/embed/v1/widget", config.PUBLIC_BASE_URL);
  iframeUrl.searchParams.set("session", session.id);
  iframeUrl.hash = new URLSearchParams({ token }).toString();
  return {
    iframeUrl: iframeUrl.toString(),
    allowedOrigin: adminOrigin,
    sessionRef: session.id,
    expiresAt: session.expires_at,
  };
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false, frameguard: false, referrerPolicy: { policy: "no-referrer" } }));
  app.use(express.json({
    limit: "16mb",
    verify: (req, _res, buffer) => { (req as RawRequest).rawBody = Buffer.from(buffer); },
  }));

  app.get("/health", asyncRoute(async (_req, res) => {
    try {
      const [, redisHealthy] = await Promise.all([prisma.$queryRaw`SELECT 1`, pingNonceStore()]);
      if (!redisHealthy) throw new Error("Redis health check failed");
      res.json({ status: "ok", database: "healthy", redis: "healthy", timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: "unavailable", timestamp: new Date().toISOString() });
    }
  }));

  app.post("/v1/sites/:siteId/sessions", requireSiteSignature, asyncRoute(async (req: RawRequest, res) => {
    const input = sessionInput.parse(req.body);
    const site = req.captchaSite!;
    const allowedOrigins = effectiveOrigins(site.allowed_origins);
    if (!allowedOrigins.includes(input.parentOrigin)) {
      res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    const token = opaqueToken();
    const integrityChallenge = createIntegrityChallenge();
    const session = await prisma.widgetSession.create({
      data: {
        site_id: site.id,
        token_digest: digest(token),
        parent_origin: input.parentOrigin,
        action: input.action,
        username_digest: input.usernameDigest,
        policy_version: input.policyVersion,
        level: input.level,
        credential_failure: input.credentialFailure,
        theme: input.theme,
        brand_color: input.brandColor,
        integrity_challenge: JSON.stringify(integrityChallenge),
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    res.status(201).json(sessionCreationResponse(session, token));
  }));

  app.post("/admin-api/test/sites/:siteId/sessions", requireAdmin, requireSiteSignature, asyncRoute(async (req: RawRequest, res) => {
    const input = testSessionInput.parse(req.body);
    if (input.parentOrigin !== adminOrigin) {
      res.status(403).json({ error: "ADMIN_ORIGIN_REQUIRED" });
      return;
    }
    const token = opaqueToken();
    const integrityChallenge = createIntegrityChallenge();
    const session = await prisma.widgetSession.create({
      data: {
        site_id: req.captchaSite!.id,
        token_digest: digest(token),
        parent_origin: input.parentOrigin,
        action: input.action,
        username_digest: input.usernameDigest,
        policy_version: input.policyVersion,
        level: input.level,
        credential_failure: input.credentialFailure,
        theme: input.theme,
        brand_color: input.brandColor,
        test_challenge_type: input.challengeType,
        integrity_challenge: JSON.stringify(integrityChallenge),
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    res.status(201).json(sessionCreationResponse(session, token));
  }));

  app.post("/v1/verifications/redeem", requireSiteSignature, asyncRoute(async (req: RawRequest, res) => {
    const input = z.object({ sessionRef: z.string().uuid(), token: z.string().min(20).max(256) }).parse(req.body);
    const session = await prisma.widgetSession.findUnique({ where: { id: input.sessionRef } });
    if (!session || !session.completion_digest || !safeEqual(session.completion_digest, digest(input.token))) {
      res.status(400).json({ success: false });
      return;
    }
    const redeemed = await prisma.widgetSession.updateMany({
      where: {
        id: session.id,
        site_id: req.captchaSite!.id,
        state: "completed",
        redeemed_at: null,
        expires_at: { gt: new Date() },
        completion_digest: digest(input.token),
      },
      data: { state: "redeemed", redeemed_at: new Date() },
    });
    if (redeemed.count !== 1) {
      res.status(400).json({ success: false });
      return;
    }
    res.json({
      success: true,
      sessionRef: session.id,
      policyVersion: session.policy_version,
      riskScore: session.risk_score,
      machineFingerprint: session.machine_fingerprint,
      fingerprintVersion: session.fingerprint_version,
      wasmIntegrityVerified: session.wasm_integrity_verified,
    });
  }));

  app.get("/v1/sites/:siteId/health", requireSiteSignature, asyncRoute(async (req: RawRequest, res) => {
    const database = await prisma.widgetSession.count({ where: { site_id: req.captchaSite!.id } });
    res.json({ status: "healthy", siteId: req.captchaSite!.id, sessionCount: database, timestamp: new Date().toISOString() });
  }));

  app.get("/v1/widget/sessions/:id/bootstrap", asyncRoute(async (req, res) => {
    const session = await requireWidgetSession(req, res);
    if (!session) return;
    const { challenge: integrityChallenge } = await ensureIntegrityChallenge(session.id, session.integrity_challenge);
    res.json({
      sessionId: session.id,
      parentOrigin: session.parent_origin,
      theme: session.theme,
      brandColor: session.brand_color,
      expiresAt: session.expires_at,
      protocolVersion: 1,
      fingerprintSalt: fingerprintSalt(session.site_id),
      integrityChallenge,
    });
  }));

  app.post("/v1/widget/sessions/:id/evaluate", asyncRoute(async (req, res) => {
    const session = await requireWidgetSession(req, res);
    if (!session) return;
    if (session.state === "completed" || session.state === "redeemed") {
      res.status(409).json({ error: "SESSION_ALREADY_COMPLETED" });
      return;
    }
    if (session.state !== "pending" || session.challenge_attempts >= MAX_CHALLENGE_ATTEMPTS) {
      res.status(429).json({ error: "CHALLENGE_ATTEMPTS_EXHAUSTED" });
      return;
    }
    const input = evaluateInput.parse(req.body);
    const signals: EnvironmentSignals = {
      wasmAvailable: input.wasmAvailable,
      webdriver: input.webdriver,
      plugins: input.plugins,
      languages: input.languages,
      hardwareConcurrency: input.hardwareConcurrency,
      touchPoints: input.touchPoints,
      visibilityChanges: input.visibilityChanges,
      elapsedMs: input.elapsedMs,
      fingerprintCapabilities: input.fingerprintCapabilities,
    };
    const baseScoreDetails = scoreEnvironmentDetails(signals);
    const report = input.wasmReport;
    const reportValid = Boolean(
      input.wasmAvailable &&
      report?.version === 2 &&
      report.score === baseScoreDetails.score &&
      report.deductionMask === scoreDeductionMask(baseScoreDetails),
    );
    const integrity = await ensureIntegrityChallenge(session.id, session.integrity_challenge);
    const wasmIntegrityVerified = Boolean(
      reportValid && report && validateIntegrityEvidence(
        integrity.challenge,
        report.fingerprint,
        report.integrity as IntegrityEvidence,
        input.visibilityChanges,
      ),
    );
    const machineFingerprint = wasmIntegrityVerified && report
      ? scopeMachineFingerprint(session.site_id, report.fingerprint)
      : null;
    const additions: ScoreDeduction[] = [];
    if (input.wasmAvailable && !reportValid) additions.push({ factor: "wasm_report_invalid", points: 25 });
    if (report && (report.score !== baseScoreDetails.score || report.deductionMask !== scoreDeductionMask(baseScoreDetails))) {
      additions.push({ factor: "wasm_score_mismatch", points: 30 });
    }
    if (!wasmIntegrityVerified) additions.push({ factor: "integrity_challenge_failed", points: 30 });
    additions.push(...await fingerprintHistoryDeductions(session.site_id, session.id, machineFingerprint));
    const scoreDetails = withDeductions(baseScoreDetails, additions);
    const riskScore = scoreDetails.score;
    const persisted = await prisma.widgetSession.updateMany({
      where: { id: session.id, state: "pending", integrity_challenge: integrity.serialized },
      data: {
        risk_score: riskScore,
        machine_fingerprint: machineFingerprint,
        fingerprint_version: report?.version,
        fingerprint_capabilities: input.fingerprintCapabilities,
        wasm_score: report?.score,
        wasm_integrity_verified: wasmIntegrityVerified,
        integrity_challenge: null,
      },
    });
    if (persisted.count !== 1) {
      res.status(409).json({ error: "SESSION_ALREADY_COMPLETED" });
      return;
    }
    const decision = session.test_challenge_type === "text" || session.test_challenge_type === "slider"
      ? session.test_challenge_type
      : selectChallenge(session.level, riskScore, session.credential_failure);
    const diagnostic = session.test_challenge_type ? {
      diagnostic: {
        ...scoreDetails,
        machineFingerprint,
        fingerprintVersion: report?.version || null,
        fingerprintCapabilities: input.fingerprintCapabilities || 0,
        wasmIntegrityVerified,
      },
    } : {};
    if (decision === "pass") {
      const completionToken = await completeSession(session.id, undefined, riskScore);
      if (!completionToken) {
        res.status(409).json({ error: "SESSION_ALREADY_COMPLETED" });
        return;
      }
      res.json({ decision, completionToken, parentOrigin: session.parent_origin, ...diagnostic });
      return;
    }
    if (decision === "text") {
      const challenge = await textChallenge();
      const updated = await prisma.widgetSession.updateMany({
        where: { id: session.id, state: "pending", challenge_attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
        data: { risk_score: riskScore, challenge_type: "text", challenge_answer_digest: challenge.answerDigest },
      });
      if (updated.count !== 1) {
        res.status(409).json({ error: "CHALLENGE_NOT_AVAILABLE" });
        return;
      }
      res.json({ decision, imageData: challenge.imageData, parentOrigin: session.parent_origin, ...diagnostic });
      return;
    }
    const puzzle = await renderSliderPuzzle(await sliderBackground());
    const motionMap = createMotionMap(puzzle.target, puzzle.sliderMax);
    const updated = await prisma.widgetSession.updateMany({
      where: { id: session.id, state: "pending", challenge_attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
      data: {
        risk_score: riskScore,
        challenge_type: "slider",
        slider_target: puzzle.target,
        slider_motion_profile: JSON.stringify(motionMap),
      },
    });
    if (updated.count !== 1) {
      res.status(409).json({ error: "CHALLENGE_NOT_AVAILABLE" });
      return;
    }
    res.json({
      decision,
      backgroundImage: puzzle.backgroundImage,
      pieceImage: puzzle.pieceImage,
      sliderMax: puzzle.sliderMax,
      motionMap,
      holeCount: puzzle.holeCount,
      parentOrigin: session.parent_origin,
      ...diagnostic,
    });
  }));

  app.post("/v1/widget/sessions/:id/verify", asyncRoute(async (req, res) => {
    const session = await requireWidgetSession(req, res);
    if (!session) return;
    if (session.state !== "pending" || !session.challenge_type) {
      res.status(409).json({ error: "CHALLENGE_NOT_READY" });
      return;
    }
    const reserved = await prisma.widgetSession.updateMany({
      where: { id: session.id, state: "pending", challenge_attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
      data: { challenge_attempts: { increment: 1 } },
    });
    if (reserved.count !== 1) {
      res.status(429).json({ error: "CHALLENGE_ATTEMPTS_EXHAUSTED" });
      return;
    }
    const input = verifyInput.parse(req.body);
    let valid = false;
    if (session.challenge_type === "text" && session.challenge_answer_digest) {
      valid = safeEqual(challengeDigest(String(input.answer).trim().toUpperCase()), session.challenge_answer_digest);
    } else if (session.challenge_type === "slider" && session.slider_target !== null && input.trajectory) {
      const motionMap = JSON.parse(session.slider_motion_profile || "[]") as number[];
      const visualTrajectory = (input.trajectory as TrajectoryPoint[]).map((point) => ({
        ...point,
        x: mapMotionPosition(point.x, motionMap),
      }));
      valid = Number(input.answer) === Math.round(input.trajectory.at(-1)?.x || -1) &&
        analyzeTrajectory(visualTrajectory, session.slider_target);
    }
    const summary = digest(JSON.stringify({
      type: session.challenge_type,
      points: input.trajectory?.length || 0,
      duration: input.trajectory?.length ? input.trajectory.at(-1)!.t - input.trajectory[0].t : 0,
      valid,
    }));
    if (!valid) {
      await prisma.widgetSession.updateMany({
        where: { id: session.id, state: "pending" },
        data: { challenge_digest: summary },
      });
      await prisma.widgetSession.updateMany({
        where: { id: session.id, state: "pending", challenge_attempts: { gte: MAX_CHALLENGE_ATTEMPTS } },
        data: { state: "failed" },
      });
      res.status(400).json({ success: false, error: "CHALLENGE_REJECTED" });
      return;
    }
    const completionToken = await completeSession(session.id, summary);
    if (!completionToken) {
      res.status(409).json({ error: "SESSION_ALREADY_COMPLETED" });
      return;
    }
    res.json({ success: true, completionToken, parentOrigin: session.parent_origin });
  }));

  app.post("/v1/widget/sessions/:id/accessibility-fallback", asyncRoute(async (req, res) => {
    const session = await requireWidgetSession(req, res);
    if (!session) return;
    if (session.state !== "pending" || session.challenge_attempts >= MAX_CHALLENGE_ATTEMPTS) {
      res.status(409).json({ error: "CHALLENGE_NOT_AVAILABLE" });
      return;
    }
    const challenge = await textChallenge();
    const updated = await prisma.widgetSession.updateMany({
      where: { id: session.id, state: "pending" },
      data: { challenge_type: "text", challenge_answer_digest: challenge.answerDigest, slider_target: null, slider_motion_profile: null },
    });
    if (updated.count !== 1) {
      res.status(409).json({ error: "CHALLENGE_NOT_AVAILABLE" });
      return;
    }
    res.json({ decision: "text", imageData: challenge.imageData, parentOrigin: session.parent_origin });
  }));

  const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  app.get("/admin-api/setup/status", asyncRoute(async (_req, res) => {
    res.json({ initialized: (await prisma.admin.count()) > 0 });
  }));
  app.post("/admin-api/setup", adminLimiter, asyncRoute(async (req, res) => {
    const input = z.object({
      username: z.string().trim().min(3).max(64),
      password: z.string().min(12).max(256).regex(/[a-z]/).regex(/[A-Z]/).regex(/\d/),
    }).parse(req.body);
    if (await prisma.admin.count()) {
      res.status(409).json({ error: "ALREADY_INITIALIZED" });
      return;
    }
    const admin = await prisma.admin.create({
      data: { username: input.username, password_hash: await bcrypt.hash(input.password, 12) },
    });
    res.status(201).json({ token: signAdminToken(admin), admin: { id: admin.id, username: admin.username } });
  }));
  app.post("/admin-api/login", adminLimiter, asyncRoute(async (req, res) => {
    const input = z.object({ username: z.string().trim().min(1), password: z.string().min(1).max(256) }).parse(req.body);
    const admin = await prisma.admin.findUnique({ where: { username: input.username } });
    if (!admin || !(await bcrypt.compare(input.password, admin.password_hash))) {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }
    res.json({ token: signAdminToken(admin), admin: { id: admin.id, username: admin.username } });
  }));

  app.get("/admin-api/sites", requireAdmin, asyncRoute(async (_req, res) => {
    const sites = await prisma.site.findMany({ orderBy: { created_at: "desc" } });
    res.json(sites.map(serializeSite));
  }));
  app.post("/admin-api/sites", requireAdmin, asyncRoute(async (req: AdminRequest, res) => {
    const input = z.object({
      name: z.string().trim().min(1).max(100),
      allowedOrigins: z.array(originSchema).min(1).max(20),
    }).parse(req.body);
    const secret = opaqueToken(48);
    const site = await prisma.site.create({
      data: { name: input.name, allowed_origins: JSON.stringify(input.allowedOrigins), encrypted_secret: encryptSecret(secret) },
    });
    await prisma.securityEvent.create({ data: { action: "site.create", site_id: site.id, metadata: JSON.stringify({ actor: req.admin!.username }) } });
    res.status(201).json({ site: serializeSite(site), secret });
  }));
  app.put("/admin-api/sites/:id", requireAdmin, asyncRoute(async (req: AdminRequest, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(100).optional(), allowedOrigins: z.array(originSchema).min(1).max(20).optional(), active: z.boolean().optional() }).parse(req.body);
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const site = await prisma.site.update({
      where: { id },
      data: { name: input.name, allowed_origins: input.allowedOrigins ? JSON.stringify(input.allowedOrigins) : undefined, active: input.active },
    });
    await prisma.securityEvent.create({
      data: { action: "site.update", site_id: site.id, metadata: JSON.stringify({ actor: req.admin!.username }) },
    });
    res.json(serializeSite(site));
  }));
  app.post("/admin-api/sites/:id/rotate-secret", requireAdmin, asyncRoute(async (req: AdminRequest, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const secret = opaqueToken(48);
    await prisma.site.update({ where: { id }, data: { encrypted_secret: encryptSecret(secret) } });
    await prisma.securityEvent.create({
      data: { action: "site.secret_rotate", site_id: id, metadata: JSON.stringify({ actor: req.admin!.username }) },
    });
    res.json({ secret });
  }));
  app.get("/admin-api/status", requireAdmin, asyncRoute(async (_req, res) => {
    const [sites, sessions, completed, events, redisHealthy] = await Promise.all([
      prisma.site.count(),
      prisma.widgetSession.count({ where: { created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      prisma.widgetSession.count({ where: { completed_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      prisma.securityEvent.findMany({ take: 20, orderBy: { created_at: "desc" } }),
      pingNonceStore().catch(() => false),
    ]);
    res.json({ status: redisHealthy ? "healthy" : "degraded", database: "healthy", redis: redisHealthy ? "healthy" : "unavailable", sites, sessions24h: sessions, completed24h: completed, recentEvents: events });
  }));
  app.get("/admin-api/assets", requireAdmin, asyncRoute(async (_req, res) => {
    res.json(await prisma.challengeAsset.findMany({ orderBy: { created_at: "desc" } }));
  }));
  app.post("/admin-api/assets", requireAdmin, asyncRoute(async (req: AdminRequest, res) => {
    const input = assetCreateInput.parse(req.body);
    const asset = await prisma.challengeAsset.create({ data: input });
    await prisma.securityEvent.create({
      data: { action: "asset.create", metadata: JSON.stringify({ actor: req.admin!.username, assetId: asset.id, kind: asset.kind }) },
    });
    res.status(201).json(asset);
  }));
  app.post("/admin-api/assets/batch", requireAdmin, asyncRoute(async (req: AdminRequest, res) => {
    const input = assetBatchInput.parse(req.body);
    const assets = await prisma.$transaction(async (transaction) => {
      const created = await transaction.challengeAsset.createManyAndReturn({ data: input.assets });
      await transaction.securityEvent.create({
        data: {
          action: "asset.batch_create",
          metadata: JSON.stringify({ actor: req.admin!.username, count: created.length, assetIds: created.map((asset) => asset.id) }),
        },
      });
      return created;
    }, { maxWait: 5_000, timeout: 30_000 });
    res.status(201).json({
      assets: assets.map(({ payload: _payload, ...asset }) => asset),
      count: assets.length,
    });
  }));
  app.put("/admin-api/assets/:id", requireAdmin, asyncRoute(async (req: AdminRequest, res) => {
    const input = assetUpdateInput.parse(req.body);
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const current = await prisma.challengeAsset.findUnique({ where: { id } });
    if (!current) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (input.payload && !validAssetPayload(current.kind, input.payload)) {
      res.status(400).json({ error: "VALIDATION_ERROR" });
      return;
    }
    const asset = await prisma.challengeAsset.update({ where: { id }, data: input });
    await prisma.securityEvent.create({
      data: { action: "asset.update", metadata: JSON.stringify({ actor: req.admin!.username, assetId: asset.id, active: asset.active }) },
    });
    res.json(asset);
  }));

  app.get("/embed/v1/widget", asyncRoute(async (req, res) => {
    const sessionId = typeof req.query.session === "string" ? req.query.session : "";
    const session = sessionId ? await prisma.widgetSession.findUnique({ where: { id: sessionId } }) : null;
    if (!session || session.expires_at <= new Date()) {
      res.status(410).type("text/plain").send("Captcha session expired");
      return;
    }
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; ${frameAncestors(session.parent_origin)}; base-uri 'none'; form-action 'self'`);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(webRoot, "index.html"));
  }));
  app.use(express.static(webRoot, { index: false, maxAge: config.NODE_ENV === "production" ? "1y" : 0 }));
  app.get(/^\/admin(?:\/.*)?$/, (_req, res) => res.sendFile(path.join(webRoot, "index.html")));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: "VALIDATION_ERROR", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
      return;
    }
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "P2025") {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    console.error("Unhandled request error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}
