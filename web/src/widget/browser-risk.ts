import wasmUrl from "./risk-engine.wasm?url";

export type IntegrityChallenge = {
  id: string;
  seed: number;
  program: string;
  sampleCount: number;
  minimumDurationMs: number;
};

export type WasmIntegrityEvidence = {
  challengeId: string;
  response: string;
  frameDeltas: number[];
  trustedActivation: boolean;
  focusState: boolean;
};

export type BrowserRiskRequest = {
  wasmAvailable: boolean;
  webdriver: boolean;
  plugins: number;
  languages: number;
  hardwareConcurrency: number;
  touchPoints: number;
  visibilityChanges: number;
  elapsedMs: number;
  fingerprintCapabilities: number;
  wasmReport?: {
    version: number;
    score: number;
    deductionMask: number;
    fingerprint: string;
    integrity: WasmIntegrityEvidence;
  };
};

type RiskEngineExports = {
  memory: WebAssembly.Memory;
  engineVersion(): number;
  inputCapacity(): number;
  inputPointer(): number;
  outputPointer(): number;
  fingerprint(length: number): void;
  riskScore(...values: number[]): number;
  deductionMask(...values: number[]): number;
  executeChallenge(
    programLength: number,
    sampleCount: number,
    seed: number,
    trustedActivation: number,
    visibilityChanges: number,
    focusState: number,
    lane: number,
  ): number;
};

type CollectedFingerprint = { bytes: Uint8Array; capabilities: number };

let enginePromise: Promise<RiskEngineExports> | null = null;
const encoder = new TextEncoder();
const AUDIO_RENDER_TIMEOUT_MS = 1_500;
const ANIMATION_FRAME_TIMEOUT_MS = 300;
const WASM_FETCH_TIMEOUT_MS = 2_000;

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(null);
      },
    );
  });
}

function encodePart(label: string, value: Uint8Array): Uint8Array {
  const labelBytes = encoder.encode(label);
  const output = new Uint8Array(2 + labelBytes.length + 4 + value.length);
  const view = new DataView(output.buffer);
  view.setUint16(0, labelBytes.length, true);
  output.set(labelBytes, 2);
  view.setUint32(2 + labelBytes.length, value.length, true);
  output.set(value, 2 + labelBytes.length + 4);
  return output;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function instantiateRiskEngine(): Promise<RiskEngineExports> {
  const imports = { env: { abort: () => { throw new Error("WASM_ABORT"); } } };
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), WASM_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(wasmUrl, {
      cache: "force-cache",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("WASM_FETCH_FAILED");
    try {
      const result = await WebAssembly.instantiateStreaming(response.clone(), imports);
      return result.instance.exports as unknown as RiskEngineExports;
    } catch {
      const result = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
      return result.instance.exports as unknown as RiskEngineExports;
    }
  } catch {
    enginePromise = null;
    throw new Error("WASM_UNAVAILABLE");
  } finally {
    window.clearTimeout(timeout);
  }
}

function riskEngine(): Promise<RiskEngineExports> {
  enginePromise ||= instantiateRiskEngine();
  return enginePromise;
}

async function collectAudioBytes(): Promise<Uint8Array | null> {
  const AudioRenderer = window.OfflineAudioContext || (window as typeof window & {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  }).webkitOfflineAudioContext;
  if (!AudioRenderer) return null;
  try {
    const context = new AudioRenderer(1, 4096, 44_100);
    const oscillator = context.createOscillator();
    const compressor = context.createDynamicsCompressor();
    oscillator.type = "triangle";
    oscillator.frequency.value = 10_000;
    compressor.threshold.value = -48;
    compressor.knee.value = 32;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    oscillator.connect(compressor);
    compressor.connect(context.destination);
    oscillator.start(0);
    const rendered = await settleWithin(context.startRendering(), AUDIO_RENDER_TIMEOUT_MS);
    if (!rendered) return null;
    const samples = rendered.getChannelData(0).slice(512, 1536);
    return new Uint8Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  } catch {
    return null;
  }
}

function compileShader(context: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = context.createShader(type);
  if (!shader) return null;
  context.shaderSource(shader, source);
  context.compileShader(shader);
  if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
    context.deleteShader(shader);
    return null;
  }
  return shader;
}

