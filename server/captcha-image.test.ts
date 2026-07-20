import { describe, expect, it } from "vitest";
import { renderCaptchaPng } from "./captcha-image.js";

describe("text captcha renderer", () => {
  it("renders a non-empty PNG without embedding the plain answer", () => {
    const image = renderCaptchaPng("A2B3C4");
    expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image.length).toBeGreaterThan(1000);
    expect(image.includes(Buffer.from("A2B3C4"))).toBe(false);
  });
});
