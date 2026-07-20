import { describe, expect, it } from "vitest";
import { analyzeTrajectory, isTextChallenge, randomTextAnswer, scoreEnvironment, scoreEnvironmentDetails, selectChallenge } from "./engine.js";

describe("captcha risk policy", () => {
  it("uses the documented low, medium and high thresholds", () => {
    expect(selectChallenge("low", 60, false)).toBe("pass");
    expect(selectChallenge("low", 59, false)).toBe("text");
    expect(selectChallenge("medium", 70, false)).toBe("pass");
    expect(selectChallenge("medium", 69, false)).toBe("text");
    expect(selectChallenge("high", 80, false)).toBe("text");
    expect(selectChallenge("high", 79, false)).toBe("slider");
  });

  it("forces text after a credential failure", () => {
    expect(selectChallenge("low", 100, true)).toBe("text");
    expect(selectChallenge("high", 10, true)).toBe("text");
  });

  it("penalizes automation and a missing WASM environment", () => {
    const signals = {
      wasmAvailable: false,
      webdriver: true,
      plugins: 0,
      languages: 0,
      hardwareConcurrency: 0,
      touchPoints: 0,
      visibilityChanges: 10,
      elapsedMs: 20,
    };
    const score = scoreEnvironment(signals);
    expect(score).toBeLessThan(20);
    expect(scoreEnvironmentDetails(signals)).toMatchObject({
      score,
      deductions: expect.arrayContaining([
        { factor: "webdriver", points: 55 },
        { factor: "wasm_unavailable", points: 25 },
      ]),
    });
  });
});

describe("slider trajectory analysis", () => {
  it("accepts a varied human-like trajectory ending at the target", () => {
    const points = [
      [0, 10, 0], [5, 11, 90], [16, 9, 190], [37, 12, 300], [61, 10, 410],
      [88, 13, 530], [112, 11, 640], [132, 14, 750], [145, 12, 850], [150, 13, 940],
    ].map(([x, y, t]) => ({ x, y, t }));
    expect(analyzeTrajectory(points, 150)).toBe(true);
  });

  it("rejects instant and perfectly synthetic movement", () => {
    const points = Array.from({ length: 10 }, (_, index) => ({ x: index * 10, y: 10, t: index * 10 }));
    expect(analyzeTrajectory(points, 90)).toBe(false);
  });
});

describe("text challenge generation", () => {
  it("generates six-character challenges containing letters and digits", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(isTextChallenge(randomTextAnswer())).toBe(true);
    }
  });

  it("uses only valid mixed candidates from an active wordlist", () => {
    expect(randomTextAnswer(["123456", "ABCDEF", "A2B3C4"])).toBe("A2B3C4");
  });
});
