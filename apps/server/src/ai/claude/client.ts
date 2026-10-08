/**
 * Cliente de Claude (SDK oficial @anthropic-ai/sdk) y utilidades comunes del editor:
 *  - parámetros base de cada petición (modelo, esfuerzo, caché de prompt, respaldo del lado del servidor);
 *  - conversión de errores del SDK y de rechazos (stop_reason "refusal") a UserFacingError en español;
 *  - contador de tokens y costo con los precios de config/models.json;
 *  - llamada con salida estructurada (zod) en streaming.
 *
 * Reglas del modelo (Claude Opus 5.5 / Sonnet 5.5): el razonamiento no se puede desactivar (no se envía
 * `thinking`; la profundidad se controla con output_config.effort), tool_choice forzado da 400 (se usa
 * "auto" + instrucción + herramientas strict) y no hay prefill del asistente.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaContentBlockParam, BetaMessage, BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import type { ModelsConfig } from "@autoeditor/shared";
import type { AiDeps } from "../deps.js";
import type { Usage } from "../../services/types.js";
import { UserFacingError } from "../../services/types.js";
import { addUsage, emptyUsage } from "../shared/usage.js";

export type Effort = ModelsConfig["claude"]["effort"];

/** Beta del respaldo automático del lado del servidor (forma "default": enruta por categoría de rechazo). */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Tokens máximos de salida con streaming (generoso: el editor escribe recetas completas). */
export const MAX_TOKENS_STREAMING = 64_000;

export interface ClaudeRuntime {
  client: Anthropic;
  models: ModelsConfig;
  log: AiDeps["log"];
  /** Streaming de las respuestas (por defecto sí; las pruebas lo apagan para simular respuestas JSON). */
  stream: boolean;
}

export interface ClaudeRuntimeOptions {
  /** Cliente inyectable (pruebas). */
  client?: Anthropic;
  stream?: boolean;
}

export function createRuntime(deps: AiDeps, opts: ClaudeRuntimeOptions = {}): ClaudeRuntime {
  const client = opts.client ?? new Anthropic({ apiKey: deps.env.anthropicApiKey, maxRetries: 3 });
  return { client, models: deps.models, log: deps.log, stream: opts.stream ?? true };
}

/** Modelo y esfuerzo para el editor principal o el ayudante (tareas simples). */
export function modelFor(models: ModelsConfig, role: "editor" | "helper"): { model: string; effort: Effort } {
  const c = models.claude;
  return role === "editor" ? { model: c.editor, effort: c.effort } : { model: c.helper, effort: c.helperEffort };
}

/**
 * Parámetros comunes de toda petición: modelo, esfuerzo, caché automática (top-level) y, si está
 * activado en la configuración, el respaldo del lado del servidor ante rechazos.
 */
