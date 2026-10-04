import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite: React + Tailwind. En desarrollo, /api va al servidor (Fastify en 127.0.0.1:4000).
 * Para los eventos en vivo (SSE) desactivamos cualquier buffer/compresión del proxy.
 */
const API_TARGET = process.env.AUTOEDITOR_API ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        ws: false,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers.accept?.includes("text/event-stream")) proxyReq.setHeader("Accept-Encoding", "identity");
          });
          proxy.on("proxyRes", (proxyRes) => {
            if (String(proxyRes.headers["content-type"] ?? "").includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
              delete proxyRes.headers["content-length"];
            }
          });
        },
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
