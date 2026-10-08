/**
 * Plantillas de motion graphics de fábrica. Las mismas 6 plantillas existen en los dos motores:
 *  - HyperFrames: HTML + GSAP con marcadores {{prop}} (contrato de hyperframes-core: root con
 *    data-composition-id/duración/tamaño, clips `.clip`, UNA timeline pausada en window.__timelines).
 *  - builtin: el mismo diseño dibujado con ASS (libass) sobre un lienzo transparente (builtin.ts).
 *
 * Marcadores reservados (los pone el motor): {{width}} {{height}} {{duration}} {{unit}} (px por
 * unidad de diseño: lado corto / 1080), {{padTop}} {{padBottom}} {{padX}} (zonas seguras en px),
 * {{fontFaces}} (reglas @font-face con archivos locales) y {{fontFamily}}.
 */
import type { MotionTemplate } from "@autoeditor/shared";

type PropsSchema = MotionTemplate["propsSchema"];

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  defaultDuration: number;
  propsSchema: PropsSchema;
  html: string;
}

const COMMON: PropsSchema = {
  color: { type: "color", default: "#8B7CF0", label: "Color principal" },
  accent: { type: "color", default: "#FBE88A", label: "Color de acento" },
  textColor: { type: "color", default: "#FFFFFF", label: "Color del texto" },
  fontFamily: { type: "string", default: "Inter", label: "Fuente" },
};

/** Cabecera HTML común (estilos base, fuentes y GSAP local). */
const head = (css: string) => `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width={{width}}, height={{height}}" />
<script src="vendor/gsap.min.js"></script>
<style>
{{fontFaces}}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: {{width}}px; height: {{height}}px; overflow: hidden; background: transparent; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: "{{fontFamily}}", "Inter", sans-serif; --u: {{unit}}px; }
.clip { position: absolute; inset: 0; }
${css}
</style>
</head>
<body>`;

const root = (body: string, script: string) => `
<div id="root" data-composition-id="mg" data-start="0" data-duration="{{duration}}" data-width="{{width}}" data-height="{{height}}">
${body}
</div>
<script>
const D = {{duration}};
const tl = gsap.timeline({ paused: true });
${script}
window.__timelines["mg"] = tl;
</script>
</body>
</html>`;

