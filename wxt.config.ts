import { defineConfig } from "wxt";

const headedOcrCaptureE2e = process.env.NORIXORTRANS_OCR_CAPTURE_E2E === "1";

export default defineConfig({
  vite: () => ({
    resolve: {
      conditions: ["onnxruntime-web-use-extern-wasm"],
      dedupe: ["onnxruntime-web"],
    },
    optimizeDeps: { exclude: ["onnxruntime-web"] },
  }),
  manifestVersion: 3,
  manifest: {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    minimum_chrome_version: "138",
    options_ui: {
      page: "options.html",
      open_in_tab: true,
    },
    action: {
      default_icon: {
        16: "icons/16.png",
        32: "icons/32.png",
        48: "icons/48.png",
        128: "icons/128.png",
      },
    },
    permissions: [
      "storage",
      "unlimitedStorage",
      "activeTab",
      "scripting",
      "offscreen",
    ],
    cross_origin_embedder_policy: { value: "require-corp" },
    cross_origin_opener_policy: { value: "same-origin" },
    host_permissions: headedOcrCaptureE2e ? ["<all_urls>"] : ["https://*/*"],
    optional_host_permissions: [
      ...(headedOcrCaptureE2e ? [] : ["<all_urls>"]),
      "https://media.githubusercontent.com/*",
      "https://raw.githubusercontent.com/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';",
    },
    commands: {
      "translate-page": {
        suggested_key: { default: "Alt+Shift+T" },
        description: "__MSG_commandTranslatePage__",
      },
      "restore-page": {
        suggested_key: { default: "Alt+Shift+R" },
        description: "__MSG_commandRestorePage__",
      },
    },
    web_accessible_resources: [
      {
        resources: ["video-main-world.js"],
        matches: [
          "https://*.youtube.com/*",
          "https://*.youtube-nocookie.com/*",
          "https://*.netflix.com/*",
          "https://*.max.com/*",
          "https://*.hbomax.com/*",
          "https://*.disneyplus.com/*",
          "https://*.hotstar.com/*",
          "https://*.starplus.com/*",
          "https://*.primevideo.com/*",
          "https://*.amazon.com/*",
          "https://*.amazon.ca/*",
          "https://*.amazon.co.uk/*",
          "https://*.amazon.de/*",
          "https://*.amazon.fr/*",
          "https://*.amazon.it/*",
          "https://*.amazon.es/*",
          "https://*.amazon.in/*",
          "https://*.amazon.co.jp/*",
          "https://*.amazon.com.au/*",
          "https://*.amazon.com.br/*",
          "https://*.amazon.com.mx/*",
          "https://*.tv.apple.com/*",
          "https://*.appletv.com/*",
          "https://*.hulu.com/*",
          "https://*.hulu.jp/*",
          "https://*.paramountplus.com/*",
          "https://*.discoveryplus.com/*",
          "https://*.peacocktv.com/*",
          "https://*.fubo.tv/*",
          "https://*.fubotv.com/*",
          "https://*.ted.com/*",
          "https://*.bbc.co.uk/*",
          "https://*.bbc.com/*",
          "https://*.zdf.de/*",
          "https://*.dw.com/*",
          "https://*.udemy.com/*",
          "https://*.kanopy.com/*",
        ],
      },
    ],
  },
});
