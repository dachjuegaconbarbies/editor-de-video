/**
 * Demostración navegable de la interfaz SIN servidor: usa la API simulada del editor
 * (datos de ejemplo y procesos simulados). Sirve para presentar el editor o publicarlo
 * como página estática: `pnpm --filter @autoeditor/web build:demo` → apps/web/dist-demo.
 */
import { AutoEditor } from "@autoeditor/editor";
import "@autoeditor/editor/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("No se encontró #root");

createRoot(root).render(
  <StrictMode>
    <AutoEditor demo routing="memory" />
  </StrictMode>,
);
