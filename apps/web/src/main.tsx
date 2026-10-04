/**
 * App anfitriona local: monta <AutoEditor/> a pantalla completa.
 * Así se integraría también dentro de Zyra (como componente o como ruta).
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
    <AutoEditor apiBaseUrl="/api/v1" routing="hash" />
  </StrictMode>,
);
