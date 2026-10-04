/**
 * Etapas del flujo (de izquierda a derecha). Son la navegación: el stepper de arriba, los nodos
 * del lienzo y la vista enfocada usan estos ids.
 */
export type StageId = "material" | "contexto" | "transcripcion" | "herramientas" | "instruccion" | "plan" | "resultado" | "versiones";

export const STAGE_ORDER: StageId[] = ["material", "contexto", "transcripcion", "herramientas", "instruccion", "plan", "resultado", "versiones"];

export const STAGE_TITLES: Record<StageId, string> = {
  material: "Material",
  contexto: "Contexto",
  transcripcion: "Transcripción",
  herramientas: "Herramientas",
  instruccion: "Instrucción",
  plan: "Plan",
  resultado: "Resultado",
  versiones: "Versiones",
};

/** Estado visible de un nodo/etapa. */
export type NodeStatus = "vacio" | "listo" | "procesando" | "error" | "opcional" | "esperando";

export const STATUS_LABELS: Record<NodeStatus, string> = {
  vacio: "Vacío",
  listo: "Listo",
  procesando: "Procesando",
  error: "Error",
  opcional: "Opcional",
  esperando: "Esperando",
};

export interface StageState {
  status: NodeStatus;
  /** Qué le falta o qué está pasando, en una frase corta. */
  hint: string;
}

export type ContextKey = "script" | "brand" | "references";

export const CONTEXT_LABELS: Record<ContextKey, { pill: string; chip: string; title: string }> = {
  script: { pill: "TENGO GUION", chip: "Guion", title: "Guion" },
  brand: { pill: "TENGO IDENTIDAD DE MARCA", chip: "Marca", title: "Identidad de marca" },
  references: { pill: "TENGO REFERENCIAS VISUALES", chip: "Referencias", title: "Referencias visuales" },
};

export const CONTEXT_KEYS: ContextKey[] = ["script", "brand", "references"];
