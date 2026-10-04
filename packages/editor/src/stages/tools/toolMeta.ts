/**
 * Metadatos de la interfaz para cada herramienta del catálogo (TOOL_CATALOG de @autoeditor/shared):
 * icono, si aparece en la paleta rápida y qué opciones se editan (formulario genérico).
 */
import { TOOL_CATALOG, type ToolGroup, type ToolKey } from "@autoeditor/shared";
import {
  AudioLines,
  Captions,
  Clapperboard,
  Film,
  Gauge,
  ImagePlus,
  Layers,
  type LucideIcon,
  Megaphone,
  MicVocal,
  Music,
  Palette,
  Scan,
  Scissors,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Type,
  Video,
  Volume2,
  WandSparkles,
  Waves,
  ZoomIn,
} from "lucide-react";

export const TOOL_ICONS: Record<ToolKey, LucideIcon> = {
  removeSilences: Scissors,
  removeFillers: AudioLines,
  pacing: Gauge,
  transitions: Layers,
  zooms: ZoomIn,
  reframe: Scan,
  colorCorrection: Palette,
  broll: Film,
  titles: Type,
  lowerThirds: Captions,
  cta: Megaphone,
  music: Music,
  sfx: Sparkles,
  ducking: Waves,
  loudness: Volume2,
  voiceEnhance: SlidersHorizontal,
  voiceover: MicVocal,
  motionGraphics: Shapes,
  aiImages: ImagePlus,
  aiVideos: Video,
};

export const GROUP_ICONS: Record<ToolGroup, LucideIcon> = {
  edicion: Clapperboard,
  texto: Type,
  audio: Music,
  ia: WandSparkles,
};

/** Botones de la paleta flotante morada (los más usados); el resto está en "Todas". */
export const QUICK_TOOLS: ToolKey[] = ["broll", "motionGraphics", "aiImages", "aiVideos", "sfx"];

export const CATALOG_BY_KEY = Object.fromEntries(TOOL_CATALOG.map((t) => [t.key, t])) as Record<ToolKey, (typeof TOOL_CATALOG)[number]>;

export type ToolOption =
  | { field: string; label: string; type: "enum"; options: { value: string; label: string }[]; help?: string }
  | { field: string; label: string; type: "text"; placeholder?: string; multiline?: boolean }
  | { field: string; label: string; type: "number"; min: number; max: number; step?: number; suffix?: string }
  | { field: string; label: string; type: "multi"; options: { value: string; label: string }[] };

const o = (value: string, label: string) => ({ value, label });

