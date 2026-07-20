import { describe, expect, it } from "vitest";
import { createAssetPackage, readAssetPackage } from "./asset-package";

describe("NX-Captcha asset packages", () => {
  it("round-trips image bytes and metadata", async () => {
    const first = new Blob([new Uint8Array([1, 2, 3, 4]).buffer], { type: "image/webp" });
    const second = new Blob([new Uint8Array([5, 6, 7]).buffer], { type: "image/jpeg" });
    const packed = await createAssetPackage([
      { label: "Mountain", blob: first, width: 960, height: 480 },
      { label: "Road", blob: second, width: 640, height: 320 },
    ]);
    const unpacked = await readAssetPackage(packed);

    expect(unpacked.map((asset) => ({ label: asset.label, type: asset.blob.type, width: asset.width, height: asset.height }))).toEqual([
      { label: "Mountain", type: "image/webp", width: 960, height: 480 },
      { label: "Road", type: "image/jpeg", width: 640, height: 320 },
    ]);
    expect([...new Uint8Array(await unpacked[0].blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });
});
