# Skills de Claude, Claude Agent SDK, Remotion, CLI `skills` y Warp

> Fecha: 2026-10-04. Versiones revisadas:
> - `@anthropic-ai/claude-agent-sdk@0.3.289`, que trae Claude Code 2.1.289. El `claude` del contenedor también es 2.1.289.
> - `skills@1.7.0` (npm, vercel-labs).
> - `remotion` / `@remotion/renderer` / `@remotion/bundler` / `@remotion/licensing` `@4.0.532`.
> - Documentación de Warp: repo `warpdotdev/docs`, commit `3d54389`, 2026-10-02.
> - Documentación de Remotion: repo `remotion-dev/remotion`, commit `e385a83`, 2026-10-03.
>
> Lo marcado **VERIFICADO** se ejecutó en este contenedor. Lo marcado **NO VERIFICADO** sale de documentación o de código, y no se probó.
>
> Carpeta de pruebas, fuera del repo: `/tmp/claude-0/-home-user-editor-de-video/f6f89765-a86b-5bf9-b268-9519fd86e804/scratchpad/research-skills-remotion-agentes/`. En adelante, `$SCRATCH`.

## 0. Veredicto (lo que hay que saber)

1. **Skill exportable que funcione en Claude Code, Warp y claude.ai.** Usa **solo los 6 campos de la spec Agent Skills** en el frontmatter: `name`, `description`, `license`, `compatibility`, `metadata` y `allowed-tools`.
   - Claude Code acepta más campos (`when_to_use`, `model`, `context`…).
   - claude.ai y la Skills API **rechazan con error** cualquier campo fuera de esos 6.
   - Reglas de `name`: hasta 64 caracteres, solo `[a-z0-9-]`, y sin las palabras "anthropic" ni "claude".
   - Reglas de `description`: entre 1 y 1024 caracteres, sin etiquetas XML.
2. **Ubicación.** Claude Code solo busca skills en `.claude/skills/<nombre>/SKILL.md` (proyecto) y en `~/.claude/skills/<nombre>/SKILL.md` (personal).
   - **No lee `.agents/skills/`.** VERIFICADO: una skill que solo está en `.agents/skills/` no aparece en la sesión.
   - Warp lee las dos rutas, `.agents/skills/` y `.claude/skills/`.
   - **Conclusión: exportar e instalar en `.claude/skills/`** cubre Claude Code y Warp al mismo tiempo.
3. **Cómo se inyecta la skill.** Al invocarla, Claude Code manda al modelo `Base directory for this skill: <ruta absoluta>` seguido del cuerpo del SKILL.md, sin el frontmatter. VERIFICADO.
   - Por eso los enlaces relativos (`[preset.json](preset.json)`) funcionan.
   - Nuestro editor puede cargar el mismo cuerpo en su prompt de sistema.
4. **Remotion.**
   - Licencia gratis solo para individuos, equipos de hasta 3 personas, organizaciones sin fines de lucro, o durante una evaluación.
   - Con **4 o más personas** hace falta Company License.
   - Un editor de video o una app de prompt a video con `renderMedia()` entra en **"Remotion for Automators"**: **USD 0.01 por render, mínimo USD 100 al mes**. Además, en Remotion 5.0 la telemetría será obligatoria para ese plan.
   - Técnicamente funciona: render programático con canal alfa real (ProRes 4444 y VP9 `yuva420p`), VERIFICADO.
   - **Recomendación: motor opcional, apagado por defecto, instalado bajo demanda.** La instalación pesa 208 MB y 179 paquetes.
5. **CLI `skills`.** Hace `git clone --depth 1` del repo e instala por agente (`claude-code` → `.claude/skills/`, `warp` → `.agents/skills/`). Guarda `skills-lock.json` en la raíz.
   - **Bug real en `scripts/setup.mjs`:** `npx skills experimental_install` restaura **solo** a `.agents/skills/` (agentes "universales"). Claude Code se queda sin las skills de HyperFrames. VERIFICADO. La solución está en §5.6.
6. **Warp.**
   - Lee `AGENTS.md` en mayúsculas, en la raíz y en subcarpetas. Si en la misma carpeta existen `WARP.md` y `AGENTS.md`, **gana `WARP.md`**.
   - El repo ya está bien: `AGENTS.md` es la fuente única y `CLAUDE.md` hace `@AGENTS.md`. **No crear `WARP.md`.**

---

## 1. Skills de Claude (Agent Skills): formato exacto

### 1.1 Estructura de la carpeta

```
<nombre-skill>/
├── SKILL.md            # obligatorio: frontmatter YAML + instrucciones en Markdown
├── reference.md        # opcional: se lee bajo demanda (nivel 3)
├── scripts/            # opcional: se EJECUTAN; su código no entra al contexto, solo su salida
└── assets/, templates/ # opcional: cualquier archivo (plantillas, imágenes, fuentes, JSON)
```

La carga es progresiva, en tres niveles (fuente: platform.claude.com, *Agent Skills overview*):

| Nivel | Cuándo se carga | Costo |
|---|---|---|
| 1. Metadatos (`name` + `description`) | Siempre, al inicio, en el prompt de sistema | ~100 tokens por skill |
| 2. Cuerpo de `SKILL.md` | Cuando la skill se activa | Recomendado: menos de 5k tokens |
| 3. Archivos extra | Solo si Claude los lee o los ejecuta | 0 hasta que se usan |

### 1.2 Frontmatter: campos soportados y límites

**El frontmatter solo se lee si `---` es la primera línea del archivo.** Si el YAML no parsea, la skill carga **sin metadatos**: `/nombre` funciona, pero Claude no puede elegirla por su descripción. Fuente: code.claude.com/docs/en/skills.

**a) Spec Agent Skills (portable).** Son los únicos campos válidos para claude.ai, la Skills API y `package_skill.py`. Si aparece otro campo, la subida falla con:

```
Unexpected key(s) in SKILL.md frontmatter: argument-hint. Allowed properties are: allowed-tools, compatibility, description, license, metadata, name
```

| Campo | Obligatorio | Regla |
|---|---|---|
| `name` | Sí (spec/API). En Claude Code es opcional: por defecto toma el nombre de la carpeta | Máx. **64** caracteres, solo minúsculas, números y guiones, sin etiquetas XML, sin las palabras reservadas **"anthropic"** ni **"claude"** |
| `description` | Sí (spec/API). En Claude Code es "recomendado": si falta, usa la primera línea no vacía del cuerpo | No vacía, máx. **1024** caracteres, sin etiquetas XML. Debe decir **qué hace y cuándo usarla** |
| `license` | No | Texto libre. Claude Code lo acepta y lo ignora |
| `compatibility` | No | Hasta **500** caracteres. Claude Code lo ignora |
| `metadata` | No | Mapa YAML libre para nuestras herramientas. Claude Code no actúa sobre él y lo descarta si no es un mapa. No hay que repetir ahí nombres de campos del frontmatter |
| `allowed-tools` | No | Herramientas preaprobadas durante el turno en que se invoca la skill. Acepta texto separado por espacios o comas, o una lista YAML |

