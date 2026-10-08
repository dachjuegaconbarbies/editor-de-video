/**
 * Herramientas compartidas por las sesiones de Claude (planear, ajustar, corregir):
 * material, transcripción por rangos, fotogramas del material, plantillas de motion graphics y el
 * formato de operaciones de parche. Todas son `strict` (esquema garantizado) y se definen con zod.
 *
 * Las definiciones (nombre, descripción, esquema) son FIJAS: forman parte del prefijo cacheado.
 * Los datos de cada proyecto llegan por el cierre (closure) de `run`, nunca por la definición.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type { BetaToolResultContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { MotionTemplate } from "@autoeditor/shared";
import type { EditInput } from "../../services/types.js";
import { assetDetail, materialInventory } from "../prompts/context.js";
import type { PatchOp } from "../shared/recipe-ops.js";
import { round2 } from "../shared/text.js";
import { wordsByAsset } from "../shared/transcript.js";

/** Herramienta del runner con esquema estricto (las restricciones no soportadas pasan a la descripción). */
export function strictTool<T>(tool: BetaRunnableTool<T>): BetaRunnableTool<T> {
  const t = tool as BetaRunnableTool<T> & { input_schema: Record<string, unknown> };
  const { $schema: _ignored, ...schema } = transformJSONSchema(t.input_schema) as Record<string, unknown>;
  return { ...t, input_schema: schema as typeof t.input_schema, strict: true } as BetaRunnableTool<T>;
}

export type ToolOutput = string | BetaToolResultContentBlockParam[];

/** Estado compartido de una sesión (lo que las herramientas van produciendo). */
export interface SessionCommon {
  newTemplates: MotionTemplate[];
}

/** Ancho de los fotogramas que ve Claude (ahorra tokens sin perder legibilidad de textos). */
export const FRAME_WIDTH = 512;
const MAX_FRAMES = 6;
const MAX_WORDS_PER_READ = 500;

export function imageBlock(base64: string, mediaType: "image/jpeg" | "image/png" = "image/jpeg"): BetaToolResultContentBlockParam {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

// ---------------------------------------------------------------------------
// Operaciones de parche (RFC 6902) — formato estricto: el valor viaja como JSON en texto
// ---------------------------------------------------------------------------

export const PatchOpInput = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string().describe("JSON Pointer, p. ej. /tracks/text/0/font/family"),
  from: z.string().nullable().describe("Solo para move/copy; null en los demás"),
  valor_json: z.string().nullable().describe('Valor en JSON (p. ej. "\\"Montserrat\\"", "-20", "{...}"); null para remove/move/copy'),
});
export type PatchOpInput = z.infer<typeof PatchOpInput>;

/** Convierte las operaciones de la herramienta a RFC 6902; devuelve errores legibles si el JSON no es válido. */
export function toPatchOps(ops: PatchOpInput[]): { ops: PatchOp[]; errors: string[] } {
  const out: PatchOp[] = [];
  const errors: string[] = [];
  ops.forEach((o, i) => {
    const op: PatchOp = { op: o.op, path: o.path };
    if (o.op === "move" || o.op === "copy") {
      if (!o.from) errors.push(`Operación #${i} (${o.op}): falta "from".`);
      else op.from = o.from;
    }
    if (o.op === "add" || o.op === "replace" || o.op === "test") {
      if (o.valor_json == null) errors.push(`Operación #${i} (${o.op} ${o.path}): falta valor_json.`);
      else {
        try {
          op.value = JSON.parse(o.valor_json);
        } catch {
          errors.push(`Operación #${i} (${o.op} ${o.path}): valor_json no es JSON válido (los textos van entre comillas: "\\"hola\\"").`);
        }
      }
    }
    out.push(op);
  });
  return { ops: out, errors };
}

// ---------------------------------------------------------------------------
// Material y transcripción
// ---------------------------------------------------------------------------

