/**
 * Flujo del estudio con la API de demostración (sin servidor): Nuevo video → subir clip base →
 * resumen de lo detectado → GENERAR → progreso → V1 con descargar y corregir.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AutoEditor } from "../src/AutoEditor.js";

beforeAll(() => {
  // jsdom no trae matchMedia ni scrollIntoView.
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.history.replaceState(null, "", "/?demo-ui=1&demo-rapido=1");
});

afterEach(() => cleanup());

describe("estudio (demo)", () => {
  it("subir el clip base, generar y obtener V1", async () => {
    render(createElement(AutoEditor, { demo: true }));
    const nuevo = await screen.findByRole("button", { name: /Nuevo video/ }, { timeout: 5000 });
    await act(async () => fireEvent.click(nuevo));
    await screen.findByText("Arrastra aquí tu clip base", undefined, { timeout: 5000 });

    // Sin clip base no se puede generar y se explica por qué.
    const gen = screen.getByRole("button", { name: /Generar video/ });
    expect((gen as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Sube tu clip base (el video principal) para poder generar.")).toBeTruthy();

    const input = screen.getByLabelText("Elegir clip base") as HTMLInputElement;
    const file = new File([new Uint8Array(2048)], "mi-clip.mp4", { type: "video/mp4" });
    await act(async () => fireEvent.change(input, { target: { files: [file] } }));
    await screen.findByText("mi-clip.mp4", undefined, { timeout: 5000 });
    await screen.findByText("Claude detectó", undefined, { timeout: 8000 });

    await waitFor(() => expect((screen.getByRole("button", { name: /Generar video/ }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Generar video/ })));
    await screen.findByLabelText("Progreso de la generación", undefined, { timeout: 5000 });

    const v1 = await screen.findByRole("article", { name: "Versión 1" }, { timeout: 15000 });
    expect(v1.textContent).toContain("Descargar");
    expect(screen.getByRole("textbox", { name: "Corregir" })).toBeTruthy();
  }, 30000);
});
