/** Utilidades comunes de persistencia: ids y fechas. */
import { customAlphabet } from "nanoid";

const alphabet = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 14);

/** Prefijos legibles por entidad (ayudan a depurar: "prj_…", "ast_…"). */
export type IdPrefix = "prj" | "ast" | "trn" | "job" | "pln" | "ver" | "sty" | "stv" | "brd" | "rul" | "gls" | "fbk" | "kw" | "tpl" | "clp";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${alphabet()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
