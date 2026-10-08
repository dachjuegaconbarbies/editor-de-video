/**
 * Prueba de humo de la interfaz (modo demo, sin servidor), con el flujo del ESTUDIO:
 * - inicio con "Nuevo video",
 * - subir el clip base (y lo demás) → resumen de lo que Claude detectó,
 * - GENERAR → progreso en vivo → V1 con DESCARGAR,
 * - corregir con texto → V2 conectada con la corrección sobre la flecha,
 * - en móvil todo se apila sin desbordarse; la vista avanzada (nodos) sigue disponible.
 */
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const SHOTS = "../../data/e2e-capturas";
const MUESTRAS = fileURLToPath(new URL("../../../data/muestras/", import.meta.url));
const DEMO = "/?demo-ui=1&demo-rapido=1";

const noHorizontalOverflow = () => document.documentElement.scrollWidth <= window.innerWidth + 1;

test("demo: subir clip base → generar → V1 → corregir → V2", async ({ page }) => {
  await page.goto(DEMO);
  await page.getByRole("button", { name: /Nuevo video/ }).click();
  await expect(page.getByText("Arrastra aquí tu clip base")).toBeVisible();

  // Sin clip base, GENERAR está apagado y dice por qué.
  await expect(page.getByRole("button", { name: /Generar video/ })).toBeDisabled();
  await expect(page.getByText("Sube tu clip base (el video principal) para poder generar.")).toBeVisible();

  // Subir: el usuario no etiqueta nada.
  await page.getByLabel("Elegir clip base").setInputFiles([`${MUESTRAS}a-roll.mp4`]);
  await page.getByLabel("Elegir otros archivos").setInputFiles([`${MUESTRAS}b-roll-1.mp4`, `${MUESTRAS}foto.jpg`, `${MUESTRAS}musica.m4a`]);
  await expect(page.getByText("a-roll.mp4")).toBeVisible();
  await expect(page.getByText("Claude detectó")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".ae-tile")).toHaveCount(4); // 3 archivos + "Agregar"
  await page.screenshot({ path: `${SHOTS}/smoke-1-estudio-material.png` });

  // GENERAR → progreso en vivo → V1.
  await page.getByRole("button", { name: /Generar video/ }).click();
  await expect(page.getByRole("progressbar", { name: "Progreso de la generación" })).toBeVisible();
  const v1 = page.getByRole("article", { name: "Versión 1" });
  await expect(v1).toBeVisible({ timeout: 30_000 });
  await expect(v1.getByText("Descargar")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/smoke-2-v1.png` });

  // Corregir con texto → V2 con la corrección sobre la flecha.
  await v1.getByRole("textbox", { name: "Corregir" }).fill("cambia la tipografía por una más bonita");
  await v1.getByRole("button", { name: "Corregir", exact: true }).click();
  const v2 = page.getByRole("article", { name: "Versión 2" });
  await expect(v2).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ae-varrow__label")).toContainText("cambia la tipografía por una más bonita");
  await expect(v2.getByText("Qué cambió")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/smoke-3-v2.png` });
});

test("demo: vaciar el clip base deja la zona lista otra vez", async ({ page }) => {
  await page.goto(DEMO);
  await page.getByRole("button", { name: /Nuevo video/ }).click();
  await page.getByLabel("Elegir clip base").setInputFiles([`${MUESTRAS}a-roll.mp4`]);
  await expect(page.getByText("a-roll.mp4")).toBeVisible();
  await page.locator(".ae-zone--base").getByRole("button", { name: "Vaciar" }).click();
  await expect(page.getByText("Arrastra aquí tu clip base")).toBeVisible();
});

test("inicio y estudio en móvil: se apilan sin desbordarse", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(DEMO);
  await expect(page.getByRole("heading", { name: "¿Qué video hacemos hoy?" })).toBeVisible();
  expect(await page.evaluate(noHorizontalOverflow)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/smoke-4-inicio-movil.png`, fullPage: true });
  await page.getByRole("button", { name: /Nuevo video/ }).click();
  await expect(page.getByText("Arrastra aquí tu clip base")).toBeVisible();
  expect(await page.evaluate(noHorizontalOverflow)).toBe(true);
  const board = page.locator(".ae-board");
  expect(await board.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("la vista avanzada (diagrama de nodos) sigue disponible desde la ayuda", async ({ page }) => {
  await page.goto(DEMO);
  await page.getByRole("button", { name: /Café de olla/ }).click();
  await expect(page.getByRole("article", { name: "Versión 2" })).toBeVisible();
  await page.getByRole("button", { name: "Ayuda" }).click();
  await page.getByRole("button", { name: /Vista avanzada/ }).click();
  await expect(page.locator(".ae-flow.is-ready")).toBeVisible();
  await page.getByRole("button", { name: "Volver al estudio" }).click();
  await expect(page.getByRole("region", { name: "Estudio" })).toBeVisible();
});
