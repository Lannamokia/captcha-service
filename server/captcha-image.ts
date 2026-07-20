import { PNG } from "pngjs";

const FONT: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "010", "010", "111"],
  "2": ["111", "001", "001", "111", "100", "100", "111"],
  "3": ["111", "001", "001", "111", "001", "001", "111"],
  "4": ["101", "101", "101", "111", "001", "001", "001"],
  "5": ["111", "100", "100", "111", "001", "001", "111"],
  "6": ["111", "100", "100", "111", "101", "101", "111"],
  "7": ["111", "001", "001", "010", "010", "100", "100"],
  "8": ["111", "101", "101", "111", "101", "101", "111"],
  "9": ["111", "101", "101", "111", "001", "001", "111"],
};

function setPixel(png: PNG, x: number, y: number, rgb: [number, number, number], alpha = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const offset = (y * png.width + x) * 4;
  png.data[offset] = rgb[0];
  png.data[offset + 1] = rgb[1];
  png.data[offset + 2] = rgb[2];
  png.data[offset + 3] = alpha;
}

export function renderCaptchaPng(answer: string): Buffer {
  const png = new PNG({ width: 220, height: 72 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const shade = 242 + Math.floor(Math.random() * 13);
      setPixel(png, x, y, [shade, shade, Math.min(255, shade + 4)]);
    }
  }
  for (let index = 0; index < 550; index += 1) {
    setPixel(png, Math.floor(Math.random() * png.width), Math.floor(Math.random() * png.height), [90, 110, 130], 110);
  }
  answer.split("").forEach((character, index) => {
    const glyph = FONT[character];
    const scale = 6;
    const startX = 12 + index * 34 + Math.floor(Math.random() * 5);
    const startY = 12 + Math.floor(Math.random() * 7);
    const color: [number, number, number] = [25 + index * 13, 55, 78 + index * 8];
    glyph.forEach((row, rowIndex) => row.split("").forEach((cell, columnIndex) => {
      if (cell !== "1") return;
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
        setPixel(png, startX + columnIndex * scale + dx, startY + rowIndex * scale + dy, color);
      }
    }));
  });
  for (let line = 0; line < 5; line += 1) {
    const yBase = Math.floor(Math.random() * png.height);
    for (let x = 0; x < png.width; x += 1) {
      const y = yBase + Math.round(Math.sin(x / 12 + line) * 7);
      setPixel(png, x, y, [80, 100, 120], 130);
    }
  }
  return PNG.sync.write(png);
}