function collectWebGlBytes(): Uint8Array | null {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true }) ||
    canvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true });
  if (!context) return null;
  try {
    const vertex = compileShader(context, context.VERTEX_SHADER, `attribute vec2 p; varying vec2 v; void main(){v=p;gl_Position=vec4(p,0.0,1.0);}`);
    const fragment = compileShader(context, context.FRAGMENT_SHADER, `precision highp float; varying vec2 v; void main(){float q=sin(v.x*19.13)+cos(v.y*27.71);gl_FragColor=vec4(fract(q),fract(q*1.7),fract(q*2.3),1.0);}`);
    if (!vertex || !fragment) return null;
    const program = context.createProgram();
    if (!program) return null;
    context.attachShader(program, vertex);
    context.attachShader(program, fragment);
    context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) return null;
    context.useProgram(program);
    const buffer = context.createBuffer();
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW);
    const location = context.getAttribLocation(program, "p");
    context.enableVertexAttribArray(location);
    context.vertexAttribPointer(location, 2, context.FLOAT, false, 0, 0);
    context.viewport(0, 0, 32, 32);
    context.drawArrays(context.TRIANGLES, 0, 3);
    const pixels = new Uint8Array(32 * 32 * 4);
    context.readPixels(0, 0, 32, 32, context.RGBA, context.UNSIGNED_BYTE, pixels);
    const debug = context.getExtension("WEBGL_debug_renderer_info");
    const range = context.getParameter(context.ALIASED_LINE_WIDTH_RANGE) as Float32Array | number[];
    const precision = context.getShaderPrecisionFormat(context.FRAGMENT_SHADER, context.HIGH_FLOAT);
    const metadata = encoder.encode(JSON.stringify({
      vendor: context.getParameter(context.VENDOR),
      renderer: context.getParameter(context.RENDERER),
      unmaskedVendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : "",
      unmaskedRenderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "",
      version: context.getParameter(context.VERSION),
      shading: context.getParameter(context.SHADING_LANGUAGE_VERSION),
      maxTexture: context.getParameter(context.MAX_TEXTURE_SIZE),
      maxViewport: Array.from(context.getParameter(context.MAX_VIEWPORT_DIMS) as Int32Array | number[]),
      range: Array.from(range),
      precision: precision ? [precision.rangeMin, precision.rangeMax, precision.precision] : [],
    }));
    return concatenate([encodePart("parameters", metadata), encodePart("pixels", pixels)]);
  } catch {
    return null;
  } finally {
    context.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function collectCanvasBytes(): Uint8Array | null {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 24;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.fillStyle = "#e6edef";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "multiply";
    context.fillStyle = "#256b76";
    context.font = "15px 'Arial', sans-serif";
    context.fillText("NX-Captcha", 1.25, 16.5);
    context.strokeStyle = "rgba(121,37,76,.72)";
    context.beginPath();
    context.arc(35.5, 11.5, 9.25, 0.2, 5.7);
    context.stroke();
    return new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
  } catch {
    return null;
  }
}

async function collectFingerprint(fingerprintSalt: string): Promise<CollectedFingerprint> {
  const [audio, webgl, canvas] = await Promise.all([
    collectAudioBytes(),
    Promise.resolve(collectWebGlBytes()),
    Promise.resolve(collectCanvasBytes()),
  ]);
  let capabilities = 0;
  if (audio) capabilities |= 1;
  if (webgl) capabilities |= 2;
  if (canvas) capabilities |= 4;
  const navigatorExtended = navigator as Navigator & { deviceMemory?: number; userAgentData?: { brands?: unknown; mobile?: boolean; platform?: string } };
  const baseline = encoder.encode(JSON.stringify({
    version: 2,
    salt: fingerprintSalt,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: navigator.languages,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    deviceMemory: navigatorExtended.deviceMemory || 0,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, screen.pixelDepth],
    devicePixelRatio: window.devicePixelRatio,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    userAgentData: navigatorExtended.userAgentData || null,
  }));
  const parts = [encodePart("baseline", baseline)];
  if (audio) parts.push(encodePart("audio", audio));
  if (webgl) parts.push(encodePart("webgl", webgl));
  if (canvas) parts.push(encodePart("canvas", canvas));
  return { bytes: concatenate(parts), capabilities };
}

