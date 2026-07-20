import crypto from "node:crypto";

const TEXT_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const TEXT_DIGITS = "23456789";
const TEXT_ALPHABET = `${TEXT_LETTERS}${TEXT_DIGITS}`;

export interface EnvironmentSignals {
  wasmAvailable: boolean;
  webdriver: boolean;
  plugins: number;
  languages: number;
  hardwareConcurrency: number;
  touchPoints: number;
  visibilityChanges: number;
  elapsedMs: number;
  fingerprintCapabilities?: number;
}

export interface ScoreDeduction {
  factor: "wasm_unavailable" | "webdriver" | "plugins_empty" | "languages_empty" |
    "hardware_concurrency_missing" | "touch_points_invalid" | "visibility_changes_high" | "elapsed_too_fast" |
    "audio_fingerprint_unavailable" | "webgl_fingerprint_unavailable" | "canvas_fingerprint_unavailable" |
    "wasm_report_invalid" | "wasm_score_mismatch" | "integrity_challenge_failed" |
    "fingerprint_account_churn" | "fingerprint_failure_history";
  points: number;
}

export interface EnvironmentScore {
  score: number;
  deductions: ScoreDeduction[];
}

export interface TrajectoryPoint { x: number; y: number; t: number }

export function scoreEnvironmentDetails(signals: EnvironmentSignals): EnvironmentScore {
  const deductions: ScoreDeduction[] = [];
  const deduct = (triggered: boolean, factor: ScoreDeduction["factor"], points: number) => {
    if (triggered) deductions.push({ factor, points });
  };
  deduct(!signals.wasmAvailable, "wasm_unavailable", 25);
  deduct(signals.webdriver, "webdriver", 55);
  deduct(signals.plugins === 0, "plugins_empty", 8);
  deduct(signals.languages === 0, "languages_empty", 12);
  deduct(signals.hardwareConcurrency <= 0, "hardware_concurrency_missing", 8);
  deduct(signals.touchPoints < 0, "touch_points_invalid", 5);
  deduct(signals.visibilityChanges > 5, "visibility_changes_high", 8);
  deduct(signals.elapsedMs < 150, "elapsed_too_fast", 20);
  if (signals.fingerprintCapabilities !== undefined) {
    deduct((signals.fingerprintCapabilities & 1) === 0, "audio_fingerprint_unavailable", 10);
    deduct((signals.fingerprintCapabilities & 2) === 0, "webgl_fingerprint_unavailable", 12);
    deduct((signals.fingerprintCapabilities & 4) === 0, "canvas_fingerprint_unavailable", 5);
  }
  const total = deductions.reduce((sum, item) => sum + item.points, 0);
  return { score: Math.max(0, Math.min(100, 100 - total)), deductions };
}

export function scoreEnvironment(signals: EnvironmentSignals): number {
  return scoreEnvironmentDetails(signals).score;
}

export type ChallengeDecision = "pass" | "text" | "slider";

export function selectChallenge(level: string, score: number, credentialFailure: boolean): ChallengeDecision {
  if (credentialFailure) return "text";
  if (level === "low") return score >= 60 ? "pass" : "text";
  if (level === "medium") return score >= 70 ? "pass" : "text";
  return score >= 80 ? "text" : "slider";
}

export function analyzeTrajectory(points: TrajectoryPoint[], target: number): boolean {
  if (points.length < 8 || points.length > 500) return false;
  const first = points[0];
  const last = points[points.length - 1];
  const duration = last.t - first.t;
  if (duration < 400 || duration > 10_000 || Math.abs(last.x - target) > 6) return false;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].t <= points[index - 1].t || points[index].x < points[index - 1].x - 4) return false;
  }
  const velocities = points.slice(1).map((point, index) => {
    const previous = points[index];
    return (point.x - previous.x) / (point.t - previous.t);
  });
  const average = velocities.reduce((sum, value) => sum + value, 0) / velocities.length;
  const variance = velocities.reduce((sum, value) => sum + (value - average) ** 2, 0) / velocities.length;
  const yValues = points.map((point) => point.y);
  const ySpread = Math.max(...yValues) - Math.min(...yValues);
  return variance > 0.00001 && ySpread >= 1;
}

export function isTextChallenge(value: string): boolean {
  return /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6}$/.test(value);
}

export function randomTextAnswer(candidates: string[] = []): string {
  const validCandidates = candidates.map((value) => value.trim().toUpperCase()).filter(isTextChallenge);
  if (validCandidates.length) return validCandidates[crypto.randomInt(0, validCandidates.length)];
  const characters = [
    TEXT_LETTERS[crypto.randomInt(0, TEXT_LETTERS.length)],
    TEXT_DIGITS[crypto.randomInt(0, TEXT_DIGITS.length)],
    ...Array.from({ length: 4 }, () => TEXT_ALPHABET[crypto.randomInt(0, TEXT_ALPHABET.length)]),
  ];
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(0, index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join("");
}

export function randomSliderTarget(): number {
  return crypto.randomInt(55, 106);
}