export const TEMPLATES: TemplateDef[] = [
  {
    id: "titulo-cinetico",
    name: "Título cinético",
    description: "Título que entra palabra por palabra con una barra de acento que crece debajo.",
    defaultDuration: 3,
    propsSchema: {
      text: { type: "string", default: "Tu título aquí", label: "Título" },
      subtitle: { type: "string", default: "", label: "Bajada" },
      position: { type: "string", default: "centro", label: "Posición (arriba, centro, abajo)" },
      ...COMMON,
    },
    html:
      head(`
#wrap { display: flex; flex-direction: column; align-items: center; justify-content: {{justify}}; padding: {{padTop}}px {{padX}}px {{padBottom}}px; text-align: center; }
#title { color: {{textColor}}; font-weight: 800; font-size: calc(var(--u) * 112); line-height: 1.05; text-transform: uppercase; text-shadow: 0 calc(var(--u) * 6) calc(var(--u) * 24) rgba(0,0,0,.45); max-width: 100%; }
#title .w { display: inline-block; margin: 0 calc(var(--u) * 12); }
#bar { display: block; width: calc(var(--u) * 360); height: calc(var(--u) * 16); border-radius: calc(var(--u) * 8); background: {{color}}; margin-top: calc(var(--u) * 28); transform-origin: left center; }
#sub { color: {{accent}}; font-weight: 600; font-size: calc(var(--u) * 52); margin-top: calc(var(--u) * 22); }
`) +
      root(
        `  <div id="wrap" class="clip" data-start="0" data-duration="{{duration}}" data-track-index="0">
    <div id="title" data-words="{{text}}"></div>
    <div id="bar"></div>
    <div id="sub">{{subtitle}}</div>
  </div>`,
        `const t = document.getElementById("title");
t.textContent = "";
t.dataset.words.split(/\\s+/).filter(Boolean).forEach((w) => { const s = document.createElement("span"); s.className = "w"; s.textContent = w; t.appendChild(s); });
const words = t.querySelectorAll(".w");
words.forEach((w, i) => tl.fromTo(w, { opacity: 0, y: 60, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.42, ease: "back.out(2)" }, 0.08 * i));
tl.fromTo("#bar", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power3.out" }, 0.25 + 0.08 * words.length);
tl.fromTo("#sub", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4 }, 0.4 + 0.08 * words.length);
tl.to("#wrap", { opacity: 0, duration: 0.3 }, Math.max(0.8, D - 0.3));`,
      ),
  },
  {
    id: "cintillo",
    name: "Cintillo (nombre y cargo)",
    description: "Lower-third con nombre y cargo que entra deslizándose desde la izquierda.",
    defaultDuration: 4,
    propsSchema: {
      text: { type: "string", default: "Nombre Apellido", label: "Nombre" },
      subtitle: { type: "string", default: "Cargo", label: "Cargo" },
      ...COMMON,
    },
    html:
      head(`
#wrap { display: flex; align-items: flex-end; justify-content: flex-start; padding: 0 {{padX}}px {{padBottom}}px; }
#lt { display: block; background: {{color}}; border-left: calc(var(--u) * 16) solid {{accent}}; border-radius: calc(var(--u) * 14); padding: calc(var(--u) * 26) calc(var(--u) * 40); max-width: 86%; box-shadow: 0 calc(var(--u) * 10) calc(var(--u) * 30) rgba(0,0,0,.35); }
#name { color: {{textColor}}; font-weight: 800; font-size: calc(var(--u) * 58); line-height: 1.1; }
#role { color: {{textColor}}; opacity: .85; font-weight: 500; font-size: calc(var(--u) * 38); margin-top: calc(var(--u) * 6); }
`) +
      root(
        `  <div id="wrap" class="clip" data-start="0" data-duration="{{duration}}" data-track-index="0">
    <div id="lt"><div id="name">{{text}}</div><div id="role">{{subtitle}}</div></div>
  </div>`,
        `tl.fromTo("#lt", { opacity: 0, x: -260 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, 0.05);
tl.fromTo("#role", { opacity: 0, y: 18 }, { opacity: 0.85, y: 0, duration: 0.35 }, 0.35);
tl.to("#lt", { opacity: 0, x: -260, duration: 0.4, ease: "power2.in" }, Math.max(0.9, D - 0.45));`,
      ),
  },
  {
    id: "cifra-contador",
    name: "Cifra con contador",
    description: "Número grande que cuenta desde cero hasta la cifra, con una etiqueta debajo.",
    defaultDuration: 3,
    propsSchema: {
      value: { type: "number", default: 1500, label: "Cifra" },
      prefix: { type: "string", default: "", label: "Prefijo (p. ej. $)" },
      suffix: { type: "string", default: "", label: "Sufijo (p. ej. %)" },
      decimals: { type: "number", default: 0, label: "Decimales" },
      text: { type: "string", default: "clientes felices", label: "Etiqueta" },
      ...COMMON,
    },
    html:
      head(`
#wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 {{padX}}px; }
#num { color: {{accent}}; font-weight: 900; font-size: calc(var(--u) * 210); line-height: 1; text-shadow: 0 calc(var(--u) * 8) calc(var(--u) * 30) rgba(0,0,0,.45); font-variant-numeric: tabular-nums; }
#label { display: block; color: {{textColor}}; background: {{color}}; font-weight: 700; font-size: calc(var(--u) * 50); padding: calc(var(--u) * 10) calc(var(--u) * 30); border-radius: calc(var(--u) * 16); margin-top: calc(var(--u) * 18); }
`) +
      root(
        `  <div id="wrap" class="clip" data-start="0" data-duration="{{duration}}" data-track-index="0">
    <div id="num" data-value="{{value}}" data-decimals="{{decimals}}" data-prefix="{{prefix}}" data-suffix="{{suffix}}">0</div>
    <div id="label">{{text}}</div>
  </div>`,
        `const el = document.getElementById("num");
const target = Number(el.dataset.value) || 0;
const dec = Math.max(0, Math.min(3, Number(el.dataset.decimals) || 0));
const fmt = (v) => el.dataset.prefix + v.toLocaleString("es-MX", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + el.dataset.suffix;
const c = { v: 0 };
el.textContent = fmt(0);
tl.fromTo("#num", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)" }, 0);
tl.to(c, { v: target, duration: Math.min(1.6, D * 0.6), ease: "power2.out", onUpdate: () => { el.textContent = fmt(c.v); } }, 0.15);
tl.fromTo("#label", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4 }, 0.3);
tl.to("#wrap", { opacity: 0, duration: 0.3 }, Math.max(0.9, D - 0.3));`,
      ),
  },
  {
    id: "palabra-clave-pop",
    name: "Palabra clave (pop)",
    description: "Palabra clave dentro de una píldora de color que aparece con rebote.",
    defaultDuration: 1.6,
    propsSchema: {
      text: { type: "string", default: "CLAVE", label: "Palabra" },
      ...COMMON,
      textColor: { type: "color", default: "#111111", label: "Color del texto" },
      color: { type: "color", default: "#FBE88A", label: "Color de la píldora" },
    },
    html:
      head(`
#wrap { display: flex; align-items: center; justify-content: center; padding: 0 {{padX}}px; }
#kw { display: block; background: {{color}}; color: {{textColor}}; font-weight: 900; font-size: calc(var(--u) * 120); line-height: 1.1; text-transform: uppercase; padding: calc(var(--u) * 14) calc(var(--u) * 46); border-radius: calc(var(--u) * 34); box-shadow: 0 calc(var(--u) * 12) 0 {{accent}}; max-width: 100%; text-align: center; }
`) +
      root(
        `  <div id="wrap" class="clip" data-start="0" data-duration="{{duration}}" data-track-index="0">
    <span id="kw">{{text}}</span>
  </div>`,
        `tl.fromTo("#kw", { opacity: 0, scale: 0.35, rotation: -6 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.42, ease: "back.out(2.6)" }, 0);
tl.to("#kw", { scale: 1.06, duration: 0.18, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0.55);
tl.to("#kw", { opacity: 0, scale: 0.9, duration: 0.22, ease: "power2.in" }, Math.max(0.7, D - 0.24));`,
      ),
  },
  {
    id: "cta-final",
    name: "Llamado a la acción",
    description: "Botón de llamado a la acción que aparece con pulso, con una línea opcional encima.",
    defaultDuration: 3,
    propsSchema: {
      text: { type: "string", default: "Síguenos para más", label: "Texto del botón" },
      subtitle: { type: "string", default: "", label: "Línea superior" },
      ...COMMON,
    },
    html:
      head(`
#wrap { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding: 0 {{padX}}px calc({{padBottom}}px + var(--u) * 120); text-align: center; }
#sub { color: {{textColor}}; font-weight: 700; font-size: calc(var(--u) * 54); margin-bottom: calc(var(--u) * 26); text-shadow: 0 calc(var(--u) * 4) calc(var(--u) * 18) rgba(0,0,0,.5); }
#btn { display: block; background: {{color}}; color: {{textColor}}; font-weight: 800; font-size: calc(var(--u) * 70); padding: calc(var(--u) * 24) calc(var(--u) * 56); border-radius: calc(var(--u) * 999); box-shadow: 0 0 0 calc(var(--u) * 8) {{accent}}; }
`) +
      root(
        `  <div id="wrap" class="clip" data-start="0" data-duration="{{duration}}" data-track-index="0">
    <div id="sub">{{subtitle}}</div>
    <div id="btn">{{text}} →</div>
  </div>`,
        `tl.fromTo("#btn", { opacity: 0, scale: 0.5, y: 40 }, { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: "back.out(2)" }, 0.05);
tl.fromTo("#sub", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4 }, 0.3);
tl.to("#btn", { scale: 1.07, duration: 0.25, yoyo: true, repeat: 3, ease: "sine.inOut" }, 0.8);
tl.to("#wrap", { opacity: 0, duration: 0.3 }, Math.max(1.0, D - 0.3));`,
      ),
  },
  {
    id: "logo-sting",
    name: "Logo sting",
    description: "Cierre de marca: fondo, anillo de acento que se expande y el nombre de la marca con su lema.",
    defaultDuration: 2.5,
    propsSchema: {
      text: { type: "string", default: "TU MARCA", label: "Marca" },
      subtitle: { type: "string", default: "", label: "Lema" },
      background: { type: "color", default: "#111111", label: "Fondo" },
      showBackground: { type: "boolean", default: true, label: "Mostrar fondo" },
      ...COMMON,
    },
    html:
      head(`
#bg { background: {{background}}; opacity: {{bgOpacity}}; }
#wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 {{padX}}px; }
#ring { position: absolute; left: 50%; top: 50%; width: calc(var(--u) * 300); height: calc(var(--u) * 300); margin: calc(var(--u) * -150) 0 0 calc(var(--u) * -150); border: calc(var(--u) * 14) solid {{accent}}; border-radius: 50%; }
#brand { position: relative; color: {{textColor}}; font-weight: 900; font-size: calc(var(--u) * 120); letter-spacing: calc(var(--u) * 4); text-transform: uppercase; }
#tag { position: relative; color: {{color}}; font-weight: 600; font-size: calc(var(--u) * 46); margin-top: calc(var(--u) * 14); }
`) +
      root(
        `  <div id="bg" class="clip" data-start="0" data-duration="{{duration}}" data-track-index="0"></div>
  <div id="wrap" class="clip" data-start="0" data-duration="{{duration}}" data-track-index="1">
    <div id="ring"></div>
    <div id="brand">{{text}}</div>
    <div id="tag">{{subtitle}}</div>
  </div>`,
        `tl.fromTo("#bg", { opacity: 0 }, { opacity: {{bgOpacity}}, duration: 0.3 }, 0);
tl.fromTo("#ring", { scale: 0, opacity: 1 }, { scale: 3.2, opacity: 0, duration: 0.9, ease: "power2.out" }, 0.1);
tl.fromTo("#brand", { opacity: 0, scale: 0.7, letterSpacing: "0.4em" }, { opacity: 1, scale: 1, letterSpacing: "0.03em", duration: 0.6, ease: "power3.out" }, 0.2);
tl.fromTo("#tag", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4 }, 0.6);
tl.to("#wrap", { opacity: 0, duration: 0.25 }, Math.max(1.0, D - 0.25));`,
      ),
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

export function findTemplateDef(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Plantilla en el formato de entidad para un motor concreto. */
export function toMotionTemplate(def: TemplateDef, engine: MotionTemplate["engine"]): MotionTemplate {
  return {
    id: def.id,
    name: def.name,
    engine,
    source: engine === "hyperframes" ? def.html : "",
    propsSchema: def.propsSchema,
    defaultDuration: def.defaultDuration,
    description: def.description,
  };
}

export type PropValue = string | number | boolean;

const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Props validados y con valores por defecto según `propsSchema` (la API de HyperFrames no tiene
 * modo estricto: se valida aquí). Claves desconocidas se conservan como texto.
 */
export function resolveProps(schema: PropsSchema, props: Record<string, unknown>): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [key, def] of Object.entries(schema)) {
    const raw = props[key] ?? def.default;
    switch (def.type) {
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[^\d.+-]/g, ""));
        out[key] = Number.isFinite(n) ? n : Number(def.default ?? 0) || 0;
        break;
      }
      case "color": {
        const s = String(raw ?? "");
        out[key] = HEX.test(s) ? s : String(def.default ?? "#FFFFFF");
        break;
      }
      case "boolean":
        out[key] = typeof raw === "boolean" ? raw : /^(1|true|si|sí|yes)$/i.test(String(raw ?? ""));
        break;
      default:
        out[key] = String(raw ?? "");
    }
  }
  for (const [key, v] of Object.entries(props)) {
    if (!(key in out) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) out[key] = v;
  }
  return out;
}