**b) Campos extra que solo entiende Claude Code.** No los uses en la skill exportable:
- `when_to_use`, `argument-hint`, `arguments`
- `disable-model-invocation`, `user-invocable`
- `disallowed-tools`
- `model`, `effort`
- `context: fork`, `agent`, `background`
- `hooks`, `paths`, `shell`

Detalles:
- Claude Code **ignora sin error** cualquier campo que no conoce.
- Los booleanos aceptan `yes/no/on/off/1/0/true/false`, desde v2.1.218.
- En el listado que ve el modelo, `description` + `when_to_use` se truncan a **1,536 caracteres**. Se puede cambiar con `skillListingMaxDescChars`. La documentación pide poner primero el caso de uso principal.
- Si hay muchas skills, el listado completo tiene un presupuesto de ~1 % de la ventana de contexto. Ajustable con `skillListingBudgetFraction` o `SLASH_COMMAND_TOOL_CHAR_BUDGET`. Cuando el listado se pasa del presupuesto, Claude Code descarta primero las descripciones de las skills menos usadas.

**Validador:** `claude plugin validate [--strict] [--json] <carpeta>` (Claude Code ≥ 2.1.233).
- **VERIFICADO:** detecta YAML roto.
- **VERIFICADO también:** **no** detecta `name` con mayúsculas ni campos fuera de la spec (`version: 2` pasó con `--strict`).
- **Por eso necesitamos nuestro propio validador** (§2.4).

### 1.3 Cómo se referencian archivos y variables

- **Enlaces relativos** desde `SKILL.md`, por ejemplo `[preset.json](preset.json)` o `[references/plantillas.md](references/plantillas.md)`.
  - VERIFICADO en Claude Code 2.1.289: al invocar la skill, el modelo recibe primero esta línea y luego el cuerpo sin frontmatter:
    ```
    Base directory for this skill: /ruta/absoluta/.claude/skills/estilo-podcast-dinamico
    ```
- Usa **barras normales** (`scripts/x.py`), nunca `\`.
- Deja las referencias **a un solo nivel** desde `SKILL.md`. Claude puede leer solo parcialmente (`head -100`) un archivo enlazado desde otro archivo enlazado.
- A los archivos de referencia de más de 100 líneas, ponles una tabla de contenido al inicio.
- Sustituciones en Claude Code (fuente: code.claude.com/docs/en/skills):
  - `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` y `$nombre` (este último con el campo `arguments`).
  - `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}` (≥ 2.1.196), `${CLAUDE_SESSION_ID}` y `${CLAUDE_EFFORT}`.
  - `${CLAUDE_SKILL_DIR}` también se sustituye dentro de reglas `Bash(...)` de `allowed-tools`.
  - **Warp solo documenta `$ARGUMENTS`, `$ARGUMENTS[N]` y `$N`.** En una skill portable, **no uses `${CLAUDE_SKILL_DIR}`**: usa enlaces relativos y la frase "relativo a la carpeta de esta skill".
- Inyección dinámica: `` !`comando` `` o un bloque ` ```! `. Es exclusiva de Claude Code; no funciona en claude.ai ni en la API. **No la uses** en la skill exportable.

### 1.4 Dónde busca Claude Code y en qué orden

| Ubicación | Ruta | Alcance |
|---|---|---|
| Enterprise | `.claude/skills/<n>/SKILL.md` dentro del directorio de managed settings | Toda la organización |
| Personal | `~/.claude/skills/<n>/SKILL.md` | Todos tus proyectos en esa máquina. **No** llega a Cowork ni a sesiones en la nube |
| Proyecto | `.claude/skills/<n>/SKILL.md` | En el directorio de inicio **y en cada padre hasta la raíz del repo** |
| Anidada | `<subdir>/.claude/skills/<n>/SKILL.md` | Se carga cuando Claude lee o edita archivos de ese subdir |
| `--add-dir` | `.claude/skills/` dentro del directorio añadido | Esa sesión |
| Plugin | `<plugin>/skills/<n>/SKILL.md` | Se invoca como `/plugin:skill` |

Reglas:
- **Precedencia ante un mismo nombre:** enterprise > personal > proyecto.
  - Consecuencia: si el usuario instala un estilo en `~/.claude/skills/x` y un repo trae `.claude/skills/x`, **gana la personal**.
- La carpeta de una skill puede ser un **symlink**; Claude Code la deduplica.
- Nombres reservados de carpeta: `synced` y `anthropic-skills…`.
- **Recarga en caliente:** Claude Code vigila `~/.claude/skills/` y `.claude/skills/`.
  - Si `.claude/skills/` **no existía** al iniciar la sesión, hay que correr `/reload-skills`.
- Formato antiguo: `.claude/commands/x.md` sigue funcionando. Si comparte nombre con una skill, gana la skill.
- **Compactación:** tras resumir la conversación, Claude Code vuelve a adjuntar los **primeros 5,000 tokens** de cada skill invocada, con un tope de **25,000 tokens** en total. **Pon las reglas críticas al inicio del cuerpo.**
- El SKILL.md no se vuelve a leer en turnos posteriores. Su contenido queda en el contexto desde la primera invocación.

### 1.5 Buenas prácticas de redacción

Fuente: platform.claude.com, *Skill authoring best practices*.

- **Descripción en tercera persona** ("Aplica el estilo…", no "Te ayudo a…"), con **qué hace + cuándo usarla** y palabras clave que diría el usuario. La descripción se inyecta en el prompt de sistema, y mezclar puntos de vista confunde la selección.
- **Cuerpo de menos de 500 líneas.** El detalle va en archivos aparte (progressive disclosure).
- **Conciso:** solo lo que Claude no sabe. Cada línea del cuerpo cuesta tokens en cada turno mientras la skill esté activa.
- **Grados de libertad:**
  - Instrucciones abiertas cuando hay muchas formas válidas.
  - Scripts exactos ("ejecuta exactamente…") cuando el proceso es frágil.
- **Una terminología consistente.** Da un valor por defecto en vez de muchas opciones.
- **Nada que dependa de una fecha.** Lo viejo va en una sección "patrones antiguos".
- **Flujos con checklist y lazos de validación:** validar → corregir → repetir.
- **Scripts que resuelven, no que delegan:** manejan sus errores y no usan constantes mágicas sin explicar.
- Si la skill usa MCP, nombra las herramientas completas: `Servidor:herramienta`.
- **Evaluaciones antes que documentación:** mínimo 3 escenarios. Prueba con los modelos en los que se usará.
- **Seguridad:** una skill ejecuta código con los permisos del agente. Solo instala skills de fuentes confiables.

### 1.6 Distribución como zip (claude.ai / Skills API)

Fuente: platform.claude.com, *Using Agent Skills with the API*.

- `SKILL.md` debe estar **en la raíz del upload o en una única carpeta contenedora**. Para nuestro zip, eso es `estilo-x/SKILL.md`.
- Tamaño total menor a **30 MB sin comprimir**.
- En claude.ai: Settings > Features > subir el zip. Disponible en Pro, Max, Team y Enterprise con ejecución de código activada.
- La Skills API (`/v1/skills`) ya no requiere el header beta `skills-2025-10-02`.
- En la API, las skills corren **sin red y sin instalar paquetes**.
- Nada de esto se probó aquí (NO VERIFICADO): no hay cuenta ni llave.

