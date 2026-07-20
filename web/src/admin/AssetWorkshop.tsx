import { useEffect, useMemo, useRef, useState } from "react";
import Cropper from "react-easy-crop";
import type { Area, Point } from "react-easy-crop";
import {
  Archive,
  CheckCircle2,
  Cpu,
  Download,
  Gauge,
  ImagePlus,
  Images,
  LoaderCircle,
  PackageOpen,
  Play,
  Scissors,
  Send,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import "react-easy-crop/react-easy-crop.css";
import { api } from "../api";
import { createAssetPackage, readAssetPackage } from "./asset-package";
import { processImageJobs } from "./image-processing";
import type { CropPixels } from "./image-processor.types";

type ItemStatus = "queued" | "processing" | "ready" | "uploaded" | "error";
type LocalImage = {
  id: string;
  label: string;
  source: Blob;
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  crop?: CropPixels;
  output?: Blob;
  outputUrl?: string;
  outputWidth?: number;
  outputHeight?: number;
  status: ItemStatus;
  error?: string;
};
type CropDraft = { id: string; crop: Point; zoom: number; pixels?: CropPixels };
type UploadedAsset = { id: string; label: string };

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_DIRECT_ASSET_BYTES = 720_000;

function fileLabel(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim().slice(0, 100) || "Slider background";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("IMAGE_ENCODING_FAILED"));
    reader.onerror = () => reject(reader.error || new Error("IMAGE_ENCODING_FAILED"));
    reader.readAsDataURL(blob);
  });
}

