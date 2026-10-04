/**
 * Fuentes para subtítulos, textos y gráficos.
 *
 * Trampa grave (media-pipeline.md §6.3): libass busca por NOMBRE COMPLETO ("Montserrat ExtraBold");
 * con el nombre de familia o el PostScript cae EN SILENCIO a DejaVu Sans. Por eso aquí se lee la
 * tabla `name` de cada TTF/OTF y el ASS siempre usa el nombre completo (nameID 4).
 *
 * Orígenes, en orden de preferencia:
 *   1. FontRef.assetId → archivo subido por la persona (vía ctx.resolveAsset).
 *   2. ctx.fontsDir (fuentes subidas del proyecto), fuentes de fábrica (apps/server/assets/fonts)
 *      y caché de Google Fonts (data/fonts-cache).
 *   3. Google Fonts: si `googleFont` (o `family`) no está en caché, se descarga el TTF estático
 *      (la API CSS2 devuelve TTF cuando NO se manda un User-Agent de navegador).
 *   4. Respaldo: Inter del peso más cercano (se registra una advertencia).
 *
 * También expone métricas (avance de glifos) para medir textos y ajustarlos al cuadro sin depender
 * del ajuste automático de libass.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FontRef } from "@autoeditor/shared";
import type { Log } from "../services/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Fuentes libres (OFL) incluidas de fábrica. */
export const FACTORY_FONTS_DIR = path.resolve(here, "../../assets/fonts");

export interface FontNames {
  family: string;
  subfamily: string;
  fullName: string;
  postscript: string;
  typoFamily: string;
  weight: number;
  italic: boolean;
}

export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Avance por punto de código (en unidades de fuente). */
  advance(codePoint: number): number;
}

export interface FontFace extends FontNames {
  file: string;
  /** Origen: subida, fábrica o caché de Google. */
  origin: "subida" | "fabrica" | "google" | "proyecto";
}

// ---------------------------------------------------------------------------
// Lectura de TTF/OTF (tablas name, OS/2, head, hhea, hmtx, cmap)
// ---------------------------------------------------------------------------

interface TableDir {
  [tag: string]: { offset: number; length: number };
}

function tableDirectory(buf: Buffer): { base: number; tables: TableDir } {
  let base = 0;
  if (buf.toString("latin1", 0, 4) === "ttcf") base = buf.readUInt32BE(12); // primera fuente de la colección
  const num = buf.readUInt16BE(base + 4);
  const tables: TableDir = {};
  for (let i = 0; i < num; i++) {
    const rec = base + 12 + i * 16;
    tables[buf.toString("latin1", rec, rec + 4)] = { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) };
  }
  return { base, tables };
}

function decodeUtf16BE(buf: Buffer, start: number, len: number): string {
  let s = "";
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(buf.readUInt16BE(start + i));
  return s;
}

/** Lee nombres y peso de un TTF/OTF. */
export function readFontNames(buf: Buffer): FontNames {
  const { tables } = tableDirectory(buf);
  const names: Record<number, string> = {};
  const nameT = tables["name"];
  if (nameT) {
    const o = nameT.offset;
    const count = buf.readUInt16BE(o + 2);
    const strOff = o + buf.readUInt16BE(o + 4);
    const score = (pid: number, eid: number, lid: number) => (pid === 3 && (eid === 1 || eid === 10) ? (lid === 0x409 ? 3 : 2) : pid === 0 ? 2 : pid === 1 && eid === 0 ? 1 : 0);
    const best: Record<number, number> = {};
    for (let i = 0; i < count; i++) {
      const r = o + 6 + i * 12;
      const pid = buf.readUInt16BE(r);
      const eid = buf.readUInt16BE(r + 2);
      const lid = buf.readUInt16BE(r + 4);
      const nid = buf.readUInt16BE(r + 6);
      const len = buf.readUInt16BE(r + 8);
      const off = buf.readUInt16BE(r + 10);
      const sc = score(pid, eid, lid);
      if (sc === 0 || (best[nid] ?? 0) >= sc) continue;
      best[nid] = sc;
      names[nid] = pid === 1 ? buf.toString("latin1", strOff + off, strOff + off + len) : decodeUtf16BE(buf, strOff + off, len);
    }
  }
  let weight = 400;
  let italic = false;
  const os2 = tables["OS/2"];
  if (os2 && os2.length >= 64) {
    weight = buf.readUInt16BE(os2.offset + 4);
    italic = (buf.readUInt16BE(os2.offset + 62) & 1) === 1;
  }
  const family = names[1] ?? "";
  return {
    family,
    subfamily: names[2] ?? "",
    fullName: names[4] ?? (family + " " + (names[2] ?? "")).trim(),
    postscript: names[6] ?? "",
    typoFamily: names[16] ?? family,
    weight,
    italic: italic || /italic|oblique/i.test(names[2] ?? ""),
  };
}

