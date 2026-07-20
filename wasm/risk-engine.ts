const ENGINE_VERSION: i32 = 2;
const INPUT_CAPACITY: i32 = 32 * 1024;
const INPUT = new StaticArray<u8>(INPUT_CAPACITY);
const OUTPUT = new StaticArray<u8>(32);
const WORDS = new StaticArray<u32>(64);

const ROUND_CONSTANTS: u32[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

@inline
function rotateRight(value: u32, amount: i32): u32 {
  return (value >>> amount) | (value << (32 - amount));
}

@inline
function paddedByte(index: i32, length: i32, paddedLength: i32): u8 {
  if (index < length) return unchecked(INPUT[index]);
  if (index == length) return 0x80;
  const lengthOffset = index - (paddedLength - 8);
  if (lengthOffset < 0) return 0;
  const bitLength = <u64>length * 8;
  return <u8>(bitLength >> ((7 - lengthOffset) * 8));
}

function writeDigestWord(offset: i32, value: u32): void {
  unchecked(OUTPUT[offset] = <u8>(value >>> 24));
  unchecked(OUTPUT[offset + 1] = <u8>(value >>> 16));
  unchecked(OUTPUT[offset + 2] = <u8>(value >>> 8));
  unchecked(OUTPUT[offset + 3] = <u8>value);
}

export function engineVersion(): i32 {
  return ENGINE_VERSION;
}

export function inputCapacity(): i32 {
  return INPUT_CAPACITY;
}

export function inputPointer(): usize {
  return changetype<usize>(INPUT);
}

export function outputPointer(): usize {
  return changetype<usize>(OUTPUT);
}

export function deductionMask(
  wasmAvailable: i32,
  webdriver: i32,
  plugins: i32,
  languages: i32,
  hardwareConcurrency: i32,
  touchPoints: i32,
  visibilityChanges: i32,
  elapsedMs: i32,
  capabilityMask: i32,
): i32 {
  let mask = 0;
  if (wasmAvailable == 0) mask |= 1 << 0;
  if (webdriver != 0) mask |= 1 << 1;
  if (plugins == 0) mask |= 1 << 2;
  if (languages == 0) mask |= 1 << 3;
  if (hardwareConcurrency <= 0) mask |= 1 << 4;
  if (touchPoints < 0) mask |= 1 << 5;
  if (visibilityChanges > 5) mask |= 1 << 6;
  if (elapsedMs < 150) mask |= 1 << 7;
  if ((capabilityMask & 1) == 0) mask |= 1 << 8;
  if ((capabilityMask & 2) == 0) mask |= 1 << 9;
  if ((capabilityMask & 4) == 0) mask |= 1 << 10;
  return mask;
}

export function riskScore(
  wasmAvailable: i32,
  webdriver: i32,
  plugins: i32,
  languages: i32,
  hardwareConcurrency: i32,
  touchPoints: i32,
  visibilityChanges: i32,
  elapsedMs: i32,
  capabilityMask: i32,
): i32 {
  const mask = deductionMask(
    wasmAvailable,
    webdriver,
    plugins,
    languages,
    hardwareConcurrency,
    touchPoints,
    visibilityChanges,
    elapsedMs,
    capabilityMask,
  );
  let score = 100;
  if ((mask & (1 << 0)) != 0) score -= 25;
  if ((mask & (1 << 1)) != 0) score -= 55;
  if ((mask & (1 << 2)) != 0) score -= 8;
  if ((mask & (1 << 3)) != 0) score -= 12;
  if ((mask & (1 << 4)) != 0) score -= 8;
  if ((mask & (1 << 5)) != 0) score -= 5;
  if ((mask & (1 << 6)) != 0) score -= 8;
  if ((mask & (1 << 7)) != 0) score -= 20;
  if ((mask & (1 << 8)) != 0) score -= 10;
  if ((mask & (1 << 9)) != 0) score -= 12;
  if ((mask & (1 << 10)) != 0) score -= 5;
  return score < 0 ? 0 : score;
}

@inline
function digestWord(index: i32): u32 {
  const offset = (index & 7) * 4;
  return (<u32>unchecked(OUTPUT[offset]) << 24) |
    (<u32>unchecked(OUTPUT[offset + 1]) << 16) |
    (<u32>unchecked(OUTPUT[offset + 2]) << 8) |
    <u32>unchecked(OUTPUT[offset + 3]);
}

@inline
function challengeOperand(
  selector: i32,
  index: i32,
  instruction: u32,
  seed: u32,
  frameTotal: u32,
  frameSquares: u32,
  frameRange: u32,
  sampleCount: i32,
  trustedActivation: i32,
  visibilityChanges: i32,
  focusState: i32,
): u32 {
  switch (selector & 7) {
    case 0: return seed;
    case 1: return digestWord(index);
    case 2: return frameTotal;
    case 3: return frameSquares;
    case 4: return frameRange;
    case 5: return (<u32>sampleCount << 16) | <u32>(trustedActivation & 0xffff);
    case 6: return (<u32>visibilityChanges << 16) | <u32>(focusState & 0xffff);
    default: return (instruction << 24) | <u32>index;
  }
}

export function executeChallenge(
  programLength: i32,
  sampleCount: i32,
  seed: u32,
  trustedActivation: i32,
  visibilityChanges: i32,
  focusState: i32,
  lane: i32,
): u32 {
  if (programLength < 8 || programLength > 128 || sampleCount < 1 || sampleCount > 64) return 0;
  if (programLength + sampleCount * 2 > INPUT_CAPACITY) return 0;

  let frameTotal: u32 = 0;
  let frameSquares: u32 = 0;
  let minimum: u32 = 0xffffffff;
  let maximum: u32 = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const offset = programLength + index * 2;
    const delta = <u32>unchecked(INPUT[offset]) | (<u32>unchecked(INPUT[offset + 1]) << 8);
    frameTotal += delta;
    frameSquares += delta * delta;
    if (delta < minimum) minimum = delta;
    if (delta > maximum) maximum = delta;
  }
  const frameRange = (minimum << 16) | (maximum & 0xffff);
  let state = seed ^ digestWord(lane) ^ digestWord(lane + 3) ^ (<u32>lane * 0x9e3779b9);

  for (let index = 0; index < programLength; index += 1) {
    const instruction = <u32>unchecked(INPUT[index]);
    const operation = <i32>(instruction >>> 5);
    const operand = challengeOperand(
      <i32>instruction,
      index + lane,
      instruction,
      seed,
      frameTotal,
      frameSquares,
      frameRange,
      sampleCount,
      trustedActivation,
      visibilityChanges,
      focusState,
    ) ^ digestWord(index + lane);
    const rotation = <i32>((instruction & 15) + 1);
    switch (operation) {
      case 0: state += operand + <u32>index; break;
      case 1: state ^= rotateRight(operand, rotation); break;
      case 2: state = state * ((operand | 1) ^ 0x85ebca6b); break;
      case 3: state = rotateRight(state, rotation) + operand; break;
      case 4: state ^= state << 13; state ^= state >>> 17; state ^= operand; break;
      case 5: state += (operand ^ <u32>index) * 0x9e3779b1; break;
      case 6: state = rotateRight(state ^ operand, rotation); break;
      default: state = (state + operand) * 0xc2b2ae35; break;
    }
  }
  state ^= state >>> 16;
  state *= 0x7feb352d;
  state ^= state >>> 15;
  state *= 0x846ca68b;
  state ^= state >>> 16;
  return state;
}

