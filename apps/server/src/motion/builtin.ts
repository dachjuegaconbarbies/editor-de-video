/**
 * Motor builtin de motion graphics (respaldo sin navegador): las plantillas de fábrica dibujadas con
 * ASS (libass) sobre un lienzo transparente (`ass=…:alpha=1`) y codificadas a MOV qtrle (ARGB, sin
 * pérdida). Es rápido (~1 s por gráfico) y determinista.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, type MotionTemplate } from "@autoeditor/shared";
import { AssDocument, assEscape, circlePath, roundedRectPath, tagColor, upperEs, type Paint } from "../render/ass.js";
import { formatCommand, runFfmpeg } from "../render/ffmpeg.js";
import { FontLibrary, measureText, stageFonts, type ResolvedFont } from "../render/fonts.js";
import { num } from "../render/graph.js";
import type { Log, MotionEngine, MotionRenderInput, RunOptions } from "../services/types.js";
import { findTemplateDef, resolveProps, TEMPLATES, toMotionTemplate, type PropValue } from "./templates.js";

/** Sube este número si cambia el dibujo de las plantillas (invalida la caché). */
const BUILTIN_VERSION = 2;
const PAINT: Paint = { mono: false };

export interface BuiltinDeps {
  ffmpegPath: string;
  log: Log;
  /** Caché de Google Fonts (data/fonts-cache) o null para no descargar. */
  fontsCacheDir: string | null;
  /** Carpeta de caché de gráficos (data/motion-cache) o null. */
  cacheDir: string | null;
}

