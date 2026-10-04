/**
 * Utilidades de seguridad: saneo del dueño y "limpieza" de textos que salen hacia el usuario
 * (mensajes de error, detalles de disponibilidad) para que NUNCA incluyan llaves ni rutas absolutas.
 */
import os from "node:os";
import path from "node:path";
import type { Env } from "../env.js";

/** Dueño por defecto cuando no llega ningún header (uso local, una sola persona). */
export const DEFAULT_OWNER = "local";

/** Sanea un id de dueño: solo [A-Za-z0-9_-], máximo 64 caracteres. Devuelve null si queda vacío. */
export function sanitizeOwnerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return clean.length > 0 ? clean : null;
}

export type Scrubber = (text: string) => string;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Crea una función que quita de un texto:
 *  - los valores de las llaves de API configuradas,
 *  - cualquier ruta absoluta (Unix o Windows), dejando solo el nombre del archivo,
 *  - patrones con forma de llave ("sk-ant-…", "Bearer …").
 */
export function createScrubber(env: Pick<Env, "anthropicApiKey" | "kieApiKey" | "transcriptionApiKey" | "dataDir">): Scrubber {
  const secrets = [env.anthropicApiKey, env.kieApiKey, env.transcriptionApiKey].filter((s) => s && s.length >= 4);
  const roots = [env.dataDir, os.homedir(), process.cwd()].filter((r) => r && r.length > 1).sort((a, b) => b.length - a.length);
  return (input: string) => {
    let text = String(input ?? "");
    for (const secret of secrets) text = text.split(secret).join("[oculto]");
    text = text.replace(/\b(sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{16,})/g, "[oculto]");
    text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[oculto]");
    for (const root of roots) text = text.replace(new RegExp(escapeRe(root) + "(?:[\\\\/]|$)", "gm"), "");
    // Rutas absolutas restantes → solo el nombre del archivo.
    text = text.replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`<>|]+/g, (m) => path.win32.basename(m));
    text = text.replace(/(^|[\s"'`(=:,])\/(?:[^\s"'`<>/]+\/)+([^\s"'`<>/]*)/g, (_m, pre: string, base: string) => `${pre}${base || "…"}`);
    return text;
  };
}
