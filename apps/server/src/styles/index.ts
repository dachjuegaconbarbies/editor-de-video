/**
 * ESTILOS guardados: preset reutilizable + ficha de reglas + Skill de Claude exportable (zip).
 *
 * Implementación inicial (ola 1): `settingsForNewProject` (arrancar un proyecto desde un estilo).
 * Guardar/actualizar/exportar/importar los completa la ola 2.
 */
import { ProjectSettings, type StyleVersion } from "@autoeditor/shared";
import type { AppContext, StyleApi } from "../context.js";
import { UserFacingError } from "../services/types.js";

const notYet = (): never => {
  throw new UserFacingError("no-implementado", "Esta función aún no está disponible", 501);
};

export function createStyleApi(ctx: AppContext): StyleApi {
  const { db } = ctx;

  async function settingsForNewProject(ownerId: string, styleId: string): Promise<{ settings: ProjectSettings; styleVersion: StyleVersion }> {
    const style = await db.styles.get(ownerId, styleId);
    if (!style) throw new UserFacingError("estilo-no-encontrado", "No encontré ese estilo", 404);
    const styleVersion = await db.styleVersions.getByNumber(ownerId, style.id, style.currentVersion);
    if (!styleVersion) throw new UserFacingError("estilo-sin-version", "Ese estilo no tiene una versión guardada", 409);
    const preset = styleVersion.preset;
    // El preset guarda secciones completas de settings; lo que no trae queda con los valores por defecto.
    const base = ProjectSettings.parse({});
    const settings = ProjectSettings.parse({
      ...base,
      ...preset.settings,
      instruction: {
        ...base.instruction,
        ...(preset.settings.instruction ?? {}),
        text: preset.settings.instruction?.text || preset.baseInstruction || base.instruction.text,
      },
      style: { styleId: style.id, styleVersion: styleVersion.number },
    });
    await db.styles.update(ownerId, style.id, (s) => ({ ...s, timesUsed: s.timesUsed + 1 }));
    return { settings, styleVersion };
  }

  return {
    create: async () => notYet(),
    update: async () => notYet(),
    exportZip: async () => notYet(),
    importZip: async () => notYet(),
    settingsForNewProject,
  };
}