/** Métricas horizontales (cmap formato 4/12 + hmtx). */
export function readFontMetrics(buf: Buffer): FontMetrics {
  const { tables } = tableDirectory(buf);
  const head = tables["head"];
  const hhea = tables["hhea"];
  const hmtx = tables["hmtx"];
  const cmap = tables["cmap"];
  const os2 = tables["OS/2"];
  const unitsPerEm = head ? buf.readUInt16BE(head.offset + 18) : 1000;
  let ascender = hhea ? buf.readInt16BE(hhea.offset + 4) : Math.round(unitsPerEm * 0.9);
  let descender = hhea ? buf.readInt16BE(hhea.offset + 6) : -Math.round(unitsPerEm * 0.2);
  // libass imita a GDI: si hay usWinAscent/usWinDescent en OS/2, esas son la "altura" del Fontsize.
  if (os2 && os2.length >= 78) {
    const winAsc = buf.readUInt16BE(os2.offset + 74);
    const winDesc = buf.readUInt16BE(os2.offset + 76);
    if (winAsc + winDesc > 0) {
      ascender = winAsc;
      descender = -winDesc;
    }
  }
  const numHMetrics = hhea ? buf.readUInt16BE(hhea.offset + 34) : 0;
  const glyphAdvance = (gid: number): number => {
    if (!hmtx || numHMetrics === 0) return unitsPerEm * 0.6;
    const i = Math.min(gid, numHMetrics - 1);
    return buf.readUInt16BE(hmtx.offset + i * 4);
  };
  // Mapa de punto de código → glifo.
  let lookup: (cp: number) => number = () => 0;
  if (cmap) {
    const o = cmap.offset;
    const n = buf.readUInt16BE(o + 2);
    let fmt4 = -1;
    let fmt12 = -1;
    for (let i = 0; i < n; i++) {
      const r = o + 4 + i * 8;
      const pid = buf.readUInt16BE(r);
      const eid = buf.readUInt16BE(r + 2);
      const sub = o + buf.readUInt32BE(r + 4);
      const format = buf.readUInt16BE(sub);
      if (format === 12 && (pid === 3 || pid === 0)) fmt12 = sub;
      if (format === 4 && ((pid === 3 && eid === 1) || pid === 0)) fmt4 = sub;
    }
    if (fmt12 >= 0) {
      const groups = buf.readUInt32BE(fmt12 + 12);
      lookup = (cp) => {
        let lo = 0;
        let hi = groups - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const g = fmt12 + 16 + mid * 12;
          const start = buf.readUInt32BE(g);
          const end = buf.readUInt32BE(g + 4);
          if (cp < start) hi = mid - 1;
          else if (cp > end) lo = mid + 1;
          else return buf.readUInt32BE(g + 8) + (cp - start);
        }
        return 0;
      };
    } else if (fmt4 >= 0) {
      const segX2 = buf.readUInt16BE(fmt4 + 6);
      const ends = fmt4 + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      lookup = (cp) => {
        if (cp > 0xffff) return 0;
        for (let s = 0; s < segX2; s += 2) {
          const end = buf.readUInt16BE(ends + s);
          if (cp > end) continue;
          const start = buf.readUInt16BE(starts + s);
          if (cp < start) return 0;
          const delta = buf.readInt16BE(deltas + s);
          const ro = buf.readUInt16BE(ranges + s);
          if (ro === 0) return (cp + delta) & 0xffff;
          const gi = buf.readUInt16BE(ranges + s + ro + (cp - start) * 2);
          return gi === 0 ? 0 : (gi + delta) & 0xffff;
        }
        return 0;
      };
    }
  }
  const memo = new Map<number, number>();
  return {
    unitsPerEm,
    ascender,
    descender,
    advance(cp) {
      let v = memo.get(cp);
      if (v === undefined) {
        const gid = lookup(cp);
        v = gid === 0 ? unitsPerEm * 0.6 : glyphAdvance(gid);
        memo.set(cp, v);
      }
      return v;
    },
  };
}

