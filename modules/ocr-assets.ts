import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineWxtModule } from "wxt/modules";

const require = createRequire(import.meta.url);

export default defineWxtModule((wxt) => {
  const ortRoot = dirname(require.resolve("onnxruntime-web"));

  wxt.hook("build:publicAssets", (_wxt, assets) => {
    for (const file of [
      "ort-wasm-simd-threaded.wasm",
      "ort-wasm-simd-threaded.mjs",
      "ort-wasm-simd-threaded.jsep.wasm",
      "ort-wasm-simd-threaded.jsep.mjs",
    ]) {
      assets.push({
        absoluteSrc: resolve(ortRoot, file),
        relativeDest: `ocr/ort/${file}`,
      });
    }
  });
});
