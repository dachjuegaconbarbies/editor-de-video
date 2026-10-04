/**
 * Prueba de humo de la interfaz (modo demo, sin servidor):
 * - se ven las etapas del flujo,
 * - prender "TENGO GUION" despliega su nodo,
 * - el diagrama se reacomoda sin que ningún nodo se encime con otro,
 * - capturas de pantalla para revisión.
 */
import { expect, test, type Page } from "@playwright/test";

const SHOTS = "../../data/e2e-capturas";

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function nodeBoxes(page: Page): Promise<Box[]> {
  return page.$$eval(".react-flow__node", (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-id") ?? "?", x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}

function overlaps(boxes: Box[], tolerance = 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ix > tolerance && iy > tolerance) out.push(`${a.id} ↔ ${b.id}`);
    }
  }
  return out;
}

/** Espera a que las posiciones dejen de moverse (fin de la animación del acomodo). */
async function waitForStableLayout(page: Page) {
  let prev = "";
  for (let i = 0; i < 40; i++) {
    const boxes = await nodeBoxes(page);
    const sig = boxes.map((b) => `${b.id}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`).join("|");
    if (sig === prev) return boxes;
    prev = sig;
    await page.waitForTimeout(150);
  }
  return nodeBoxes(page);
}

test("demo: etapas visibles, TENGO GUION se despliega y nada se encima", async ({ page }) => {
  await page.goto("/?demo-ui=1");
  await expect(page.locator(".ae-flow.is-ready")).toBeVisible();

  // Vista general del diagrama.
  await page.getByRole("button", { name: "Ver todo el diagrama" }).click();
  await waitForStableLayout(page);

  for (const id of ["material", "ctx-script", "ctx-brand", "ctx-references", "transcripcion", "herramientas", "instruccion"]) {
    await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
  }
  await expect(page.locator('.react-flow__node[data-id^="version-"]')).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "Etapas del flujo" })).toBeVisible();
  await expect(page.locator(".ae-edge-label")).toContainText("cambia la tipografía por una más bonita");

  const before = await waitForStableLayout(page);
  expect(overlaps(before)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/smoke-1-general.png` });

  // Prender TENGO GUION: el chip se convierte en un nodo desplegado.
  const chip = page.getByRole("switch", { name: /TENGO GUION: apagado/ });
  await expect(chip).toBeVisible();
  const chipBox = before.find((b) => b.id === "ctx-script")!;
  await chip.click();
  const script = page.locator('.react-flow__node[data-id="ctx-script"]');
  await expect(script.getByRole("textbox", { name: "Texto del guion" })).toBeVisible();

  const after = await waitForStableLayout(page);
  const expanded = after.find((b) => b.id === "ctx-script")!;
  expect(expanded.height).toBeGreaterThan(chipBox.height * 2);
  expect(overlaps(after)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/smoke-2-guion-prendido.png` });

  // Escribir en el guion y deshacer con Ctrl+Z fuera del campo.
  await script.getByRole("textbox", { name: "Texto del guion" }).fill("Gancho, proceso y cierre.");
  await expect(page.locator(".ae-save")).toContainText(/Guard/);

  // Apagar de nuevo: vuelve a ser chip y sigue sin encimarse.
  await script.getByRole("switch", { name: "TENGO GUION" }).click();
  await expect(page.getByRole("switch", { name: /TENGO GUION: apagado/ })).toBeVisible();
  const collapsed = await waitForStableLayout(page);
  expect(overlaps(collapsed)).toEqual([]);
});

test("demo: vista enfocada de MATERIAL con doble clic y Esc", async ({ page }) => {
  await page.goto("/?demo-ui=1");
  await expect(page.locator(".ae-flow.is-ready")).toBeVisible();
  // El stepper lleva a la etapa (el lienzo se mueve) y desde ahí se abre en grande.
  await page.getByRole("navigation", { name: "Etapas del flujo" }).getByRole("button", { name: /Material/ }).click();
  await page.waitForTimeout(600);
  await page.locator('.react-flow__node[data-id="material"] .ae-stage__tab').dblclick();
  const dialog = page.getByRole("dialog", { name: /Material en vista enfocada/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("entrevista-barista.mp4")).toBeVisible();
  await expect(dialog.getByText("B-roll").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/smoke-3-material.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("inicio: se ve en móvil sin desbordarse", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo-ui=1#/inicio");
  await expect(page.getByRole("heading", { name: "¿Qué video hacemos hoy?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Nuevo desde cero/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${SHOTS}/smoke-4-inicio-movil.png`, fullPage: true });
});
