import crypto from "node:crypto";
import sharp from "sharp";

const WIDTH = 240;
const HEIGHT = 78;
const FONT_FAMILIES = [
  "DejaVu Sans",
  "DejaVu Serif",
  "DejaVu Sans Mono",
];
const INK_COLORS = ["#163a4a", "#4f2635", "#214f45", "#3e355d", "#5a351d"];

function randomInt(minimum: number, maximum: number): number {
  return crypto.randomInt(minimum, maximum + 1);
}

function randomFloat(minimum: number, maximum: number): number {
  return minimum + (crypto.randomInt(0, 1_000_000) / 1_000_000) * (maximum - minimum);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]!);
}

function backgroundTexture(): string {
  const strands = Array.from({ length: 11 }, (_, index) => {
    const startY = randomInt(-8, HEIGHT + 8);
    const controlOneY = randomInt(-14, HEIGHT + 14);
    const controlTwoY = randomInt(-14, HEIGHT + 14);
    const endY = randomInt(-8, HEIGHT + 8);
    const color = index % 2 === 0 ? "#9aafb2" : "#c29b98";
    return `<path d="M -8 ${startY} C ${randomInt(40, 78)} ${controlOneY}, ${randomInt(150, 196)} ${controlTwoY}, ${WIDTH + 8} ${endY}" fill="none" stroke="${color}" stroke-width="${randomFloat(0.45, 1.15).toFixed(2)}" opacity="${randomFloat(0.22, 0.42).toFixed(2)}"/>`;
  }).join("");
  const flecks = Array.from({ length: 95 }, (_, index) => {
    const radiusX = randomFloat(0.25, index % 7 === 0 ? 2.2 : 1.15).toFixed(2);
    const radiusY = randomFloat(0.25, index % 7 === 0 ? 1.6 : 1).toFixed(2);
    return `<ellipse cx="${randomInt(1, WIDTH - 1)}" cy="${randomInt(1, HEIGHT - 1)}" rx="${radiusX}" ry="${radiusY}" fill="${index % 3 === 0 ? "#7d5360" : "#527079"}" opacity="${randomFloat(0.14, 0.38).toFixed(2)}"/>`;
  }).join("");
  return `${strands}${flecks}`;
}

function characterMarkup(answer: string): string {
  const characters = answer.toUpperCase().slice(0, 6).split("");
  const baseStep = 34;
  return characters.map((character, index) => {
    const x = 17 + index * baseStep + randomInt(-3, 3);
    const baseline = randomInt(54, 66);
    const angle = randomFloat(-18, 18).toFixed(2);
    const skew = randomFloat(-16, 16).toFixed(2);
    const scaleX = randomFloat(0.82, 1.08).toFixed(3);
    const scaleY = randomFloat(0.88, 1.16).toFixed(3);
    const fontSize = randomInt(45, 53);
    const font = FONT_FAMILIES[randomInt(0, FONT_FAMILIES.length - 1)];
    const color = INK_COLORS[randomInt(0, INK_COLORS.length - 1)];
    const filterId = `glyph-warp-${index}`;
    return `<g transform="translate(${x} ${baseline}) rotate(${angle}) skewX(${skew}) scale(${scaleX} ${scaleY})" filter="url(#${filterId})">
      <text x="0" y="0" font-family="${font}" font-size="${fontSize}" font-weight="700" letter-spacing="0" fill="${color}" stroke="${color}" stroke-width="0.7" paint-order="stroke fill">${escapeXml(character)}</text>
    </g>`;
  }).join("");
}

function glyphFilters(): string {
  return Array.from({ length: 6 }, (_, index) => (
    `<filter id="glyph-warp-${index}" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="${randomFloat(0.012, 0.026).toFixed(4)} ${randomFloat(0.055, 0.095).toFixed(4)}" numOctaves="2" seed="${randomInt(1, 9999)}" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="${randomFloat(3.8, 7.2).toFixed(2)}" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`
  )).join("");
}

function foregroundInterference(): string {
  const curves = Array.from({ length: 4 }, (_, index) => {
    const startY = randomInt(14, HEIGHT - 12);
    const endY = randomInt(14, HEIGHT - 12);
    const color = INK_COLORS[randomInt(0, INK_COLORS.length - 1)];
    return `<path d="M -5 ${startY} C ${randomInt(42, 86)} ${randomInt(-8, HEIGHT + 8)}, ${randomInt(148, 205)} ${randomInt(-8, HEIGHT + 8)}, ${WIDTH + 5} ${endY}" fill="none" stroke="${color}" stroke-width="${randomFloat(index < 2 ? 1.5 : 0.8, index < 2 ? 2.7 : 1.65).toFixed(2)}" opacity="${randomFloat(0.58, 0.86).toFixed(2)}" stroke-linecap="round"/>`;
  }).join("");
  const fragments = Array.from({ length: 18 }, (_, index) => {
    const x = randomInt(4, WIDTH - 8);
    const y = randomInt(7, HEIGHT - 7);
    const radius = randomInt(3, 10);
    const color = INK_COLORS[index % INK_COLORS.length];
    return `<path d="M ${x - radius} ${y} A ${radius} ${randomInt(2, 7)} ${randomInt(-35, 35)} 0 1 ${x + radius} ${y + randomInt(-3, 3)}" fill="none" stroke="${color}" stroke-width="${randomFloat(0.65, 1.5).toFixed(2)}" opacity="${randomFloat(0.3, 0.62).toFixed(2)}"/>`;
  }).join("");
  return `${curves}${fragments}`;
}

function captchaSvg(answer: string): Buffer {
  const background = randomInt(0, 1) === 0 ? "#e7eeee" : "#eee9e5";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH * 2}" height="${HEIGHT * 2}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>${glyphFilters()}</defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
    ${backgroundTexture()}
    ${characterMarkup(answer)}
    ${foregroundInterference()}
  </svg>`);
}

export async function renderCaptchaPng(answer: string): Promise<Buffer> {
  return sharp(captchaSvg(answer), { density: 192 })
    .resize(WIDTH, HEIGHT, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .modulate({ brightness: randomFloat(0.97, 1.03), saturation: randomFloat(0.9, 1.16) })
    .sharpen({ sigma: 0.55, m1: 0.7, m2: 1.2 })
    .png({ compressionLevel: 8, palette: false })
    .toBuffer();
}