// ---------------------------------------------------------------------------
// Biblioteca
// ---------------------------------------------------------------------------

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "Poppins ExtraBold" → "poppins" (algunas fuentes no traen nameID 16 y el peso va en la familia). */
const baseFamily = (s: string) =>
  normName(s).replace(/(thin|hairline|extralight|ultralight|light|regular|normal|book|medium|semibold|demibold|extrabold|ultrabold|bold|black|heavy|italic)+$/, "");

export interface ResolvedFont {
  /** Nombre que va en el estilo ASS (nombre completo de la cara). */
  assName: string;
  /** Familia (CSS) — para HyperFrames. */
  family: string;
  weight: number;
  file: string;
  origin: FontFace["origin"];
  metrics: FontMetrics;
}

export interface FontLibraryOptions {
  log: Log;
  /** Carpetas adicionales a escanear (p. ej. ctx.fontsDir). */
  dirs?: string[];
  /** Caché de Google Fonts (data/fonts-cache). null = sin descargas. */
  googleCacheDir?: string | null;
  /** Resuelve un FontRef.assetId a una ruta local. */
  resolveAssetPath?: (assetId: string) => Promise<string>;
  /** Tiempo límite de descarga (ms). */
  downloadTimeoutMs?: number;
}

const faceCache = new Map<string, { names: FontNames; metrics: FontMetrics }>();

async function loadFace(file: string): Promise<{ names: FontNames; metrics: FontMetrics }> {
  const hit = faceCache.get(file);
  if (hit) return hit;
  const buf = await readFile(file);
  const v = { names: readFontNames(buf), metrics: readFontMetrics(buf) };
  faceCache.set(file, v);
  return v;
}

async function scanDir(dir: string, origin: FontFace["origin"]): Promise<FontFace[]> {
  if (!dir || !existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
  const out: FontFace[] = [];
  for (const f of files) {
    try {
      const { names } = await loadFace(path.join(dir, f));
      out.push({ ...names, file: path.join(dir, f), origin });
    } catch {
      // Archivo de fuente ilegible: se ignora.
    }
  }
  return out;
}

/** URL del TTF estático de Google Fonts para familia+peso (sin User-Agent de navegador → TTF). */
async function googleTtfUrl(family: string, weight: number, signal: AbortSignal): Promise<string | null> {
  const fam = family.trim().replace(/\s+/g, "+");
  for (const q of [`family=${fam}:wght@${weight}`, `family=${fam}`]) {
    const res = await fetch(`https://fonts.googleapis.com/css2?${q}`, { signal });
    if (!res.ok) continue;
    const css = await res.text();
    const m = /src:\s*url\(([^)]+\.(?:ttf|otf))\)/i.exec(css);
    if (m) return m[1]!;
  }
  return null;
}

export class FontLibrary {
  private faces: FontFace[] | null = null;
  private readonly opts: FontLibraryOptions;

  constructor(opts: FontLibraryOptions) {
    this.opts = opts;
  }

  private async allFaces(): Promise<FontFace[]> {
    if (!this.faces) {
      const lists = await Promise.all([
        ...(this.opts.dirs ?? []).map((d) => scanDir(d, "proyecto")),
        scanDir(FACTORY_FONTS_DIR, "fabrica"),
        this.opts.googleCacheDir ? scanDir(this.opts.googleCacheDir, "google") : Promise.resolve([]),
      ]);
      this.faces = lists.flat();
    }
    return this.faces;
  }

  private pick(faces: FontFace[], family: string, weight: number): FontFace | null {
    const n = normName(family);
    let cands = faces.filter((f) => !f.italic && (normName(f.typoFamily) === n || normName(f.family) === n));
    const b = baseFamily(family);
    cands = [...cands, ...faces.filter((f) => !f.italic && !cands.includes(f) && (baseFamily(f.typoFamily) === b || baseFamily(f.family) === b))];
    if (!cands.length) return null;
    // Peso más cercano; empate → el más pesado (los títulos suelen pedir negritas).
    return cands.reduce((best, f) => {
      const d = Math.abs(f.weight - weight);
      const bd = Math.abs(best.weight - weight);
      return d < bd || (d === bd && f.weight > best.weight) ? f : best;
    });
  }

