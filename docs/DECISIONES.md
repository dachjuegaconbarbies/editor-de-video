# Decisiones técnicas

Registro de las decisiones de arquitectura: qué se eligió, por qué y qué se descartó.
Se actualiza conforme avanza el proyecto.

## 1. Monorepo pnpm con contratos compartidos

- **Elegido:** `packages/shared` (zod) como única fuente de verdad de tipos: receta, settings del diagrama,
  entidades, API/SSE, estimador, diff y subtítulos. Servidor e interfaz importan lo mismo.
- **Por qué:** la receta, el estimador y el diff se usan en ambos lados (la interfaz recalcula el estimado al
  instante sin ir al servidor; el servidor verifica la regla de oro con el mismo diff que muestra la interfaz).
- **Descartado:** tipos duplicados o generados desde OpenAPI (más fricción para iterar).

## 2. Backend: Node 22 + Fastify 5 + `node:sqlite`

- **Elegido:** Fastify (rápido, validación con esquemas, OpenAPI integrado), cola de trabajos persistente propia
  en SQLite, SSE para progreso en vivo.
- **Base de datos:** `node:sqlite` incluido en Node ≥ 22.13 → **cero dependencias nativas** (better-sqlite3
  necesita compilar o descargar binarios, lo que falla seguido en Windows/macOS sin herramientas de desarrollo).
  Los repositorios están detrás de una interfaz para pasar a Postgres al integrarse a Zyra.
- **Cola:** propia sobre SQLite en vez de Redis/BullMQ → no requiere servicios extra para correr en local; la
  interfaz de la cola permite cambiar a BullMQ en servidor.
- **Progreso:** SSE (unidireccional, reconecta solo, pasa por proxies HTTP) en vez de WebSocket.

## 3. Frontend: React 19 + React Flow + elkjs + motion + Zustand + Tailwind 4

- React Flow (`@xyflow/react`) para el lienzo de nodos con nodos/conectores propios; elkjs (layered, izquierda →
  derecha) para el auto-layout sin solapes; `motion` para desplegar/colapsar; Zustand + zundo para estado con
  deshacer/rehacer; Tailwind 4 con tokens del lenguaje visual del diagrama.
- El editor es un **paquete montable** (`@autoeditor/editor`, componente `<AutoEditor/>`) y `apps/web` es solo la
  app anfitriona: así se incrusta en Zyra sin reescribir.

## 4. Claude como editor: SDK oficial con herramientas propias (no el Agent SDK)

- **Elegido:** `@anthropic-ai/sdk` con el *tool runner* y herramientas propias del dominio: ver fotogramas del
  material, ver cómo se ve la receta en un segundo dado (render de un fotograma), validar la receta, leer la
  transcripción, listar plantillas de motion graphics, escribir plantillas HyperFrames. Modelo `claude-opus-5-5`
  (configurable), `effort: high`; `claude-sonnet-5-5` para tareas simples (palabras clave, describir fotogramas).
- **Por qué:** el editor trabaja sobre una estructura (la receta) y no sobre un sistema de archivos libre; las
  herramientas de dominio dan control total, validación estricta, costo predecible y nada de procesos hijos de
  Claude Code en el servidor. Mantiene el espíritu de "editar como en Claude Code" (revisa, edita, mira su propio
  render y se corrige).
- **Skills:** cada estilo guardado se exporta como Skill de Claude (`SKILL.md` + `preset.json` + assets +
  plantillas) que funciona en Claude Code, y el editor carga ese mismo `SKILL.md` en su prompt de sistema.
- **Descartado:** Claude Agent SDK (más pesado para un backend API-first; queda como opción futura).
- **Rechazos/seguridad:** se activa el reintento automático en otro modelo (`fallbacks: "default"`) para que un
  falso positivo de los clasificadores no deje al usuario sin video.

## 5. Transcripción: faster-whisper local (worker de Python)

- Tiempos por palabra, VAD, `hotwords` para el glosario (nombres propios y marcas), sin costo por minuto.
- Alternativas configurables: API compatible con OpenAI (`verbose_json` + palabras) y proveedor **demo**.
- El glosario del usuario corrige automáticamente las variantes erróneas y alimenta las `hotwords`.

## 6. Render: ffmpeg determinista a partir de la receta

- Cortes, transiciones (`xfade`), reencuadre a vertical (recorte siguiendo el rostro o fondo desenfocado), zooms,
  color, textos y subtítulos ASS (karaoke palabra por palabra con resaltado de palabras clave), audio con ducking
  (`sidechaincompress`) y `loudnorm` a −14 LUFS, overlays con alfa.
- Motion graphics: **HyperFrames** por defecto (HTML → video), motor *builtin* (ffmpeg/ASS) como respaldo,
  **Remotion opcional y apagado** por su licencia (empresa ≥ 4 personas y compra de renders automatizados).

## 7. IA generativa: Kie AI detrás de un adaptador

- Tareas asíncronas (crear → consultar → descargar) con reintentos; modelos y precios en `config/providers.json`.
- Sin llave o sin créditos: modo demo con marcadores locales y aviso claro, sin romper el flujo.

## 8. Aprendizaje ("que se vaya entrenando")

- No es reentrenar el modelo: es memoria persistente (reglas cortas y verificables, glosario, palabras clave,
  señales de 👍/👎 y exportaciones) con alcance global / marca / estilo / proyecto, visible y editable en el panel
  "Lo que Claude aprendió". Las reglas con comprobación automática se verifican en la revisión de calidad.
