import crypto from "node:crypto";

export type IntegrityChallenge = {
  id: string;
  seed: number;
  program: string;
  sampleCount: number;
  minimumDurationMs: number;
};

export type IntegrityEvidence = {
  challengeId: string;
  response: string;
  frameDeltas: number[];
  trustedActivation: boolean;
  focusState: boolean;
};

const PROGRAM_LENGTH = 32;

function rotateRight(value: number, amount: number): number {
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

function digestWord(bytes: Buffer, index: number): number {
  return bytes.readUInt32BE((index & 7) * 4) >>> 0;
}

function operand(
  fingerprintBytes: Buffer,
  selector: number,
  index: number,
  instruction: number,
  seed: number,
  frameTotal: number,
  frameSquares: number,
  frameRange: number,
  sampleCount: number,
  trustedActivation: boolean,
  visibilityChanges: number,
  focusState: boolean,
): number {
  switch (selector & 7) {
    case 0: return seed >>> 0;
    case 1: return digestWord(fingerprintBytes, index);
    case 2: return frameTotal >>> 0;
    case 3: return frameSquares >>> 0;
    case 4: return frameRange >>> 0;
    case 5: return (((sampleCount & 0xffff) << 16) | Number(trustedActivation)) >>> 0;
    case 6: return (((visibilityChanges & 0xffff) << 16) | Number(focusState)) >>> 0;
    default: return (((instruction & 0xff) << 24) | (index & 0xffffff)) >>> 0;
  }
}

export function createIntegrityChallenge(): IntegrityChallenge {
  const sampleCount = crypto.randomInt(12, 21);
  const program = crypto.randomBytes(PROGRAM_LENGTH);
  for (let operation = 0; operation < 8; operation += 1) {
    program[operation] = (operation << 5) | (program[operation] & 0x18) | operation;
  }
  return {
    id: crypto.randomBytes(16).toString("base64url"),
    seed: crypto.randomBytes(4).readUInt32LE(0),
    program: program.toString("base64url"),
    sampleCount,
    minimumDurationMs: sampleCount * 6,
  };
}

export function executeIntegrityProgram(
  challenge: IntegrityChallenge,
  fingerprint: string,
  evidence: Pick<IntegrityEvidence, "frameDeltas" | "trustedActivation" | "focusState">,
  visibilityChanges: number,
  lane: number,
): number {
  const program = Buffer.from(challenge.program, "base64url");
  const fingerprintBytes = Buffer.from(fingerprint, "hex");
  if (program.length < 8 || program.length > 128 || fingerprintBytes.length !== 32) return 0;
  if (evidence.frameDeltas.length < 1 || evidence.frameDeltas.length > 64) return 0;
  let frameTotal = 0;
  let frameSquares = 0;
  let minimum = 0xffffffff;
  let maximum = 0;
  for (const deltaValue of evidence.frameDeltas) {
    const delta = deltaValue & 0xffff;
    frameTotal = (frameTotal + delta) >>> 0;
    frameSquares = (frameSquares + Math.imul(delta, delta)) >>> 0;
    if (delta < minimum) minimum = delta;
    if (delta > maximum) maximum = delta;
  }
  const frameRange = (((minimum & 0xffff) << 16) | (maximum & 0xffff)) >>> 0;
  let state = (challenge.seed ^ digestWord(fingerprintBytes, lane) ^ digestWord(fingerprintBytes, lane + 3) ^ Math.imul(lane, 0x9e3779b9)) >>> 0;
  for (let index = 0; index < program.length; index += 1) {
    const instruction = program[index];
    const operation = instruction >>> 5;
    const selected = operand(
      fingerprintBytes,
      instruction,
      index + lane,
      instruction,
      challenge.seed,
      frameTotal,
      frameSquares,
      frameRange,
      evidence.frameDeltas.length,
      evidence.trustedActivation,
      visibilityChanges,
      evidence.focusState,
    );
    const mixedOperand = (selected ^ digestWord(fingerprintBytes, index + lane)) >>> 0;
    const rotation = (instruction & 15) + 1;
    switch (operation) {
      case 0: state = (state + mixedOperand + index) >>> 0; break;
      case 1: state = (state ^ rotateRight(mixedOperand, rotation)) >>> 0; break;
      case 2: state = Math.imul(state, ((mixedOperand | 1) ^ 0x85ebca6b) >>> 0) >>> 0; break;
      case 3: state = (rotateRight(state, rotation) + mixedOperand) >>> 0; break;
      case 4: state = (state ^ (state << 13)) >>> 0; state = (state ^ (state >>> 17)) >>> 0; state = (state ^ mixedOperand) >>> 0; break;
      case 5: state = (state + Math.imul((mixedOperand ^ index) >>> 0, 0x9e3779b1)) >>> 0; break;
      case 6: state = rotateRight((state ^ mixedOperand) >>> 0, rotation); break;
      default: state = Math.imul((state + mixedOperand) >>> 0, 0xc2b2ae35) >>> 0; break;
    }
  }
  state = (state ^ (state >>> 16)) >>> 0;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state = (state ^ (state >>> 15)) >>> 0;
  state = Math.imul(state, 0x846ca68b) >>> 0;
  return (state ^ (state >>> 16)) >>> 0;
}

export function expectedIntegrityResponse(
  challenge: IntegrityChallenge,
  fingerprint: string,
  evidence: Pick<IntegrityEvidence, "frameDeltas" | "trustedActivation" | "focusState">,
  visibilityChanges: number,
): string {
  return [0, 1]
    .map((lane) => executeIntegrityProgram(challenge, fingerprint, evidence, visibilityChanges, lane).toString(16).padStart(8, "0"))
    .join("");
}

export function validateIntegrityEvidence(
  challenge: IntegrityChallenge,
  fingerprint: string,
  evidence: IntegrityEvidence,
  visibilityChanges: number,
): boolean {
  if (evidence.challengeId !== challenge.id || evidence.frameDeltas.length !== challenge.sampleCount) return false;
  if (!evidence.trustedActivation || !evidence.focusState) return false;
  if (evidence.frameDeltas.some((delta) => !Number.isInteger(delta) || delta < 1 || delta > 20_000)) return false;
  const durationMs = evidence.frameDeltas.reduce((sum, delta) => sum + delta, 0) / 10;
  if (durationMs < challenge.minimumDurationMs || durationMs > 10_000) return false;
  const expected = Buffer.from(expectedIntegrityResponse(challenge, fingerprint, evidence, visibilityChanges), "hex");
  const received = Buffer.from(evidence.response, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