  private async toResolved(face: FontFace): Promise<ResolvedFont> {
    const { metrics } = await loadFace(face.file);
    return { assName: face.fullName, family: face.typoFamily || face.family, weight: face.weight, file: face.file, origin: face.origin, metrics };
  }

  private async download(family: string, weight: number): Promise<FontFace | null> {
    const dir = this.opts.googleCacheDir;
    if (!dir) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.downloadTimeoutMs ?? 15_000);
    try {
      const url = await googleTtfUrl(family, weight, ctrl.signal);
      if (!url) return null;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const names = readFontNames(buf); // valida que sea una fuente
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${family.replace(/[^\w-]+/g, "")}-${names.weight}.ttf`);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, file);
      faceCache.delete(file);
      const face: FontFace = { ...names, file, origin: "google" };
      this.faces?.push(face);
      this.opts.log.info({ family, weight: names.weight }, "Fuente descargada de Google Fonts");
      return face;
    } catch (err) {
      this.opts.log.warn({ family, err: err instanceof Error ? err.message : String(err) }, "No se pudo descargar la fuente de Google Fonts");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resuelve un FontRef a un archivo concreto y su nombre para libass. */
  async resolve(ref: Partial<FontRef> | null | undefined, fallbackWeight = 700): Promise<ResolvedFont> {
    const weight = ref?.weight ?? fallbackWeight;
    if (ref?.assetId && this.opts.resolveAssetPath) {
      try {
        const file = await this.opts.resolveAssetPath(ref.assetId);
        const { names } = await loadFace(file);
        return this.toResolved({ ...names, file, origin: "subida" });
      } catch (err) {
        this.opts.log.warn({ assetId: ref.assetId, err: err instanceof Error ? err.message : String(err) }, "No se pudo usar la fuente subida; uso una de respaldo");
      }
    }
    const faces = await this.allFaces();
    const family = ref?.family || ref?.googleFont || "Inter";
    let face = this.pick(faces, family, weight) ?? (ref?.googleFont ? this.pick(faces, ref.googleFont, weight) : null);
    // Si existe la familia pero no un peso cercano, intenta bajar el peso exacto.
    if (face && Math.abs(face.weight - weight) >= 200 && this.opts.googleCacheDir) {
      const better = await this.download(ref?.googleFont || family, weight);
      if (better && Math.abs(better.weight - weight) < Math.abs(face.weight - weight)) face = better;
    }
    if (!face) face = await this.download(ref?.googleFont || family, weight);
    if (!face) {
      this.opts.log.warn({ family, weight }, "Fuente no disponible; uso Inter");
      face = this.pick(faces, "Inter", weight);
    }
    if (!face) throw new Error("No hay fuentes de fábrica (apps/server/assets/fonts está vacío)");
    return this.toResolved(face);
  }
}

/**
 * Copia las fuentes elegidas a una carpeta propia del render (fontsdir de libass): así libass solo
 * ve esas caras y no hay ambigüedad entre una subida y una de fábrica con el mismo nombre.
 */
export async function stageFonts(fonts: ResolvedFont[], dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const seen = new Set<string>();
  for (const f of fonts) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    const h = createHash("sha1").update(f.file).digest("hex").slice(0, 8);
    await copyFile(f.file, path.join(dir, `${h}-${path.basename(f.file)}`));
  }
}

/**
 * Factor em/Fontsize de libass: Fontsize = alto de celda (ascender − descender, métricas de
 * Windows si existen), así que 1 em = Fontsize × unitsPerEm / (asc − desc).
 */
export function assScaleFactor(metrics: FontMetrics): number {
  return metrics.unitsPerEm / (metrics.ascender - metrics.descender);
}

/**
 * Ancho de un texto tal como lo dibuja libass con `Fontsize = assFontSize` (en unidades del
 * PlayRes). `spacing` = \fsp en px por carácter.
 */
export function measureText(metrics: FontMetrics, text: string, assFontSize: number, spacing = 0): number {
  let w = 0;
  let n = 0;
  for (const ch of text) {
    w += metrics.advance(ch.codePointAt(0)!);
    n++;
  }
  return (w / (metrics.ascender - metrics.descender)) * assFontSize + Math.max(0, n - 1) * spacing;
}
