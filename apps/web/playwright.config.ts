import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Pruebas de interfaz. Usa el Chromium preinstalado en /opt/pw-browsers/chromium si existe
 * (no hace falta `playwright install`). Levanta Vite solo; las pruebas usan ?demo-ui=1 (sin servidor).
 */
const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const executablePath = existsSync(CHROMIUM) ? CHROMIUM : undefined;
const PORT = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../data/e2e-resultados",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "es-MX",
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions: executablePath ? { executablePath } : {} } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
