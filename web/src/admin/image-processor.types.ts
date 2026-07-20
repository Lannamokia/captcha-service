export type CropPixels = { x: number; y: number; width: number; height: number };

export type ImageProcessRequest = {
  id: string;
  source: ArrayBuffer;
  sourceType: string;
  crop?: CropPixels;
  outputWidth: number;
  outputType: "image/webp" | "image/jpeg";
  quality: number;
};

export type ImageProcessResponse = {
  id: string;
  output?: ArrayBuffer;
  outputType?: string;
  width?: number;
  height?: number;
  error?: string;
};