---

## 2. Diseño recomendado: "estilo de video" → Skill exportable

### 2.1 Estructura del paquete exportado

```
estilo-podcast-dinamico/            # = name (slug), prefijo "estilo-" para no chocar con skills de HyperFrames
├── SKILL.md                        # reglas del estilo en lenguaje natural (< 500 líneas, críticas arriba)
├── preset.json                     # FUENTE DE VERDAD de valores (lo que el editor aplica tal cual)
├── references/
│   └── plantillas.md               # índice de plantillas: qué hace cada una, duración, variables
├── plantillas/                     # composiciones HyperFrames (.html) de títulos/cintillos/intro/outro
└── assets/
    ├── logos/  fuentes/  luts/  sonidos/
```

Notas:
- **`preset.json` manda.** El SKILL.md lo enlaza y explica en prosa lo que no cabe en números (ritmo, criterio editorial, qué evitar). Así el editor aplica valores deterministas, y Claude Code (sin la app) entiende la intención.
- **Recursos de marca y licencias:** en `metadata` y en `license` indica que las fuentes y logos son del usuario.
  - **No incluyas fuentes con licencia que prohíba redistribuirlas.** Pon un enlace a Google Fonts en `preset.json`.
- Una carpeta exportada está bien con el tamaño típico. El zip debe quedar bajo **30 MB** si se quiere subir a claude.ai.
- **El repo ignora `.agents/skills/` y `.claude/skills/` (`.gitignore`).** Los estilos exportados son datos del usuario: guárdalos en `data/estilos/<id>/skill/`, no en el repo. Para versionar en el futuro una skill propia del proyecto, hará falta una negación (`!.claude/skills/mi-skill/`).

### 2.2 Plantilla de `SKILL.md` que genera el editor

```markdown
---
name: estilo-podcast-dinamico
description: Aplica el estilo de video "Podcast dinámico" (cortes rápidos, subtítulos karaoke amarillos, zooms en frases clave, música a -18 LUFS bajo la voz). Usar cuando el usuario pida editar o renderizar un video con este estilo o mencione "podcast dinámico".
license: Uso personal del autor del estilo
metadata:
  generador: autoeditor
  formato: "1"
  estilo-id: st_01J9ZK
---

# Estilo de video: Podcast dinámico

Valores exactos (fuente de verdad): [preset.json](preset.json). No los inventes; léelos de ahí.

## Reglas del estilo (críticas primero)
1. ...
## Recursos
- Plantillas HyperFrames: [references/plantillas.md](references/plantillas.md) (archivos en `plantillas/`).
- Logos y fuentes: `assets/`.
## Cómo aplicarlo fuera del autoeditor
...
```

VERIFICADO con una copia de esta plantilla en `$SCRATCH/test-proyecto2/.claude/skills/estilo-podcast-dinamico/`:
- `claude plugin validate --strict` pasa.
- El mensaje `system/init` de Claude Code 2.1.289 la lista en `skills` y en `slash_commands`.
- `/estilo-podcast-dinamico` inyecta el cuerpo con `Base directory for this skill: …`.

### 2.3 Instalación por el usuario

| Caso | Comando |
|---|---|
| Solo para un proyecto | `mkdir -p .claude/skills && unzip estilo-podcast-dinamico.zip -d .claude/skills/` |
| Para todos sus proyectos (Claude Code y Warp) | `unzip estilo-podcast-dinamico.zip -d ~/.claude/skills/` |
| Con el CLI `skills` (copia y registra en `skills-lock.json`) | `npx skills add ./estilo-podcast-dinamico -a claude-code -a warp -y` (`--copy` en Windows) |

- En modo local, el servidor puede ofrecer un botón **"Instalar en Claude Code"** que copie la carpeta a `~/.claude/skills/<name>/`. Si ya existe, debe preguntar antes de sobrescribir.
- En modo servidor (Zyra) solo se ofrece la descarga del zip.
- Si la sesión de Claude Code ya estaba abierta y `~/.claude/skills/` no existía al iniciarla: `/reload-skills`.

### 2.4 Validador, serializador y parser (código VERIFICADO)

Dependencia: `yaml@2`, la misma que usa el CLI `skills`. Probado en `$SCRATCH/loader-test/` con `node test.mjs`: roundtrip OK, detecta campo `version`, nombre con mayúsculas y descripción mayor a 1024, y el SKILL.md real de `hyperframes-core` pasa.

```js
import { parse, stringify } from 'yaml';

// Campos permitidos por la spec de Agent Skills (claude.ai / Skills API / package_skill.py).
export const SPEC_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const XML_RE = /<\/?[a-zA-Z][^>]*>/;

/** "Podcast dinámico!" -> "estilo-podcast-dinamico" (<= 64, sin palabras reservadas). */
export function slugSkillName(nombre, prefijo = 'estilo') {
  let s = `${prefijo}-${nombre}`.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .replace(/\b(anthropic|claude)\b/g, 'x');
  return s.slice(0, 64).replace(/-+$/, '');
}

export function validateFrontmatter(fm) {
  const errores = [];
  for (const k of Object.keys(fm)) if (!SPEC_KEYS.includes(k)) errores.push(`campo no permitido por la spec: ${k}`);
  if (typeof fm.name !== 'string' || !NAME_RE.test(fm.name) || fm.name.length > 64) errores.push('name: 1-64 caracteres [a-z0-9-]');
  if (/anthropic|claude/.test(fm.name ?? '')) errores.push('name: contiene palabra reservada');
  if (typeof fm.description !== 'string' || !fm.description.trim()) errores.push('description: vacía');
  else {
    if (fm.description.length > 1024) errores.push(`description: ${fm.description.length} > 1024`);
    if (XML_RE.test(fm.description)) errores.push('description: no puede tener etiquetas XML');
  }
  if (fm.compatibility && String(fm.compatibility).length > 500) errores.push('compatibility: > 500');
  if (fm.metadata !== undefined && (typeof fm.metadata !== 'object' || Array.isArray(fm.metadata))) errores.push('metadata: debe ser un mapa');
  return errores;
}

export function buildSkillMd(fm, body) {
  const errores = validateFrontmatter(fm);
  if (errores.length) throw new Error(errores.join('; '));
  // stringify escapa comillas, dos puntos, acentos, etc. (no armar el YAML a mano)
  return `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** Igual que Claude Code: frontmatter solo si '---' es la primera línea. */
export function parseSkillMd(text) {
  const t = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(t);
  if (!m) return { frontmatter: {}, body: t };
  return { frontmatter: parse(m[1]) ?? {}, body: m[2] };
}
```

Notas de la prueba:
- Con el nombre `'Podcast dinámico: "Claude" edición!'`, `slugSkillName` produjo `estilo-podcast-dinamico-x-edicion`. La palabra reservada se reemplaza.
- `stringify` puso la descripción entre comillas simples porque contiene `":`. Eso es necesario: armar el YAML a mano lo rompería.
- Además: si el slug ya existe en la biblioteca, agrega un sufijo corto (`-2`, o 4 caracteres del id).

