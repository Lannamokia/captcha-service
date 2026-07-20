import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [
    react(),
    ...(command === "build" ? [{
      name: "obfuscate-captcha-widget",
      enforce: "post" as const,
      transform(code: string, id: string) {
        if (!id.replace(/\\/g, "/").includes("/src/widget/")) return null;
        return {
          code: JavaScriptObfuscator.obfuscate(code, {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.65,
            deadCodeInjection: false,
            identifierNamesGenerator: "hexadecimal",
            rotateStringArray: true,
            selfDefending: false,
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 8,
            stringArray: true,
            stringArrayEncoding: ["base64"],
            stringArrayThreshold: 0.75,
          }).getObfuscatedCode(),
          map: null,
        };
      },
    }] : []),
  ],
  build: {
    outDir: path.resolve(__dirname, "../dist/web"),
    emptyOutDir: true,
    sourcemap: false,
    minify: "esbuild",
  },
  server: {
    port: 4101,
    proxy: {
      "/v1": "http://localhost:4100",
      "/admin-api": "http://localhost:4100",
    },
  },
}));