export function materialTools(input: EditInput) {
  const byAsset = wordsByAsset(input.transcripts);
  const assetIds = new Set(input.assets.map((a) => a.id));

  const verMaterial = strictTool(
    betaZodTool({
      name: "ver_material",
      description:
        "Resumen del material del proyecto (videos, fotos, audio) con duración, rol (a-roll/b-roll), prioridad, silencios, cambios de escena, rostros y fragmentos aprovechables como b-roll. Con asset_id = null lista todo; con un id da el detalle de ese archivo.",
      inputSchema: z.object({ asset_id: z.string().nullable().describe("Id del archivo o null para el inventario completo") }),
      run: async ({ asset_id }) => {
        if (!asset_id) return materialInventory(input.assets);
        const a = input.assets.find((x) => x.id === asset_id);
        if (!a) return `No existe el archivo ${asset_id}. Ids válidos: ${[...assetIds].join(", ")}`;
        return JSON.stringify(assetDetail(a));
      },
    }),
  );

  const leerTranscripcion = strictTool(
    betaZodTool({
      name: "leer_transcripcion",
      description:
        "Lee la transcripción de un archivo entre dos segundos del ORIGINAL. Cada palabra: [índice] inicio–fin texto, con marcas del usuario {quitar|debe-ir|resaltar} y (muletilla). Los huecos ≥ 0.4 s se muestran como «· pausa X s ·». Usa estos tiempos para cortar entre palabras.",
      inputSchema: z.object({
        asset_id: z.string(),
        desde: z.number().describe("Segundo inicial en el archivo original"),
        hasta: z.number().describe("Segundo final en el archivo original"),
      }),
      run: async ({ asset_id, desde, hasta }) => {
        const words = byAsset.get(asset_id);
        if (!words) return `El archivo ${asset_id} no tiene transcripción lista. Con transcripción: ${[...byAsset.keys()].join(", ") || "ninguno"}.`;
        const inRange = words.filter((w) => w.end >= desde && w.start <= hasta);
        if (!inRange.length) return `No hay palabras entre ${desde} y ${hasta} s (la transcripción va de ${round2(words[0]!.start)} a ${round2(words[words.length - 1]!.end)} s).`;
        const shown = inRange.slice(0, MAX_WORDS_PER_READ);
        const lines: string[] = [];
        shown.forEach((w, k) => {
          const prev = k > 0 ? shown[k - 1] : null;
          if (prev && w.start - prev.end >= 0.4) lines.push(`· pausa ${round2(w.start - prev.end)} s ·`);
          lines.push(`[${w.i}] ${round2(w.start)}–${round2(w.end)} ${w.text}${w.mark ? ` {${w.mark}}` : ""}${w.filler ? " (muletilla)" : ""}`);
        });
        const more = inRange.length > shown.length ? `\n…(${inRange.length - shown.length} palabras más: pide desde ${round2(shown[shown.length - 1]!.end)} s)` : "";
        return lines.join("\n") + more;
      },
    }),
  );

  const verFotogramas = strictTool(
    betaZodTool({
      name: "ver_fotogramas",
      description: `Fotogramas de un archivo del material (video o foto) en los segundos indicados del ORIGINAL (máximo ${MAX_FRAMES} por llamada). Sirve para ver encuadre, rostros, texto en pantalla y qué muestra un b-roll.`,
      inputSchema: z.object({ asset_id: z.string(), tiempos: z.array(z.number()).describe("Segundos del archivo original") }),
      run: async ({ asset_id, tiempos }): Promise<ToolOutput> => {
        const a = input.assets.find((x) => x.id === asset_id);
        if (!a) return `No existe el archivo ${asset_id}.`;
        if (a.kind !== "video" && a.kind !== "imagen") return `El archivo ${asset_id} es de tipo ${a.kind}: no tiene imagen.`;
        const times = (a.kind === "imagen" ? [0] : tiempos.slice(0, MAX_FRAMES)).map((t) => Math.max(0, Math.min(t, (a.probe.duration ?? t + 0.1) - 0.05)));
        const blocks: BetaToolResultContentBlockParam[] = [];
        for (const t of times) {
          const frame = await input.toolbox.sourceFrame(asset_id, t, FRAME_WIDTH);
          blocks.push({ type: "text", text: `${asset_id} @ ${round2(t)} s` }, imageBlock(frame.base64, frame.mediaType));
        }
        return blocks;
      },
    }),
  );

  return { verMaterial, leerTranscripcion, verFotogramas };
}

