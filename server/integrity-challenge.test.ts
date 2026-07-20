import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createIntegrityChallenge,
  expectedIntegrityResponse,
  validateIntegrityEvidence,
} from "./integrity-challenge.js";

type WasmExports = {
  memory: WebAssembly.Memory;
  inputPointer(): number;
  outputPointer(): number;
  fingerprint(length: number): void;
  executeChallenge(...values: number[]): number;
  riskScore(...values: number[]): number;
};

async function riskEngine(): Promise<WasmExports> {
  const binary = fs.readFileSync(new URL("../web/src/widget/risk-engine.wasm", import.meta.url));
  const result = await WebAssembly.instantiate(binary, { env: { abort: () => { throw new Error("WASM_ABORT"); } } });
  return result.instance.exports as unknown as WasmExports;
}

describe("WASM browser risk engine", () => {
  it("generates programs that cover every operation and operand source", () => {
    const challenge = createIntegrityChallenge();
    const program = Buffer.from(challenge.program, "base64url");
    expect(new Set(program.subarray(0, 8).map((instruction) => instruction >>> 5))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(new Set(program.subarray(0, 8).map((instruction) => instruction & 7))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
  });

  it("implements SHA-256 inside WASM and calculates the risk score", async () => {
    const engine = await riskEngine();
    const input = Buffer.from("browser-fingerprint-fixture");
    new Uint8Array(engine.memory.buffer, engine.inputPointer(), input.length).set(input);
    engine.fingerprint(input.length);
    const digest = Buffer.from(new Uint8Array(engine.memory.buffer, engine.outputPointer(), 32)).toString("hex");
    expect(digest).toBe(crypto.createHash("sha256").update(input).digest("hex"));
    expect(engine.riskScore(1, 0, 3, 2, 8, 0, 0, 500, 7)).toBe(100);
    expect(engine.riskScore(1, 1, 0, 0, 0, 0, 0, 500, 0)).toBe(0);
  });

  it("matches the server interpreter for dynamic challenge bytecode", async () => {
    const engine = await riskEngine();
    const challenge = createIntegrityChallenge();
    const fingerprint = crypto.createHash("sha256").update("machine-a").digest("hex");
    const frameDeltas = Array.from({ length: challenge.sampleCount }, (_, index) => 162 + (index % 7));
    const evidence = {
      challengeId: challenge.id,
      response: "",
      frameDeltas,
      trustedActivation: true,
      focusState: true,
    };
    new Uint8Array(engine.memory.buffer, engine.outputPointer(), 32).set(Buffer.from(fingerprint, "hex"));
    const program = Buffer.from(challenge.program, "base64url");
    const challengeBuffer = new Uint8Array(program.length + frameDeltas.length * 2);
    challengeBuffer.set(program);
    const view = new DataView(challengeBuffer.buffer);
    frameDeltas.forEach((delta, index) => view.setUint16(program.length + index * 2, delta, true));
    new Uint8Array(engine.memory.buffer, engine.inputPointer(), challengeBuffer.length).set(challengeBuffer);
    evidence.response = [0, 1].map((lane) => (
      engine.executeChallenge(program.length, frameDeltas.length, challenge.seed, 1, 0, 1, lane) >>> 0
    ).toString(16).padStart(8, "0")).join("");
    expect(evidence.response).toBe(expectedIntegrityResponse(challenge, fingerprint, evidence, 0));
    expect(validateIntegrityEvidence(challenge, fingerprint, evidence, 0)).toBe(true);
    expect(validateIntegrityEvidence(challenge, fingerprint, { ...evidence, response: "0".repeat(16) }, 0)).toBe(false);
  });
});
