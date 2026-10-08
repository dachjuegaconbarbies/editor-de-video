/**
 * Utilidades de DOM para la entrada.
 *
 * `useEscape`: la vista enfocada se cierra con Esc escuchando el evento nativo en su contenedor,
 * así que un campo que quiera usar Esc (cancelar una edición, limpiar una selección) debe atraparlo
 * con un listener nativo en el propio elemento, antes de que suba.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export function useEscape(ref: RefObject<HTMLElement | null>, handler: () => boolean | void, active = true) {
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Si el manejador devuelve false, no consumió la tecla (deja que cierre la vista).
      if (h.current() === false) return;
      e.stopPropagation();
      e.preventDefault();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [ref, active]);
}

/** Copia texto al portapapeles (con alternativa para navegadores sin permiso). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Carga una familia de Google Fonts para la vista previa (una sola vez por familia). */
const loadedFonts = new Set<string>();
export function loadGoogleFont(family: string | null | undefined) {
  const f = family?.trim();
  if (!f || typeof document === "undefined" || loadedFonts.has(f)) return;
  loadedFonts.add(f);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600;700;800;900&display=swap`;
  link.dataset.aeFont = f;
  document.head.appendChild(link);
}

/** Registra una tipografía subida (.ttf/.otf/.woff) para la vista previa. */
const loadedFiles = new Set<string>();
export function loadFontFile(family: string, url: string) {
  const key = `${family}|${url}`;
  if (!url || typeof document === "undefined" || typeof FontFace === "undefined" || loadedFiles.has(key)) return;
  loadedFiles.add(key);
  const face = new FontFace(family, `url("${url}")`);
  face
    .load()
    .then((f) => document.fonts.add(f))
    .catch(() => loadedFiles.delete(key));
}

/** Nombre de familia a partir del nombre de un archivo de fuente ("Poppins-Bold.ttf" → "Poppins Bold"). */
export function fontFamilyFromFile(name: string): string {
  return name
    .replace(/\.(ttf|otf|woff2?)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

/** Ancho de un elemento (se actualiza al redimensionar). */

export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 320): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || fallback);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return w;
}