### 2.5 Cargar la misma skill en el prompt de sistema del editor

El editor usa `@anthropic-ai/sdk`, no el Agent SDK (DECISIONES §4). Esbozo (**NO VERIFICADO**, no se ejecutó contra la API):

```ts
// apps/server/src/styles/skill-prompt.ts (esbozo)
const { frontmatter, body } = parseSkillMd(await readFile(join(dir, 'SKILL.md'), 'utf8'));
const preset = await readFile(join(dir, 'preset.json'), 'utf8');
const system = [
  { type: 'text', text: PROMPT_BASE_EDITOR },
  {
    type: 'text',
    // Igual que Claude Code: solo el cuerpo (sin frontmatter); aquí además se incrusta preset.json
    text: `<estilo nombre="${frontmatter.name}">\n${body}\n\npreset.json:\n${preset}\n</estilo>`,
    cache_control: { type: 'ephemeral' }, // el estilo es estable entre turnos → cacheable
  },
];
```

- No hace falta pasar el frontmatter al modelo; Claude Code tampoco lo pasa.
- Para que el editor lea plantillas o assets, se exponen con una herramienta propia (`leer_archivo_estilo(ruta)`) restringida a la carpeta del estilo. No hay que dar acceso libre al disco.
- Las etiquetas `<estilo>` van en el **prompt**, no en `description`: la spec prohíbe XML solo dentro de `description` y `name`.

---

## 3. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.3.289`)

- **Qué es:** ejecuta el binario de Claude Code (2.1.289) como subproceso.
  - El binario llega en `optionalDependencies` por plataforma (`@anthropic-ai/claude-agent-sdk-linux-x64`, etc.) y pesa **~230-246 MB** según `manifest.json`.
  - Requiere Node ≥ 18.
  - Peer deps: `zod ^4`, `@modelcontextprotocol/sdk ^1.29` y `@anthropic-ai/sdk >=0.93.0`.
- Entradas del paquete: `@anthropic-ai/claude-agent-sdk` y `/core`. `/core` es más ligera: exporta `query`, `tool` y `createSdkMcpServer`, y no incluye las peer deps. **No mezclar las dos en un mismo proceso.**
- **Carga de skills** (tipos en `sdk.d.ts` + doc code.claude.com/docs/en/agent-sdk/skills):
  - `settingSources?: ('user'|'project'|'local')[]`.
    - El tipo dice: *"When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode)."*
    - `'project'` carga `<cwd>/.claude/skills/` y los padres hasta la raíz del repo, además de `CLAUDE.md`. `'user'` carga `~/.claude/skills/`.
  - `skills?: string[] | 'all'`.
    - Omitido: aplican los defaults del CLI.
    - `'all'`: todas.
    - Lista: solo esas. Los nombres deben ser exactos: no acepta comodines (`*`, `x:*`), nombres vacíos ni paréntesis, y `query()` lanza un error antes de arrancar.
    - Al usar `skills`, el SDK agrega la herramienta `Skill` a `allowedTools` solo. Si pasas `tools` explícito, incluye `"Skill"`.
    - *"This is a context filter, not a sandbox"*: los archivos siguen accesibles por Read y Bash.
  - **No existe API para registrar skills en memoria:** son archivos en disco.
  - Para cargar skills de una ruta arbitraria: `plugins: [{ type: 'local', path }]`, con las skills en `<plugin>/skills/<n>/SKILL.md` (quedan con prefijo de plugin), o `additionalDirectories: [dir]`, que equivale a `--add-dir` y carga `<dir>/.claude/skills/`.
  - Para confirmar la carga: el mensaje `{ type: 'system', subtype: 'init' }` trae `skills: string[]` y `slash_commands: string[]`. VERIFICADO con el CLI (`claude -p … --output-format stream-json --verbose`).
- **`createSdkMcpServer(options)`:** crea un servidor MCP **dentro del mismo proceso** para exponer herramientas propias a Claude sin un servidor externo.
  - Firma: `createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad?, timeout? }): McpSdkServerConfigWithInstance`.
  - Las herramientas se definen con `tool(name, description, zodRawShape, handler, extras?)`.
  - Se pasa como `mcpServers: { autoeditor: servidor }`, y Claude ve las herramientas como `mcp__autoeditor__<tool>`.

Ejemplo. El chequeo de tipos se VERIFICÓ con `tsc --strict` en `$SCRATCH/sdk-typecheck/`; **no se ejecutó** contra la API:

```ts
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const leerPreset = tool('leer_preset', 'Devuelve el preset.json de un estilo guardado',
  { estiloId: z.string() },
  async ({ estiloId }) => ({ content: [{ type: 'text', text: JSON.stringify({ estiloId }) }] }));

const autoeditor = createSdkMcpServer({ name: 'autoeditor', version: '1.0.0', tools: [leerPreset] });

for await (const msg of query({
  prompt: 'Edita con el estilo podcast dinámico',
  options: {
    cwd,                                   // carpeta con .claude/skills/
    settingSources: ['project'],
    skills: ['estilo-podcast-dinamico'],
    mcpServers: { autoeditor },
    allowedTools: ['mcp__autoeditor__leer_preset', 'Read'],
    maxTurns: 5,
  },
})) {
  if (msg.type === 'system' && msg.subtype === 'init') console.log(msg.skills, msg.slash_commands);
  if (msg.type === 'result') console.log(msg.subtype);
}
```

**Para el autoeditor:** se mantiene la decisión de usar `@anthropic-ai/sdk` con herramientas de dominio. El Agent SDK queda como opción futura, por ejemplo un modo "abrir este proyecto en Claude Code" que pruebe la skill exportada en un entorno real. Si se adopta, hay que cuidar el peso del binario y que agrega un subproceso por sesión.

---

## 4. Remotion (licencia y render programático)

### 4.1 Licencia (a octubre de 2026)

Fuentes: `LICENSE.md` del paquete npm 4.0.532; `packages/docs/docs/license/faq.mdx` y el componente de precios `packages/promo-pages/src/components/homepage/FreePricing.tsx` del repo oficial, commit 2026-10-03. Las páginas remotion.dev y remotion.pro están bloqueadas para WebFetch, así que leí el **código fuente de la documentación**.

- **Free License** (*"For individuals and companies of up to 3 people"*):
  - individuos, uso personal o comercial;
  - organizaciones o equipos de **hasta 3 personas**;
  - organizaciones sin fines de lucro;
  - evaluación sin uso comercial todavía.
  - Permite automatizar y lanzar un SaaS. Tiene la misma funcionalidad que la de pago.
- **Company License** (*"Required for collaborations and companies of 4+ people"*):
  - **Remotion for Creators:** **USD 25 al mes por persona** que escribe código Remotion, a mano o con agentes. Sin pago por render.
  - **Remotion for Automators:** **USD 0.01 por render, gasto mínimo de USD 100 al mes**. En el código del calculador: `RENDER_UNIT_PRICE = 10` por cada 1,000 renders. Los desarrolladores de la automatización no necesitan seat.
  - Si se activan los dos planes, aplica un mínimo combinado de USD 100 al mes.
  - **Enterprise:** desde **USD 500 al mes**.
