import { describe, expect, it } from "vitest";
import { createMotionMap, mapMotionPosition } from "./motion-profile.js";

describe("slider motion profiles", () => {
  it("creates a monotonic per-session speed curve that materially shifts the target", () => {
    const first = createMotionMap(82, 132);
    const second = createMotionMap(82, 132);
    expect(first).toHaveLength(133);
    expect(first[0]).toBe(0);
    expect(first.at(-1)).toBe(132);
    expect(first.every((value, index) => index === 0 || value > first[index - 1])).toBe(true);
    expect(Math.abs(mapMotionPosition(82, first) - 82)).toBeGreaterThanOrEqual(7);
    expect(first).not.toEqual(second);
  });
});
