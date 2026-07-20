import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { renderCaptchaPng } from "./captcha-image.js";

describe("text captcha renderer", () => {
  it("renders a warped, noisy PNG without embedding the plain answer", async () => {
    const image = await renderCaptchaPng("A2B3C4");
    const decoded = PNG.sync.read(image);
    expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(decoded).toMatchObject({ width: 240, height: 78 });
    expect(image.length).toBeGreaterThan(10_000);
    expect(image.includes(Buffer.from("A2B3C4"))).toBe(false);
  });

  it("randomizes the complete distortion field for every rendering", async () => {
    const [first, second] = await Promise.all([
      renderCaptchaPng("A2B3C4"),
      renderCaptchaPng("A2B3C4"),
    ]);
    expect(first.equals(second)).toBe(false);
  });
});
