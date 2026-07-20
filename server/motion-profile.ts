import crypto from "node:crypto";

function randomFloat(minimum: number, maximum: number): number {
  return minimum + (crypto.randomInt(0, 1_000_000) / 1_000_000) * (maximum - minimum);
}

export function mapMotionPosition(position: number, motionMap: number[]): number {
  if (motionMap.length < 2) return position;
  const clamped = Math.max(0, Math.min(motionMap.length - 1, position));
  const lower = Math.floor(clamped);
  const upper = Math.min(motionMap.length - 1, lower + 1);
  const fraction = clamped - lower;
  return motionMap[lower] + (motionMap[upper] - motionMap[lower]) * fraction;
}

export function createMotionMap(target: number, sliderMax: number): number[] {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const primaryPhase = randomFloat(0, Math.PI * 2);
    const secondaryPhase = randomFloat(0, Math.PI * 2);
    const primaryCycles = crypto.randomInt(1, 3);
    const rates = Array.from({ length: sliderMax }, (_, index) => {
      const progress = (index + 0.5) / sliderMax;
      return 1 +
        0.42 * Math.sin(progress * Math.PI * 2 * primaryCycles + primaryPhase) +
        0.16 * Math.sin(progress * Math.PI * 4 + secondaryPhase);
    });
    const total = rates.reduce((sum, rate) => sum + rate, 0);
    let cumulative = 0;
    const motionMap = [0];
    for (const rate of rates) {
      cumulative += rate;
      motionMap.push(Number(((cumulative / total) * sliderMax).toFixed(3)));
    }
    if (Math.abs(mapMotionPosition(target, motionMap) - target) >= 7) return motionMap;
  }
  throw new Error("Unable to create a sufficiently perturbed motion profile");
}