/** Opciones editables de cada herramienta (los campos existen en ToolSettings). */
export const TOOL_OPTIONS: Partial<Record<ToolKey, ToolOption[]>> = {
  removeSilences: [{ field: "aggressiveness", label: "Qué tanto recorta", type: "enum", options: [o("suave", "Suave"), o("media", "Media"), o("agresiva", "Agresiva")] }],
  pacing: [{ field: "value", label: "Ritmo", type: "enum", options: [o("lento", "Lento"), o("medio", "Medio"), o("rapido", "Rápido")] }],
  transitions: [
    { field: "style", label: "Estilo", type: "enum", options: [o("auto", "Auto"), o("corte", "Corte"), o("fundido", "Fundido"), o("barrido", "Barrido"), o("zoom", "Zoom"), o("deslizar", "Deslizar")] },
  ],
  zooms: [{ field: "intensity", label: "Intensidad", type: "enum", options: [o("sutil", "Sutil"), o("media", "Media"), o("fuerte", "Fuerte")] }],
  reframe: [{ field: "mode", label: "Modo", type: "enum", options: [o("auto", "Auto"), o("seguir", "Seguir a quien habla"), o("centro", "Centro"), o("fondo-desenfocado", "Fondo desenfocado")] }],
  colorCorrection: [
    { field: "look", label: "Look", type: "enum", options: [o("natural", "Natural"), o("calido", "Cálido"), o("frio", "Frío"), o("vivo", "Vivo"), o("cine", "Cine"), o("blanco-negro", "B/N")] },
  ],
  broll: [
    { field: "source", label: "De dónde sale", type: "enum", options: [o("material", "Mi material"), o("ia", "IA"), o("ambos", "Ambos")], help: "Con IA se prende Kie AI en el recuadro de motores." },
    { field: "frequency", label: "Frecuencia", type: "enum", options: [o("baja", "Baja"), o("media", "Media"), o("alta", "Alta")] },
    {
      field: "layout",
      label: "Cómo se ve",
      type: "enum",
      options: [o("auto", "Auto"), o("pantalla-completa", "Corte completo"), o("fondo", "De fondo"), o("pip", "En recuadro")],
      help: "“De fondo”: el B-roll ocupa la pantalla y la persona queda en un recuadro.",
    },
  ],
  lowerThirds: [
    { field: "name", label: "Nombre", type: "text", placeholder: "Ana Pérez" },
    { field: "role", label: "Cargo", type: "text", placeholder: "Fundadora de Zyra" },
  ],
  cta: [{ field: "text", label: "Texto del cierre", type: "text", placeholder: "Sígueme para más tips" }],
  music: [
    { field: "source", label: "Música", type: "enum", options: [o("mia", "La mía"), o("biblioteca", "Biblioteca"), o("ia", "Con IA")] },
    { field: "gainDb", label: "Volumen bajo la voz", type: "number", min: -40, max: 0, step: 1, suffix: "dB" },
  ],
  sfx: [
    { field: "source", label: "De dónde salen", type: "enum", options: [o("biblioteca", "Biblioteca"), o("ia", "Con IA")] },
    { field: "density", label: "Cantidad", type: "enum", options: [o("baja", "Pocos"), o("media", "Normal"), o("alta", "Muchos")] },
  ],
  loudness: [{ field: "targetLufs", label: "Volumen objetivo", type: "number", min: -30, max: -8, step: 1, suffix: "LUFS" }],
  voiceover: [
    { field: "voice", label: "Voz", type: "text", placeholder: "Femenina, cálida, español neutro" },
    { field: "script", label: "Texto (vacío = que Claude lo escriba)", type: "text", multiline: true },
  ],
  motionGraphics: [
    { field: "mode", label: "Modo", type: "enum", options: [o("automatico", "Automático"), o("manual", "Manual")], help: "Automático: Claude decide qué y dónde." },
    { field: "engine", label: "Motor", type: "enum", options: [o("hyperframes", "HyperFrames"), o("builtin", "Integrado"), o("remotion", "Remotion")] },
  ],
  aiImages: [
    { field: "max", label: "Máximo de imágenes", type: "number", min: 1, max: 30, step: 1 },
    { field: "style", label: "Estilo", type: "text", placeholder: "fotográfico, natural" },
    { field: "usage", label: "Uso", type: "multi", options: [o("broll", "B-roll"), o("fondo", "Fondos"), o("portada", "Portada")] },
  ],
  aiVideos: [
    { field: "max", label: "Máximo de clips", type: "number", min: 1, max: 10, step: 1 },
    { field: "duration", label: "Duración de cada clip", type: "number", min: 2, max: 15, step: 1, suffix: "s" },
  ],
};

/** Resumen corto del valor principal de una herramienta (p. ej. "medio"). */
export function toolValueSummary(key: ToolKey, tool: Record<string, unknown>): string | null {
  const opts = TOOL_OPTIONS[key];
  const first = opts?.[0];
  if (!first) return null;
  const v = tool[first.field];
  if (first.type === "enum") return first.options.find((x) => x.value === v)?.label ?? null;
  if (first.type === "number" && typeof v === "number") return `${v}${first.suffix ? ` ${first.suffix}` : ""}`;
  return null;
}

