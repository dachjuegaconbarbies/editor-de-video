/**
 * Traducción de errores de Kie AI a mensajes claros en español (UserFacingError con código estable).
 * La app debe decir claro qué pasó y seguir sin esa parte (PROMPT.md §4.4).
 */
import { UserFacingError } from "../../services/types.js";
import { KieApiError } from "./client.js";

const MODERATION = /sensitive|content policy|policy|moderat|inappropriate|nsfw|violat|prohibit|unsafe|not allowed|flagged|english prompts only/i;
const MODEL_GONE = /model|not supported|unsupported|not exist|not found|disabled|deprecat|invalid model|offline/i;

/** Convierte cualquier error del flujo de Kie en un UserFacingError en español. */
export function toKieUserError(err: unknown, ctx: { model: string; kind: string }): UserFacingError {
  if (err instanceof UserFacingError) return err;
  if (!(err instanceof KieApiError)) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|cancel/i.test(msg)) return new UserFacingError("kie-cancelado", "Se canceló la generación con IA.", 499);
    return new UserFacingError("kie-error", `Falló la generación con IA (${ctx.kind}, ${ctx.model}): ${msg}`, 502);
  }
  const body = err.body as { msg?: string } | null;
  const detail = (typeof body === "object" && body && typeof body.msg === "string" ? body.msg : err.message) || "";
  const details = { model: ctx.model, kind: ctx.kind, code: err.code, stage: err.stage };
  switch (true) {
    case err.code === 402:
      return new UserFacingError(
        "kie-sin-creditos",
        "Tu cuenta de Kie AI no tiene créditos suficientes para esta generación. Recarga en https://kie.ai y vuelve a intentarlo; mientras tanto el video sigue sin esa parte.",
        402,
        details,
      );
    case err.code === 401:
      return new UserFacingError("kie-llave-invalida", "La llave de Kie AI (KIE_API_KEY) no es válida o fue revocada. Revísala en el archivo .env del servidor.", 401, details);
    case err.code === 408 && err.stage === "esperar":
      return new UserFacingError(
        "kie-tiempo-agotado",
        `Kie AI tardó demasiado en generar (${ctx.kind}, ${ctx.model}). La tarea puede terminar después; vuelve a intentarlo más tarde o elige un modelo más rápido.`,
        504,
        details,
      );
    case err.code === 400 || (err.stage === "esperar" && MODERATION.test(detail)) || /SENSITIVE_WORD/i.test(detail):
      return new UserFacingError(
        "kie-contenido-rechazado",
        `Kie AI rechazó el pedido por su política de contenido (${ctx.model}). Cambia el prompt (evita marcas, personas reales o temas sensibles; algunos modelos solo aceptan inglés) y vuelve a intentarlo.`,
        422,
        { ...details, detail },
      );
    case err.code === 404 || err.code === 505 || (err.code === 422 && MODEL_GONE.test(detail)):
      return new UserFacingError(
        "kie-modelo-no-disponible",
        `El modelo «${ctx.model}» no está disponible en Kie AI ahora mismo. Elige otro en config/providers.json o en la herramienta de IA.`,
        424,
        { ...details, detail },
      );
    case err.code === 422:
      return new UserFacingError("kie-parametros-invalidos", `Kie AI no aceptó los parámetros del pedido (${ctx.model}): ${detail}`, 422, details);
    case err.code === 429 || err.code === 433:
      return new UserFacingError("kie-limite", "Kie AI está limitando las peticiones (demasiadas en poco tiempo). Espera un momento y vuelve a intentarlo.", 429, details);
    case err.code === 455:
      return new UserFacingError("kie-mantenimiento", "Kie AI está en mantenimiento. Vuelve a intentarlo en unos minutos.", 503, details);
    case err.ambiguous && err.stage === "crear":
      return new UserFacingError(
        "kie-creacion-incierta",
        "Se perdió la conexión con Kie AI justo al crear la tarea: no sé si se creó (y se cobró). No la reenvío en automático; revisa tu saldo en kie.ai antes de reintentar.",
        502,
        details,
      );
    case err.stage === "esperar":
      return new UserFacingError("kie-generacion-fallida", `Kie AI no pudo generar el ${ctx.kind} (${ctx.model}): ${detail || "sin detalle"}. Puedes reintentar o elegir otro modelo.`, 502, { ...details, detail });
    case err.stage === "descargar":
      return new UserFacingError("kie-descarga-fallida", `Kie AI generó el ${ctx.kind}, pero no se pudo descargar: ${detail}.`, 502, details);
    case err.code === 0:
      return new UserFacingError("kie-sin-conexion", "No hay conexión con Kie AI (api.kie.ai). Revisa la red del servidor.", 503, details);
    default:
      return new UserFacingError("kie-error", `Kie AI respondió con un error (${err.code}): ${detail}`, 502, details);
  }
}
