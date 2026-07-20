import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderSliderPuzzle } from "./puzzle-image.js";

async function sampleBackground(): Promise<string> {
  const buffer = await sharp({
    create: { width: 900, height: 500, channels: 3, background: { r: 72, g: 118, b: 136 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function payload(value: string): Buffer {
  return Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
}

describe("slider puzzle rendering", () => {
  it("creates one movable piece, several randomized holes, and a watermarked background", async () => {
    const source = await sampleBackground();
    const first = await renderSliderPuzzle(source);
    const second = await renderSliderPuzzle(source);

    expect(first.holeCount).toBeGreaterThanOrEqual(3);
    expect(first.holeCount).toBeLessThanOrEqual(4);
    expect(first.target).toBeGreaterThanOrEqual(55);
    expect(first.target).toBeLessThanOrEqual(120);
    expect(first.sliderMax).toBeGreaterThan(first.target);
    expect(first.backgroundImage).toMatch(/^data:image\/webp;base64,/);
    expect(first.pieceImage).toMatch(/^data:image\/png;base64,/);
    expect(await sharp(payload(first.backgroundImage)).metadata()).toMatchObject({ width: 640, height: 320, format: "webp" });
    expect(await sharp(payload(first.pieceImage)).metadata()).toMatchObject({ width: 640, height: 320, format: "png" });
    expect(first.backgroundImage).not.toBe(second.backgroundImage);
  });
});
