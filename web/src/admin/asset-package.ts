import { strFromU8, strToU8, unzip, zip } from "fflate";

const PACKAGE_VERSION = 1;

export type PackageAsset = {
  label: string;
  blob: Blob;
  width: number;
  height: number;
};

type Manifest = {
  format: "nx-captcha-assets";
  version: 1;
  createdAt: string;
  assets: Array<{ label: string; file: string; mime: string; width: number; height: number; bytes: number }>;
};

function extension(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp";
}

export async function createAssetPackage(assets: PackageAsset[]): Promise<Blob> {
  const archive: Record<string, Uint8Array> = {};
  const manifest: Manifest = {
    format: "nx-captcha-assets",
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    assets: [],
  };
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const file = `assets/${String(index + 1).padStart(4, "0")}.${extension(asset.blob.type)}`;
    archive[file] = new Uint8Array(await asset.blob.arrayBuffer());
    manifest.assets.push({
      label: asset.label,
      file,
      mime: asset.blob.type,
      width: asset.width,
      height: asset.height,
      bytes: asset.blob.size,
    });
  }
  archive["manifest.json"] = strToU8(JSON.stringify(manifest));
  const data = await new Promise<Uint8Array>((resolve, reject) => {
    zip(archive, { level: 0 }, (error, result) => error ? reject(error) : resolve(result));
  });
  return new Blob([Uint8Array.from(data).buffer], { type: "application/x-nx-captcha-assets" });
}

export async function readAssetPackage(file: Blob): Promise<PackageAsset[]> {
  const source = new Uint8Array(await file.arrayBuffer());
  const archive = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(source, (error, result) => error ? reject(error) : resolve(result));
  });
  const manifestBytes = archive["manifest.json"];
  if (!manifestBytes) throw new Error("PACKAGE_MANIFEST_MISSING");
  const manifest = JSON.parse(strFromU8(manifestBytes)) as Manifest;
  if (manifest.format !== "nx-captcha-assets" || manifest.version !== PACKAGE_VERSION || !Array.isArray(manifest.assets)) {
    throw new Error("PACKAGE_VERSION_UNSUPPORTED");
  }
  return manifest.assets.map((asset) => {
    const bytes = archive[asset.file];
    if (!bytes || !/^image\/(?:png|jpeg|webp)$/.test(asset.mime)) throw new Error("PACKAGE_ASSET_INVALID");
    return {
      label: asset.label,
      blob: new Blob([Uint8Array.from(bytes).buffer], { type: asset.mime }),
      width: asset.width,
      height: asset.height,
    };
  });
}