- **Qué cuenta como automatización:** tener código que llame programáticamente a `renderMedia()`, `renderStill()`, `renderFrames()`, `render*OnLambda/Cloudrun/Vercel/Web()`, `npx remotion render|still` o al `<Player>`. Cita: *"organizations building video editors, prompt-to-video tools, automated video pipelines or using the Remotion Player will fall under Remotion for Automators"*. **El autoeditor de Zyra cae exactamente aquí.**
- **1 render** = la generación exitosa de un video, audio, GIF, imagen fija o PDF. Las previsualizaciones en Studio o Player no cuentan.
- **Telemetría:**
  - En render del lado del servidor hoy es voluntaria.
  - *"we are making a change to our license and terms in Remotion 5.0 to make telemetry mandatory for 'Remotion for Automators' customers"*. Quien no pueda activarla debe mandar un reporte mensual verificable.
  - En render del lado del cliente es obligatoria.
- **En el código 4.0.532** (`@remotion/renderer/dist/render-media.js`):
  - `renderMedia({ licenseKey })`:
    - `null`, o la opción omitida: no envía nada.
    - `'free-license'`: registra un evento sin llave.
    - Con una llave real: registra un evento `cloud-render` en `https://www.remotion.pro`.
  - Con `ENABLE_V5_BREAKING_CHANGES` (v5) avisará si no se pasa `licenseKey`.
  - `@remotion/licensing` expone `registerUsageEvent` y `getUsage`.

**Implicación:**
- Para el usuario individual en su computadora: gratis.
- Al integrarse a Zyra (empresa de 4 o más personas), cuesta al menos USD 100 al mes y luego exige telemetría en v5.

→ **Remotion opcional, apagado por defecto.** Llave en `.env` (`REMOTION_LICENSE_KEY`, que se pasa como `licenseKey`) y una nota visible en la interfaz al prenderlo. HyperFrames cubre el mismo caso (HTML → video con alfa) sin este costo; ver `docs/research/hyperframes.md`.

### 4.2 Paquetes y requisitos para render programático

| Paquete | Uso |
|---|---|
| `remotion` | Núcleo: `registerRoot`, `<Composition>`, hooks (`useCurrentFrame`, `interpolate`…) |
| `@remotion/bundler` | `bundle({ entryPoint, webpackOverride? })` empaqueta el proyecto React con webpack y devuelve `serveUrl` |
| `@remotion/renderer` | `selectComposition`, `renderMedia`, `renderStill`, `ensureBrowser`, `openBrowser`… Trae binarios `@remotion/compositor-<plataforma>` con **su propio ffmpeg**: el VP9 que generó dice `Lavc61.19.100` (ffmpeg 7.1) |
| `react`, `react-dom` | Peer deps (≥ 16.8; probé 19.2.3) |

- **Todas las versiones `remotion` y `@remotion/*` deben ser idénticas y exactas** (`--save-exact`).
- Instalación VERIFICADA: `npm install --save-exact remotion@4.0.532 @remotion/renderer@4.0.532 @remotion/bundler@4.0.532 react@19.2.3 react-dom@19.2.3`. Resultado: **179 paquetes, 208 MB, 13 s**.
- **Chrome Headless Shell:** `ensureBrowser()` lo descarga si falta; la versión probada por Remotion es `TESTED_VERSION = 149.0.7790.0`.
  - En Linux con glibc ≥ 2.35 lo descarga de `https://remotion.media/chromium-headless-shell-linux-x64-149.0.7790.0.zip`. Si no, de `storage.googleapis.com/chrome-for-testing-public/…`.
  - Los dos hosts están bloqueados en el contenedor.
  - **Solución VERIFICADA:** `browserExecutable: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'` en `selectComposition` y en `renderMedia`. Es la build 1194 de Playwright; funcionó aunque no es la versión probada por Remotion.
- **Dependencias de Linux** para Chrome Headless Shell en Ubuntu 22.04/24.04 (doc oficial): `apt install -y libnss3 libdbus-1-3 libatk1.0-0 libasound2t64 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libgbm-dev libcups2 libcairo2 libpango-1.0-0 libatk-bridge2.0-0`.
- No se puede usar `@remotion/bundler` dentro de Next.js. No nos afecta: el backend es Fastify.

### 4.3 Script de render VERIFICADO (`$SCRATCH/remotion-test/render.mjs`)

```js
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';

const browserExecutable = process.env.REMOTION_CHROME ?? null; // null = usa/descarga el suyo
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.jsx') }); // ~2 s; reutilizable
const inputProps = { texto: 'Autoeditor' };
const composition = await selectComposition({ serveUrl, id: 'Titulo', inputProps, browserExecutable });

// MP4 normal
await renderMedia({ serveUrl, composition, inputProps, browserExecutable, codec: 'h264',
  outputLocation: 'out/titulo.mp4', licenseKey: null });
// Alfa para componer con ffmpeg (sin pérdida visual): ProRes 4444
await renderMedia({ serveUrl, composition, inputProps, browserExecutable, codec: 'prores',
  proResProfile: '4444', pixelFormat: 'yuva444p10le', imageFormat: 'png',
  outputLocation: 'out/titulo-alfa.mov', licenseKey: null });
// Alfa para el navegador: VP9 + yuva420p
await renderMedia({ serveUrl, composition, inputProps, browserExecutable, codec: 'vp9',
  pixelFormat: 'yuva420p', imageFormat: 'png', outputLocation: 'out/titulo-alfa.webm', licenseKey: null });
```

`src/index.jsx` es una `<Composition id="Titulo" … width={640} height={360} fps={30} durationInFrames={30}>` con fondo `transparent`. Resultados para 640×360 y 30 frames, en 4 vCPU:

| Archivo | Render | ffprobe |
|---|---|---|
| mp4 | 1.3 s | h264 |
| mov | 1.6 s | prores 4444 `yuva444p12le` |
| webm | 2.0 s | vp9 con `alpha_mode=1` |

**Alfa VERIFICADO por píxel:** extraje un fotograma a PNG y medí el alfa en la esquina y en el centro.

| Archivo | Alfa en la esquina | Alfa en el centro |
|---|---|---|
| mov | 0 | ~65520/65535 |
| webm | 0 | 255 |

Para leer el alfa de un VP9 con ffmpeg hay que forzar el decodificador: `ffmpeg -c:v libvpx-vp9 -i x.webm …`.

**Reglas de alfa** (validadas en `pixel-format.js` e `image-format.js`):
- Con `yuva420p` o `yuva444p10le`, `imageFormat` tiene que ser `'png'`. Si no, se lanza este error: *"To render transparent videos, you need to set PNG as the image format"*.
- `yuva420p` solo vale con `vp8` o `vp9`.
- Para ProRes se usa `yuva444p10le` con `proResProfile: '4444'` o `'4444-xq'`.
- WebM transparente puede parpadear en los bordes de los chunks de Lambda; en Lambda conviene ProRes.
- Los PixelFormat válidos son: `yuv420p, yuva420p, yuv422p, yuv444p, yuv420p10le, yuv422p10le, yuv444p10le, yuva444p10le`.

