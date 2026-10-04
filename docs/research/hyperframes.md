# HyperFrames (HeyGen): investigación para el motor de motion graphics

> Fecha: 2026-10-04 · Versiones probadas: `hyperframes@0.8.120` (CLI), `@hyperframes/producer@0.8.120`, `gsap@3.15.0`, Node 22.22.0, ffmpeg 6.1.1 (`/usr/bin/ffmpeg`).
> Todo lo marcado **VERIFICADO** se ejecutó en este contenedor. Lo marcado **NO VERIFICADO** viene de la documentación o del código y no se pudo probar aquí.
> Carpeta de pruebas: `/tmp/claude-0/-home-user-editor-de-video/f6f89765-a86b-5bf9-b268-9519fd86e804/scratchpad/research-hyperframes/` (de aquí en adelante, `$SCRATCH`).

> **Revisión crítica (2026-10-04, segunda mirada).** Cambios marcados con **[REVISIÓN]** en el texto:
> - **Corregido §12:** las skills de HyperFrames **no** viajan con el repo. `.agents/skills/` y `.claude/skills/` están en `.gitignore`; se restauran con `pnpm instalar`, y esa restauración hoy solo llena `.agents/skills/` (Claude Code no las ve; ver `skills-remotion-warp.md` §5.6).
> - **Verificado:** `HYPERFRAMES_FFMPEG_PATH` sí lo respeta el engine. `doctor` lo reporta y una ruta falsa da `✗ Configured path does not exist`. En el código, el engine lo lee de `process.env` dentro de `getFfmpegBinary()`, aparte de `producerConfig`, así que sigue valiendo aunque se pase `producerConfig`.
> - **Verificado:** el "byte a byte" de §2.2. `md5sum` da lo mismo (`60465d07…`) para el Chrome 152 descargado, el headless_shell de Playwright y el Chromium completo.
> - **Nuevo, para la Mac del usuario:** el `ffmpeg` de Homebrew (9.0.2 al 2026-10-04) trae libvpx y ProRes, así que HyperFrames funciona con él. Si se instala `ffmpeg-full` (necesario para los subtítulos, ver `media-pipeline.md` §14.1), es *keg-only* y no queda en el `PATH`: hay que pasar `HYPERFRAMES_FFMPEG_PATH` y `HYPERFRAMES_FFPROBE_PATH`, o poner su `bin` en el `PATH` del worker.

## 0. Veredicto

**HyperFrames cumple los 4 objetivos y queda VERIFICADO en el contenedor:**

1. **Generar la composición con props:** es un HTML normal. Nuestro backend lo arma con un template string. Para los props hay dos opciones: escribirlos directo en el HTML, o declarar **variables** (`data-composition-variables`) y sobrescribirlas al renderizar.
2. **Renderizar con alfa real** (no es chroma key):
   - `webm`: VP9 `yuva420p`, con `ALPHA_MODE=1`.
   - `mov`: ProRes 4444 `yuva444p`.
   - `png-sequence`: PNG RGBA.

   Probé que el alfa se conserva (por píxel) y que el resultado se compone con ffmpeg sobre un video base.
3. **Duración, fps y resolución:**
   - La duración y la resolución salen del HTML (`data-duration`, `data-width`, `data-height` en el root).
   - Los fps salen de la opción `fps`.
   - Probé 1080x1920 a 30 fps, 1080x1080 a 24 fps y 1920x1080 a 60 fps.
4. **Requisitos:**
   - Node ≥ 22.
   - ffmpeg.
   - Chrome **headless shell**: se descarga solo, o se usa el de `/opt/pw-browsers`.
   - GSAP **local**: el CDN está bloqueado en el contenedor, así que GSAP se instala de npm y se copia al proyecto.

**Recomendación:**
- Usar la **API programática `@hyperframes/producer`** (`createRenderJob` + `executeRenderJob`) dentro de un **proceso worker aparte**.
- El **CLI vía `child_process.spawn`** es la alternativa, y sirve también para `lint`, `check` y `snapshot`.
- Como intermedio para componer con ffmpeg conviene **`png-sequence`** (el más rápido, sin pérdida) o **`mov`**. `webm` queda para previsualizar en el navegador.

---

## 1. Paquetes npm del scope

| Paquete | Versión | Para qué | ¿Lo necesitamos? |
|---|---|---|---|
| `hyperframes` | 0.8.120 | CLI: `init`, `lint`, `check`, `render`, `snapshot`, `browser`, `skills`, `add`, `catalog`… Trae el producer **empaquetado** en su `dist/` | Sí: lint/check/snapshot, descarga de Chrome y CLI de respaldo |
| `@hyperframes/producer` | 0.8.120 (salió 0.8.121 durante esta sesión) | Pipeline completo de render desde Node: compila, captura, codifica y mezcla audio | **Sí**: API programática |
| `@hyperframes/engine` | 0.8.120 | Primitivas de bajo nivel (Puppeteer + FFmpeg, captura por frame) | No directamente (es dependencia del producer) |
| `@hyperframes/core` | 0.8.120 | Tipos, parser y generador de HTML, linter, runtime IIFE, frame adapters | Opcional (`lintHyperframeHtml`, tipos) |
| `@hyperframes/player` | 0.8.120 | Web component `<hyperframes-player>` para previsualizar en el navegador | Opcional (frontend). NO VERIFICADO |
| `@hyperframes/sdk`, `studio`, `studio-server`, `parsers`, `lint`, `shader-transitions`, `aws-lambda`, `gcp-cloud-run` | 0.8.120 | Edición headless, Studio, parsers, transiciones WebGL, render distribuido | No por ahora |
| `@hyperframes/renderer` | — | **No existe** (`npm view` da 404) | — |

- Licencia de `hyperframes`: Apache-2.0.
- GSAP: "Standard 'no charge' license" (`npm view gsap license`).
- **El proyecto publica versiones casi a diario** (0.x, 470+ versiones). Hay que fijar **versiones exactas e iguales** para todos los `@hyperframes/*`.

---

## 2. Requisitos y entorno

| Requisito | Detalle | Estado |
|---|---|---|
| Node | `engines: { node: ">=22" }` en CLI, producer y engine | VERIFICADO con 22.22.0 |
| ffmpeg / ffprobe | Usa el del `PATH`. Se puede forzar con `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` | VERIFICADO con `/usr/bin/ffmpeg` 6.1.1. **[REVISIÓN]** Override VERIFICADO con `doctor` (ruta falsa → `✗`, `/usr/bin/ffmpeg` → `✓`); render con override no probado |
| Chrome | Prefiere **chrome-headless-shell**, que permite la captura determinista `HeadlessExperimental.beginFrame` en Linux | VERIFICADO |
| GSAP | Es el runtime de animación por defecto. **Debe cargarse local** (ver §8) | VERIFICADO |
| RAM | Cada worker lanza un Chrome (~256 MB según la ayuda del CLI). Con ≤ 8 GB activa "low-memory mode" (1 worker) | Documentado |