interface PaintCtx {
  doc: AssDocument;
  X: number;
  Y: number;
  D: number;
  fps: number;
  padTop: number;
  padBottom: number;
  padX: number;
  title: ResolvedFont;
  body: ResolvedFont;
  p: Record<string, PropValue>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const ms = (s: number) => Math.max(0, Math.round(s * 1000));
const str = (p: Record<string, PropValue>, k: string, d = "") => (p[k] == null ? d : String(p[k]));
const col = (p: Record<string, PropValue>, k: string, d: string) => tagColor(/^#/.test(String(p[k] ?? "")) ? String(p[k]) : d, PAINT);

/** Etiquetas comunes de un texto: fuente, tamaño, color, sombra suave. */
function textTags(font: ResolvedFont, fs: number, color: string, shadow = true): string {
  return `\\fn${font.assName}\\fs${r1(fs)}\\1c${color}\\bord0${shadow ? `\\shad${r1(fs * 0.05)}\\4c&H000000&\\4a&H90&` : "\\shad0"}`;
}

/** Ajusta el tamaño para que el texto quepa en `maxW`. */
function fitSize(font: ResolvedFont, text: string, fs: number, maxW: number): number {
  const w = measureText(font.metrics, text, fs);
  return w > maxW ? (fs * maxW) / w : fs;
}

function paintTitle(c: PaintCtx): void {
  const text = upperEs(str(c.p, "text", "Título"));
  const sub = str(c.p, "subtitle");
  const maxW = c.X - 2 * c.padX;
  let fs = 112;
  const words = text.split(/\s+/).filter(Boolean);
  const space = () => measureText(c.title.metrics, " ", fs) + 24;
  let lines: string[][] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    lines = [];
    let cur: string[] = [];
    let w = 0;
    for (const word of words) {
      const ww = measureText(c.title.metrics, word, fs);
      if (cur.length && w + space() + ww > maxW) {
        lines.push(cur);
        cur = [];
        w = 0;
      }
      w += (cur.length ? space() : 0) + ww;
      cur.push(word);
    }
    if (cur.length) lines.push(cur);
    const widest = Math.max(...lines.map((l) => l.reduce((s, x, i) => s + (i ? space() : 0) + measureText(c.title.metrics, x, fs), 0)));
    if (lines.length <= 3 && widest <= maxW) break;
    fs *= 0.9;
  }
  const lineH = fs * 1.1;
  const subFs = 52;
  const blockH = lines.length * lineH + 44 + (sub ? subFs * 1.3 + 22 : 0);
  const pos = str(c.p, "position", "centro");
  const y0 = pos === "arriba" ? c.padTop : pos === "abajo" ? c.Y - c.padBottom - blockH : (c.Y - blockH) / 2;
  const textColor = col(c.p, "textColor", "#FFFFFF");
  let i = 0;
  lines.forEach((line, li) => {
    const widths = line.map((w) => measureText(c.title.metrics, w, fs));
    const lw = widths.reduce((s, w) => s + w, 0) + space() * (line.length - 1);
    let x = (c.X - lw) / 2;
    const cy = y0 + li * lineH + lineH / 2;
    line.forEach((word, k) => {
      const cx = x + widths[k]! / 2;
      x += widths[k]! + space();
      const t0 = 0.08 * i++;
      c.doc.add({
        layer: 2,
        start: t0,
        end: c.D,
        style: "Base",
        text: `{\\an5\\move(${r1(cx)},${r1(cy + 50)},${r1(cx)},${r1(cy)},0,320)${textTags(c.title, fs, textColor)}\\fad(120,300)\\fscx80\\fscy80\\t(0,260,\\fscx104\\fscy104)\\t(260,380,\\fscx100\\fscy100)}${assEscape(word)}`,
      });
    });
  });
  const barY = y0 + lines.length * lineH + 28;
  const barW = Math.min(360, maxW);
  c.doc.add({
    layer: 1,
    start: 0.25 + 0.08 * i,
    end: c.D,
    style: "Base",
    text: `{\\an7\\pos(${r1((c.X - barW) / 2)},${r1(barY)})\\bord0\\shad0\\1c${col(c.p, "color", "#8B7CF0")}\\fad(0,300)\\fscx0\\t(0,500,\\fscx100)\\p1}${roundedRectPath(barW, 16, 8)}{\\p0}`,
  });
  if (sub) {
    const sfs = fitSize(c.body, sub, subFs, maxW);
    c.doc.add({
      layer: 2,
      start: 0.4 + 0.08 * i,
      end: c.D,
      style: "Base",
      text: `{\\an8\\move(${r1(c.X / 2)},${r1(barY + 60)},${r1(c.X / 2)},${r1(barY + 38)},0,400)${textTags(c.body, sfs, col(c.p, "accent", "#FBE88A"))}\\fad(200,300)}${assEscape(sub)}`,
    });
  }
}

function paintLowerThird(c: PaintCtx): void {
  const name = str(c.p, "text", "Nombre");
  const role = str(c.p, "subtitle");
  const maxW = (c.X - 2 * c.padX) * 0.9;
  const bar = 16;
  const pad = 40;
  let fsN = 58;
  let fsR = 38;
  const nameW0 = measureText(c.title.metrics, name, fsN);
  const roleW0 = role ? measureText(c.body.metrics, role, fsR) : 0;
  const k = Math.min(1, (maxW - bar - 2 * pad) / Math.max(1, nameW0, roleW0));
  fsN *= k;
  fsR *= k;
  const contentW = Math.max(nameW0, roleW0) * k;
  const boxW = bar + 2 * pad + contentW;
  const boxH = 26 * 2 + fsN * 1.15 + (role ? fsR * 1.25 + 6 : 0);
  const x = c.padX;
  const y = c.Y - c.padBottom - boxH;
  const tOut = Math.max(0.9, c.D - 0.45);
  const textColor = col(c.p, "textColor", "#FFFFFF");
  const group = (dx: (phase: "in" | "out") => string, phase: "in" | "out", start: number, end: number, fad: string) => {
    const mv = (bx: number, by: number) => dx(phase).replace(/X0/g, String(r1(bx))).replace(/Y0/g, String(r1(by)));
    c.doc.add({ layer: 1, start, end, style: "Base", text: `{\\an7${mv(x, y)}${fad}\\bord0\\xshad0\\yshad${r1(10)}\\4c&H000000&\\4a&HA0&\\1c${col(c.p, "color", "#8B7CF0")}\\p1}${roundedRectPath(boxW, boxH, 14)}{\\p0}` });
    c.doc.add({ layer: 2, start, end, style: "Base", text: `{\\an7${mv(x, y)}${fad}\\bord0\\shad0\\1c${col(c.p, "accent", "#FBE88A")}\\p1}${roundedRectPath(bar, boxH, 6)}{\\p0}` });
    c.doc.add({ layer: 3, start, end, style: "Base", text: `{\\an7${mv(x + bar + pad, y + 26)}${fad}${textTags(c.title, fsN, textColor, false)}}${assEscape(name)}` });
    if (role) c.doc.add({ layer: 3, start, end, style: "Base", text: `{\\an7${mv(x + bar + pad, y + 26 + fsN * 1.15 + 6)}${fad}${textTags(c.body, fsR, textColor, false)}\\1a&H26&}${assEscape(role)}` });
  };
  const slide = 260;
  group((ph) => (ph === "in" ? `\\move(X0-${slide},Y0,X0,Y0,0,450)` : `\\move(X0,Y0,X0-${slide},Y0,0,400)`), "in", 0.05, tOut, "\\fad(220,0)");
  group((ph) => (ph === "in" ? `\\move(X0-${slide},Y0,X0,Y0,0,450)` : `\\move(X0,Y0,X0-${slide},Y0,0,400)`), "out", tOut, c.D, "\\fad(0,380)");
}

function formatNumber(v: number, decimals: number): string {
  const d = Math.max(0, Math.min(3, Math.round(decimals)));
  return v.toLocaleString("es-MX", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function paintCounter(c: PaintCtx): void {
  const target = Number(c.p.value ?? 0) || 0;
  const dec = Number(c.p.decimals ?? 0) || 0;
  const prefix = str(c.p, "prefix");
  const suffix = str(c.p, "suffix");
  const label = str(c.p, "text");
  const maxW = c.X - 2 * c.padX;
  const finalText = `${prefix}${formatNumber(target, dec)}${suffix}`;
  const fs = fitSize(c.title, finalText, 210, maxW);
  const cy = c.Y / 2 - (label ? 50 : 0);
  const color = col(c.p, "accent", "#FBE88A");
  const countStart = 0.15;
  const countDur = Math.min(1.6, c.D * 0.6);
  const endCount = countStart + countDur;
  const step = 1 / c.fps;
  const back = (p: number) => {
    const s = 2;
    const q = p - 1;
    return 1 + (s + 1) * q * q * q + s * q * q;
  };
  for (let t = 0; t < endCount - 1e-6; t += step) {
    const p = Math.max(0, Math.min(1, (t - countStart) / countDur));
    const v = target * (1 - (1 - p) * (1 - p));
    const sc = 60 + 40 * back(Math.min(1, t / 0.35));
    const alpha = Math.min(1, t / 0.2);
    c.doc.add({
      layer: 2,
      start: t,
      end: Math.min(endCount, t + step),
      style: "Base",
      text: `{\\an5\\pos(${r1(c.X / 2)},${r1(cy)})${textTags(c.title, fs, color)}\\fscx${r1(sc)}\\fscy${r1(sc)}\\alpha&H${Math.round(255 * (1 - alpha)).toString(16).padStart(2, "0").toUpperCase()}&}${assEscape(`${prefix}${formatNumber(v, dec)}${suffix}`)}`,
    });
  }
  c.doc.add({ layer: 2, start: endCount, end: c.D, style: "Base", text: `{\\an5\\pos(${r1(c.X / 2)},${r1(cy)})${textTags(c.title, fs, color)}\\fad(0,300)}${assEscape(finalText)}` });
  if (label) {
    const lfs = fitSize(c.body, label, 50, maxW - 60);
    const lw = measureText(c.body.metrics, label, lfs) + 60;
    const lh = lfs * 1.25 + 20;
    const ly = cy + fs * 0.55 + 18 + lh / 2;
    const anim = `\\move(${r1(c.X / 2)},${r1(ly + 24)},${r1(c.X / 2)},${r1(ly)},0,400)\\fad(200,300)`;
    c.doc.add({ layer: 1, start: 0.3, end: c.D, style: "Base", text: `{\\an5${anim}\\bord0\\shad0\\1c${col(c.p, "color", "#8B7CF0")}\\p1}${roundedRectPath(lw, lh, 16)}{\\p0}` });
    c.doc.add({ layer: 2, start: 0.3, end: c.D, style: "Base", text: `{\\an5${anim}${textTags(c.body, lfs, col(c.p, "textColor", "#FFFFFF"), false)}}${assEscape(label)}` });
  }
}

function paintKeyword(c: PaintCtx): void {
  const text = upperEs(str(c.p, "text", "CLAVE"));
  const maxW = c.X - 2 * c.padX;
  const fs = fitSize(c.title, text, 120, maxW - 92);
  const w = measureText(c.title.metrics, text, fs) + 92;
  const h = fs * 1.15 + 28;
  const cx = c.X / 2;
  const cy = c.Y / 2;
  const out = Math.max(0.7, c.D - 0.24);
  const anim = `\\an5\\pos(${r1(cx)},${r1(cy)})\\fad(80,240)\\frz6\\fscx35\\fscy35\\t(0,250,\\frz0\\fscx112\\fscy112)\\t(250,420,\\fscx100\\fscy100)\\t(550,730,\\fscx106\\fscy106)\\t(730,910,\\fscx100\\fscy100)\\t(${ms(out)},${ms(c.D)},\\fscx90\\fscy90)`;
  c.doc.add({ layer: 1, start: 0, end: c.D, style: "Base", text: `{${anim}\\bord0\\xshad0\\yshad12\\4c${col(c.p, "accent", "#FBE88A")}\\4a&H00&\\1c${col(c.p, "color", "#FBE88A")}\\p1}${roundedRectPath(w, h, 34)}{\\p0}` });
  c.doc.add({ layer: 2, start: 0, end: c.D, style: "Base", text: `{${anim}${textTags(c.title, fs, col(c.p, "textColor", "#111111"), false)}}${assEscape(text)}` });
}

function paintCta(c: PaintCtx): void {
  const text = `${str(c.p, "text", "Síguenos para más")} →`;
  const sub = str(c.p, "subtitle");
  const maxW = c.X - 2 * c.padX;
  const fs = fitSize(c.title, text, 70, maxW - 112 - 16);
  const w = measureText(c.title.metrics, text, fs) + 112;
  const h = fs * 1.2 + 48;
  const cx = c.X / 2;
  const cy = c.Y - c.padBottom - 120 - h / 2;
  const pulse = [0.8, 1.05, 1.3, 1.55].map((t, i) => `\\t(${ms(t)},${ms(t + 0.25)},\\fscx${i % 2 ? 100 : 107}\\fscy${i % 2 ? 100 : 107})`).join("");
  const anim = `\\an5\\move(${r1(cx)},${r1(cy + 40)},${r1(cx)},${r1(cy)},50,550)\\fad(150,300)\\fscx50\\fscy50\\t(50,450,\\fscx104\\fscy104)\\t(450,600,\\fscx100\\fscy100)${pulse}`;
  c.doc.add({ layer: 1, start: 0, end: c.D, style: "Base", text: `{${anim}\\bord8\\3c${col(c.p, "accent", "#FBE88A")}\\shad0\\1c${col(c.p, "color", "#8B7CF0")}\\p1}${roundedRectPath(w, h, h / 2)}{\\p0}` });
  c.doc.add({ layer: 2, start: 0, end: c.D, style: "Base", text: `{${anim}${textTags(c.title, fs, col(c.p, "textColor", "#FFFFFF"), false)}}${assEscape(text)}` });
  if (sub) {
    const sfs = fitSize(c.body, sub, 54, maxW);
    const sy = cy - h / 2 - 26;
    c.doc.add({ layer: 2, start: 0.3, end: c.D, style: "Base", text: `{\\an2\\move(${r1(cx)},${r1(sy + 20)},${r1(cx)},${r1(sy)},0,400)${textTags(c.body, sfs, col(c.p, "textColor", "#FFFFFF"))}\\fad(200,300)}${assEscape(sub)}` });
  }
}

function paintSting(c: PaintCtx): void {
  const brand = upperEs(str(c.p, "text", "TU MARCA"));
  const tag = str(c.p, "subtitle");
  const maxW = c.X - 2 * c.padX;
  const fs = fitSize(c.title, brand, 120, maxW * 0.92);
  const cx = c.X / 2;
  const cy = c.Y / 2 - (tag ? 30 : 0);
  const fadeOut = Math.min(250, ms(c.D * 0.15));
  if (c.p.showBackground !== false) {
    c.doc.add({ layer: 0, start: 0, end: c.D, style: "Base", text: `{\\an7\\pos(0,0)\\bord0\\shad0\\1c${col(c.p, "background", "#111111")}\\fad(300,${fadeOut})\\p1}${roundedRectPath(c.X, c.Y, 0)}{\\p0}` });
  }
  c.doc.add({
    layer: 1,
    start: 0.1,
    end: Math.min(c.D, 1.1),
    style: "Base",
    text: `{\\an5\\pos(${r1(cx)},${r1(c.Y / 2)})\\1a&HFF&\\bord14\\shad0\\3c${col(c.p, "accent", "#FBE88A")}\\fscx0\\fscy0\\t(0,900,0.6,\\fscx320\\fscy320\\3a&HFF&)\\p1}${circlePath(150)}{\\p0}`,
  });
  c.doc.add({
    layer: 2,
    start: 0.2,
    end: c.D,
    style: "Base",
    text: `{\\an5\\pos(${r1(cx)},${r1(cy)})${textTags(c.title, fs, col(c.p, "textColor", "#FFFFFF"))}\\fad(200,${fadeOut})\\fsp40\\fscx70\\fscy70\\t(0,600,0.5,\\fsp4\\fscx100\\fscy100)}${assEscape(brand)}`,
  });
  if (tag) {
    const tfs = fitSize(c.body, tag, 46, maxW);
    c.doc.add({ layer: 2, start: 0.6, end: c.D, style: "Base", text: `{\\an8\\move(${r1(cx)},${r1(cy + fs * 0.6 + 34)},${r1(cx)},${r1(cy + fs * 0.6 + 14)},0,400)${textTags(c.body, tfs, col(c.p, "color", "#8B7CF0"), false)}\\fad(200,${fadeOut})}${assEscape(tag)}` });
  }
}

const PAINTERS: Record<string, (c: PaintCtx) => void> = {
  "titulo-cinetico": paintTitle,
  cintillo: paintLowerThird,
  "cifra-contador": paintCounter,
  "palabra-clave-pop": paintKeyword,
  "cta-final": paintCta,
  "logo-sting": paintSting,
};

/** Clave de caché determinista de un gráfico. */
export function graphicCacheKey(engine: string, input: Omit<MotionRenderInput, "outPath">, extra: unknown = null): string {
  const h = createHash("sha256");
  h.update(
    canonicalJson({
      engine,
      template: input.template.id,
      source: createHash("sha256").update(input.template.source ?? "").digest("hex"),
      props: input.props,
      w: input.width,
      h: input.height,
      d: Math.round(input.duration * 1000) / 1000,
      fps: input.fps,
      fonts: (input.fonts ?? []).map((f) => f.family),
      extra,
    }),
  );
  return h.digest("hex").slice(0, 24);
}

/** Copia atómica (archivo temporal + rename) para no dejar cachés a medias. */
export async function atomicCopy(from: string, to: string): Promise<void> {
  if (path.resolve(from) === path.resolve(to)) return;
  await mkdir(path.dirname(to), { recursive: true });
  const tmp = `${to}.${process.pid}.${Date.now()}.tmp`;
  await copyFile(from, tmp);
  await rename(tmp, to);
}

export function createBuiltinMotionEngine(deps: BuiltinDeps): MotionEngine {
  const fonts = new FontLibrary({ log: deps.log, googleCacheDir: deps.fontsCacheDir });
  const templates = TEMPLATES.map((t) => toMotionTemplate(t, "builtin"));

  async function render(input: MotionRenderInput, opts: RunOptions = {}): Promise<{ path: string; hasAlpha: boolean; seconds: number }> {
    const t0 = Date.now();
    const def = findTemplateDef(input.template.id) ?? findTemplateDef("palabra-clave-pop")!;
    const props = resolveProps(def.propsSchema, { ...input.props, text: input.props.text ?? input.props.texto ?? (findTemplateDef(input.template.id) ? undefined : input.template.name) });
    const key = graphicCacheKey("builtin", { ...input, template: { ...input.template, id: def.id } as MotionTemplate, props }, BUILTIN_VERSION);
    const cached = deps.cacheDir ? path.join(deps.cacheDir, `builtin-${key}.mov`) : null;
    if (cached && existsSync(cached)) {
      await atomicCopy(cached, input.outPath);
      return { path: input.outPath, hasAlpha: true, seconds: (Date.now() - t0) / 1000 };
    }
    const W = input.width;
    const H = input.height;
    const short = Math.min(W, H);
    const X = Math.round((W * 1080) / short);
    const Y = Math.round((H * 1080) / short);
    const vertical = H > W;
    const family = str(props, "fontFamily", "Inter") || "Inter";
    const custom = input.fonts?.find((f) => f.family.toLowerCase() === family.toLowerCase());
    const title = custom
      ? await new FontLibrary({ log: deps.log, dirs: [path.dirname(custom.path)], googleCacheDir: null }).resolve({ family, weight: 800 })
      : await fonts.resolve({ family, weight: 800, googleFont: family, assetId: null });
    const body = custom ? title : await fonts.resolve({ family, weight: 600, googleFont: family, assetId: null });
    const doc = new AssDocument(X, Y);
    doc.addStyle({ name: "Base", fontName: title.assName, fontSize: 100, primary: "&H00FFFFFF", secondary: "&H00FFFFFF", outline: "&H00000000", back: "&H80000000", borderStyle: 1, outlineWidth: 0, shadow: 0, alignment: 5 });
    const D = Math.max(0.2, input.duration);
    PAINTERS[def.id]!({
      doc,
      X,
      Y,
      D,
      fps: input.fps,
      padTop: Y * (vertical ? 0.12 : 0.08),
      padBottom: Y * (vertical ? 0.22 : 0.1),
      padX: X * (vertical ? 0.07 : 0.06),
      title,
      body,
      p: props,
    });
    const tmp = await mkdtemp(path.join(path.dirname(input.outPath), ".mg-"));
    try {
      await stageFonts([title, body], path.join(tmp, "fonts"));
      await writeFile(path.join(tmp, "g.ass"), doc.toString(), "utf8");
      const frames = Math.max(1, Math.round(D * input.fps));
      const target = cached ?? input.outPath;
      await mkdir(path.dirname(target), { recursive: true });
      const partial = path.join(tmp, "out.mov");
      const args = [
        "-f",
        "lavfi",
        "-i",
        // Todo dentro de la entrada lavfi: si `format=rgba` fuera en -vf, el dispositivo lavfi
        // negociaría un formato sin alfa antes y el lienzo saldría opaco.
        `color=c=black@0:s=${W}x${H}:r=${num(input.fps, 6)}:d=${num(frames / input.fps + 1, 4)},format=rgba,ass=filename=g.ass:alpha=1:fontsdir=fonts`,
        "-frames:v",
        String(frames),
        "-c:v",
        "qtrle",
        "-pix_fmt",
        "argb",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-map_metadata",
        "-1",
        partial,
      ];
      deps.log.debug({ cmd: formatCommand(deps.ffmpegPath, args) }, "motion builtin");
      await runFfmpeg(deps.ffmpegPath, args, {
        cwd: tmp,
        signal: opts.signal,
        timeoutMs: 5 * 60 * 1000,
        durationSeconds: frames / input.fps,
        onProgress: opts.onProgress ? (f) => opts.onProgress!(f, "Dibujando el gráfico") : undefined,
        log: deps.log,
        what: "dibujar el gráfico animado",
      });
      await atomicCopy(partial, target);
      if (cached) await atomicCopy(cached, input.outPath);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    return { path: input.outPath, hasAlpha: true, seconds: (Date.now() - t0) / 1000 };
  }

  return {
    id: "builtin",
    available: async () => ({ ready: true, detail: "Gráficos con ffmpeg + libass (sin navegador)." }),
    renderGraphic: render,
    builtinTemplates: () => templates.map((t) => ({ ...t, propsSchema: { ...t.propsSchema } })),
  };
}