En el contenedor, Remotion imprime un aviso de memoria por cgroup (*"Detected differing memory amounts"*). Es inofensivo.

### 4.4 Cómo dejarlo como motor opcional

- **Paquete aparte** `packages/motion-remotion` (o una dependencia opcional) instalado **solo** al activarlo, por ejemplo con `pnpm instalar --remotion`. Así no suma 208 MB a la instalación por defecto.
- **Interfaz:** que el `MotionEngine` "remotion" se registre solo si:
  1. el paquete existe (`import()` dinámico dentro de try/catch);
  2. `config` lo tiene encendido;
  3. el usuario confirmó la licencia.

  La interfaz muestra el motor apagado, con el texto "requiere licencia de empresa si tu equipo tiene 4 o más personas".
- **Configuración:**
  - Reutiliza el Chrome headless shell de HyperFrames o de `/opt/pw-browsers` con `browserExecutable`.
  - Haz `bundle()` una vez por plantilla y cachea el `serveUrl`.
  - Pasa `licenseKey` desde `.env`; sin llave, `null`.
- **Salida:** `mov` ProRes 4444 o una secuencia PNG para el compositor ffmpeg, igual que HyperFrames.

---

## 5. El CLI `skills` de npm (`npx skills add heygen-com/hyperframes`)

### 5.1 Qué es

- Paquete `skills@1.7.0`, licencia MIT, de **vercel-labs**: <https://github.com/vercel-labs/skills>. Directorio público de skills: <https://skills.sh>.
- Binarios: `skills` y `add-skill`. **Requiere Node ≥ 22.20.0** (`engines`); el `.nvmrc` del repo dice `22`.
- Instala skills con formato `SKILL.md` en ~80 agentes: Claude Code, Warp, Codex, Cursor…
- Comandos: `add`, `use`, `list|ls`, `find`, `remove|rm`, `update`, `init`, `experimental_install` (restaura desde `skills-lock.json`) y `experimental_sync` (desde `node_modules`).

### 5.2 De dónde descarga

Revisado en `dist/cli.mjs`:

- **GitHub:** `owner/repo` → `https://github.com/owner/repo.git`, con un **`git clone --depth 1`** a un directorio temporal (`skills-*`). Si falla la autenticación, intenta `gh repo clone` y luego SSH (`git@github.com:…`).
  - Para listar el árbol, usa `https://api.github.com/repos/...`: primero anónimo, luego con `GITHUB_TOKEN`/`GH_TOKEN`, luego `gh api`.
  - Para leer un SKILL.md puntual, usa `raw.githubusercontent.com`.
- **Otras fuentes:** URL de GitLab, Azure Repos, cualquier URL git, **ruta local**, o una URL directa a un `SKILL.md` o a un `.zip/.tar/.tgz`. Límites de esas descargas: 10 MiB de descarga, 25 MiB extraídos, 1,000 archivos.
  - También descubre índices `/.well-known/agent-skills/index.json`.
- **Telemetría:** anónima, a `add-skill.vercel.sh/t`, más una auditoría de seguridad en `add-skill.vercel.sh/audit` solo para repos públicos. Se desactiva con `DISABLE_TELEMETRY=1` o `DO_NOT_TRACK=1`.
- Si detecta que corre dentro de un agente (`@vercel/detect-agent`), instala **sin preguntar**. VERIFICADO: dentro de Claude Code imprimió *"Agent detected — installing non-interactively"*.
- **Dónde busca skills dentro del repo:**
  - la raíz;
  - `skills/`, `skills/.curated/`, `.experimental/`, `.system/`;
  - `.claude/skills/`, `.agents/skills/` y las demás carpetas de agentes;
  - en todos los casos, hasta 3 niveles de profundidad.
  - `--full-depth` busca en todo el repo.
  - VERIFICADO: sin `--full-depth`, `heygen-com/hyperframes` lista 21 skills; el lock del repo tiene 28, que incluyen `registry/blocks/*`.

### 5.3 Dónde instala

| Agente (`-a`) | Proyecto | Global (`-g`) |
|---|---|---|
| `claude-code` | `.claude/skills/` | `~/.claude/skills/` |
| `warp` (y cline, zed, dexto…) | `.agents/skills/` | `~/.agents/skills/` |
| `codex` | `.agents/skills/` | `~/.codex/skills/` |
| `cursor` | `.agents/skills/` | `~/.cursor/skills/` |

- **Copia canónica en `.agents/skills/<nombre>`.** Los agentes con otra carpeta reciben un **symlink relativo**, a menos que se pase `--copy`.
- VERIFICADO con `-a claude-code -a warp -y`: queda `.claude/skills/x -> ../../.agents/skills/x`. Con `--copy`, quedan copias reales en las dos carpetas. Con solo `-a claude-code -y`, copió directo a `.claude/skills/`.
- **`skills-lock.json`** en la raíz del proyecto (`version: 1`). Cada entrada lleva `source`, `sourceType` (`github|local|…`), `skillPath` y `computedHash`.
  - `computedHash` es un SHA-256 de (ruta relativa + contenido) de todos los archivos ordenados, ignorando `.git` y `node_modules`.
  - Las fuentes locales se guardan con rutas relativas portables.

### 5.4 Comandos exactos para la máquina local (Warp o cualquier terminal)

```bash
# Requisitos: Node >= 22.20, git (y opcional: gh autenticado)
cd editor-de-video

# Opción A (recomendada): instalar para Claude Code Y Warp (copia canónica en .agents + symlink en .claude)
npx -y skills add heygen-com/hyperframes --full-depth -a claude-code -a warp -y
#   Windows (sin symlinks): agrega --copy
npx -y skills add heygen-com/hyperframes --full-depth -a claude-code -a warp -y --copy

# Ver lo instalado / actualizar / quitar
npx skills ls
npx skills update -p -y
npx skills remove <nombre> -a '*'

# Estilo exportado por el autoeditor (carpeta local)
npx skills add ./data/estilos/<id>/skill -a claude-code -a warp -y
```

### 5.5 En este contenedor

- `curl https://github.com/...` y `curl https://api.github.com/...` responden **403**.
- **`git clone`/`git ls-remote` por HTTPS sí funcionan a través del proxy.** Por eso `npx skills add heygen-com/hyperframes --list` funcionó aquí (VERIFICADO), y por eso el repo ya trae las skills.

### 5.6 Bug encontrado en `scripts/setup.mjs` (VERIFICADO)

`setup.mjs` corre primero `npx -y skills experimental_install`. Solo si falla usa `skills add … --full-depth --yes`.

El código de `runInstallFromLock` llama `runAdd(..., { agent: getUniversalAgents() })`. Es decir, restaura **solo a `.agents/skills/`**.

Prueba: en `$SCRATCH/test-restore*` restauré con el `skills-lock.json` del repo.
- Quedan `.agents/skills/hyperframes*` y **no se crea `.claude/skills/`**.
- Claude Code 2.1.289 **no ve** skills que solo viven en `.agents/skills/` (VERIFICADO con el mensaje `init`).
- Warp sí las ve.

