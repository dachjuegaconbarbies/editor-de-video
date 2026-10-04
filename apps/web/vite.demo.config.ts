import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Build estático de la demostración (sin servidor): rutas relativas para poder
 * abrirlo desde cualquier carpeta o publicarlo como página.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./demo", import.meta.url)),
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist-demo", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