export function fingerprint(length: i32): void {
  if (length < 0 || length > INPUT_CAPACITY) return;
  const paddedLength = (length + 9 + 63) & ~63;
  let h0: u32 = 0x6a09e667;
  let h1: u32 = 0xbb67ae85;
  let h2: u32 = 0x3c6ef372;
  let h3: u32 = 0xa54ff53a;
  let h4: u32 = 0x510e527f;
  let h5: u32 = 0x9b05688c;
  let h6: u32 = 0x1f83d9ab;
  let h7: u32 = 0x5be0cd19;

  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      const offset = block + index * 4;
      unchecked(WORDS[index] =
        (<u32>paddedByte(offset, length, paddedLength) << 24) |
        (<u32>paddedByte(offset + 1, length, paddedLength) << 16) |
        (<u32>paddedByte(offset + 2, length, paddedLength) << 8) |
        <u32>paddedByte(offset + 3, length, paddedLength));
    }
    for (let index = 16; index < 64; index += 1) {
      const left = unchecked(WORDS[index - 15]);
      const right = unchecked(WORDS[index - 2]);
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      unchecked(WORDS[index] = unchecked(WORDS[index - 16]) + sigma0 + unchecked(WORDS[index - 7]) + sigma1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = h + sum1 + choice + unchecked(ROUND_CONSTANTS[index]) + unchecked(WORDS[index]);
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = sum0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temporary1;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2;
    }
    h0 += a;
    h1 += b;
    h2 += c;
    h3 += d;
    h4 += e;
    h5 += f;
    h6 += g;
    h7 += h;
  }

  writeDigestWord(0, h0);
  writeDigestWord(4, h1);
  writeDigestWord(8, h2);
  writeDigestWord(12, h3);
  writeDigestWord(16, h4);
  writeDigestWord(20, h5);
  writeDigestWord(24, h6);
  writeDigestWord(28, h7);
}
