# AGENTS.md — guía para agentes (Claude Code, Warp, Codex…) y personas

Autoeditor de video con IA: subo material → doy contexto → prendo herramientas → escribo la instrucción →
**Claude edita** → V1 → corrijo con texto → V2, V3… → exporto → guardo el estilo y lo reutilizo.
La especificación completa del producto está en [`PROMPT.md`](PROMPT.md). Las decisiones técnicas, en
[`docs/DECISIONES.md`](docs/DECISIONES.md). La investigación de herramientas, en `docs/research/`.

## Idioma

- Interfaz, mensajes de error para el usuario, README y documentación: **español**.
- Código (identificadores) en inglés; comentarios en español. Los valores de enums visibles al
  usuario están en español (p. ej. `"debe-aparecer"`, `"palabra"`).

## Estructura del monorepo (pnpm workspaces)

```
packages/shared   @autoeditor/shared  Contratos: receta (timeline JSON), settings del diagrama, entidades,
                                       API/SSE, estimador, diff "qué cambió", subtítulos. Fuente de verdad de tipos.
packages/editor   @autoeditor/editor  Componente React montable <AutoEditor/> (lienzo de nodos + paneles).
apps/server       @autoeditor/server  Fastify (API REST /api/v1 + SSE), cola de trabajos, SQLite (node:sqlite),
                                       almacenamiento local, análisis/transcripción/render/motion/IA.
apps/web          @autoeditor/web     App anfitriona local (Vite) que monta el editor.
workers/python                        Worker de transcripción (faster-whisper) y rostros (OpenCV).
config/                               models.json, providers.json, estimator.json — editables sin programar.
scripts/                              setup.mjs (instalación/diagnóstico), generar-material-prueba.mjs.
data/                                 (ignorado por git) base de datos, archivos subidos, renders.
```

### Servidor (`apps/server/src`)

| Carpeta | Responsabilidad |
|---|---|
| `services/types.ts` | **Contratos internos** (StorageAdapter, MediaAnalyzer, Transcriber, Renderer, MotionEngine, GenerativeProvider, EditorBrain). Las rutas y el pipeline solo dependen de estas interfaces. |
| `services/container.ts` | Arma los servicios (reales o demo) según config y llaves. |
| `env.ts`, `config/` | Variables de entorno y carga/validación de `/config/*.json`. |
| `db/` | SQLite con `node:sqlite` (sin dependencias nativas) + repositorios. Todas las tablas llevan `owner_id`. |
| `storage/` | Almacenamiento local por claves relativas (adaptable a S3). |
| `auth/` | Resuelve el dueño (`X-Owner-Id`, por defecto `local`); adaptable al login de Zyra. |
| `events/` | Bus de eventos por proyecto + endpoint SSE. |
| `jobs/` | Cola persistente con reintentos, cancelación y progreso por etapa. |
| `routes/` | Endpoints REST documentados con OpenAPI (`/api/v1/docs`). |
| `media/` | ffprobe, miniaturas, fotogramas, escenas, silencios, loudness, rostros. |
| `transcription/` | Proveedores: faster-whisper (local), API compatible, demo. |
| `render/` | Receta → ffmpeg (cortes, transiciones, reencuadre, color, textos, subtítulos ASS, audio con ducking y loudnorm, overlays). |
| `motion/` | Motores de motion graphics: HyperFrames (por defecto), builtin (ffmpeg/ASS), Remotion (opcional, apagado). |
| `ai/` | Cliente de Claude, cerebro editor (agente con herramientas), editor demo, correcciones (parches RFC 6902), revisión de calidad, palabras clave, Kie AI. |
| `pipeline/` | Orquestación de trabajos: generar, plan, corregir, exportar. |
| `styles/` | Guardar estilo (preset + ficha de reglas + Skill exportable), importar/exportar zip. |
| `memory/` | Aprendizaje: reglas, glosario, métricas. |

## Reglas no negociables

1. **Llaves de API solo en el backend** (`.env`). Nunca en el navegador, nunca en respuestas de la API,
   nunca en logs, nunca en el repositorio. `GET /api/v1/config` solo expone booleanos de capacidad.
2. **La receta es la fuente de verdad.** Toda versión guarda su receta completa; el render es determinista.
3. **Regla de oro de correcciones:** una corrección es un parche mínimo sobre la receta; todo lo demás queda
   idéntico. Se verifica con `diffRecipes` + `changesOutsideAreas` (`@autoeditor/shared`).
4. **Nada de rutas absolutas guardadas.** El almacenamiento usa claves relativas.
5. **`owner_id` en todas las tablas** y en todas las consultas.
6. **Modelos, precios y proveedores en `/config`**, nunca fijos en código.
7. **Modo demo:** sin llaves, la app funciona de punta a punta (editor determinista + IA simulada).
8. Remotion queda **opcional y apagado** por licencia (ver `docs/research/skills-remotion-warp.md`).

## Comandos

```bash
pnpm setup          # instala dependencias, worker de Python, skills, crea .env
pnpm dev            # servidor (4000) + interfaz (5173) con recarga
pnpm start          # compila la interfaz y la sirve desde el servidor en http://localhost:4000
pnpm typecheck      # TypeScript en todos los paquetes
pnpm test           # pruebas unitarias (vitest)
pnpm test:e2e       # pruebas de interfaz (Playwright)
pnpm material-prueba  # genera clips de prueba en data/muestras
pnpm doctor         # diagnóstico: ffmpeg, Python, transcripción, llaves, HyperFrames
```

## Convenciones de código

- TypeScript estricto, ESM. Importar tipos de `@autoeditor/shared` en lugar de redefinirlos.
- Validar entradas de la API con zod (esquemas de `@autoeditor/shared/api`).
- Errores para el usuario: lanzar `UserFacingError(code, mensajeEnEspañol, status)`.
- Procesos externos (ffmpeg, python, hyperframes): siempre con `spawn` y argumentos en arreglo (nunca
  concatenar strings de shell), con `AbortSignal` y tiempo límite.
- Pruebas: vitest junto a cada paquete (`test/`). Las pruebas no deben requerir llaves ni red.
- Claude: SDK oficial `@anthropic-ai/sdk`, modelo `claude-opus-5-5` por defecto (configurable en
  `config/models.json`); `claude-sonnet-5-5` para tareas simples.

## Skills para agentes

- Las skills de HyperFrames se instalan con `pnpm setup` (o `npx skills add heygen-com/hyperframes --full-depth`)
  en `.agents/skills/` (enlazadas a `.claude/skills/`). Están en `.gitignore`; `skills-lock.json` fija versiones
  y se restauran con `npx skills experimental_install`.
- Los estilos guardados por el editor se exportan como skills (`SKILL.md` + `preset.json` + assets + plantillas).
