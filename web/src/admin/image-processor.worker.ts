import type { CropPixels, ImageProcessRequest, ImageProcessResponse } from "./image-processor.types";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ImageProcessRequest>) => void) | null;
  postMessage: (message: ImageProcessResponse, transfer?: Transferable[]) => void;
};

function centeredCrop(width: number, height: number): CropPixels {
  const targetAspect = 2;
  if (width / height > targetAspect) {
    const cropWidth = height * targetAspect;
    return { x: (width - cropWidth) / 2, y: 0, width: cropWidth, height };
  }
  const cropHeight = width / targetAspect;
  return { x: 0, y: (height - cropHeight) / 2, width, height: cropHeight };
}

function boundedCrop(crop: CropPixels, width: number, height: number): CropPixels {
  const x = Math.max(0, Math.min(width - 1, crop.x));
  const y = Math.max(0, Math.min(height - 1, crop.y));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, crop.width)),
    height: Math.max(1, Math.min(height - y, crop.height)),
  };
}

scope.onmessage = async (event) => {
  const request = event.data;
  try {
    const bitmap = await createImageBitmap(new Blob([request.source], { type: request.sourceType }));
    const crop = boundedCrop(request.crop || centeredCrop(bitmap.width, bitmap.height), bitmap.width, bitmap.height);
    const outputHeight = Math.round(request.outputWidth / 2);
    const canvas = new OffscreenCanvas(request.outputWidth, outputHeight);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, request.outputWidth, outputHeight);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: request.outputType, quality: request.quality });
    const output = await blob.arrayBuffer();
    scope.postMessage({
      id: request.id,
      output,
      outputType: blob.type || request.outputType,
      width: request.outputWidth,
      height: outputHeight,
    }, [output]);
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : "IMAGE_PROCESSING_FAILED" });
  }
};