export function baseParams(models: ModelsConfig, role: "editor" | "helper") {
  const { model, effort } = modelFor(models, role);
  return {
    model,
    output_config: { effort },
    cache_control: { type: "ephemeral" as const },
    ...(models.claude.serverSideFallback ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

/** Prompt de sistema como bloque de texto (estable: sin fechas ni ids, para que la caché funcione). */
export function systemBlocks(text: string): BetaTextBlockParam[] {
  return [{ type: "text", text }];
}

// ---------------------------------------------------------------------------
// Uso y costo
// ---------------------------------------------------------------------------

/** Acumula tokens y costo de todas las respuestas de una tarea. */
export class UsageMeter {
  private acc: Usage;
  constructor(
    private readonly models: ModelsConfig,
    model: string,
  ) {
    this.acc = emptyUsage(model);
  }
  add(message: Pick<BetaMessage, "usage" | "model">): void {
    this.acc = addUsage(this.models, this.acc, message.model || this.acc.model, message.usage);
  }
  get usage(): Usage {
    return { ...this.acc };
  }
}

// ---------------------------------------------------------------------------
// Rechazos y errores
// ---------------------------------------------------------------------------

const REFUSAL_CATEGORY: Record<string, string> = {
  cyber: "seguridad informática",
  bio: "riesgo biológico",
  frontier_llm: "desarrollo de modelos de IA",
  reasoning_extraction: "extracción del razonamiento interno",
  general_harms: "contenido dañino",
};

/** Lanza un UserFacingError claro si Claude rechazó la petición (revisar ANTES de leer el contenido). */
export function assertNotRefused(message: Pick<BetaMessage, "stop_reason" | "stop_details">, what: string): void {
  if (message.stop_reason !== "refusal") return;
  const details = message.stop_details;
  const category = details?.category ?? null;
  const label = category ? (REFUSAL_CATEGORY[category] ?? category) : null;
  throw new UserFacingError(
    "claude-rechazo",
    `Claude no pudo ${what}: sus filtros de seguridad rechazaron la petición${label ? ` (categoría: ${label})` : ""}. ` +
      "Revisa la instrucción, el guion o el material (a veces un término técnico se malinterpreta) y vuelve a intentarlo con otras palabras.",
    422,
    { category, explanation: details?.explanation ?? null },
  );
}

/** Convierte errores del SDK (tipados) en errores para el usuario en español. Deja pasar los UserFacingError. */
export function toClaudeUserError(err: unknown, what: string): Error {
  if (err instanceof UserFacingError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new UserFacingError("claude-cancelado", `Se canceló la tarea de Claude (${what}).`, 499);
  if (err instanceof Anthropic.AuthenticationError) {
    return new UserFacingError("claude-llave-invalida", "La llave de Claude (ANTHROPIC_API_KEY) no es válida o fue revocada. Revísala en el archivo .env del servidor.", 401);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new UserFacingError("claude-sin-permiso", "Tu llave de Claude no tiene permiso para usar este modelo. Revisa tu cuenta en console.anthropic.com o cambia el modelo en config/models.json.", 403);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new UserFacingError("claude-modelo-no-disponible", "El modelo de Claude configurado no existe o no está disponible para tu cuenta. Revisa config/models.json.", 404);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new UserFacingError("claude-limite", "Claude está limitando las peticiones de tu cuenta (demasiadas en poco tiempo). Espera un minuto y vuelve a intentarlo.", 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    // El saldo insuficiente llega como 400 invalid_request_error: solo el mensaje lo distingue.
    const msg = err.message ?? "";
    if (/credit balance/i.test(msg)) {
      return new UserFacingError("claude-sin-creditos", "Tu cuenta de Claude no tiene saldo suficiente. Recarga créditos en console.anthropic.com y vuelve a intentarlo.", 402);
    }
    return new UserFacingError("claude-peticion-invalida", `Claude no aceptó la petición (${what}): ${msg.slice(0, 300)}`, 502);
  }
  if (err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && (err.status === 529 || (err.status ?? 0) >= 500))) {
    return new UserFacingError("claude-saturado", "Los servidores de Claude están saturados o fallaron. Vuelve a intentarlo en unos minutos.", 503);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new UserFacingError("claude-tiempo-agotado", `Claude tardó demasiado en responder (${what}). Vuelve a intentarlo.`, 504);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new UserFacingError("claude-sin-conexion", "No hay conexión con la API de Claude (api.anthropic.com). Revisa la red del servidor.", 503);
  }
  if (err instanceof Anthropic.APIError) {
    return new UserFacingError("claude-error", `Claude respondió con un error (${err.status ?? "?"}) al ${what}: ${err.message.slice(0, 300)}`, 502);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Texto plano de la respuesta (bloques de texto unidos). */
export function textOf(message: Pick<BetaMessage, "content">): string {
  return message.content
    .filter((b): b is Extract<BetaMessage["content"][number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Llamada con salida estructurada
// ---------------------------------------------------------------------------

export interface StructuredCall<T> {
  role: "editor" | "helper";
  system: string;
  content: string | BetaContentBlockParam[];
  schema: z.ZodType<T>;
  /** Qué está haciendo Claude (para los mensajes de error: "revisar la calidad", "detectar palabras clave"…). */
  what: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Una petición con salida estructurada (output_config.format con zod). Revisa rechazos y cortes por
 * max_tokens antes de leer el resultado, y suma el uso al medidor.
 */
export async function callStructured<T>(rt: ClaudeRuntime, meter: UsageMeter, call: StructuredCall<T>): Promise<T> {
  const base = baseParams(rt.models, call.role);
  const params = {
    ...base,
    max_tokens: call.maxTokens ?? (rt.stream ? MAX_TOKENS_STREAMING : 16_000),
    system: systemBlocks(call.system),
    messages: [{ role: "user" as const, content: call.content }],
    output_config: { ...base.output_config, format: betaZodOutputFormat(call.schema) },
  };
  let message: BetaMessage & { parsed_output?: T | null };
  try {
    message = rt.stream
      ? await rt.client.beta.messages.stream(params, { signal: call.signal }).finalMessage()
      : await rt.client.beta.messages.parse(params, { signal: call.signal });
  } catch (err) {
    throw toClaudeUserError(err, call.what);
  }
  meter.add(message);
  assertNotRefused(message, call.what);
  if (message.stop_reason === "max_tokens") {
    throw new UserFacingError("claude-respuesta-cortada", `La respuesta de Claude se cortó por largo al ${call.what}. Vuelve a intentarlo.`, 502);
  }
  if (message.parsed_output != null) return message.parsed_output;
  // Respaldo: interpretar el texto con el esquema (p. ej. si el SDK no adjuntó parsed_output).
  try {
    return call.schema.parse(JSON.parse(textOf(message)));
  } catch {
    throw new UserFacingError("claude-respuesta-invalida", `Claude respondió en un formato inesperado al ${call.what}. Vuelve a intentarlo.`, 502);
  }
}

/** Una petición de texto libre (streaming). Revisa rechazos antes de leer el contenido. */
export async function callText(
  rt: ClaudeRuntime,
  meter: UsageMeter,
  call: { role: "editor" | "helper"; system: string; content: string | BetaContentBlockParam[]; what: string; maxTokens?: number; signal?: AbortSignal },
): Promise<string> {
  const params = {
    ...baseParams(rt.models, call.role),
    max_tokens: call.maxTokens ?? (rt.stream ? MAX_TOKENS_STREAMING : 16_000),
    system: systemBlocks(call.system),
    messages: [{ role: "user" as const, content: call.content }],
  };
  let message: BetaMessage;
  try {
    message = rt.stream ? await rt.client.beta.messages.stream(params, { signal: call.signal }).finalMessage() : await rt.client.beta.messages.create(params, { signal: call.signal });
  } catch (err) {
    throw toClaudeUserError(err, call.what);
  }
  meter.add(message);
  assertNotRefused(message, call.what);
  const text = textOf(message);
  if (!text) throw new UserFacingError("claude-respuesta-vacia", `Claude no devolvió texto al ${call.what}. Vuelve a intentarlo.`, 502);
  return text;
}
