/**
 * Errores del cliente de API. El mensaje siempre está en español y listo para mostrarse.
 * Si el servidor responde con `{ error, message }` (ApiError de @autoeditor/shared) usamos su `message`.
 */
import type { ApiError as ApiErrorBody } from "@autoeditor/shared";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    /** Código HTTP (0 = sin conexión / red caída). */
    public readonly status: number,
    /** Código estable del servidor (p. ej. "no-encontrado") o "red" / "abortado". */
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  /** true si el problema es de conexión (servidor apagado, sin red). */
  get isNetwork(): boolean {
    return this.status === 0 && this.code === "red";
  }

  get isAbort(): boolean {
    return this.code === "abortado";
  }
}

const FALLBACK_BY_STATUS: Record<number, string> = {
  400: "La petición no es válida.",
  401: "Necesitas iniciar sesión.",
  403: "No tienes permiso para hacer esto.",
  404: "No se encontró lo que buscabas.",
  409: "Hay un conflicto con el estado actual. Recarga e intenta de nuevo.",
  413: "El archivo es demasiado grande.",
  415: "Ese tipo de archivo no se puede usar aquí.",
  422: "Faltan datos o hay datos inválidos.",
  429: "Demasiadas peticiones. Espera un momento.",
  500: "El servidor tuvo un problema. Intenta de nuevo.",
  502: "El servidor no está disponible.",
  503: "El servidor no está disponible.",
  504: "El servidor tardó demasiado en responder.",
};

export const NETWORK_MESSAGE = "No hay conexión con el servidor.";

export function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return !!v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string";
}

/** Construye el error a partir de la respuesta (cuerpo JSON opcional). */
export function errorFromResponse(status: number, body: unknown): ApiRequestError {
  if (isApiErrorBody(body)) {
    return new ApiRequestError(body.message, status, body.error || `http-${status}`, body.details);
  }
  const fallback = FALLBACK_BY_STATUS[status] ?? (status >= 500 ? FALLBACK_BY_STATUS[500]! : `Error inesperado (${status}).`);
  return new ApiRequestError(fallback, status, `http-${status}`, body);
}

export function networkError(cause?: unknown): ApiRequestError {
  return new ApiRequestError(NETWORK_MESSAGE, 0, "red", cause);
}

export function abortError(): ApiRequestError {
  return new ApiRequestError("Se canceló la operación.", 0, "abortado");
}

/** Mensaje en español para cualquier error (para toasts). */
export function messageOf(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Ocurrió un error inesperado.";
}
