/**
 * Datos de un proyecto para editar: material, transcripciones, palabras clave, reglas, glosario,
 * marca, estilo y plantillas → `EditInput` (lo que reciben Claude y el editor demo).
 */
import { readFile } from "node:fs/promises";
import type { Asset, Brand, Keyword, MotionTemplate, Project, ProjectSettings, StyleVersion, Transcript } from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import { scopeMatches } from "../memory/index.js";
import { factoryTemplates } from "../motion/index.js";
import type { EditInput } from "../services/types.js";
import { memoryScopeFor } from "./assets.js";
import { createToolbox } from "./toolbox.js";

/** Categorías que son resultado interno (no material para editar). */
const INTERNAL_CATEGORIES = new Set<Asset["category"]>(["render", "motion-render"]);

/** Clave en kv de las plantillas de motion graphics escritas para un proyecto. */
export const projectTemplatesKey = (projectId: string) => `motion-templates:${projectId}`;

export interface ProjectData {
  project: Project;
  /** Material del proyecto (sin renders internos) + assets de la marca de la biblioteca. */
  assets: Asset[];
  /** Todo lo que una receta puede referenciar (incluye renders de motion graphics). */
  allAssets: Asset[];
  transcripts: Transcript[];
  keywords: Keyword[];
  brand: Brand | null;
  style: { version: StyleVersion; skillMarkdown: string } | null;
  templates: MotionTemplate[];
  /** Settings efectivos para editar (p. ej. con el guion subido como archivo ya leído). */
  settings: ProjectSettings;
}

async function brandAssets(ctx: AppContext, ownerId: string, brand: Brand | null, known: Set<string>): Promise<Asset[]> {
  if (!brand) return [];
  const ids = [
    ...brand.logoAssetIds,
    ...brand.fontAssetIds,
    ...brand.transitionAssetIds,
    ...(brand.introAssetId ? [brand.introAssetId] : []),
    ...(brand.outroAssetId ? [brand.outroAssetId] : []),
  ];
  const out: Asset[] = [];
  for (const id of ids) {
    if (known.has(id)) continue;
    const a = await ctx.db.assets.get(ownerId, id);
    if (a) {
      out.push(a);
      known.add(id);
    }
  }
  return out;
}

/** Texto de un guion subido como archivo (txt/md), recortado. */
async function readScriptAsset(ctx: AppContext, asset: Asset): Promise<string> {
  const textual = asset.mimeType.startsWith("text/") || /\.(txt|md|srt|vtt)$/i.test(asset.originalName);
  if (!textual || asset.sizeBytes > 512 * 1024) return "";
  try {
    return (await readFile(await ctx.services.storage.localPath(asset.storageKey), "utf8")).slice(0, 20_000).trim();
  } catch {
    return "";
  }
}

/** Settings efectivos: si subieron un guion como archivo y no escribieron texto, se usa el archivo. */
async function effectiveSettings(ctx: AppContext, project: Project, assets: Asset[]): Promise<ProjectSettings> {
  const s = project.settings;
  if (s.context.script.text.trim()) return s;
  const byId = s.context.script.fileAssetId ? assets.find((a) => a.id === s.context.script.fileAssetId) : undefined;
  const scriptAsset = byId ?? assets.find((a) => a.category === "guion");
  if (!scriptAsset) return s;
  const text = await readScriptAsset(ctx, scriptAsset);
  if (!text) return s;
  return { ...s, context: { ...s.context, script: { ...s.context.script, enabled: true, text } } };
}

export async function loadProjectData(ctx: AppContext, ownerId: string, project: Project): Promise<ProjectData> {
  const { db } = ctx;
  const [rawAssets, transcripts, kwRecord] = await Promise.all([
    db.assets.list(ownerId, { projectId: project.id }, { orderBy: "order" }),
    db.transcripts.list(ownerId, { projectId: project.id }),
    db.keywords.get(ownerId, project.id),
  ]);
  const s = project.settings;
  const brandId = s.context.brand.enabled ? s.context.brand.brandId : null;
  const brand = brandId ? await db.brands.get(ownerId, brandId) : null;
  const known = new Set(rawAssets.map((a) => a.id));
  const fromBrand = await brandAssets(ctx, ownerId, brand, known);

  let style: ProjectData["style"] = null;
  if (s.style.styleId) {
    const st = await db.styles.get(ownerId, s.style.styleId);
    if (st) {
      const version = await db.styleVersions.getByNumber(ownerId, st.id, s.style.styleVersion ?? st.currentVersion);
      if (version) style = { version, skillMarkdown: version.rulesMarkdown };
    }
  }
  const engine = s.tools.motionGraphics.engine === "builtin" ? "builtin" : "hyperframes";
  const projectTemplates = (await db.kv.get<MotionTemplate[]>(ownerId, projectTemplatesKey(project.id))) ?? [];
  const seen = new Set<string>();
  const templates: MotionTemplate[] = [];
  for (const t of [...projectTemplates, ...(style?.version.preset.templates ?? []), ...factoryTemplates(engine)]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    templates.push(t);
  }
  const all = [...rawAssets, ...fromBrand];
  const material = all.filter((a) => !INTERNAL_CATEGORIES.has(a.category));
  return {
    project,
    assets: material,
    allAssets: all,
    transcripts,
    keywords: kwRecord?.keywords ?? [],
    brand,
    style,
    templates,
    settings: await effectiveSettings(ctx, project, material),
  };
}

/** Guarda plantillas nuevas que escribió el editor (para renders y correcciones futuras). */
export async function saveProjectTemplates(ctx: AppContext, ownerId: string, projectId: string, templates: MotionTemplate[]): Promise<void> {
  if (!templates.length) return;
  const current = (await ctx.db.kv.get<MotionTemplate[]>(ownerId, projectTemplatesKey(projectId))) ?? [];
  const byId = new Map(current.map((t) => [t.id, t]));
  for (const t of templates) byId.set(t.id, t);
  await ctx.db.kv.set(ownerId, projectTemplatesKey(projectId), [...byId.values()]);
}

/** Arma la entrada del editor (con su caja de herramientas). */
export async function buildEditInput(ctx: AppContext, ownerId: string, data: ProjectData, workDir: string, extra: Partial<EditInput> = {}): Promise<EditInput> {
  const scope = memoryScopeFor(data.project);
  const [rules, glossaryAll] = await Promise.all([ctx.memory.rulesFor(ownerId, scope), ctx.db.glossary.list(ownerId)]);
  const toolbox = createToolbox(
    ctx,
    { ownerId, projectId: data.project.id, assets: data.allAssets, transcripts: data.transcripts, keywords: data.keywords, templates: data.templates },
    { workDir },
  );
  return {
    project: data.project,
    settings: data.settings,
    assets: data.assets,
    transcripts: data.transcripts.filter((t) => t.status === "listo"),
    keywords: data.keywords,
    rules,
    glossary: glossaryAll.filter((g) => scopeMatches(g, scope)),
    brand: data.brand,
    style: data.style,
    baseRecipe: null,
    toolbox,
    aiModels: ctx.services.generative.models(),
    ...extra,
  };
}