**Corrección sugerida** (no la apliqué: fuera de mi alcance). Después de `experimental_install`, asegurar `.claude/skills/` con una de estas opciones:
1. Correr siempre `npx -y skills add heygen-com/hyperframes --full-depth -a claude-code -a warp -y` (con `--copy` en Windows) en lugar de o además de `experimental_install`.
2. Por cada carpeta de `.agents/skills/`, crear `.claude/skills/<n>`: symlink relativo en macOS/Linux, copia en Windows (`fs.cpSync(src, dst, { recursive: true })`).

Y en `pnpm diagnostico`, comprobar `.claude/skills/hyperframes-core/SKILL.md`, no solo la ruta en `.agents`.

Observación: el restore completo es lento. Cada entrada del lock tiene su propio `skillPath` y se convierte en una fuente distinta (`…hyperframes.git (skills/product-launch-video)`), así que hace **un `git clone` por skill**: 28 clones. En el contenedor, la restauración completa tardó **283 s**. Por eso `skills add heygen-com/hyperframes --full-depth`, que clona una sola vez, es más rápido para la instalación inicial.

---

## 6. Warp: reglas de proyecto, skills y lo que necesita el repo

Fuente: código fuente de la documentación oficial, `warpdotdev/docs`: `src/content/docs/agents/capabilities/rules.mdx`, `skills.mdx`, `mcp.mdx`, `codebase-context.mdx` y `cli-agents/claude-code.mdx`. `docs.warp.dev` está bloqueado para WebFetch; el repo se leyó con `git clone`.

### 6.1 Reglas (Project Rules)

- Viven en **`AGENTS.md`**, o en `WARP.md` por compatibilidad.
  - El nombre **tiene que ir en MAYÚSCULAS**: `agents.md` no se reconoce.
  - **Si en la misma carpeta existen `WARP.md` y `AGENTS.md`, gana `WARP.md`.**
- Se aplican automáticamente el `AGENTS.md` de la **raíz** y el de la **carpeta actual**. El de otra subcarpeta se incluye "best effort" cuando editas archivos ahí.
- **Precedencia:** subcarpeta actual > raíz > Global Rules (las de Warp Drive, personales).
- `/init` en modo Agent:
  - indexa el código;
  - genera un `AGENTS.md`;
  - o **vincula** un archivo existente: `CLAUDE.md`, `.cursorrules`, `AGENT.md`, `GEMINI.md`, `.clinerules`, `.windsurfrules` o `.github/copilot-instructions.md`.
- Comandos útiles: `/open-project-rules` para editarlas y `/add-rule` para crear una regla global. También en Settings > Agents > Knowledge > Manage Rules.

### 6.2 Skills en Warp

- **Carpetas de proyecto** que escanea (desde la carpeta actual hasta la raíz del repo): `.agents/skills/` (recomendada), `.warp/skills/`, **`.claude/skills/`**, `.codex/skills/`, `.cursor/skills/`, `.gemini/skills/`, `.copilot/skills/`, `.factory/skills/`, `.github/skills/` y `.opencode/skills/`.
- **Carpetas globales:** los mismos nombres bajo `~`: `~/.agents/skills/`, `~/.claude/skills/`…
- **Formato:** `SKILL.md` con `name` y `description`, igual que Claude Code.
- **Invocación:**
  - por lenguaje natural;
  - con `/{nombre}`;
  - con argumentos `$ARGUMENTS`, `$ARGUMENTS[N]` y `$N`. Si la skill no tiene placeholders, el texto extra llega como un mensaje aparte.
- `/open-skill` lista y abre las skills disponibles.
- **Nombres repetidos:** el agente ve todas, con sus rutas, y elige. En la resolución automática gana la global y luego la más cercana a la raíz.
- Para scripts, la documentación sugiere rutas desde la raíz del proyecto (`python3 .agents/skills/x/script.py`). En la skill exportada, mejor rutas relativas a la skill más una aclaración.
- **Consecuencia para nosotros:**
  - Un estilo exportado e instalado en `.claude/skills/` o `~/.claude/skills/` funciona en **Warp y en Claude Code** sin hacer nada más.
  - Las skills de HyperFrames: Warp las ve en `.agents/skills/`; Claude Code necesita `.claude/skills/` (§5.6).
  - NO VERIFICADO: si el symlink `.claude/skills/x → .agents/skills/x` hace que Warp la liste dos veces. Según la doc, sería un nombre repetido que el agente resuelve por ruta.

### 6.3 Otros detalles de Warp

- **MCP por archivo:**
  - Warp lee `.warp/.mcp.json` (proyecto) y `~/.warp/.mcp.json` (global), activados por defecto.
  - El `.mcp.json` de Claude Code (en la raíz del proyecto) se usa solo si se activa el interruptor "Requires toggle".
  - Si en el futuro exponemos un servidor MCP del autoeditor, `.mcp.json` en la raíz sirve para Claude Code y, con el interruptor, para Warp.
- **Indexado:** respeta `.gitignore` y `.warpindexingignore`. Como `data/` y `node_modules/` ya están en `.gitignore`, no se indexan.
- **Claude Code dentro de Warp:** Warp lo detecta solo. Para notificaciones instala el plugin `warpdotdev/claude-code-warp`, que requiere `jq`:
  ```bash
  claude plugin marketplace add warpdotdev/claude-code-warp
  claude plugin install warp@claude-code-warp
  ```

### 6.4 Checklist: repo listo para seguir en Warp en local

| Punto | Estado en el repo hoy | Acción |
|---|---|---|
| `AGENTS.md` en la raíz, en mayúsculas, con estructura, reglas y comandos | ✔ existe | Mantenerlo como **fuente única** |
| `CLAUDE.md` con `@AGENTS.md` | ✔ existe | Correcto. Claude Code (≥ 2.1.277) lee `AGENTS.md` solo si **no** hay `CLAUDE.md`; con `CLAUDE.md` presente, el import `@AGENTS.md` lo incluye. Es el patrón recomendado por Anthropic, mejor que un symlink: en Windows un symlink de git se convierte en un archivo de texto |
| `WARP.md` | No existe | **No crearlo.** Si existiera, Warp lo leería en lugar de `AGENTS.md` en esa carpeta. Si la tarea #7 pide "AGENTS.md/WARP.md", basta con mencionar en el README que Warp lee `AGENTS.md` |
| `AGENTS.md` por subcarpeta (opcional) | No existe | Opcional: `apps/server/AGENTS.md` y `packages/editor/AGENTS.md` con las reglas locales de cada uno. Warp los aplica al trabajar ahí; Claude Code también los carga al leer archivos de esa carpeta |
| Skills de HyperFrames visibles en Warp | Restauradas en `.agents/skills/` | ✔ Warp las ve |
| Skills visibles en Claude Code | Solo con el fallback de `setup.mjs` | Corregir según §5.6 |
| Node | `.nvmrc` = `22` | El CLI `skills` exige ≥ 22.20 (`engines`). `node:sqlite` sin flag requiere ≥ 22.13, según DECISIONES. Sugerencia: `.nvmrc` → `22.20` o más reciente |
| Windows | — | Las skills con symlink se rompen sin `core.symlinks`. Usar `--copy` |

