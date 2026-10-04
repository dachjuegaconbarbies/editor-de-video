import { defaultProjectSettings, type ProjectSettings } from "@autoeditor/shared";

/**
 * Configuración por defecto como copia PROFUNDA.
 * Ojo: `defaultProjectSettings()` (zod `.default(...)`) comparte objetos anidados entre llamadas
 * (p. ej. `tools.aiImages`), así que mutar su resultado contamina los siguientes. Aquí siempre clonamos.
 */
export function freshSettings(): ProjectSettings {
  return structuredClone(defaultProjectSettings());
}