### 2.1 De dónde saca Chrome (orden real, leído de `engine/dist/services/browserManager.js`)

1. `producerConfig.chromePath` (API).
2. `PRODUCER_HEADLESS_SHELL_PATH`.
3. `HYPERFRAMES_BROWSER_PATH`.
4. `~/.cache/hyperframes/chrome/chrome-headless-shell/…`: lo descarga `npx hyperframes browser ensure`.
5. `~/.cache/puppeteer/chrome-headless-shell/…`.

### 2.2 Apuntar al Chromium de `/opt/pw-browsers` (VERIFICADO)

```bash
# Headless shell de Playwright (Chromium 141.0.7390.37): soporta BeginFrame. Opción recomendada en el contenedor.
export HYPERFRAMES_BROWSER_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
npx hyperframes doctor   # → "✓ Chrome  env: /opt/pw-browsers/.../headless_shell"
```

- **Headless shell:** mp4 (beginframe), webm con alfa y API con `chromePath` funcionan, y salen **byte a byte iguales** que con el Chrome 152 descargado (mismo tamaño, 352 775 B). **[REVISIÓN]** Confirmado con `md5sum`: `overlay.mp4`, `pw_headless.mp4` y `fullchrome.mp4` dan `60465d07abf8f4ddf90f4b5c0d0e4f37`.
- **Chromium completo** (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`): también renderiza, pero BeginFrame falla (`'HeadlessExperimental.enable' wasn't found`) y cae al modo screenshot, más lento (12.7 s contra 8.6 s). **Conviene usar el headless_shell.**
- **Descarga propia:** `npx hyperframes browser ensure` descargó Chrome Headless Shell **152.0.7977.30** (114 MB, ~6 s) desde storage.googleapis.com, que **sí es alcanzable** desde el contenedor. Queda en `~/.cache/hyperframes/chrome` (261 MB descomprimido).

En local (Warp / macOS / Windows) basta con `npx hyperframes browser ensure`. Hay que dejar `HYPERFRAMES_BROWSER_PATH` como variable **opcional** en `.env`.

### 2.3 Variables de entorno útiles para un backend

| Variable | Efecto |
|---|---|
| `HYPERFRAMES_NO_TELEMETRY=1` (o `DO_NOT_TRACK=1`) | Desactiva la telemetría anónima del CLI |
| `HYPERFRAMES_NO_UPDATE_CHECK=1` y `HYPERFRAMES_NO_AUTO_INSTALL=1` | Evitan el chequeo y la **auto-actualización en segundo plano** del CLI, que existe (`autoUpdate-*.js`, config en `~/.hyperframes`) |
| `HYPERFRAMES_SKIP_SKILLS=1` | `init` no intenta instalar skills |
| `HYPERFRAMES_BROWSER_PATH` / `PRODUCER_HEADLESS_SHELL_PATH` | Ruta de Chrome |
| `HYPERFRAMES_EXTRACT_CACHE_DIR` | Caché de frames extraídos de `<video>`. Por defecto `/tmp/hyperframes-extract-cache-<uid>` |
| `PRODUCER_VP9_CPU_USED` | Velocidad/calidad de VP9 (-8…8, default 4) |
| `PRODUCER_LOW_MEMORY_MODE`, `PRODUCER_MAX_WORKERS`, `PRODUCER_PLAYER_READY_TIMEOUT_MS`, `PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS`, `PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS` | Ajustes del engine (lista completa en `engine/dist/config.js`) |

---

## 3. Instalación (comandos exactos, VERIFICADOS)

```bash
# npm
npm install hyperframes@0.8.120 @hyperframes/producer@0.8.120 gsap@3.15.0
# o pnpm (como nuestro monorepo)
pnpm add hyperframes@0.8.120 @hyperframes/producer@0.8.120 gsap@3.15.0
#   → pnpm 10 avisa "Ignored build scripts: esbuild, puppeteer". NO hace falta aprobarlos:
#     render por CLI y por API funcionaron así. Además evita que puppeteer descargue su propio Chrome.
#   → con npm, usa PUPPETEER_SKIP_DOWNLOAD=1 para no bajar Chrome dos veces.

# Chrome (una vez por máquina; en el contenedor se puede saltar usando /opt/pw-browsers)
npx hyperframes browser ensure
npx hyperframes browser path      # imprime la ruta, útil para scripts
npx hyperframes doctor            # chequea Node, ffmpeg, Chrome, /dev/shm…
```

- Tiempos: `npm install hyperframes` tardó 6 s; con el producer, 4.6 s más (node_modules: 285 MB, sobre todo por `@fontsource/*` y Puppeteer).
- `doctor` marca como opcionales (✗) whisper-cpp, Kokoro TTS, MusicGen y Docker. No hacen falta para renderizar.

Para el "un comando para instalar" de la app, se puede añadir un `postinstall` que ejecute `hyperframes browser ensure`, salvo que esté definido `HYPERFRAMES_BROWSER_PATH`.

---

## 4. El contrato de una composición (lo que enseñan las skills y la doc de core)

Fuentes: `@hyperframes/core/docs/core.md`, la skill `hyperframes-core` (`SKILL.md` + `references/*`) y el `CLAUDE.md` que genera `hyperframes init`.

- **Root standalone** (`index.html`): `<div id="root" data-composition-id="ID" data-start="0" data-duration="S" data-width="W" data-height="H">` directo en `<body>`, **sin `<template>`**.
  - La resolución sale de `data-width` y `data-height`.
  - Incluye `<meta name="viewport" content="width=W, height=H">`.
- **Duración del render = `data-duration` del root.** Se lee **una sola vez al compilar**: ni un script ni `--variables` pueden cambiarla después. Para variar la duración, se escribe en el HTML generado.
- **Una sola timeline GSAP pausada** registrada con la misma clave que el `data-composition-id`:

  ```js
  const tl = gsap.timeline({ paused: true });
  // …tweens…
  window.__timelines["ID"] = tl;
  ```

  - El runtime crea `window.__timelines` antes de que corran tus scripts.
  - Si la timeline se arma de forma async (por ejemplo tras `document.fonts.ready`), **se registra al final**.
- **Clips:** cualquier elemento con `data-start` y `data-duration` es un clip temporizado. El framework controla su visibilidad.
  - Convención: `class="clip"`.
  - `data-track-index` solo sirve como carril visual en Studio; el render no lo lee.
- **Prohibido** (lo detecta `lint`, o es un bug silencioso):
  - Animar `visibility`, `display` o `autoAlpha` sobre un `.clip`: anima un hijo.
  - Combinar un `transform` inicial en CSS con un tween GSAP sobre la misma propiedad. Usa `fromTo`.
  - `Date.now()`, `performance.now()`, `Math.random()` sin semilla, fetch de red en tiempo de render, eventos hover/scroll.
  - `repeat: -1` sin `data-duration` finita en el root.
  - Llamar `video.play()`, `pause()` o `currentTime`: el framework controla los medios.
  - `crossorigin` en `<video>` o `<audio>`.
  - `<audio>` sin `id` (queda **mudo**).
  - `<video data-start>` dentro de un contenedor que también tenga `data-start`.
- **Texto:**
  - Nada de `<br>` en texto corrido.
  - Los elementos transformados deben ser block o inline-block con tamaño.
  - Para que texto dinámico quepa existen `window.__hyperframes.fitTextFontSize(text, {maxWidth, fontFamily, fontWeight})` y `window.__hyperframes.pretext` (NO VERIFICADOS).
- **Fondo y alfa:**
  - Para salida transparente no se pinta fondo en `html`, `body` ni el root. Al renderizar con alfa, el engine los fuerza a `transparent !important`.
  - Los fondos de elementos internos sí se respetan.
  - Si se renderiza a **mp4** con fondo transparente, sale **blanco** (VERIFICADO). Para mp4 opaco, pinta un fondo.
- **Sub-composiciones:** `data-composition-src="compositions/x.html"`. Ese archivo va envuelto en `<template>`, con `<style>` y `<script>` **dentro** del template.
- **Medios:** `<video src data-start data-duration data-media-start>` con seek exacto por frame: el render extrae los frames con ffmpeg y los inyecta (VERIFICADO, ver §6.4).

### 4.1 Variables (props en tiempo de render), VERIFICADO

**Declaración** en `<html>`: un **array** `[{id, type, label, default}]`. Tipos: `string`, `number`, `color`, `boolean`, `enum` (con `options`).

**Uso dentro de la composición:**
- `data-var-text="id"`: reemplaza el texto del elemento. VERIFICADO.
- `data-var-src="id"`: reemplaza `src` (imágenes). NO VERIFICADO.
- Cada variable escalar queda como **propiedad CSS `--id`** en el root: `background: var(--accent)`. VERIFICADO.
- Desde JS: `const v = window.__hyperframes.getVariables();` (contador con `v.count`). VERIFICADO.

**Sobrescritura:**
- CLI: `--variables '{"title":"…"}'` (un **objeto**) o `--variables-file f.json`.
- API: `createRenderJob({ variables: {...} })`.
- Con `--strict-variables`, una clave no declarada o con tipo incorrecto aborta el render con exit 1 (VERIFICADO: "Variable validation failed").
- La API **no** tiene equivalente a `--strict-variables`: hay que validar los props en nuestro backend.

---

## 5. Ejemplo mínimo que funciona (VERIFICADO)

Proyecto `$SCRATCH/overlay-test/`:
- `index.html` y `vendor/gsap.min.js`, copiado de `node_modules/gsap/dist/gsap.min.js`.
- 1080x1920, 3 s, fondo transparente.
- Contenido: título animado, palabra clave en "pill", contador y cintillo (lower-third).

```html
<!doctype html>
<html
  lang="es"
  data-composition-variables='[
    {"id":"title","type":"string","label":"Título","default":"Hola Zyra"},
    {"id":"subtitle","type":"string","label":"Cintillo","default":"Autoeditor con IA"},
    {"id":"keyword","type":"string","label":"Palabra clave","default":"RÁPIDO"},
    {"id":"count","type":"number","label":"Contador","default":1500},
    {"id":"accent","type":"color","label":"Acento","default":"#8B7CF0"}
  ]'
>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="vendor/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: transparent; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: sans-serif; }
      .clip { position: absolute; inset: 0; }
      #title-wrap { display: flex; align-items: flex-start; justify-content: center; padding-top: 260px; }
      #title { color: #fff; font-size: 110px; font-weight: 800; text-shadow: 0 6px 24px rgba(0,0,0,.45); }
      #kw-wrap { display: flex; align-items: center; justify-content: center; }
      #kw { display: block; background: var(--accent); color: #fff; font-size: 120px; font-weight: 900; padding: 10px 40px; border-radius: 24px; }
      #counter-wrap { display: flex; align-items: flex-start; justify-content: center; padding-top: 1150px; }
      #counter { color: #FBE88A; font-size: 140px; font-weight: 900; text-shadow: 0 6px 24px rgba(0,0,0,.45); }
      #lt-wrap { display: flex; align-items: flex-end; justify-content: flex-start; padding: 0 0 380px 60px; }
      #lt { display: block; width: 760px; background: rgba(15,15,20,.88); border-left: 16px solid var(--accent); padding: 28px 36px; }
      #lt-text { color: #fff; font-size: 56px; font-weight: 700; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="overlay" data-start="0" data-duration="3" data-width="1080" data-height="1920">
      <div id="title-wrap" class="clip" data-start="0" data-duration="3" data-track-index="0">
        <h1 id="title" data-var-text="title">Hola Zyra</h1>
      </div>
      <div id="kw-wrap" class="clip" data-start="0.8" data-duration="1.6" data-track-index="1">
        <span id="kw" data-var-text="keyword">RÁPIDO</span>
      </div>
      <div id="counter-wrap" class="clip" data-start="0" data-duration="3" data-track-index="2">
        <div id="counter">0</div>
      </div>
      <div id="lt-wrap" class="clip" data-start="0.3" data-duration="2.7" data-track-index="3">
        <div id="lt"><div id="lt-text" data-var-text="subtitle">Autoeditor con IA</div></div>
      </div>
    </div>
    <script>
      const vars = window.__hyperframes.getVariables();
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#title", { opacity: 0, y: -80 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, 0);
      tl.fromTo("#kw", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2)" }, 0.8);
      tl.to("#kw", { opacity: 0, duration: 0.3 }, 2.1);
      const counter = { v: 0 };
      tl.to(counter, {
        v: Number(vars.count) || 0, duration: 2, ease: "power2.out",
        onUpdate: () => { document.getElementById("counter").textContent = Math.round(counter.v).toLocaleString("es-MX"); }
      }, 0.2);
      tl.fromTo("#lt", { opacity: 0, x: -120 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, 0.3);
      tl.to("#title", { opacity: 0, duration: 0.3 }, 2.7);
      window.__timelines["overlay"] = tl;
    </script>
  </body>
</html>
```

**Comandos ejecutados** (desde `$SCRATCH/overlay-test`, con `HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1`):

```bash
npx hyperframes lint .                     # 0 errores, 3 warnings (ver §9)
npx hyperframes check .                    # lint + runtime + layout + motion + contraste → "Check passed" (6 s)
npx hyperframes render . -o out/overlay.mp4                       # 8.6 s → h264 yuv420p 1080x1920 30fps 90 frames 3.0 s
npx hyperframes render . --format webm -o out/overlay.webm        # 18.2 s → vp9, tag ALPHA_MODE=1
npx hyperframes render . --format mov --quiet --strict-variables \
  --variables '{"title":"Lanzamiento","keyword":"GRATIS","count":250,"accent":"#EE6B6B","subtitle":"Ana López · CEO"}' \
  -o out/overlay_vars.mov                                         # 15.5 s → prores 4444, textos y color sustituidos
npx hyperframes render . --format png-sequence --workers 4 -o out/seq   # 4.9 s → 90 PNG RGBA (frame_000001.png…)
npx hyperframes snapshot . --at 0.5,1.5 --no-end -o snaps --describe false  # PNG por instante + contact-sheet.jpg (4 s)
```

Revisé visualmente frames de mp4, mov y webm compuesto: textos, colores y el contador ("1,436" a 1.5 s) salieron correctos.

---

## 6. Transparencia y composición con ffmpeg (VERIFICADO)

### 6.1 Formatos con alfa

| `--format` / `format` | Códec y píxeles | Alfa | Tamaño medido (3 s 1080x1920) | Uso recomendado |
|---|---|---|---|---|
| `webm` | VP9 `yuva420p`, metadato `alpha_mode=1`, audio Opus | Sí | ~515 KB | Previsualización web (`<video>` en Chrome/Firefox; Safari incompleto) |
| `mov` | ProRes 4444. Se codifica como `yuva444p10le`; ffprobe lo reporta como `yuva444p12le` | Sí, 10 bit | ~26 MB | Intermedio de alta calidad |
| `png-sequence` | Carpeta de PNG RGBA `frame_%06d.png`; el audio va aparte en sidecar | Sí, sin pérdida | ~6.8 MB | **El intermedio más rápido para ffmpeg** |
| `mp4` | H.264 yuv420p | No (el fondo transparente sale blanco) | ~345 KB | Clip opaco a pantalla completa |
| `gif` | Paleta | Alfa de 1 bit | — | No aplica |

Lo que confirma la doc del producer y el código:
- **En Linux, el alfa fuerza la captura por screenshot**, porque BeginFrame no conserva el alfa. Es más lento por frame.
- HDR y alfa no se pueden combinar.
- `--resolution 4k` (supersample) no funciona con alfa en cloud (según la doc de cloud; NO VERIFICADO en local).

### 6.2 Comprobar que el alfa existe de verdad

`ffprobe` muestra `pix_fmt=yuv420p` para el webm porque **el decodificador VP9 nativo de ffmpeg ignora el alfa**. Hay que forzar `libvpx-vp9` **antes** de `-i`:

```bash
ffmpeg -c:v libvpx-vp9 -ss 1.5 -i out/overlay.webm -frames:v 1 -vf alphaextract -f rawvideo -pix_fmt gray - \
  | od -An -tu1 -v | tr -s ' ' '\n' | grep -v '^$' | sort -n | uniq -c | sort -rn | head -3
#  1760288 0      ← píxeles 100 % transparentes
#   129651 255    ← opacos (texto)
#    78172 225    ← el cintillo rgba(...,.88) → 0.88*255 ≈ 225  (alfa parcial conservado)
```

### 6.3 Superponer sobre el video base

**WebM** con un desfase de 1 s (en la prueba el video base no tenía audio):

```bash
ffmpeg -y -i base.mp4 -c:v libvpx-vp9 -i overlay.webm \
  -filter_complex "[1:v]setpts=PTS-STARTPTS+1/TB[ov];[0:v][ov]overlay=0:0:eof_action=pass:format=auto[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p composited.mp4        # 4.2 s para 5 s de video
```

**Secuencia PNG** (la ruta recomendada), con un desfase de 0.5 s:

```bash
ffmpeg -y -i base.mp4 -framerate 30 -start_number 1 -i seq/frame_%06d.png \
  -filter_complex "[1:v]setpts=PTS-STARTPTS+0.5/TB[ov];[0:v][ov]overlay=0:0:eof_action=pass:format=auto[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -preset veryfast out.mp4   # 4.0 s
```

**MOV** ProRes 4444: `[0][1]overlay=format=auto` funciona directo, sin forzar decodificador (probado sobre `color=` 1920x1080).

Puntos importantes:
- `-c:v libvpx-vp9` **debe ir antes** de `-i overlay.webm`. Sin eso, el overlay sale opaco.
- `setpts=PTS-STARTPTS+T/TB` coloca el overlay en el segundo T. `eof_action=pass` deja ver el video base cuando termina el overlay.
- Para conservar el audio del base, lo estándar es añadir `-map 0:a? -c:a copy`. **NO VERIFICADO** aquí (el base de prueba no tenía audio).
- **No hace falta chroma key**: hay alfa real.

### 6.4 Alternativa: render a pantalla completa (VERIFICADO)

HyperFrames también puede renderizar **todo el corte**, metiendo el video base como `<video>` dentro de la composición:

```html
<video id="base" class="clip" src="assets/base.mp4" data-start="0" data-duration="3" data-media-start="0.5" data-track-index="0" data-has-audio="true" playsinline></video>
```

- Resultado: mp4 con video y audio AAC, 3 s, renderizado en 14.1 s (extracción 1.3 s + captura 9.5 s).
- El seek es exacto: el frame de salida en 1.5 s corresponde a la fuente en `00:00:02.000` (frame 60), es decir 1.5 + `data-media-start` 0.5.
- Es más lento que ffmpeg (~4.7× tiempo real en 4 vCPU). Por eso se recomienda la estrategia híbrida de §10.

---

## 7. Invocación desde Node

### 7.1 API programática `@hyperframes/producer` (recomendada), VERIFICADA

> ⚠️ **El README de npm del producer está desactualizado**: muestra `createRenderJob({ inputPath, outputPath, width, height, fps })` y `executeRenderJob(job, onProgress)`. **Las firmas reales** (`dist/services/renderOrchestrator.d.ts`, y la doc oficial `docs/packages/producer.mdx` del repo) son las de abajo. **No existen** `width` ni `height`: salen del HTML.

```ts
// Firmas (extraídas de los .d.ts de @hyperframes/producer@0.8.120)
createRenderJob(config: RenderConfigInput): RenderJob
//   RenderConfigInput = {
//     fps: number | { num: number; den: number };    // requerido
//     quality: "draft" | "standard" | "high";        // requerido
//     format?: "mp4" | "webm" | "mov" | "png-sequence" | "gif" | "hls";
//     variables?: Record<string, unknown>;           // = --variables
//     entryFile?: string;                            // default "index.html"
//     workers?: number; crf?: number; videoBitrate?: string; useGpu?: boolean;
//     strictness?: "strict" | "best-effort"; hdrMode?: "auto"|"force-hdr"|"force-sdr";
//     producerConfig?: EngineConfig;                 // p.ej. resolveConfig({ chromePath }) — si se pasa, NO lee env vars
//     logger?: ProducerLogger; debug?: boolean; ...
//   }
executeRenderJob(job, projectDir: string, outputPath: string,
                 progressSink?: (job: RenderJob, message: string) => void | Promise<void>,
                 abortSignal?: AbortSignal, assertRenderActive?: () => void): Promise<void>
// RenderJob: { id, status: "queued"|"preprocessing"|"rendering"|"encoding"|"assembling"|"complete"|"failed"|"cancelled",
//              progress (0-100), currentStage, outcome: "completed"|"completed_with_warnings"|"failed"|"cancelled",
//              warnings[], error?, totalFrames?, framesRendered?, perfSummary?, errorDetails?, ... }
// Errores: RenderQualityError (warnings de corrección bloquean el render), RenderCancelledError (abort).
// Otros exports: resolveConfig, startServer, createProducerApp, plan/renderChunk/assemble (distribuido), createConsoleLogger…
```

**Script probado** (`$SCRATCH/node-api/render-api.mjs`): genera la composición desde props y renderiza tres formatos.

```js
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";

const require = createRequire(import.meta.url);
const GSAP_PATH = require.resolve("gsap/dist/gsap.min.js");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function buildLowerThirdHtml({ width, height, duration, name, role, accent }) {
  const vars = [
    { id: "name", type: "string", label: "Nombre", default: name },
    { id: "role", type: "string", label: "Cargo", default: role },
    { id: "accent", type: "color", label: "Acento", default: accent },
  ];
  return `<!doctype html>
<html lang="es" data-composition-variables='${esc(JSON.stringify(vars))}'>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<script src="vendor/gsap.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
  #root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: sans-serif; }
  .clip { position: absolute; inset: 0; }
  #lt-wrap { display: flex; align-items: flex-end; padding: 0 0 ${Math.round(height * 0.12)}px ${Math.round(width * 0.05)}px; }
  #lt { display: block; background: rgba(10,10,14,.9); border-left: 14px solid var(--accent); padding: 22px 34px; }
  #lt-name { color: #fff; font-size: ${Math.round(Math.min(width, height) * 0.05)}px; font-weight: 800; }
  #lt-role { color: #ddd; font-size: ${Math.round(Math.min(width, height) * 0.032)}px; font-weight: 500; }
</style>
</head>
<body>
<div id="root" data-composition-id="lt" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
  <div id="lt-wrap" class="clip" data-start="0" data-duration="${duration}" data-track-index="0">
    <div id="lt">
      <div id="lt-name" data-var-text="name">${esc(name)}</div>
      <div id="lt-role" data-var-text="role">${esc(role)}</div>
    </div>
  </div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo("#lt", { opacity: 0, x: -200 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, 0.1);
  tl.fromTo("#lt-role", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4 }, 0.4);
  tl.to("#lt", { opacity: 0, x: -200, duration: 0.4, ease: "power2.in" }, ${duration} - 0.5);
  window.__timelines["lt"] = tl;
</script>
</body>
</html>`;
}

async function renderOverlay({ outDir, width, height, duration, fps, format, variables }) {
  const projectDir = path.join(outDir, `proj-${width}x${height}`);
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(path.join(projectDir, "vendor"), { recursive: true });
  await copyFile(GSAP_PATH, path.join(projectDir, "vendor", "gsap.min.js"));
  await writeFile(path.join(projectDir, "index.html"),
    buildLowerThirdHtml({ width, height, duration, name: "Nombre", role: "Cargo", accent: "#8B7CF0" }));
  const outputPath = path.join(outDir, `lt-${width}x${height}-${fps}fps.${format}`);
  const job = createRenderJob({ fps, quality: "standard", format, variables, workers: 2 });
  await executeRenderJob(job, projectDir, outputPath, (j, msg) => {/* j.progress 0-100, j.status, msg */});
  return { outputPath, status: job.status, outcome: job.outcome, frames: job.totalFrames };
}
// casos probados: {1080x1920, 2.5 s, 30 fps, webm} {1080x1080, 2.5 s, 24 fps, webm} {1920x1080, 2.5 s, 60 fps, mov}
```

**Resultados:**

| Caso | Tiempo | Frames | Estado |
|---|---|---|---|
| 1080x1920, 30 fps, webm | 12.7 s | 75 | `completed` |
| 1080x1080, 24 fps, webm | 7.2 s | 60 | `completed` |
| 1920x1080, 60 fps, mov | 15.6 s | 150 | `completed` |

Los tres con duración 2.5 s exacta y alfa comprobada al componer sobre un color.

**Otros comportamientos comprobados:**
- **Chrome explícito:** `createRenderJob({ …, producerConfig: resolveConfig({ chromePath: "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell" }) })` funciona (14.7 s webm). `resolveConfig` se importa desde `@hyperframes/producer`.
- **Errores:**
  - Con GSAP bloqueado, `executeRenderJob` **lanza** `RenderQualityError` y deja `job.status = "failed"`.
  - Con `AbortController.abort()` lanza `RenderCancelledError` y deja `status = "cancelled"`.
- **Al terminar:** el proceso sale limpio sin `process.exit` y no quedan Chromes vivos.
- **Logs:** el engine escribe muchas líneas con `console.log` (`[BrowserManager]`, `[initSession]`…) **aunque se pase `logger`**. Esta es una de las razones para correr los renders en un proceso aparte.

### 7.2 CLI vía `child_process` (alternativa), VERIFICADA

Script probado: `$SCRATCH/node-api/render-cli.mjs`. Usa el bin local en lugar de `npx` para no resolver ni descargar en runtime.

```js
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const HF_BIN = path.join(path.dirname(require.resolve("hyperframes/package.json")), "bin", "hyperframes.mjs");

export function renderWithCli({ projectDir, output, format = "webm", fps = 30, quality = "standard", variables, workers, browserPath, signal, onLine }) {
  const args = [HF_BIN, "render", projectDir, "-o", output, "--format", format, "--fps", String(fps), "--quality", quality, "--quiet", "--strict-variables"];
  if (variables) args.push("--variables", JSON.stringify(variables));
  if (workers) args.push("--workers", String(workers));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectDir, signal,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", NO_COLOR: "1",
             ...(browserPath ? { HYPERFRAMES_BROWSER_PATH: browserPath } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const collect = (b) => { const s = b.toString(); tail = (tail + s).slice(-8000); onLine?.(s); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ output, code })
      : reject(Object.assign(new Error(`hyperframes render salió con código ${code}`), { code, tail })));
  });
}
```

- **Caso bueno:** `{ok:true, ms:12961}`, webm con variables.
- **Caso malo** (variable no declarada con `--strict-variables`): exit 1 y "Variable validation failed".
- **CDN bloqueado:** exit 1, sin archivo de salida, mensaje `Render blocked by 1 correctness warning: sub_timeline_script_failure`.
- **El código de salida es fiable.** `--quiet` y `--json` **no limpian stdout**: siguen saliendo logs del engine. No hay que parsear stdout para saber el resultado.

### 7.3 Render por lotes con el CLI, VERIFICADO

Una sola composición, muchas filas de variables:

```bash
npx hyperframes render . --batch rows.json --format webm --json --quiet -o 'out/batch-{index}.webm'
```

- `rows.json` es un array de objetos de variables.
- Sin `{index}` en `-o`, falla con "Batch output collision".
- Escribe `out/manifest.json`: `{ total, completed, failed, rows: [{ index, outputPath, status, durationMs, renderTimeMs, error, variables }] }`. **Hay que leer el manifest**, no stdout.
- Prueba: 2 filas renderizadas en 32 s, en serie. `--batch-concurrency` sube el paralelismo.

### 7.4 ¿API o CLI?

| | API producer | CLI spawn |
|---|---|---|
| Progreso | Callback tipado (`progress`, `status`, mensaje) | Hay que parsear texto (frágil) |
| Cancelar | `AbortSignal` → `RenderCancelledError` | `signal`/kill del hijo |
| Validar variables | No hay modo estricto: validar en nuestro backend | `--strict-variables` |
| Chrome | `chromePath` en `resolveConfig` o env | Env, o el que gestiona el CLI (`browser ensure`) |
| Aislamiento | Se ejecuta en el proceso que la llama: **hay que ponerla en un worker** | Ya es otro proceso |
| Extras | — | `lint`, `check`, `snapshot`, `batch` |

**Decisión sugerida:**
- **Worker de render** (proceso Node aparte, por ejemplo con `child_process.fork` o una cola) que usa la API del producer.
- **CLI** para `check` y `snapshot` antes de entregar.
- **`snapshot --at …`** genera PNG que Claude puede revisar ("mirar fotogramas de su propio render", PROMPT §6).

---

## 8. GSAP, CDN y red (problema encontrado y solución)

- Las plantillas oficiales (`init`, la doc y los bloques del registry) cargan GSAP desde `https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js`.
- Al compilar, el compilador intenta **descargar e inlinear** ese script desde Node: `[Compiler] WARNING: Failed to download CDN script … HTTP 403`. Después, en Chrome, `gsap` es `null` y el render se aborta con `RenderQualityError` / exit 1.
- **Solución VERIFICADA:** instalar `gsap` de npm, copiar `node_modules/gsap/dist/gsap.min.js` dentro del proyecto (`vendor/gsap.min.js`) y referenciarlo de forma relativa. El compilador solo reescribe a CDN un `gsap…/dist/…` local **cuando el archivo no existe**.
- En una máquina con internet el CDN funcionaría (NO VERIFICADO aquí), pero **conviene vendorizar siempre** para que el render sea determinista y funcione offline.

---

## 9. Tipografías (VERIFICADO)

- **Fuentes genéricas:** `sans-serif` y las de sistema se mapean a una fuente determinista empaquetada. Por ejemplo, `sans-serif`, Arial, Helvetica y SF Pro → **Inter**. Tabla completa: `FONT_ALIAS_MAP` de `@hyperframes/parsers`.
- **Nombres de Google Fonts:** se **descargan al compilar** desde `fonts.googleapis.com` (alcanzable desde el contenedor) y se guardan en `~/.cache/hyperframes/fonts/<familia>`. Probado con "Anton".
- ⚠️ **Algunos nombres se sustituyen por alias:** "Bebas Neue" se renderizó como **League Gothic** (`league-gothic <= league gothic, bebas neue`), "Futura" como Montserrat y "Georgia" como EB Garamond.
- **Fuentes de marca:** usar `@font-face` con **archivo local** dentro del proyecto. El compilador lo incrusta como data URI (`Embedded local font file: assets/fonts/MiMarca-ExtraBold.woff2 (19 KB → data URI)`). Es la opción robusta para "TENGO IDENTIDAD DE MARCA".

  ```css
  @font-face { font-family: "MiMarca"; src: url("assets/fonts/MiMarca-ExtraBold.woff2") format("woff2"); font-weight: 800; }
  ```

---

## 10. Arquitectura recomendada para el autoeditor

1. **La receta describe cada motion graphic.** Ejemplo: `{ tipo: "lower-third", props, inicio, duracion, formato: "9:16" }`.
2. **El generador** (función TS pura) devuelve el HTML. Las dimensiones salen del formato:

   | Formato | Resolución |
   |---|---|
   | 9:16 | 1080x1920 |
   | 1:1 | 1080x1080 |
   | 4:5 | 1080x1350 (NO VERIFICADO) |
   | 16:9 | 1920x1080 |

   - La **duración va escrita en el root**.
   - Los textos y colores van como variables, y se escapan con `esc()`.
   - La carpeta del proyecto lleva `vendor/gsap.min.js` y las fuentes de marca.
   - Claude puede escribir las plantillas siguiendo el contrato de §4 (las skills lo enseñan).
3. **Validación:** `hyperframes lint --json` (o `lintHyperframeHtml` de `@hyperframes/core/lint`, NO VERIFICADO) y, opcionalmente, `hyperframes check`.
4. **Render en el worker** con la API: `format: "png-sequence"` (el más rápido) o `"mov"`, con `workers: 2–4`. Para la previsualización en la UI, `webm`.
5. **Composición:** el render base (cortes, música, subtítulos) lo hace ffmpeg. Cada overlay se aplica con `overlay=…:eof_action=pass` y `setpts=PTS-STARTPTS+inicio/TB`.
6. **Revisión de calidad:** `hyperframes snapshot --at t1,t2` sobre la composición, o extraer frames del resultado final con ffmpeg, para que Claude los revise.
7. **Caché por hash** de (HTML + variables + fps + formato): solo se re-renderiza lo que cambió entre V1 y V2 (regla de oro del PROMPT).

Alternativa sin ffmpeg: meter el video base en la composición (§6.4). Es útil para piezas cortas; para videos largos es más lento.

---

## 11. Rendimiento medido (contenedor: 4 vCPU Xeon 2.8 GHz, 15.7 GB, GL por software SwiftShader)

| Render | Ruta de captura | Tiempo total | Desglose |
|---|---|---|---|
| mp4 1080x1920, 3 s, 30 fps | beginframe, 2 workers | **8.6 s** | captura+encode 6.7 s, setup 1.4 s |
| webm alfa, ídem | screenshot (forzado por el alfa) | **18.2 s** | captura 6.4 s + **VP9 9.4 s** |
| webm `--vp9-cpu-used 8` | screenshot | 16.1 s | encode 8.2 s |
| webm `--workers 4 --vp9-cpu-used 8` | screenshot | **12.8 s** | captura 4.3 s + encode 7.9 s |
| mov ProRes 4444 `--workers 4` | screenshot | 10.5 s | captura 4.5 s + encode 5.3 s (26 MB) |
| **png-sequence `--workers 4`** | screenshot | **4.9 s** | sin encode (6.8 MB) |
| Pantalla completa con `<video>` + audio, 3 s | beginframe | 14.1 s | extracción 1.3 s, captura 9.5 s |
| ffmpeg: overlay webm o PNG sobre base de 5 s | — | ~4 s | — |

- El arranque (compilar y lanzar Chrome) cuesta ~1–3 s por render.
- `--quality draft` no acelera VP9 de forma notable.

---

## 12. Skills para Claude Code: `npx skills add heygen-com/hyperframes`

- **Qué es:** `skills` (npm, de vercel-labs, v1.7.0) es un instalador genérico de "agent skills".
- **Cómo instala:** clona `github.com/heygen-com/hyperframes` y copia las carpetas `SKILL.md`.
- **En el contenedor funciona** (`git clone` pasa por el proxy, aunque `curl` a github.com da 403). Lo probé con `HOME` falso en `$SCRATCH/skills-proj`:

  ```bash
  npx --yes skills add heygen-com/hyperframes --list                                       # lista 21 skills
  npx --yes skills add heygen-com/hyperframes --skill '*' --agent claude-code --copy --yes # instaló las 21 (9.5 s)
  ```

**Las 21 skills:**
- **Núcleo:** `hyperframes` (router, punto de entrada obligatorio), `hyperframes-core` (contrato de composición), `hyperframes-animation`, `hyperframes-keyframes`, `hyperframes-creative`, `hyperframes-audio`, `hyperframes-cli`, `hyperframes-registry`, `hyperframes-studio`, `media-use`.
- **Flujos:** `motion-graphics` (incluye `lower-thirds`, `kinetic-type`, `news` con keyword, `logo-reveal`; exporta como `alpha-overlay` → `--format webm/mov`), `talking-head-recut` (overlays sobre footage: títulos, lower-thirds, callouts, sincronizados a la transcripción), `embedded-captions` (subtítulos sobre talking-head), `general-video`, `faceless-explainer`, `music-to-video`, `product-launch-video`, `pr-to-video`, `slideshow`, `remotion-to-hyperframes`, `figma`.

**Dónde quedan:**

| Agente | Proyecto | Global |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| **Warp** (tabla interna de `skills`) | **`.agents/skills/`** | `~/.agents/skills/` |

- El repo **ya tiene** las skills instaladas, aunque no las instalé yo: lo hizo otro agente a las 08:39. Están en `.agents/skills/` con symlinks en `.claude/skills/` y `skills-lock.json`, más 7 bloques del registry como skills (`canopy-part-title`, `glass-shard-title`…).
  - **[REVISIÓN] Corrección:** esto vale **solo para este contenedor**. `.agents/skills/` y `.claude/skills/` están en `.gitignore` (`git ls-files .agents .claude` no devuelve nada). Al clonar el repo en local **solo llega `skills-lock.json`**, y las skills se restauran con `pnpm instalar`. Hoy esa restauración (`skills experimental_install`) llena solo `.agents/skills/`: Warp las ve, pero **Claude Code no**. La corrección está en `skills-remotion-warp.md` §5.6.
- **Instalación no interactiva para agentes o CI:** `npx hyperframes skills update [nombre]`.
  - Por dentro ejecuta `npx skills add https://github.com/heygen-com/hyperframes --skill … --global --agent claude-code universal --copy --full-depth --yes`.
  - Instala **global**, y solo el set núcleo más lo que se pida.
- El paquete npm `hyperframes` trae una copia de solo 3 skills en `dist/skills/` (`hyperframes`, `hyperframes-cli`, `media-use`).

**Reglas de composición que enseñan:** son las de §4, más estas:
- Patrones GSAP seek-safe: posiciones precalculadas, nunca `getBoundingClientRect` durante un tween; solo `x`/`y`/`scale`/`rotation` para movimiento espacial.
- Pasos obligatorios: `npx hyperframes check` antes de entregar y `snapshot` para revisar.
- "Renderiza solo tras aprobación". Esta regla está pensada para uso interactivo; nuestro backend la sustituye por la revisión automática de frames.
- `motion-graphics/lower-thirds`: "barra que entra con wipe (`scaleX` desde 0, `transform-origin:left`), texto que sube, hold, salida; fondo transparente → webm/mov; dentro de la franja title-safe inferior".

---

## 13. Registry de bloques (VERIFICADO)

- `npx hyperframes catalog --query "lower third" --json` busca entre **386 items** (bloques y componentes) sin instalar nada: `yt-lower-third`, `lt-stack-bars`, `lt-kicker-name`…
- `npx hyperframes add lt-stack-bars` descargó `compositions/lt-stack-bars.html` desde `raw.githubusercontent.com` (alcanzable) y creó `hyperframes.lock.json`.
- Los bloques **también cargan GSAP desde CDN**: hay que reescribir el `src` a `../vendor/gsap.min.js`.
- Con eso, `npx hyperframes render . -c compositions/lt-stack-bars.html --format webm -o out/lt.webm` funcionó (16.3 s; overlay transparente correcto).
- Algunos bloques traen textos fijos, sin variables: hay que parametrizarlos nosotros. Sirven como **catálogo de plantillas** de partida (licencia del repo: Apache-2.0).

---

## 14. Problemas encontrados y soluciones

| Problema | Causa | Solución |
|---|---|---|
| `Render blocked by 1 correctness warning: sub_timeline_script_failure (…jsdelivr…/gsap.min.js)`, exit 1 | CDN bloqueado (403) | Vendorizar GSAP desde npm (§8) |
| `ffprobe` muestra `yuv420p` en el webm "transparente" | El decodificador VP9 nativo ignora el alfa | Leer con `-c:v libvpx-vp9` antes de `-i` (§6.2) |
| mp4 con fondo blanco | No hay alfa en H.264; el fondo por defecto de Chrome es blanco | Pintar fondo para mp4, o usar webm/mov/png-sequence |
| `Screenshot capture (slower): BeginFrame did not run` | Alfa en Linux, o Chromium completo en vez de headless shell | Esperado con alfa. Para mp4, usar headless_shell |
| `Batch output collision` | Sin placeholder en `-o` | `-o 'out/x-{index}.webm'` |
| Warning `nested_structure_needs_subcomposition` | Regla de organización de Studio (un clip con hijos en el root) | Inofensivo para el render. Para silenciarlo, mover cada escena a una sub-composición `<template>` |
| "Bebas Neue" se ve como League Gothic | Alias de fuentes | `@font-face` local con el archivo real (§9) |
| `--quiet`/`--json` siguen imprimiendo logs | Logs del engine con `console.log` | Usar el exit code y `manifest.json`, o la API |
| README del producer en npm con firmas viejas | Doc desactualizada | Usar las firmas de §7.1 (.d.ts + `docs/packages/producer.mdx`) |
| Versiones que cambian a diario (0.8.121 apareció a mitad de la sesión) | Proyecto 0.x muy activo | Fijar versión exacta y la misma en todos los paquetes; desactivar la auto-actualización (§2.3) |

---

## 15. Verificado en el contenedor

**VERIFICADO (ejecutado aquí):**
- [x] Instalación con npm y con pnpm 10 (sin aprobar build scripts). `doctor`.
- [x] `hyperframes browser ensure` (Chrome Headless Shell 152, desde storage.googleapis.com).
- [x] `HYPERFRAMES_BROWSER_PATH` con el headless_shell de `/opt/pw-browsers` (Chromium 141) en mp4 y webm alfa. `chromePath` vía `resolveConfig` en la API. Chromium completo (cae a screenshot).
- [x] `init --example blank --non-interactive --resolution portrait`; `lint`; `check`; `snapshot --at`; `catalog`; `add`; `compositions` por `-c`.
- [x] Render a mp4, webm (VP9 alfa), mov (ProRes 4444), png-sequence. Alfa medido por píxel. Composición con ffmpeg sobre video base (webm, png-seq, mov).
- [x] Resoluciones 1080x1920, 1080x1080, 1920x1080. fps 24, 30, 60. Duración desde `data-duration` (3 s y 2.5 s exactos).
- [x] Variables: `data-var-text`, CSS `var(--id)`, `getVariables()`, `--variables`, `--strict-variables`, `variables` en la API, `--batch` + `manifest.json`.
- [x] API producer: progreso, `RenderQualityError`, `RenderCancelledError` con AbortSignal, salida limpia del proceso.
- [x] CLI vía `child_process.spawn` (éxito y error con exit code).
- [x] Fuentes: `@font-face` local incrustada, Google Fonts descargadas, alias.
- [x] `<video>` dentro de la composición, seek exacto por frame y audio AAC en la salida.
- [x] `npx skills add heygen-com/hyperframes` (lista e instalación de las 21 skills en scratch).
- [x] Lectura de la doc oficial: clon sparse de `docs/` del repo con `git` (commit `a8ccda23`, 2026-10-04), porque `hyperframes.heygen.com`, `developers.heygen.com` y `skills.sh` están bloqueados para WebFetch y github.com para curl y MCP.

**NO VERIFICADO (y por qué):**
- [ ] `startServer({ port })` / `POST /render` del producer (servidor HTTP): no se probó; el formato del body está en `renderRequest.d.ts`.
- [ ] `--docker` (el daemon de Docker no corre en el contenedor), `--gpu`, `--browser-gpu` por hardware (no hay GPU).
- [ ] Render en la nube de HeyGen (`hyperframes cloud`, requiere cuenta), AWS Lambda y Cloud Run.
- [ ] macOS y Windows (destino local con Warp). Según la doc usan modo screenshot por defecto, y `browser ensure` descarga el binario de cada plataforma.
- [ ] Audio dentro de overlays webm (Opus) y mapeo `-map 0:a?` al componer.
- [ ] fps distintos de 24/30/60 (la ayuda del CLI acepta 1–240 y racionales como `30000/1001`), atributo `data-fps` en el root, formato 4:5.
- [ ] `data-var-src`, `fitTextFontSize`, `pretext`, `@hyperframes/player`, `lintHyperframeHtml` desde código. (`HYPERFRAMES_FFMPEG_PATH`: **[REVISIÓN]** verificado con `doctor`; falta un render completo con el override.)
- [ ] **[REVISIÓN]** Render con el ffmpeg 9.x de Homebrew (`ffmpeg` o `ffmpeg-full`). El engine avisa que sin el filtro `psnr` cae del modo "fast capture" a otro más lento; no se midió cuánto.
- [ ] `hyperframes transcribe` (whisper-cpp no instalado), `tts` y `remove-background`.
- [ ] Rendimiento en piezas largas (más de 10 s) o con muchos `<video>`.

---

## 16. Archivos de prueba (en `$SCRATCH`, fuera del repo)

- `overlay-test/index.html`: ejemplo de §5. Salidas en `overlay-test/out/` (`overlay.mp4`, `overlay.webm`, `overlay_vars.mov`, `composited.mp4`, `batch-*.webm`, `manifest.json`…).
- `node-api/render-api.mjs`: generador + API, 3 resoluciones. `render-chromepath.mjs`, `render-fail.mjs` (error y abort), `render-cli.mjs` (spawn).
- `video-test/`: `<video>` dentro de la composición. `font-test/`: fuentes. `reg-test/`: bloque del registry. `pnpm-test/`: instalación con pnpm.
- `pack/`: tarballs extraídos de `hyperframes`, `@hyperframes/core`, `producer` y `engine`. `hf-repo/docs/`: doc oficial (clon sparse). `skills-proj/.claude/skills/`: las 21 skills.

## 17. Fuentes consultadas

- Paquetes npm (`npm pack`): README y `dist/*.d.ts` de `hyperframes`, `@hyperframes/core` (`docs/core.md`, `docs/common-mistakes.md`, `docs/quickstart-template.html`), `@hyperframes/producer` y `@hyperframes/engine`.
- Doc oficial (fuente MDX del repo `heygen-com/hyperframes`, carpeta `docs/`): `packages/producer.mdx`, `guides/rendering.mdx`, `guides/skills.mdx`, `guides/plugins.mdx`.
- Skills: `hyperframes`, `hyperframes-core` (+ `references/variables-and-media.md`, `determinism-rules.md`, `minimal-composition.md`), `hyperframes-cli` (`references/preview-render.md`, `doctor-browser.md`), `motion-graphics`, `talking-head-recut`.
- Búsqueda web: [developers.heygen.com/hyperframes-overview](https://developers.heygen.com/hyperframes-overview), [skills.sh/heygen-com/hyperframes/hyperframes-cli](https://skills.sh/heygen-com/hyperframes/hyperframes-cli), [yuv.ai/blog/heygen-hyperframes-html-video](https://yuv.ai/blog/heygen-hyperframes-html-video). Solo los títulos de resultados; el contenido estaba bloqueado para WebFetch.