---

## 7. Verificado en el contenedor

| # | Prueba | Resultado |
|---|---|---|
| 1 | `npm pack` y lectura de `@anthropic-ai/claude-agent-sdk@0.3.289`, `skills@1.7.0`, `remotion`, `@remotion/renderer`, `@remotion/bundler` y `@remotion/licensing@4.0.532` | ✔ Firmas y opciones citadas desde `sdk.d.ts`, `render-media.d.ts`, `pixel-format.js`, `image-format.js`, `get-chrome-download-url.js` y `cli.mjs` |
| 2 | Docs de Claude Code (`code.claude.com/docs/en/skills.md`, `memory.md`) y de la plataforma (`skills-guide.md`) por `curl` | ✔ Accesibles desde el contenedor; tablas citadas del Markdown original |
| 3 | Skill de estilo de ejemplo en `.claude/skills/` + `claude plugin validate --strict` | ✔ Pasa. Con YAML roto falla. Un `name` con mayúsculas y el campo `version` **no** se detectan |
| 4 | Claude Code 2.1.289 (`claude -p --output-format stream-json --setting-sources project`) | ✔ `init.skills` y `init.slash_commands` incluyen `estilo-podcast-dinamico`. Si la skill solo está en `.agents/skills/`, **no** aparece |
| 5 | Invocar `/estilo-podcast-dinamico` (1 turno) | ✔ El transcript muestra `Base directory for this skill: <ruta>` + cuerpo sin frontmatter |
| 6 | Validador, serializador y parser con `yaml@2` (§2.4) | ✔ Roundtrip, errores esperados, SKILL.md real de `hyperframes-core` válido |
| 7 | Ejemplo del Agent SDK con `skills`, `settingSources` y `createSdkMcpServer` | ✔ `tsc --strict` sin errores (no ejecutado contra la API) |
| 8 | `skills add <ruta local> -a claude-code -y` | ✔ Copia a `.claude/skills/` y escribe `skills-lock.json` (`sourceType: local`) |
| 9 | `skills add <ruta> -a claude-code -a warp -y` con y sin `--copy` | ✔ Symlink `.claude/skills/x → ../../.agents/skills/x`; con `--copy`, dos copias |
| 10 | `skills add heygen-com/hyperframes --list` | ✔ Funciona: clona por git a través del proxy. 21 skills sin `--full-depth` |
| 11 | `skills experimental_install` con el lock del repo | ✔ Restaura en `.agents/skills/` y **no** crea `.claude/skills/` (bug §5.6). Con el lock completo, la primera corrida se cortó a los 240 s con 23 de 28 |
| 12 | Corrida completa en segundo plano de `experimental_install` | ✔ exit 0 en **283 s**, con 28 de 28 skills en `.agents/skills/` y **sin** `.claude/` (un `git clone` por skill) |
| 13 | Instalación de Remotion 4.0.532 + React 19.2.3 | ✔ 179 paquetes, 208 MB, 13 s |
| 14 | `bundle` + `selectComposition` + `renderMedia` con `browserExecutable` de `/opt/pw-browsers` | ✔ MP4 h264, MOV ProRes 4444 `yuva444p12le` y WebM VP9 `alpha_mode=1`, cada uno en 1.3-2.0 s |
| 15 | Alfa por píxel (PNG extraído y decodificado) | ✔ Esquina con alfa 0, centro con alfa máximo, en MOV y WebM |
| 16 | Docs fuente de Remotion (licencia, FAQ, precios, alfa, SSR, dependencias de Linux) y de Warp (rules, skills, MCP, indexado, Claude Code) por `git clone --sparse` | ✔ Citadas |

## 8. NO VERIFICADO / no se pudo probar (y por qué)

- **Precios de Remotion en remotion.pro** (checkout real) y la página renderizada de remotion.dev: **bloqueados** (EGRESS_BLOCKED en WebFetch y sin conexión por curl). Los números salen del código fuente de la documentación y del calculador en el repo oficial (2026-10-03), y coinciden con los snippets de búsqueda. Los términos legales completos (`/docs/terms`) no se revisaron.
- **`ensureBrowser()` descargando Chrome:** `remotion.media` y `storage.googleapis.com` están bloqueados. Se usó el Chromium de Playwright.
- **Subida a claude.ai o a la Skills API:** sin cuenta ni llave. Los requisitos (30 MB, SKILL.md en la raíz, 6 campos) vienen de la documentación.
- **Ejecutar el Agent SDK contra la API:** solo se comprobaron los tipos. La carga de skills se verificó con el CLI `claude`, que es el mismo motor.
- **El prompt de sistema del editor con la skill (§2.5):** es un esbozo, no se ejecutó.
- **Warp en sí:** no hay Warp en el contenedor. Su comportamiento (orden de reglas, escaneo de `.claude/skills/`, duplicados por symlink) viene solo de su documentación oficial.
- **Windows y macOS:** el comportamiento de symlinks y de `--copy` en Windows viene de la documentación (Claude Code memory, README de `skills`). No se probó.
- **Lo que se indexa en Warp con nuestros `.gitignore`:** no probado.

## 9. Fuentes

- Claude Code, skills: <https://code.claude.com/docs/en/skills> (Markdown: `…/skills.md`).
- Claude Code, memoria (AGENTS.md / CLAUDE.md): <https://code.claude.com/docs/en/memory>.
- Agent SDK, skills: <https://code.claude.com/docs/en/agent-sdk/skills>.
- Agent Skills, overview: <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>.
- Buenas prácticas: <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>.
- Skills API: <https://platform.claude.com/docs/en/build-with-claude/skills-guide>.
- Spec abierta: <https://agentskills.io> (citada por la doc de Claude Code; no accesible desde el contenedor).
- `@anthropic-ai/claude-agent-sdk@0.3.289`: `README.md`, `sdk.d.ts`, `manifest.json` (npm pack).
- `skills@1.7.0`: `README.md`, `dist/cli.mjs` (npm pack); repo <https://github.com/vercel-labs/skills>.
- Remotion:
  - `LICENSE.md` (npm 4.0.532);
  - `packages/docs/docs/license/faq.mdx`, `license/pricing.mdx`, `transparent-videos.mdx`, `ssr-node.mdx`, `miscellaneous/linux-dependencies.mdx`;
  - `packages/promo-pages/src/components/homepage/FreePricing.tsx` (repo `remotion-dev/remotion`, commit `e385a83`);
  - <https://www.remotion.dev/docs/license/pricing>, <https://www.remotion.pro/license>.
- Warp: `src/content/docs/agents/capabilities/{rules,skills,mcp,codebase-context}.mdx` y `agents/cli-agents/claude-code.mdx` (repo `warpdotdev/docs`, commit `3d54389`); <https://docs.warp.dev/agents/capabilities/rules/>, <https://docs.warp.dev/agents/capabilities/skills/>.
