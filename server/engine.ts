import crypto from "node:crypto";

export interface EnvironmentSignals {
  wasmAvailable: boolean;
  webdriver: boolean;
  plugins: number;
  languages: number;
  hardwareConcurrency: number;
  touchPoints: number;
  visibilityChanges: number;
  elapsedMs: number;
}

export interface TrajectoryPoint { x: number; y: number; t: number }

export function scoreEnvironment(signals: EnvironmentSignals): number {
  let score = 100;
  if (!signals.wasmAvailable) score -= 25;
  if (signals.webdriver) score -= 55;
  if (signals.plugins === 0) score -= 8;
  if (signals.languages === 0) score -= 12;
  if (signals.hardwareConcurrency <= 0) score -= 8;
  if (signals.touchPoints < 0) score -= 5;
  if (signals.visibilityChanges > 5) score -= 8;
  if (signals.elapsedMs < 150) score -= 20;
  return Math.max(0, Math.min(100, score));
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

export function randomTextAnswer(): string {
  return Array.from({ length: 6 }, () => crypto.randomInt(0, 10).toString()).join("");
}

export function randomSliderTarget(): number {
  return crypto.randomInt(90, 235);
}