async function collectFrameDeltas(sampleCount: number): Promise<number[]> {
  const nextFrame = () => new Promise<number>((resolve) => {
    let settled = false;
    const frame = requestAnimationFrame((timestamp) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(timestamp);
    });
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      resolve(performance.now());
    }, ANIMATION_FRAME_TIMEOUT_MS);
  });
  const deltas: number[] = [];
  let previous = await nextFrame();
  for (let index = 0; index < sampleCount; index += 1) {
    const current = await nextFrame();
    deltas.push(Math.max(1, Math.min(20_000, Math.round((current - previous) * 10))));
    previous = current;
  }
  return deltas;
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function collectBrowserRisk(
  fingerprintSalt: string,
  challenge: IntegrityChallenge,
  visibilityChanges: number,
  trustedActivation: boolean,
  startedAt: number,
): Promise<BrowserRiskRequest> {
  const [fingerprintData, frameDeltas, engineResult] = await Promise.all([
    collectFingerprint(fingerprintSalt),
    collectFrameDeltas(challenge.sampleCount),
    riskEngine().then((engine) => ({ engine })).catch(() => ({ engine: null })),
  ]);
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  const scalarValues = {
    webdriver: navigator.webdriver,
    plugins: navigator.plugins.length,
    languages: navigator.languages.length,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    touchPoints: navigator.maxTouchPoints || 0,
    visibilityChanges,
    elapsedMs,
    fingerprintCapabilities: fingerprintData.capabilities,
  };
  const engine = engineResult.engine;
  if (!engine || fingerprintData.bytes.length > engine.inputCapacity()) {
    return { wasmAvailable: false, ...scalarValues };
  }

  const inputPointer = engine.inputPointer();
  new Uint8Array(engine.memory.buffer, inputPointer, fingerprintData.bytes.length).set(fingerprintData.bytes);
  engine.fingerprint(fingerprintData.bytes.length);
  const fingerprint = hexadecimal(new Uint8Array(engine.memory.buffer, engine.outputPointer(), 32));
  const program = base64UrlBytes(challenge.program);
  const challengeBytes = new Uint8Array(program.length + frameDeltas.length * 2);
  challengeBytes.set(program);
  const challengeView = new DataView(challengeBytes.buffer);
  frameDeltas.forEach((delta, index) => challengeView.setUint16(program.length + index * 2, delta, true));
  new Uint8Array(engine.memory.buffer, inputPointer, challengeBytes.length).set(challengeBytes);
  const challengeArguments = [
    program.length,
    frameDeltas.length,
    challenge.seed,
    Number(trustedActivation),
    visibilityChanges,
    Number(document.hasFocus()),
  ] as const;
  const response = [0, 1].map((lane) => (
    engine.executeChallenge(...challengeArguments, lane) >>> 0
  ).toString(16).padStart(8, "0")).join("");
  const scoreArguments = [
    1,
    Number(scalarValues.webdriver),
    scalarValues.plugins,
    scalarValues.languages,
    scalarValues.hardwareConcurrency,
    scalarValues.touchPoints,
    scalarValues.visibilityChanges,
    scalarValues.elapsedMs,
    scalarValues.fingerprintCapabilities,
  ];
  return {
    wasmAvailable: true,
    ...scalarValues,
    wasmReport: {
      version: engine.engineVersion(),
      score: engine.riskScore(...scoreArguments),
      deductionMask: engine.deductionMask(...scoreArguments),
      fingerprint,
      integrity: {
        challengeId: challenge.id,
        response,
        frameDeltas,
        trustedActivation,
        focusState: document.hasFocus(),
      },
    },
  };
}
