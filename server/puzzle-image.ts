import crypto from "node:crypto";
import sharp from "sharp";
import { randomSliderTarget } from "./engine.js";

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 320;
const LOGICAL_WIDTH = 320;
const SLIDER_MAX = 132;

type ShapeName = "circle" | "diamond" | "hexagon" | "cross";
type Hole = { x: number; y: number; size: number; shape: ShapeName };

export type SliderPuzzle = {
  backgroundImage: string;
  pieceImage: string;
  target: number;
  sliderMax: number;
  holeCount: number;
};

function randomInt(minimum: number, maximum: number): number {
  return crypto.randomInt(minimum, maximum + 1);
}

function shuffle<T>(values: T[]): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(0, index + 1);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

function shapeElement(shape: ShapeName, size: number, attributes: string): string {
  const middle = size / 2;
  const margin = Math.max(3, Math.round(size * 0.07));
  if (shape === "circle") {
    return `<circle cx="${middle}" cy="${middle}" r="${middle - margin}" ${attributes}/>`;
  }
  if (shape === "diamond") {
    return `<path d="M ${middle} ${margin} L ${size - margin} ${middle} L ${middle} ${size - margin} L ${margin} ${middle} Z" ${attributes}/>`;
  }
  if (shape === "hexagon") {
    const inset = Math.round(size * 0.24);
    return `<path d="M ${inset} ${margin} H ${size - inset} L ${size - margin} ${middle} L ${size - inset} ${size - margin} H ${inset} L ${margin} ${middle} Z" ${attributes}/>`;
  }
  const third = size / 3;
  return `<path d="M ${third} ${margin} H ${2 * third} V ${third} H ${size - margin} V ${2 * third} H ${2 * third} V ${size - margin} H ${third} V ${2 * third} H ${margin} V ${third} H ${third} Z" ${attributes}/>`;
}

function holesOverlay(holes: Hole[]): Buffer {
  const elements = holes.map((hole) => (
    `<g transform="translate(${hole.x} ${hole.y})">${shapeElement(hole.shape, hole.size, "fill=\"#102129\" fill-opacity=\"0.66\" stroke=\"#ffffff\" stroke-opacity=\"0.72\" stroke-width=\"3\"")}</g>`
  )).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}">${elements}</svg>`);
}

function pieceMask(hole: Hole): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${hole.size}" height="${hole.size}">${shapeElement(hole.shape, hole.size, "fill=\"#ffffff\"")}</svg>`);
}

function pieceOutline(hole: Hole): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${hole.size}" height="${hole.size}">${shapeElement(hole.shape, hole.size, "fill=\"none\" stroke=\"#ffffff\" stroke-opacity=\"0.92\" stroke-width=\"3\"")}</svg>`);
}

function watermark(): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}">
    <rect x="466" y="273" width="154" height="32" rx="3" fill="#081116" fill-opacity="0.46"/>
    <text x="605" y="296" text-anchor="end" font-family="Arial, sans-serif" font-size="21" font-weight="700" fill="#ffffff" fill-opacity="0.92">NX-Captcha</text>
  </svg>`);
}

function defaultBackground(): Buffer {
  const lines = Array.from({ length: 13 }, (_, index) => `<path d="M 0 ${index * 28} L ${CANVAS_WIDTH} ${Math.max(0, index * 28 - 76)}" stroke="#82a5aa" stroke-opacity="0.3" stroke-width="2"/>`).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}">
    <rect width="640" height="320" fill="#b8c8c8"/>
    <path d="M0 245 C145 176 248 265 384 171 C486 101 556 127 640 80 V320 H0Z" fill="#567d82"/>
    <path d="M0 282 C134 220 264 302 398 218 C497 157 570 166 640 130" fill="none" stroke="#dbe4df" stroke-width="22" stroke-opacity="0.75"/>
    ${lines}
  </svg>`);
}

function decodeDataUrl(value?: string): Buffer | null {
  if (!value) return null;
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  return match ? Buffer.from(match[1], "base64") : null;
}

async function normalizedBackground(value?: string): Promise<Buffer> {
  const supplied = decodeDataUrl(value);
  try {
    return await sharp(supplied || defaultBackground())
      .rotate()
      .resize(CANVAS_WIDTH, CANVAS_HEIGHT, { fit: "cover", position: "centre" })
      .composite([{ input: watermark() }])
      .png()
      .toBuffer();
  } catch {
    return sharp(defaultBackground())
      .resize(CANVAS_WIDTH, CANVAS_HEIGHT, { fit: "cover" })
      .composite([{ input: watermark() }])
      .png()
      .toBuffer();
  }
}

function overlaps(left: Hole, right: Hole): boolean {
  const padding = 15;
  return left.x < right.x + right.size + padding && left.x + left.size + padding > right.x &&
    left.y < right.y + right.size + padding && left.y + left.size + padding > right.y;
}

function randomHole(shape: ShapeName, occupied: Hole[], minimumX = 22): Hole {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const size = randomInt(62, 78);
    const candidate = {
      x: randomInt(minimumX, CANVAS_WIDTH - size - 22),
      y: randomInt(24, CANVAS_HEIGHT - size - 38),
      size,
      shape,
    };
    if (!occupied.some((hole) => overlaps(hole, candidate))) return candidate;
  }
  throw new Error("Unable to place puzzle holes");
}

export async function renderSliderPuzzle(backgroundDataUrl?: string): Promise<SliderPuzzle> {
  const base = await normalizedBackground(backgroundDataUrl);
  const target = randomSliderTarget();
  const offset = target * (CANVAS_WIDTH / LOGICAL_WIDTH);
  const shapes = shuffle<ShapeName>(["circle", "diamond", "hexagon", "cross"]);
  const holeCount = randomInt(3, 4);
  const realHole = randomHole(shapes[0], [], Math.ceil(offset) + 24);
  const initialPiece: Hole = { ...realHole, x: Math.round(realHole.x - offset) };
  const holes: Hole[] = [realHole];
  for (let index = 1; index < holeCount; index += 1) {
    holes.push(randomHole(shapes[index], [...holes, initialPiece]));
  }

  const extracted = await sharp(base)
    .extract({ left: realHole.x, top: realHole.y, width: realHole.size, height: realHole.size })
    .composite([
      { input: pieceMask(realHole), blend: "dest-in" },
      { input: pieceOutline(realHole), blend: "over" },
    ])
    .png()
    .toBuffer();
  const [background, piece] = await Promise.all([
    sharp(base).composite([{ input: holesOverlay(holes) }]).webp({ quality: 82, effort: 4 }).toBuffer(),
    sharp({ create: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: extracted, left: initialPiece.x, top: initialPiece.y }])
      .png({ compressionLevel: 7 }).toBuffer(),
  ]);

  return {
    backgroundImage: `data:image/webp;base64,${background.toString("base64")}`,
    pieceImage: `data:image/png;base64,${piece.toString("base64")}`,
    target,
    sliderMax: SLIDER_MAX,
    holeCount,
  };
}