export function AssetWorkshop({ token, onUploaded }: { token: string; onUploaded: () => void | Promise<void> }) {
  const [items, setItems] = useState<LocalImage[]>([]);
  const [outputWidth, setOutputWidth] = useState(960);
  const [outputType, setOutputType] = useState<"image/webp" | "image/jpeg">("image/webp");
  const [quality, setQuality] = useState(82);
  const maximumWorkers = Math.min(16, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
  const [workerCount, setWorkerCount] = useState(Math.min(8, maximumWorkers));
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [processing, setProcessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");
  const [throughput, setThroughput] = useState<number | null>(null);
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const packageInputRef = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>());

  const processedItems = items.filter((item) => item.output && (item.status === "ready" || item.status === "uploaded"));
  const readyToUpload = items.filter((item) => item.output && item.status === "ready");
  const originalBytes = useMemo(() => items.reduce((sum, item) => sum + item.sourceBytes, 0), [items]);
  const outputBytes = useMemo(() => processedItems.reduce((sum, item) => sum + (item.output?.size || 0), 0), [processedItems]);
  const savings = originalBytes > 0 && outputBytes > 0 ? Math.max(0, Math.round((1 - outputBytes / originalBytes) * 100)) : 0;
  const editingItem = cropDraft ? items.find((item) => item.id === cropDraft.id) : undefined;

  useEffect(() => () => objectUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  function trackedUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    objectUrls.current.add(url);
    return url;
  }

  function revokeUrl(url?: string) {
    if (!url || !objectUrls.current.has(url)) return;
    URL.revokeObjectURL(url);
    objectUrls.current.delete(url);
  }

  function invalidateOutputs() {
    items.forEach((item) => {
      if (item.outputUrl && item.outputUrl !== item.sourceUrl) revokeUrl(item.outputUrl);
    });
    setItems((current) => current.map((item) => ({ ...item, output: undefined, outputUrl: undefined, status: "queued", error: undefined })));
    setMessage("");
  }

  async function addFiles(files: File[]) {
    const accepted = files.filter((file) => ACCEPTED_TYPES.has(file.type));
    if (!accepted.length) {
      setMessage("仅支持 PNG、JPEG 和 WebP 原图");
      return;
    }
    const decoded = await Promise.allSettled(accepted.map(async (file): Promise<LocalImage> => {
        const bitmap = await createImageBitmap(file);
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return {
          id: crypto.randomUUID(),
          label: fileLabel(file.name),
          source: file,
          sourceUrl: trackedUrl(file),
          sourceWidth: dimensions.width,
          sourceHeight: dimensions.height,
          sourceBytes: file.size,
          status: "queued",
        };
      }));
    const added = decoded.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejected = decoded.length - added.length;
    setItems((current) => [...current, ...added]);
    setMessage(`${added.length} 张原图已加入队列${rejected ? `，${rejected} 张无法解码` : ""}`);
  }

  function removeItem(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) {
      revokeUrl(item.sourceUrl);
      if (item.outputUrl !== item.sourceUrl) revokeUrl(item.outputUrl);
    }
    setItems((current) => current.filter((candidate) => candidate.id !== id));
  }

  function saveCrop() {
    if (!cropDraft?.pixels) return;
    const item = items.find((candidate) => candidate.id === cropDraft.id);
    if (item?.outputUrl && item.outputUrl !== item.sourceUrl) revokeUrl(item.outputUrl);
    setItems((current) => current.map((candidate) => candidate.id === cropDraft.id ? {
      ...candidate,
      crop: cropDraft.pixels,
      output: undefined,
      outputUrl: undefined,
      status: "queued",
      error: undefined,
    } : candidate));
    setCropDraft(null);
  }

  async function processAll() {
    if (!items.length || processing) return;
    setProcessing(true);
    setMessage("");
    setProgress({ completed: 0, total: items.length });
    setItems((current) => current.map((item) => ({ ...item, status: "processing", error: undefined })));
    const started = performance.now();
    const results = await processImageJobs(items.map((item) => ({
      id: item.id,
      source: item.source,
      crop: item.crop,
      outputWidth,
      outputType,
      quality: quality / 100,
    })), workerCount, (completed, total) => setProgress({ completed, total }));
    const resultById = new Map(results.map((result) => [result.id, result]));
    setItems((current) => current.map((item) => {
      const result = resultById.get(item.id);
      if (!result?.blob) return { ...item, status: "error", error: result?.error || "处理线程异常退出" };
      if (result.blob.size > MAX_DIRECT_ASSET_BYTES) {
        return { ...item, status: "error", error: "输出超过 720 KB，请降低尺寸或质量" };
      }
      if (item.outputUrl && item.outputUrl !== item.sourceUrl) revokeUrl(item.outputUrl);
      return {
        ...item,
        output: result.blob,
        outputUrl: trackedUrl(result.blob),
        outputWidth: result.width,
        outputHeight: result.height,
        status: "ready",
        error: undefined,
      };
    }));
    const seconds = Math.max(0.001, (performance.now() - started) / 1000);
    setThroughput(items.length / seconds);
    setMessage("批量处理完成");
    setProcessing(false);
  }

  async function exportPackage() {
    if (!processedItems.length) return;
    setMessage("正在生成资源包");
    const packageBlob = await createAssetPackage(processedItems.map((item) => ({
      label: item.label,
      blob: item.output!,
      width: item.outputWidth || outputWidth,
      height: item.outputHeight || Math.round(outputWidth / 2),
    })));
    const url = URL.createObjectURL(packageBlob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nx-captcha-assets-${new Date().toISOString().slice(0, 10)}.nxcap`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage(`${processedItems.length} 张图片已打包`);
  }

  async function importPackage(file?: File) {
    if (!file) return;
    if (file.size > 250 * 1024 * 1024) {
      setMessage("资源包不能超过 250 MB");
      return;
    }
    try {
      const assets = await readAssetPackage(file);
      const added = assets.map((asset): LocalImage => {
        const url = trackedUrl(asset.blob);
        return {
          id: crypto.randomUUID(),
          label: asset.label.slice(0, 100),
          source: asset.blob,
          sourceUrl: url,
          sourceWidth: asset.width,
          sourceHeight: asset.height,
          sourceBytes: asset.blob.size,
          output: asset.blob,
          outputUrl: url,
          outputWidth: asset.width,
          outputHeight: asset.height,
          status: "ready",
        };
      });
      setItems((current) => [...current, ...added]);
      setMessage(`${added.length} 张图片已从资源包载入`);
    } catch {
      setMessage("资源包无效或版本不受支持");
    } finally {
      if (packageInputRef.current) packageInputRef.current.value = "";
    }
  }

  async function uploadReady() {
    if (!readyToUpload.length || uploading) return;
    setUploading(true);
    setMessage("正在编码上传批次");
    let uploaded = 0;
    try {
      const encoded = await Promise.all(readyToUpload.map(async (item) => ({
        id: item.id,
        kind: "slider_background" as const,
        label: item.label,
        payload: await blobDataUrl(item.output!),
      })));
      const batches: typeof encoded[] = [];
      let batch: typeof encoded = [];
      let batchBytes = 0;
      for (const asset of encoded) {
        if (batch.length >= 40 || batchBytes + asset.payload.length > 10_000_000) {
          batches.push(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(asset);
        batchBytes += asset.payload.length;
      }
      if (batch.length) batches.push(batch);
      for (const current of batches) {
        const response = await api<{ assets: UploadedAsset[]; count: number }>("/admin-api/assets/batch", {
          method: "POST",
          body: JSON.stringify({ assets: current.map(({ id: _id, ...asset }) => asset) }),
        }, token);
        const uploadedIds = new Set(current.map((asset) => asset.id));
        setItems((existing) => existing.map((item) => uploadedIds.has(item.id) ? { ...item, status: "uploaded" } : item));
        uploaded += response.count;
        setMessage(`已上传 ${uploaded} / ${encoded.length}`);
      }
      await onUploaded();
      setMessage(`${uploaded} 张挑战图片已写入控制台`);
    } catch {
      setMessage(`上传在 ${uploaded} 张后中断，未完成项目仍可重试`);
    } finally {
      setUploading(false);
    }
  }

  const progressPercent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <div className="workshop-shell">
      <section
        className={`workshop-dropzone ${dragging ? "dragging" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => imageInputRef.current?.click()}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") imageInputRef.current?.click(); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles([...event.dataTransfer.files]); }}
      >
        <span className="dropzone-icon"><ImagePlus /></span>
        <div><strong>拖入原图</strong><small>PNG / JPEG / WebP</small></div>
        <button className="secondary-button" type="button"><UploadCloud size={16} /> 选择文件</button>
      </section>

      <section className="workshop-control-rail">
        <label>输出宽度
          <select value={outputWidth} onChange={(event) => { setOutputWidth(Number(event.target.value)); invalidateOutputs(); }}>
            <option value={640}>640 px</option><option value={960}>960 px</option><option value={1280}>1280 px</option><option value={1600}>1600 px</option>
          </select>
        </label>
        <label>编码格式
          <select value={outputType} onChange={(event) => { setOutputType(event.target.value as "image/webp" | "image/jpeg"); invalidateOutputs(); }}>
            <option value="image/webp">WebP</option><option value="image/jpeg">JPEG</option>
          </select>
        </label>
        <label className="rail-slider">质量 <b>{quality}</b>
          <input type="range" min={50} max={95} value={quality} onChange={(event) => { setQuality(Number(event.target.value)); invalidateOutputs(); }} />
        </label>
        <label className="rail-slider">工作线程 <b>{workerCount}</b>
          <input type="range" min={1} max={maximumWorkers} value={workerCount} onChange={(event) => setWorkerCount(Number(event.target.value))} />
        </label>
        <div className="worker-readout"><Cpu size={17} /><span>{navigator.hardwareConcurrency || 4} 逻辑核心</span></div>
      </section>

      <section className="workshop-telemetry">
        <div><Images /><span>队列</span><strong>{items.length}</strong></div>
        <div><Archive /><span>原始体积</span><strong>{formatBytes(originalBytes)}</strong></div>
        <div><Gauge /><span>压缩率</span><strong>{savings}%</strong></div>
        <div><Cpu /><span>吞吐</span><strong>{throughput === null ? "--" : `${throughput.toFixed(1)}/s`}</strong></div>
      </section>

      {(processing || progress.total > 0) && <div className="workshop-progress"><i style={{ width: `${progressPercent}%` }} /><span>{progress.completed} / {progress.total}</span></div>}

      <section className="workshop-queue">
        <div className="queue-header"><span>预览</span><span>文件与裁剪</span><span>输出</span><span>状态</span><span>操作</span></div>
        {!items.length && <div className="queue-empty"><Scissors /><span>处理队列为空</span></div>}
        {items.map((item) => (
          <div className="queue-row" key={item.id}>
            <div className="queue-preview"><img src={item.outputUrl || item.sourceUrl} alt={item.label} /><span>NX-Captcha</span></div>
            <div className="queue-file"><input value={item.label} maxLength={100} onChange={(event) => setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, label: event.target.value } : candidate))} /><small>{item.sourceWidth} x {item.sourceHeight} / {formatBytes(item.sourceBytes)}</small></div>
            <div className="queue-output">{item.output ? <><strong>{item.outputWidth} x {item.outputHeight}</strong><small>{formatBytes(item.output.size)}</small></> : <span>2:1 待处理</span>}</div>
            <div className={`queue-status status-${item.status}`}>{item.status === "processing" && <LoaderCircle className="spin" />}{item.status === "uploaded" && <CheckCircle2 />}{item.error || ({ queued: "等待", processing: "处理中", ready: "就绪", uploaded: "已上传", error: "失败" }[item.status])}</div>
            <div className="queue-actions"><button className="icon-button compact" title="裁剪" onClick={() => setCropDraft({ id: item.id, crop: { x: 0, y: 0 }, zoom: 1, pixels: item.crop })}><Scissors size={15} /></button><button className="icon-button compact danger" title="移除" onClick={() => removeItem(item.id)}><Trash2 size={15} /></button></div>
          </div>
        ))}
      </section>

      <footer className="workshop-actions">
        <div className="workshop-message">{message || `${readyToUpload.length} 张可上传 / ${formatBytes(outputBytes)}`}</div>
        <button className="secondary-button" onClick={() => packageInputRef.current?.click()}><PackageOpen size={16} /> 导入资源包</button>
        <button className="secondary-button" disabled={!processedItems.length} onClick={() => void exportPackage()}><Download size={16} /> 导出 .nxcap</button>
        <button className="secondary-button" disabled={!items.length || processing} onClick={() => void processAll()}>{processing ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />} 批量处理</button>
        <button className="primary-button" disabled={!readyToUpload.length || uploading} onClick={() => void uploadReady()}>{uploading ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />} 上传 {readyToUpload.length} 张</button>
      </footer>

      <input ref={imageInputRef} className="visually-hidden" type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => { void addFiles([...(event.target.files || [])]); event.target.value = ""; }} />
      <input ref={packageInputRef} className="visually-hidden" type="file" accept=".nxcap,application/x-nx-captcha-assets" onChange={(event) => void importPackage(event.target.files?.[0])} />

      {editingItem && cropDraft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setCropDraft(null)}>
          <section className="crop-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <header className="crop-modal-header"><div><span className="eyebrow">LOCAL CROP STAGE</span><h2>{editingItem.label}</h2></div><button className="icon-button" title="关闭" onClick={() => setCropDraft(null)}><X size={18} /></button></header>
            <div className="crop-stage">
              <Cropper
                image={editingItem.sourceUrl}
                crop={cropDraft.crop}
                zoom={cropDraft.zoom}
                aspect={2}
                showGrid
                onCropChange={(crop) => setCropDraft((current) => current ? { ...current, crop } : current)}
                onZoomChange={(zoom) => setCropDraft((current) => current ? { ...current, zoom } : current)}
                onCropComplete={(_area: Area, pixels: Area) => setCropDraft((current) => current ? { ...current, pixels } : current)}
              />
              <span className="crop-watermark">NX-Captcha</span>
            </div>
            <div className="crop-controls"><label>缩放 <b>{cropDraft.zoom.toFixed(2)}x</b><input type="range" min={1} max={3} step={0.01} value={cropDraft.zoom} onChange={(event) => setCropDraft((current) => current ? { ...current, zoom: Number(event.target.value) } : current)} /></label><button className="primary-button" disabled={!cropDraft.pixels} onClick={saveCrop}><Scissors size={16} /> 应用裁剪</button></div>
          </section>
        </div>
      )}
    </div>
  );
}
