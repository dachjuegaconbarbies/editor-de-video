/**
 * Traducción de parámetros genéricos (prompt, formato, duración, semilla, negative prompt…) a los campos
 * reales de cada modelo de Kie AI, usando `KieModelConfig.fieldMap` y `defaults` de config/providers.json.
 *
 * Convención de configuración: las claves de `defaults` que empiezan con "$" son METADATOS para este
 * adaptador y nunca se envían a Kie:
 *   "$unit"          unidad de precio: "image" | "second" | "video" | "request" | "1000_chars"
 *   "$baseSeconds"   segundos a los que corresponde `costCredits` cuando la unidad es "second"
 *   "$aspectRatios"  formatos que acepta el modelo (se elige el más parecido)
 *   "$durations"     duraciones permitidas (se elige la más cercana)
 *   "$durationRange" [mín, máx] de duración
 *   "$durationType"  "string" | "integer" (algunos modelos piden la duración como texto)
 */
import type { AiRequest, KieModelConfig, ProvidersConfig } from "@autoeditor/shared";

export type KieKind = KieModelConfig["kind"];

/** Busca el modelo: el pedido explícitamente, el de la configuración por defecto o el primero activo del tipo. */
export function resolveKieModel(kie: ProvidersConfig["kie"], kind: KieKind, explicit?: string | null): KieModelConfig | null {
  const models = kie.models;
  if (explicit) {
    const m = models.find((x) => x.id === explicit) ?? models.find((x) => x.model === explicit && x.kind === kind);
    if (m) return m;
  }
  const def = kie.defaults[kind];
  return models.find((x) => x.id === def && x.enabled) ?? models.find((x) => x.kind === kind && x.enabled) ?? null;
}

const meta = <T>(m: KieModelConfig, key: string): T | undefined => m.defaults[`$${key}`] as T | undefined;

/** Defaults sin los metadatos "$…". */
export function inputDefaults(m: KieModelConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(m.defaults).filter(([k]) => !k.startsWith("$")));
}

const ratio = (a: string): number | null => {
  const mm = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(a);
  return mm ? Number(mm[1]) / Number(mm[2]) : null;
};

/** Elige el formato permitido más parecido al pedido. */
export function snapAspect(m: KieModelConfig, aspect: string): string {
  const allowed = meta<string[]>(m, "aspectRatios");
  if (!allowed?.length || allowed.includes(aspect)) return aspect;
  const want = ratio(aspect);
  if (want == null) return allowed[0]!;
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const a of allowed) {
    const r = ratio(a);
    if (r == null) continue;
    const diff = Math.abs(Math.log(r / want));
    if (diff < bestDiff) (bestDiff = diff), (best = a);
  }
  // Si lo más parecido está muy lejos (p. ej. 1:1 con solo 16:9 y 9:16), usa "auto" si existe.
  const auto = allowed.find((a) => /^(auto|adaptive)$/i.test(a));
  if (bestDiff > 0.5 && auto) return auto;
  return best ?? auto ?? allowed[0]!;
}

/** Ajusta la duración a lo que acepta el modelo (lista, rango y tipo). */
export function snapDuration(m: KieModelConfig, seconds: number): number | string {
  let v = seconds;
  const list = meta<number[]>(m, "durations");
  if (list?.length) v = list.reduce((best, d) => (Math.abs(d - seconds) < Math.abs(best - seconds) ? d : best), list[0]!);
  const range = meta<[number, number]>(m, "durationRange");
  if (range) v = Math.min(range[1], Math.max(range[0], v));
  const type = meta<string>(m, "durationType");
  if (type === "string") return String(Math.round(v));
  if (type === "integer" || list?.length || range) return Math.round(v);
  return v;
}

export interface BuiltKieRequest {
  path: string;
  body: Record<string, unknown>;
  /** Campos de entrada del modelo (para guardarlos en la receta / depurar). */
  input: Record<string, unknown>;
}

/**
 * Construye el cuerpo HTTP para crear la tarea.
 *  - market:    POST createPath { model, input }
 *  - dedicated: POST createPath { ...input, model? }   (Veo, Suno: cuerpo plano)
 */
export function buildKieRequest(m: KieModelConfig, request: Pick<AiRequest, "prompt" | "negativePrompt" | "params" | "seed">, aspect: string): BuiltKieRequest {
  const input: Record<string, unknown> = inputDefaults(m);
  const params = request.params ?? {};
  const generic: Record<string, unknown> = {
    prompt: request.prompt,
    negativePrompt: request.negativePrompt || undefined,
    seed: request.seed ?? undefined,
    aspectRatio: (params.aspectRatio as string | undefined) ?? aspect,
    duration: params.duration ?? params.durationSec,
    resolution: params.resolution,
    voice: params.voice,
  };
  for (const [k, v] of Object.entries(params)) if (!(k in generic)) generic[k] = v;

  const fieldMap = { ...m.fieldMap };
  if (!fieldMap.prompt) fieldMap.prompt = "prompt";
  for (const [key, value] of Object.entries(generic)) {
    if (value === undefined || value === null || value === "") continue;
    const field = fieldMap[key];
    if (field) {
      let v: unknown = value;
      if (key === "aspectRatio" && typeof v === "string") v = snapAspect(m, v);
      if (key === "duration" && (typeof v === "number" || typeof v === "string")) v = snapDuration(m, Number(v));
      input[field] = v;
    } else if (key in input) {
      // Parámetro nativo del modelo (mismo nombre que en defaults): lo sobrescribe.
      input[key] = value;
    }
  }
  if (m.api === "market") {
    return { path: m.createPath || "/api/v1/jobs/createTask", body: { model: m.model || m.id, input }, input };
  }
  return { path: m.createPath, body: { ...input, ...(m.model ? { model: m.model } : {}) }, input };
}

/** Costo estimado en USD de una generación (según la unidad de precio del modelo). */
export function estimateKieCostUsd(m: KieModelConfig, request: Pick<AiRequest, "prompt" | "params">, usdPerCredit: number): number {
  const unit = meta<string>(m, "unit") ?? "item";
  const baseUsd = m.costUsd || m.costCredits * usdPerCredit;
  let usd = baseUsd;
  if (unit === "second") {
    const base = Number(meta<number>(m, "baseSeconds") ?? m.defaults.duration ?? 5) || 5;
    const secs = Number(request.params?.duration ?? request.params?.durationSec ?? base) || base;
    usd = (baseUsd / base) * secs;
  } else if (unit === "1000_chars") {
    usd = baseUsd * Math.max(1, Math.ceil((request.prompt?.length ?? 1) / 1000));
  }
  return Math.round(usd * 10000) / 10000;
}
