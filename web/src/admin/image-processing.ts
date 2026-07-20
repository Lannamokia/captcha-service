import type { CropPixels, ImageProcessRequest, ImageProcessResponse } from "./image-processor.types";

export type ImageJob = {
  id: string;
  source: Blob;
  crop?: CropPixels;
  outputWidth: number;
  outputType: "image/webp" | "image/jpeg";
  quality: number;
};

export type ImageJobResult = {
  id: string;
  blob?: Blob;
  width?: number;
  height?: number;
  error?: string;
};

export async function processImageJobs(
  jobs: ImageJob[],
  workerCount: number,
  onProgress: (completed: number, total: number) => void,
): Promise<ImageJobResult[]> {
  if (!jobs.length) return [];
  const results: ImageJobResult[] = [];
  let nextIndex = 0;
  let completed = 0;

  return new Promise((resolve) => {
    const count = Math.max(1, Math.min(workerCount, jobs.length));
    const workers = Array.from({ length: count }, () => new Worker(new URL("./image-processor.worker.ts", import.meta.url), { type: "module" }));
    const activeJobs = new Map<Worker, string>();

    const finish = () => {
      if (completed !== jobs.length) return;
      workers.forEach((worker) => worker.terminate());
      resolve(results);
    };

    const dispatch = async (worker: Worker) => {
      const job = jobs[nextIndex];
      nextIndex += 1;
      if (!job) return;
      activeJobs.set(worker, job.id);
      try {
        const source = await job.source.arrayBuffer();
        const request: ImageProcessRequest = {
          id: job.id,
          source,
          sourceType: job.source.type,
          crop: job.crop,
          outputWidth: job.outputWidth,
          outputType: job.outputType,
          quality: job.quality,
        };
        worker.postMessage(request, [source]);
      } catch (error) {
        results.push({ id: job.id, error: error instanceof Error ? error.message : "IMAGE_READ_FAILED" });
        activeJobs.delete(worker);
        completed += 1;
        onProgress(completed, jobs.length);
        void dispatch(worker);
        finish();
      }
    };

    workers.forEach((worker) => {
      worker.onmessage = (event: MessageEvent<ImageProcessResponse>) => {
        const response = event.data;
        activeJobs.delete(worker);
        results.push(response.output ? {
          id: response.id,
          blob: new Blob([response.output], { type: response.outputType }),
          width: response.width,
          height: response.height,
        } : { id: response.id, error: response.error || "IMAGE_PROCESSING_FAILED" });
        completed += 1;
        onProgress(completed, jobs.length);
        void dispatch(worker);
        finish();
      };
      worker.onerror = () => {
        const id = activeJobs.get(worker);
        if (id) results.push({ id, error: "IMAGE_WORKER_FAILED" });
        activeJobs.delete(worker);
        completed += 1;
        onProgress(completed, jobs.length);
        void dispatch(worker);
        finish();
      };
      void dispatch(worker);
    });
  });
}