// ---------------------------------------------------------------------------
// Plantillas de motion graphics
// ---------------------------------------------------------------------------

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function templateTools(input: EditInput, state: SessionCommon) {
  const listarPlantillas = strictTool(
    betaZodTool({
      name: "listar_plantillas",
      description: "Lista las plantillas de motion graphics disponibles (de fábrica, del estilo, del proyecto y las que escribiste en esta sesión) con sus propiedades y duración sugerida.",
      inputSchema: z.object({}),
      run: async () => {
        const all = [...input.toolbox.motionTemplates(), ...state.newTemplates];
        if (!all.length) return "No hay plantillas disponibles.";
        return JSON.stringify(
          all.map((t) => ({ id: t.id, nombre: t.name, motor: t.engine, descripcion: t.description, duracion: t.defaultDuration, props: t.propsSchema })),
        );
      },
    }),
  );

  const guiaHyperframes = strictTool(
    betaZodTool({
      name: "guia_hyperframes",
      description: "Guía de autoría de HyperFrames (HTML + GSAP) para escribir plantillas de motion graphics válidas. Léela antes de escribir_plantilla.",
      inputSchema: z.object({}),
      run: async () => input.toolbox.hyperframesGuide(),
    }),
  );

  const escribirPlantilla = strictTool(
    betaZodTool({
      name: "escribir_plantilla",
      description:
        "Escribe una plantilla nueva de motion graphics (HyperFrames: HTML con root data-composition-id y UNA timeline GSAP pausada en window.__timelines) con marcadores {{prop}}. Después úsala en tracks.graphics con su templateId.",
      inputSchema: z.object({
        id: z.string().describe("Id en minúsculas con guiones, p. ej. contador-cifra"),
        nombre: z.string(),
        descripcion: z.string(),
        html: z.string().describe("Documento HTML completo de la composición"),
        props: z.array(
          z.object({
            nombre: z.string(),
            tipo: z.enum(["string", "number", "color", "boolean"]),
            por_defecto: z.string().nullable(),
            etiqueta: z.string(),
          }),
        ),
        duracion: z.number().describe("Duración sugerida en segundos"),
      }),
      run: async (args) => {
        const errors: string[] = [];
        if (!TEMPLATE_ID.test(args.id)) errors.push("El id debe ir en minúsculas, con letras, números y guiones (2-49 caracteres).");
        if (input.toolbox.motionTemplates().some((t) => t.id === args.id)) errors.push(`Ya existe una plantilla con id ${args.id}: usa otro.`);
        if (!/data-composition-id\s*=/.test(args.html)) errors.push("Falta el root con data-composition-id.");
        if (!/__timelines/.test(args.html)) errors.push("Falta registrar la timeline en window.__timelines.");
        if (!(args.duracion > 0 && args.duracion <= 30)) errors.push("La duración debe estar entre 0 y 30 s.");
        if (errors.length) return `No se guardó la plantilla:\n- ${errors.join("\n- ")}`;
        const propsSchema: MotionTemplate["propsSchema"] = {};
        for (const p of args.props) {
          const def = p.por_defecto == null ? undefined : p.tipo === "number" ? Number(p.por_defecto) : p.tipo === "boolean" ? p.por_defecto === "true" : p.por_defecto;
          propsSchema[p.nombre] = { type: p.tipo, label: p.etiqueta, ...(def !== undefined ? { default: def } : {}) };
        }
        const template: MotionTemplate = { id: args.id, name: args.nombre, engine: "hyperframes", source: args.html, propsSchema, defaultDuration: args.duracion, description: args.descripcion };
        state.newTemplates = [...state.newTemplates.filter((t) => t.id !== args.id), template];
        const missing = args.props.filter((p) => !args.html.includes(`{{${p.nombre}}}`)).map((p) => p.nombre);
        return `Plantilla «${args.id}» guardada para esta edición.${missing.length ? ` Aviso: el HTML no usa los marcadores ${missing.map((m) => `{{${m}}}`).join(", ")}.` : ""} Úsala en tracks.graphics con "templateId": "${args.id}", "engine": "hyperframes".`;
      },
    }),
  );

  return { listarPlantillas, guiaHyperframes, escribirPlantilla };
}
