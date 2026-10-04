# Pipeline de medios: ffmpeg 6.1 + transcripción con tiempos por palabra

> **Fecha:** 2026-10-04 · **Para:** el ingeniero que implementa el análisis, el render y la transcripción del autoeditor (ver `PROMPT.md` §4.1, §4.3, §4.4, §4.5 y §6).
> **Estado:** casi todo se ejecutó de verdad en el contenedor (4 vCPU Xeon a 2.8 GHz, 15 GB de RAM, ffmpeg 6.1.1 de Ubuntu). Los clips de prueba se generaron ahí mismo. **No se corrió ningún modelo Whisper**, porque Hugging Face no es alcanzable desde el contenedor; de faster-whisper se verificaron la instalación, las firmas leídas del código, el VAD incluido y el error al trabajar sin conexión (§10).
> **Segunda pasada (reanudación tras una interrupción del flujo):** se volvió a correr el script de humo de §14 (`TODO OK`, tercer render con el mismo hash que los dos anteriores) y se re-verificaron a mano las afirmaciones de más impacto: desfase de `fps`, caída silenciosa de libass a DejaVu, alfa de VP9, límite de anidamiento de expresiones (con un ajuste: ver §5.3), Haar en OpenCV 5 (con un matiz: ver §11.1) y la lógica de `hotwords`/`initial_prompt` en el código de faster-whisper.
> Lo marcado **NO VERIFICADO** no se pudo probar aquí. La sección §14 explica cómo repetir todo en local (Warp, macOS o Linux) con un solo script.
> **Revisión crítica (2026-10-04, tercera mirada).** Cambios marcados con **[REVISIÓN]**. Tres de ellos bloquean la implementación:
> 1. **`-filter_complex_script` ya no existe en FFmpeg 9.0.2**, que es la versión actual de Homebrew en la Mac del usuario. Lo verifiqué en el código: `fftools/ffmpeg_opt.c` del tag `n9.0.2` no lo define. Y `-/filter_complex archivo` **no existe en 6.1**: aquí da `Unrecognized option '/filter_complex'`, exit 8. **Ninguna de las dos formas funciona en ambas versiones.** Lo recomendado es pasar el grafo inline con `-filter_complex <texto>` como elemento del arreglo de `spawn`. En Linux un solo argumento debe medir menos de 128 KiB (verificado: 131071 bytes pasa, 131072 da `E2BIG`). Si el grafo es más grande: `-/filter_complex` con ffmpeg ≥ 7 y `-filter_complex_script` con ffmpeg < 7, según `ffmpeg -version` (§5.1).
> 2. **El `ffmpeg` de Homebrew (9.0.2) no trae libass, freetype, fontconfig ni harfbuzz**, así que le faltan `ass`, `subtitles` y `drawtext`. Hay que usar **`brew install ffmpeg-full`**, que es *keg-only*, y apuntar `FFMPEG_PATH`/`FFPROBE_PATH` a `$(brew --prefix ffmpeg-full)/bin/`. Lo verifiqué leyendo `Formula/f/ffmpeg.rb` y `ffmpeg-full.rb` de homebrew-core (commit `619eaea`, 2026-10-04) (§14.1).
> 3. **Primera transcripción real con Whisper y tiempos por palabra**, sin red y sin Python. Usé transformers.js 4.3.0 con `onnxruntime-node` y pesos ONNX q8 de whisper-small sacados de npm. En español salió bien, con errores en nombres propios ("Zyra" → "Sia"). Además, la corrección determinista del glosario de §10.4 **no** arregla ese tipo de error (§10.4 y §10.6).

---

## 0. Resumen: lo que hay que saber antes de programar

1. **ffprobe JSON** (`-show_format -show_streams`) basta para el inventario. La **rotación** viene en `streams[].side_data_list[].rotation` (displaymatrix): ffprobe reporta el tamaño *codificado* (1920x1080) y ffmpeg **autorrota al decodificar** (entrega 1080x1920). **VFR:** `r_frame_rate ≠ avg_frame_rate` es una buena pista; la prueba fiable son los deltas de PTS. El `duration_time` de los paquetes **no sirve** para esto (§2).
2. **Muestreo de fotogramas con tiempo exacto:** `fps=1/N` (con `round=near`, el valor por defecto) entrega el frame de **t ≈ k·N + N/2**, no el de k·N. Hay que usar **`fps=1/N:round=up`** o `select` + `showinfo`. Esto importa para los fotogramas que mira Claude y para el seguimiento de rostro (§3).
3. **Escenas:** `select='gt(scene,0.3)',showinfo` y se parsea `pts_time`; un cambio de color puro solo puntúa 0.40. **Silencios:** `silencedetect=noise=-35dB:d=0.4`. **Loudness:** `ebur128` para medir y `loudnorm` en dos pasadas para normalizar (§4).
4. **Render desde la receta:** cada segmento entra con `-ss/-to` como opción de entrada y se normaliza con `setpts=PTS-STARTPTS,fps=30,…,setsar=1,format=yuv420p`. El audio va a 48 kHz estéreo fltp. Después vienen `xfade` y `acrossfade` con `offset_k = Σdur − Σtransiciones`. Probado con 4 fuentes (25/60/29.97 fps y VFR, 1080p/720p, iPhone rotado, una sin audio): la duración sale **exacta** (§5).
5. **Reencuadre a vertical:** `crop` con `x` como expresión de `t` (lineal por tramos) o con `sendcmd`. **Las expresiones de ffmpeg admiten ~100 niveles de funciones anidadas**: 98 `if()` sueltos funcionan, pero dentro de `clip(...)` solo 97. Para pistas largas: `sendcmd` (probado con 1000 comandos) o una expresión por segmento (§5.3).
6. **Punch-in:** `scale=w='…t…':h=-2:eval=frame,crop=1080:1920` funciona en 6.1 (+0.25 s por segundo de video); `zoompan` también (+0.12) (§5.4). **Color:** `eq` es casi gratis; `colorbalance` y `lut3d` cuestan **~+0.7 s por segundo de video cada uno**, así que conviene hornear todo en **un solo .cube** (§5.5).
7. **Subtítulos:** `.ass` generado por nosotros (código probado en §6) y quemado con `ass=…:fontsdir=…`. **Trampa grave:** libass busca por *nombre completo* (`Montserrat ExtraBold`). Con `Montserrat` o con el nombre PostScript **cae en silencio a DejaVu Sans**, así que siempre se verifica con la línea `fontselect` del log. Con `BorderStyle=3` (caja) el color de la caja es **OutlineColour**. Google Fonts entrega **TTF** si se pide sin User-Agent de navegador.
8. **Audio:** el ducking se hace con `sidechaincompress` (umbral **lineal**) y bajó la música 13.5 dB mientras hay voz. Los SFX van con `adelay=…:all=1` + `amix=…:normalize=0`: con el `normalize=1` por defecto la mezcla queda ~8 dB más baja. **`loudnorm` cae a modo dinámico** si `TP_medido + (I_obj − I_medido) > TP_obj`. Un limitador previo lo mantiene lineal: así llegó a **−13.8 LUFS / −1.6 dBTP** (§7).
9. **Alfa:** WebM VP9 `yuva420p` **solo conserva el alfa si se decodifica con `-c:v libvpx-vp9` antes de `-i`**; el decodificador nativo lo descarta. ProRes 4444 (`prores_ks`) funciona sin truco (§8).
10. **Determinismo:** el mismo comando en la misma máquina da **bytes idénticos**. **Cambiar `-threads` cambia la salida de x264**, así que hay que fijar `-threads 4`. `-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1` quita las cadenas de versión. Las fuentes aleatorias (`anoisesrc`) necesitan `seed=` (§9).
11. **Rendimiento a 1080x1920 y 30 fps con `-preset veryfast` en 4 vCPU:** **0.58 s de render por segundo de video** con una fuente con grano. Una receta realista sale entre 0.85 y 1.36 s/s (§9.2). La tabla de costos por filtro para el estimador está en §9.2.
12. **faster-whisper 1.2.1** (ctranslate2 4.8.2) se instala con pip/uv en 2 s. `WhisperModel(...).transcribe(audio, language="es", word_timestamps=True, vad_filter=True, hotwords=..., initial_prompt=...)` devuelve un **generador** de `Segment` con `words: [Word(start,end,word,probability)]`. Para el glosario sirve **`hotwords`**, que se aplica en *cada* ventana de 30 s; `initial_prompt` solo afecta a la primera si `condition_on_previous_text=False`. Sin conexión: `download_model(..., output_dir=...)` y cargar por ruta, o `HF_HUB_OFFLINE=1` (§10).
13. **Rostros:** **opencv-python-headless 5.0 quitó `CascadeClassifier` y los XML Haar** (`opencv-contrib-python` 5.0 conserva la clase, pero tampoco trae los XML), así que hay que fijar `opencv-python-headless<5` (4.14.0 trae los cascades). **mediapipe 1.0.1** ya no trae `mp.solutions`: solo la Tasks API, con un modelo `.tflite` que se descarga de `storage.googleapis.com` (alcanzable) y necesita `libEGL.so.1`. Su modelo *short-range* no ve rostros chicos. El script de seguimiento con suavizado sin retraso centró el rostro con un error de ±4 % del ancho (§11).

---

## 1. Entorno probado y convenciones

| Componente | Versión (contenedor) |
|---|---|
| ffmpeg / ffprobe | 6.1.1-3ubuntu5 (`--enable-libass --enable-libfreetype --enable-libfribidi --enable-libharfbuzz --enable-libx264 --enable-libx265 --enable-libvpx --enable-libzimg --enable-libfontconfig …`) |
| libass / x264 / libvpx / zimg | 0.17.1 / 0.164.3108 / 1.14.0 / 3.0.5 |
| Node / Python / uv | 22.22.0 / 3.11.15 / 0.8.17 |
| espeak-ng (voz de prueba) | 1.51, voz `es-419` |
| faster-whisper / ctranslate2 / av (PyAV) | 1.2.1 / 4.8.2 / 18.1.0 |
| opencv-python-headless | 5.0.0.93 (sin Haar) y 4.14.0 (con Haar) |
| mediapipe | 1.0.1 (arrastra `opencv-contrib-python` 5.0) |
| CPU | 4 vCPU Intel Xeon a 2.80 GHz, 15 GB de RAM |

- Todo se probó en una carpeta de scratch con estas subcarpetas: `clips/`, `out/`, `render/`, `subs/`, `audio/`, `alpha/`, `bench/`, `face/` y `asr/`. Los comandos usan esas rutas relativas.
- Los tiempos se midieron con el reloj de pared y **sin otros procesos pesados en paralelo**. "s/s" significa **segundos de render por segundo de video de salida**.
- Opciones comunes: `-hide_banner -v error -y`. Para parsear la salida de los filtros de análisis se necesita `-v info` (es el valor por defecto) porque `showinfo` y `silencedetect` escriben en nivel info.

### 1.1 Clips de prueba (generados con ffmpeg y espeak-ng)

```bash
cd clips
# Voz en español (espeak-ng). En macOS sin espeak-ng: say -v Paulina -o voz1.aiff "..."
espeak-ng -v es-419 -s 150 -w voz1.wav "Hola, soy Zyra. Hoy te voy a enseñar tres trucos para editar video con inteligencia artificial."
espeak-ng -v es-419 -s 150 -w voz2.wav "Primero, quita los silencios. Segundo, agrega subtítulos. Tercero, usa música con ducking."
ffmpeg -hide_banner -v error -y -i voz1.wav -i voz2.wav -filter_complex \
  "[0:a]aresample=48000,apad=pad_dur=1.5[a0];[1:a]aresample=48000[a1];[a0][a1]concat=n=2:v=0:a=1[a]" -map "[a]" -ac 1 voz.wav   # 17.24 s, silencio de 1.5 s en medio

# A: horizontal 1920x1080 25fps H.264 + voz ("entrevista")
ffmpeg -hide_banner -v error -y -f lavfi -i "testsrc2=s=1920x1080:r=25:d=17.24" -i voz.wav -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 128k -ar 48000 -shortest A_h1080p25_voz.mp4
# B: 1280x720 60fps con 2 cambios de escena (rojo -> azul -> testsrc2) + ruido rosa
ffmpeg -hide_banner -v error -y -f lavfi -i "color=c=red:s=1280x720:r=60:d=3" -f lavfi -i "color=c=blue:s=1280x720:r=60:d=3" -f lavfi -i "testsrc2=s=1280x720:r=60:d=3" -f lavfi -i "anoisesrc=c=pink:a=0.1:d=9:r=48000" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]" -map "[v]" -map 3:a -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 B_720p60_escenas.mp4
# C: tipo iPhone, HEVC 'hvc1' guardado en 1920x1080 a 29.97 con displaymatrix de 90° (se ve vertical)
ffmpeg -hide_banner -v error -y -f lavfi -i "mandelbrot=s=1920x1080:r=30000/1001" -f lavfi -i "sine=f=440:d=6:r=48000" -t 6 -c:v libx265 -preset ultrafast -x265-params log-level=error -tag:v hvc1 -pix_fmt yuv420p -c:a aac -ar 48000 C_raw.mov
ffmpeg -hide_banner -v error -y -display_rotation 90 -i C_raw.mov -c copy C_iphone_rot90.mov      # -display_rotation existe en 6.1
# D: VFR (30 fps los primeros 2 s, luego 10 fps), sin audio
ffmpeg -hide_banner -v error -y -f lavfi -i "testsrc2=s=1280x720:r=30:d=6" -vf "select='lt(t\,2)+not(mod(n\,3))'" -fps_mode vfr -c:v libx264 -preset veryfast -pix_fmt yuv420p D_vfr_sin_audio.mp4
# E: tipo iPhone HDR (HEVC 10 bit, BT.2020, HLG)
ffmpeg -hide_banner -v error -y -f lavfi -i "testsrc2=s=1920x1080:r=30:d=3" -vf format=yuv420p10le -c:v libx265 -preset ultrafast \
  -x265-params "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc" -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -tag:v hvc1 E_hlg10.mov
```

**Trampa:** `testsrc2` y `color` se comprimen de forma irreal (son muy baratos para x264). Para medir rendimiento se usó una fuente "tipo celular" con grano temporal (§9.2).

---

## 2. ffprobe: duración, fps (incluye VFR), rotación, códec, resolución y audio

### 2.1 Comandos

```bash
# Inventario completo (lo que guarda la app)
ffprobe -v error -print_format json -show_format -show_streams archivo.mov

# Solo lo necesario del video, incluida la rotación (side data)
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:stream_side_data=rotation -of json archivo.mov

# ¿Tiene audio? (vacío => no)
ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 archivo.mp4

# Confirmar VFR: distribución de deltas de PTS (NO usar packet duration_time)
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 D_vfr_sin_audio.mp4 \
  | sort -g | awk 'NR>1{printf "%.4f\n",$1-p}{p=$1}' | sort | uniq -c
#   60 0.0333   <- tramo a 30 fps
#   39 0.1000   <- tramo a 10 fps
```

Resultados reales:

| Clip | codec | width x height (codificado) | r_frame_rate | avg_frame_rate | rotación | ¿Audio? |
|---|---|---|---|---|---|---|
| A | h264 | 1920x1080 | 25/1 | 25/1 | — | sí |
| B | h264 | 1280x720 | 60/1 | 60/1 | — | sí |
| C (iPhone) | hevc (`hvc1`) | 1920x1080 | 30000/1001 | 30000/1001 | **90** (`side_data_type: "Display Matrix"`) | sí |
| D (VFR) | h264 | 1280x720 | 30/1 | **500/29** (17.24) | — | **no** |

- Al decodificar, C se extrae en **1080x1920** (`ffmpeg -ss 1 -i C_iphone_rot90.mov -frames:v 1 x.jpg`). Con `-noautorotate` sale en 1920x1080. **Todos los filtros ven el frame ya rotado**, así que el "tamaño visible" es el que importa para la receta.
- **Trampa VFR:** en el MP4 de prueba, `packet=duration_time` reportó 0.0333 en los 100 paquetes, incluso en el tramo a 10 fps. Para VFR solo valen los deltas de PTS o la comparación `r_frame_rate` contra `avg_frame_rate`.
- Los videos reales de iPhone suelen reportar `rotation: -90` (NO VERIFICADO aquí; el clip de prueba usa 90). El código debe aceptar ±90 y ±270.
- HDR: `color_transfer` = `arib-std-b67` (HLG) o `smpte2084` (PQ) indica que hay que hacer tonemapping (§5.7).

### 2.2 Función Node probada (`probe.mjs`)

```js
// probe.mjs — node probe.mjs <archivo>
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const ratio = (s) => { const [n, d] = String(s ?? '0/0').split('/').map(Number); return d ? n / d : 0; };

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file], { maxBuffer: 32 << 20 });
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  // rotación: side_data_list[].rotation (ffmpeg ≥5); fallback tags.rotate (ffmpeg viejo)
  const rot = Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0);
  const swap = Math.abs(rot) % 180 === 90;
  const rFps = ratio(v?.r_frame_rate), avgFps = ratio(v?.avg_frame_rate);
  return {
    durationSec: Number(j.format.duration ?? v?.duration ?? 0),
    container: j.format.format_name,
    sizeBytes: Number(j.format.size ?? 0),
    video: v ? {
      codec: v.codec_name, pixFmt: v.pix_fmt,
      codedWidth: v.width, codedHeight: v.height,
      rotation: rot,
      width: swap ? v.height : v.width,     // tamaño tal como se ve (ffmpeg autorrota al decodificar)
      height: swap ? v.width : v.height,
      fps: avgFps || rFps, rFrameRate: v.r_frame_rate, avgFrameRate: v.avg_frame_rate,
      // heurística barata; la confirmación real es medir deltas de PTS (ver doc)
      maybeVfr: rFps > 0 && avgFps > 0 && Math.abs(rFps - avgFps) / rFps > 0.01,
      hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
    hasAudio: !!a,
  };
}
if (process.argv[2]) console.log(JSON.stringify(await probe(process.argv[2]), null, 1));
```

Salida real para C: `{"durationSec":6.006,"video":{"codec":"hevc","codedWidth":1920,"codedHeight":1080,"rotation":90,"width":1080,"height":1920,"fps":29.97,"maybeVfr":false,...},"hasAudio":true}`. Para D: `"fps":17.24,"maybeVfr":true,"hasAudio":false`. ffprobe tarda **0.06–0.13 s** por archivo.

---

## 3. Miniaturas, fotogramas clave, escenas y sprites

### 3.1 Miniaturas y fotogramas periódicos

```bash
# Póster a 1 s (búsqueda por entrada: rápida), ancho 480 conservando aspecto
ffmpeg -hide_banner -v error -y -ss 1 -i A_h1080p25_voz.mp4 -frames:v 1 -vf "scale=480:-2" -q:v 3 poster.jpg          # 0.2 s

# Frame "representativo" (filtro thumbnail: el más parecido al promedio de cada lote de N)
ffmpeg -hide_banner -v error -y -i B_720p60_escenas.mp4 -vf "thumbnail=n=60,scale=320:-2" -frames:v 1 repr.jpg

# Un frame cada 2 s CON TIEMPO EXACTO (round=up)
ffmpeg -hide_banner -v error -y -i A_h1080p25_voz.mp4 -vf "fps=1/2:round=up,scale=320:-2" -q:v 4 cada2s_%03d.jpg
# -> archivo i (desde 1) corresponde a t = (i-1)*2 s

# Solo keyframes (lo más rápido en videos largos: no decodifica los demás)
ffmpeg -hide_banner -skip_frame nokey -i A_h1080p25_voz.mp4 -vf "scale=320:-2,showinfo" -fps_mode vfr -q:v 4 kf_%03d.jpg 2>&1 | grep -oE 'pts_time:[0-9.]+'
```

**Trampa verificada (importante):** se usó un video donde el frame *n* tiene luminancia *n*, y se vio qué frame entrega cada variante para "un frame cada 0.5 s" a 30 fps:

| Filtro | Frames entregados | Tiempo real |
|---|---|---|
| `fps=1/0.5` (round=near, por defecto) | 7, 22, 37, 52… | **k·0.5 + 0.23 s** (las marcas de tiempo dicen k·0.5) |
| `fps=1/0.5:round=down` | 14, 29, 44… | k·0.5 + 0.47 s |
| `fps=1/0.5:round=up` | **0, 15, 30, 45…** | **k·0.5** ✔ |
| `select='not(mod(n\,15))'` | 0, 15, 30… | k·0.5 ✔ (solo si el fps es constante) |

Para fotogramas que se mandan a Claude con su timestamp, o para el seguimiento de rostro, se usa `round=up` o `select` + `showinfo`, que reporta el `pts_time` real del frame elegido.

### 3.2 Detección de cambios de escena

```bash
# Opción A: select + showinfo y se parsea pts_time (también guarda los frames de corte)
ffmpeg -hide_banner -i B_720p60_escenas.mp4 -an -vf "select='gt(scene,0.3)',showinfo" -fps_mode vfr -q:v 3 scene_%03d.jpg 2>&1 | grep -oE 'pts_time:[0-9.]+'
# pts_time:3
# pts_time:6

# Opción B: metadata=print a stdout (incluye el puntaje; más fácil de parsear)
ffmpeg -hide_banner -v error -i B_720p60_escenas.mp4 -an -vf "select='gt(scene,0.3)',metadata=print:file=-" -f null -
# frame:0    pts:46080   pts_time:3
# lavfi.scene_score=0.400000      <- rojo -> azul (solo cambia el color): puntaje bajo
# frame:1    pts:92160   pts_time:6
# lavfi.scene_score=0.850334

# Opción C: scdet (puntaje 0-100)
ffmpeg -hide_banner -i B_720p60_escenas.mp4 -an -vf "scdet=threshold=10" -f null - 2>&1 | grep -oE 'lavfi.scd.score: [0-9.]+, lavfi.scd.time: [0-9.]+'
# lavfi.scd.score: 15.625, lavfi.scd.time: 3
# lavfi.scd.score: 33.216, lavfi.scd.time: 6
```

Parser (Node): con regex `/pts_time:([\d.]+)/g` sobre stderr (opción A) o `/^frame:\d+\s+pts:\d+\s+pts_time:([\d.]+)\n(?:lavfi\.scene_score=([\d.]+))/gm` sobre stdout (opción B).

- Un umbral de 0.3 sí detecta cambios de puro color (0.40), pero con poco margen. Conviene aplicar luego una **duración mínima de escena** (por ejemplo 0.5 s) para no cortar en destellos.
- **Medido en una fuente 1080p de 15 Mb/s:** a resolución completa tarda 0.12 s por segundo de fuente. **Escalar antes a 320 px fue más lento** (0.16 s/s), porque el costo lo dominan la decodificación y el escalado.

### 3.3 Sprites de previsualización (scrub de la línea de tiempo)

```bash
# 1 frame/s, 160 px de ancho, hojas de 5x4 = 20 s por hoja (la última se completa con lo que haya)
ffmpeg -hide_banner -v error -y -i A_h1080p25_voz.mp4 -vf "fps=1:round=up,scale=160:-2,tile=5x4:padding=2:margin=0:color=black" -fps_mode vfr -q:v 4 sprite_%02d.jpg
# -> sprite_01.jpg de 808x366 (5*160+4*2, 4*90+3*2). La celda de t=s está en: hoja floor(s/20), col (s%20)%5, fila floor((s%20)/5)
```

Para el reproductor se puede generar un WebVTT de miniaturas (`sprite_01.jpg#xywh=x,y,160,90`) a partir de esa fórmula. Costo medido: 0.11 s por segundo de fuente.

---

## 4. Silencios y loudness

### 4.1 silencedetect

```bash
ffmpeg -hide_banner -nostats -i A_h1080p25_voz.mp4 -vn -af "silencedetect=noise=-35dB:d=0.4" -f null - 2>&1 | grep -E 'silence_(start|end)'
# [silencedetect @ ...] silence_start: 7.04715
# [silencedetect @ ...] silence_end: 8.98429 | silence_duration: 1.93715
# ... silence_start: 11.1689 / silence_end: 11.5714 | 0.402542
# ... silence_start: 13.8925 / silence_end: 14.3266 | 0.434125
# ... silence_start: 16.8442 / silence_end: 17.2587 | 0.414479   <- 6.1 emite el end al llegar al EOF

# Variante por stdout (más fácil de parsear)
ffmpeg -hide_banner -v error -i A_h1080p25_voz.mp4 -vn -af "silencedetect=noise=-35dB:d=0.4,ametadata=mode=print:file=-" -f null -
# lavfi.silence_start=7.04715 / lavfi.silence_end=8.98429 / lavfi.silence_duration=1.93715 ...
```

- Parser: emparejar `silence_start` con el `silence_end` que sigue. **Si queda un `start` sin `end`, se cierra con la duración del archivo.**
- Por defecto, *todos* los canales tienen que estar en silencio. `mono=1` analiza cada canal por separado (útil con 2 micrófonos, §10.6).
- Para "quitar silencios" conviene dejar ~0.1–0.15 s de colchón a cada lado del corte (`keep = [end-0.12, nextStart+0.12]`). Así no se come el inicio de las consonantes. El VAD de faster-whisper (§10.3) da tramos de voz casi idénticos sin tener que elegir un umbral en dB.
- Costo: **0.01 s por segundo de fuente** (solo audio).

### 4.2 Medición de loudness (EBU R128)

```bash
ffmpeg -hide_banner -nostats -i A_h1080p25_voz.mp4 -vn -af "ebur128=peak=true:framelog=quiet" -f null - 2>&1 | sed -n '/Summary/,$p'
#   Integrated loudness:  I: -21.2 LUFS   Threshold: -31.5 LUFS
#   Loudness range:       LRA: 5.0 LU
#   True peak:            Peak: -0.5 dBFS
```

### 4.3 loudnorm en dos pasadas (JSON)

```bash
# Pasada 1: medir (el JSON sale al final de stderr)
ffmpeg -hide_banner -nostats -i entrada.wav -af "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p' > p1.json
# {"input_i":"-21.48","input_tp":"-0.47","input_lra":"3.70","input_thresh":"-31.74","output_i":"-16.47",...,"normalization_type":"dynamic","target_offset":"2.47"}

# Pasada 2: aplicar con los valores medidos (¡y volver a 48 kHz!)
ffmpeg -hide_banner -nostats -y -i entrada.wav -af "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-21.48:measured_TP=-0.47:measured_LRA=3.70:measured_thresh=-31.74:offset=2.47:linear=true:print_format=json" -ar 48000 salida.wav
```

**Trampas verificadas:**
- **loudnorm sube la salida a 192 kHz.** Sin `-ar 48000` (o `aresample=48000` al final del grafo), el WAV quedó a 192000 Hz.
- **Los valores de la pasada 1 vienen como strings** (`"-21.48"`): hay que convertirlos con `Number()`.
- **El modo lineal no siempre es posible.** Si `measured_TP + (I_obj − measured_I) > TP_obj`, la pasada 2 reporta `"normalization_type": "dynamic"` y no llega al objetivo. Con la voz de espeak (pico alto) salió **−15.4 LUFS** en lugar de −14. La solución está en §7.3 (limitador antes).
- El `output_i` de la pasada 1 **no** es el resultado final. Siempre hay que **medir el archivo final** con `ebur128` para el control de calidad.

---

## 5. Render final desde la receta

### 5.1 Grafo de referencia probado (3 fuentes distintas → 1080x1920 a 30 fps)

Entradas: A (1920x1080 a 25 fps, se reencuadra siguiendo x(t)), B (1280x720 a 60 fps, fondo desenfocado) y C (HEVC rotado a 29.97, punch-in + color). Las transiciones son `fade` y `slideleft` de 0.5 s.

`render/graph1.txt`:
```
[0:v]setpts=PTS-STARTPTS,fps=30,crop=w=608:h=1080:x='clip(if(lt(t,2),300+(900-300)*t/2,if(lt(t,4),900+(500-900)*(t-2)/2,500))-304,0,iw-608)':y=0,scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p[v0];
[1:v]setpts=PTS-STARTPTS,fps=30,split[b1][f1];
[b1]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.08[bg1];
[f1]scale=1080:-2:flags=lanczos[fg1];
[bg1][fg1]overlay=x=(W-w)/2:y=(H-h)/2,setsar=1,format=yuv420p[v1];
[2:v]setpts=PTS-STARTPTS,fps=30,scale=1080:1920,scale=w='trunc(1080*(1+0.15*min(t/0.6\,1))/2)*2':h=-2:eval=frame,crop=1080:1920,eq=contrast=1.08:saturation=1.15,colorbalance=rs=0.04:bs=-0.04,lut3d=file=luts/calido.cube,setsar=1,format=yuv420p[v2];
[v0][v1]xfade=transition=fade:duration=0.5:offset=4.5[x01];
[x01][v2]xfade=transition=slideleft:duration=0.5:offset=9.0[vout];
[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];
[1:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];
[2:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a2];
[a0][a1]acrossfade=d=0.5:c1=tri:c2=tri[ax01];
[ax01][a2]acrossfade=d=0.5[aout]
```

```bash
ffmpeg -hide_banner -v warning -stats -y \
  -ss 1.0 -to 6.0 -i clips/A_h1080p25_voz.mp4 \
  -ss 1.5 -to 6.5 -i clips/B_720p60_escenas.mp4 \
  -ss 0.5 -to 5.0 -i clips/C_iphone_rot90.mov \
  -filter_complex_script render/graph1.txt -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -ar 48000 -movflags +faststart render/v1.mp4
# Resultado: 1080x1920, 30/1, 13.500 s de video y de audio (5 + 5 + 4.5 − 0.5 − 0.5). Render: 18.4 s (1.36 s/s; el segmento C con mandelbrot HEVC + lut3d es el caro)
```

Reglas que salen de esta prueba:
- **`-ss` y `-to` como opciones de entrada** (antes de `-i`): la búsqueda es rápida y, como se recodifica, precisa. Dentro del grafo, `setpts=PTS-STARTPTS` hace que cada segmento empiece en t=0.
- **xfade exige el mismo time base, tamaño y formato en ambas entradas.** Errores reales: `First input link main timebase (1/25) do not match ... (1/30)` y `... parameters (size 640x360) do not match ... (size 1280x720)`. `fps=30` fija el time base en 1/30. Una diferencia de SAR **no** dio error, pero igual conviene poner `setsar=1` siempre.
- **Offsets:** `offset_k = Σ_{i≤k} dur_i − Σ_{i<k} T_i − T_k`. La duración total es `Σdur − ΣT`. `acrossfade=d=T` acorta el audio exactamente igual. **Hay que validar en la receta que cada segmento dure más que sus transiciones**: un `acrossfade` más largo que su entrada no dio error, pero tampoco hace lo esperado.
- **Fuente sin audio:** se sustituye por `anullsrc=r=48000:cl=stereo,atrim=0:<dur>` (probado en §5.2).
- Alternativa sin `-ss` por entrada: `trim/atrim` + `split/asplit` sobre una sola entrada (probado; `concat=n=2:v=1:a=1` dio 5.000 s exactos). Es más lento en fuentes largas porque decodifica desde el inicio.
- Cortes secos sin transición: filtro `concat=n=N:v=1:a=1` (requiere entradas normalizadas igual).
- ~~En ffmpeg 7+ `-filter_complex_script` está obsoleto, pero sigue funcionando~~. **[REVISIÓN] Corrección VERIFICADA:**
  - En **FFmpeg 9.0.2** (la versión de Homebrew al 2026-10-04) `-filter_complex_script` **ya no existe**: la tabla de opciones de `fftools/ffmpeg_opt.c` (tag `n9.0.2`) solo tiene `filter_complex`, `filter_complex_threads` y `lavfi`. Leer el valor de una opción desde un archivo se hace con el prefijo genérico `-/opción archivo` (`fftools/cmdutils.c`: `if (*opt == '/') … read_file_to_string(arg)`).
  - En **6.1** (contenedor, Ubuntu 24.04) `-/filter_complex g.txt` falla: `Unrecognized option '/filter_complex'`, exit 8. Ahí `-filter_complex_script` sí funciona.
  - **Regla para el constructor:** pasar el grafo **inline**, `['-filter_complex', grafo]`, como elemento del arreglo de `spawn`. No hace falta escapar nada porque no hay shell, y funciona igual en 6.1 y en 9.x. Verificado en 6.1: un grafo multilínea con `;` pasado inline por `spawn` sale con exit 0; en 9.x no se ejecutó, pero `-filter_complex` sigue en la tabla de opciones. Límite: en Linux un solo argumento debe medir menos de 128 KiB (`MAX_ARG_STRLEN`; verificado: 131 071 bytes pasa, 131 072 da `E2BIG`). Si el grafo es más grande, escribirlo a un archivo temporal y usar `-/filter_complex` (ffmpeg ≥ 7) o `-filter_complex_script` (ffmpeg < 7), según la versión mayor que dé `ffmpeg -version`. Los comandos de esta guía que usan `-filter_complex_script` son de 6.1.

### 5.2 Constructor "receta → argumentos de ffmpeg" (Node, probado)

```js
// recipe_graph.mjs — receta mínima -> argumentos de ffmpeg (filter_complex) con normalización + xfade/acrossfade
// node recipe_graph.mjs  (usa la receta de ejemplo de abajo y renderiza render/recipe_out.mp4)
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { probe } from './probe.mjs';

export async function buildArgs(recipe, outFile) {
  const { w, h, fps } = recipe.output;
  const args = ['-hide_banner', '-y'];
  const parts = [];
  const durs = [];
  for (const [i, s] of recipe.segments.entries()) {
    const p = await probe(s.src);
    args.push('-ss', String(s.in), '-to', String(s.out), '-i', s.src);    // búsqueda por entrada: rápida y precisa al recodificar
    durs.push(s.out - s.in);
    const norm = `setpts=PTS-STARTPTS,fps=${fps}`;
    let v;
    if (s.fit === 'blur') {                                              // horizontal -> vertical con fondo desenfocado
      v = `[${i}:v]${norm},split[b${i}][f${i}];` +
          `[b${i}]scale=${w / 4}:${h / 4}:force_original_aspect_ratio=increase,crop=${w / 4}:${h / 4},boxblur=10:2,scale=${w}:${h},eq=brightness=-0.08[bg${i}];` +
          `[f${i}]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg${i}];[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2`;
    } else if (s.fit === 'track' && s.cropX) {                           // recorte 9:16 siguiendo x(t)
      const cw = Math.floor(p.video.height * w / h / 2) * 2;
      let e = String(s.cropX.at(-1).x);
      for (let k = s.cropX.length - 2; k >= 0; k--) { const a = s.cropX[k], b = s.cropX[k + 1];
        e = `if(lt(t,${b.t}),${a.x}+(${b.x - a.x})*(t-${a.t})/${b.t - a.t},${e})`; }
      v = `[${i}:v]${norm},crop=w=${cw}:h=ih:x='clip(${e},0,iw-${cw})':y=0,scale=${w}:${h}`;
    } else {                                                             // 'cover': llenar y recortar al centro
      v = `[${i}:v]${norm},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    }
    if (s.zoom) v += `,scale=w='trunc(${w}*(1+${s.zoom.to - 1}*min(t/${s.zoom.dur}\\,1))/2)*2':h=-2:eval=frame,crop=${w}:${h}`;
    if (s.eq) v += `,eq=${s.eq}`;
    parts.push(`${v},setsar=1,format=yuv420p[v${i}]`);
    const a = p.hasAudio ? `[${i}:a]asetpts=PTS-STARTPTS,` : `anullsrc=r=48000:cl=stereo,atrim=0:${durs[i]},`;  // sin audio => silencio
    parts.push(`${a}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  }
  // transiciones: offset_k = suma(duraciones hasta k) - suma(transiciones hasta k)
  let vl = 'v0', al = 'a0', acc = durs[0];
  for (let k = 1; k < durs.length; k++) {
    const t = recipe.transitions[k - 1] ?? { type: 'cut', dur: 0 };
    if (t.type === 'cut' || !t.dur) {
      parts.push(`[${vl}][${al}][v${k}][a${k}]concat=n=2:v=1:a=1[vx${k}][ax${k}]`);
    } else {
      parts.push(`[${vl}][v${k}]xfade=transition=${t.type}:duration=${t.dur}:offset=${(acc - t.dur).toFixed(3)}[vx${k}]`);
      parts.push(`[${al}][a${k}]acrossfade=d=${t.dur}[ax${k}]`);
      acc -= t.dur;
    }
    acc += durs[k]; vl = `vx${k}`; al = `ax${k}`;
  }
  writeFileSync('render/recipe_graph.txt', parts.join(';\n'));   // [REVISIÓN] en producción: grafo inline (ver nota de §5.1); -filter_complex_script no existe en ffmpeg 9
  args.push('-filter_complex_script', 'render/recipe_graph.txt', '-map', `[${vl}]`, '-map', `[${al}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '4', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', outFile);
  return { args, expectedDuration: +acc.toFixed(3) };
}

const recipe = {
  output: { w: 1080, h: 1920, fps: 30 },
  segments: [
    { src: 'clips/A_h1080p25_voz.mp4', in: 1, out: 5, fit: 'track', cropX: [{ t: 0, x: 600 }, { t: 2, x: 1200 }, { t: 4, x: 900 }] },
    { src: 'clips/D_vfr_sin_audio.mp4', in: 0, out: 3, fit: 'blur' },
    { src: 'clips/C_iphone_rot90.mov', in: 0.5, out: 4, fit: 'cover', zoom: { to: 1.15, dur: 0.6 }, eq: 'contrast=1.06:saturation=1.1' },
    { src: 'clips/B_720p60_escenas.mp4', in: 6, out: 8, fit: 'cover' },
  ],
  transitions: [{ type: 'fade', dur: 0.4 }, { type: 'wipeleft', dur: 0.4 }, { type: 'cut', dur: 0 }],
};
if (process.argv[1].endsWith('recipe_graph.mjs')) {
  const { args, expectedDuration } = await buildArgs(recipe, 'render/recipe_out.mp4');
  const t0 = Date.now(); const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { stdio: 'inherit' });
  const got = await probe('render/recipe_out.mp4');
  console.log(JSON.stringify({ exit: r.status, seconds: (Date.now() - t0) / 1000, expectedDuration, got: got.durationSec, size: `${got.video.width}x${got.video.height}`, fps: got.video.fps }));
}
```

Salida real: `{"exit":0,"seconds":10.475,"expectedDuration":11.7,"got":11.7,"size":"1080x1920","fps":30}` (en la segunda pasada, `"seconds":13.561` con la misma duración: el tiempo de pared varía ~±15 % entre corridas). Video y audio duran **11.700 s**: 4 + 3 + 3.5 + 2 − 0.4 − 0.4. La receta mezcló VFR sin audio, iPhone rotado, 60 fps y un corte seco.

**[REVISIÓN] Cuidado con la convención de `x`:** en el grafo de §5.1, la `x` de los puntos es el **centro** del recorte (se le resta la mitad del ancho, `-304`). En `buildArgs` y en `track_face.py` (§11.2), `cropX[].x` es el **borde izquierdo**, y solo se recorta con `clip(…,0,iw-cw)`. La receta debe fijar una sola convención; se recomienda el centro normalizado (0–1), que no depende de la resolución de la fuente. El constructor convierte a borde izquierdo. Además, `buildArgs` escribe siempre en `render/recipe_graph.txt`, una ruta fija relativa al cwd: dos renders en paralelo se pisan el archivo. Usar el grafo inline o un archivo temporal por trabajo.

### 5.3 Reencuadre horizontal → vertical

**a) `crop` con x variable por expresión.** `x` se evalúa en cada frame y `t` es el tiempo del segmento después de `setpts`:
```bash
crop=w=608:h=1080:x='clip(if(lt(t,2),300+(900-300)*t/2,if(lt(t,4),900+(500-900)*(t-2)/2,500))-304,0,iw-608)':y=0,scale=1080:1920
```
- Ancho del recorte 9:16 = `floor(ih*9/16/2)*2` (606 para 1080). `w` y `h` de `crop` son fijos; solo `x` y `y` cambian por frame.
- **Trampa verificada: límite de anidamiento.** El evaluador de expresiones corta en ~100 niveles de funciones anidadas y devuelve `Missing ')' or too many args`. Medido en la segunda pasada:

  | Forma de la expresión | Funciona | Falla |
  |---|---|---|
  | `if(lt(t,T1),x1,if(lt(t,T2),x2,…))` suelta | 98 `if` | 99 `if` |
  | La misma dentro de `clip(…,0,iw-606)` | 97 `if` | 98 `if` |
  | Lineal por tramos (`a+(b)*(t-t0)/d`) dentro de `clip` | 97 `if` | 98 `if` |

  Para más de ~80 puntos se usa **sendcmd** o una expresión por segmento.
- Costo: prácticamente cero (0.596 contra 0.579 s/s).

**b) `sendcmd`**, probado con 4 comandos (uno con expresión) y con 1000 comandos:
```
# tiempo   [enter] filtro comando valor   (x = borde izquierdo del recorte)
0.0  crop@cr x 0;
1.0  crop@cr x 400;
2.0  crop@cr x 1000;
3.0  crop@cr x 'clip(1000-300*(t-3),0,1312)';
```
```bash
ffmpeg -i in.mp4 -vf "sendcmd=f=crop_cmds.txt,crop@cr=w=608:h=1080:x=0:y=0,scale=1080:1920" ...
# un comando por tramo, lineal:  12.250 crop@c x '493.9+(-56.8)*(t-12.250)/0.250';
```
Se nombra la instancia (`crop@cr`) para dirigirle los comandos. Los comandos se interpretan como expresiones, así que `t` está disponible.

**c) scale + pad con fondo desenfocado** (tomas horizontales que no se deben recortar):
```bash
[in]split[b][f];
[b]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,eq=brightness=-0.08[bg];
[f]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2
```
Desenfocar a 1/4 de resolución y luego escalar cuesta **+0.15 s/s**. `gblur=sigma=30` a 1080x1920 cuesta **+0.40 s/s**.

### 5.4 Zoom / punch-in

```bash
# scale+crop animado (eval=frame acepta t en 6.1). Zoom a 1.15x en 0.6 s, centrado:
scale=w='trunc(1080*(1+0.15*min(t/0.6\,1))/2)*2':h=-2:eval=frame,crop=1080:1920
# zoompan equivalente (d=1 => 1 frame de salida por frame de entrada; 'it' = tiempo de entrada):
zoompan=z='min(1+0.15*it/0.6\,1.15)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps=30
```
- Se verificó visualmente (frame 0 contra frame 45) que el zoom ocurre y que `crop` sigue funcionando aunque el tamaño de entrada cambie por frame.
- Costo: scale eval=frame **+0.25 s/s**, zoompan **+0.12 s/s**. zoompan redondea `x/y` a enteros y puede "temblar" en zooms lentos (NO VERIFICADO visualmente aquí). Si pasa, se usa el método scale+crop o se sobreescala antes.
- Para un punch-in hacia un punto (el rostro), se usa `crop=1080:1920:x='(iw-ow)*fx':y='(ih-oh)*fy'` con fx y fy entre 0 y 1.

### 5.5 Corrección de color

```bash
eq=contrast=1.08:saturation=1.15:brightness=0.02:gamma=1.0        # YUV: casi gratis (+0.01 s/s)
colorbalance=rs=0.04:bs=-0.04:rm=0.02:bm=-0.02                       # RGB: +0.73 s/s
lut3d=file=luts/calido.cube:interp=tetrahedral                       # RGB: +0.68 s/s (interp=nearest: algo menos)
```
- Generador de un `.cube` (formato Adobe/Resolve, R varía más rápido), probado con `lut3d`:
```python
N=17; out=["TITLE \"calido\"","LUT_3D_SIZE %d"%N,"DOMAIN_MIN 0 0 0","DOMAIN_MAX 1 1 1"]
for b in range(N):
  for g in range(N):
    for r in range(N):
      R,G,B=r/(N-1),g/(N-1),b/(N-1)
      out.append(f"{min(1,R*1.06+0.01):.6f} {min(1,G*1.01):.6f} {max(0,B*0.92):.6f}")
open("luts/calido.cube","w").write("\n".join(out)+"\n")
```
- **Medido:** eq + colorbalance + lut3d = **1.95 s/s**, contra 0.58 sin color. Forzar `format=gbrp` lo empeoró (2.19) y la conversión con `zscale` también (1.65). Aplicar el color *antes* de escalar (a 608x1080) bajó a 1.44. `-filter_threads 4` no ayudó: en 6.1 el grafo corre en un solo hilo junto con el resto del pipeline.
- **Recomendación:** para correcciones simples, `eq` (y `hue` si hace falta). Para un "look" de marca, **un único `lut3d`** que hornee colorbalance + look (la app genera el .cube), aplicado sobre la resolución más chica de la cadena. En el estimador cuenta como +0.7 s/s.
- FFmpeg 7 corre demuxer, decoder, filtros y encoder en hilos separados (NO VERIFICADO aquí). En local con 7.x u 8.x el sobrecosto del color debería solaparse con la codificación, pero hay que medirlo.

### 5.6 Caché por segmento (re-render solo de lo que cambió)

```bash
# Intermedios normalizados con audio PCM (en MKV) -> concat demuxer sin recodificar el video
ENC="-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 -g 60 -c:a pcm_s16le -ar 48000 -ac 2"
ffmpeg -y -ss 1 -to 4 -i A.mp4 -vf "fps=30,crop=608:1080,scale=1080:1920,setsar=1" $ENC s1.mkv
ffmpeg -y -ss 0 -to 3 -i D_vfr.mp4 -f lavfi -t 3 -i "anullsrc=r=48000:cl=stereo" -vf "fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -map 0:v -map 1:a -shortest $ENC s2.mkv
printf "file 's1.mkv'\nfile 's2.mkv'\n" > list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c:v copy -c:a aac -b:a 192k -movflags +faststart final.mp4    # video 6.000 / audio 6.000
```
**Trampa verificada:** con intermedios **AAC** en MP4 y `-c copy`, el audio quedó en **6.021 s contra 6.000 s** de video. Es el retardo del encoder AAC, ~21 ms por segmento, y se acumula. Con PCM en los intermedios y AAC solo al final, ambos quedan en 6.000. Los segmentos con transición se re-renderizan juntos (xfade necesita decodificar los dos lados) o se cachean "colas" de 0.5 s.

### 5.7 HDR (iPhone HLG/Dolby Vision) → SDR BT.709

```bash
ffmpeg -i E_hlg10.mov -vf "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p" \
  -c:v libx264 -preset veryfast -color_primaries bt709 -color_trc bt709 -colorspace bt709 out_sdr.mp4
# entrada yuv420p10le/bt2020nc/arib-std-b67 -> salida yuv420p/bt709/bt709. 3 s en 3.9 s (≈ +0.7 s/s de costo)
```
Probado con un HLG sintético. Con un archivo Dolby Vision real de iPhone: **NO VERIFICADO** (ffmpeg usa la capa base HLG compatible).

### 5.8 Progreso en vivo

```bash
ffmpeg -nostats -progress pipe:1 ...   # stdout: bloques key=value
# frame=60 / fps=0.00 / bitrate=... / total_size=475403 / out_time_us=1966667 / out_time_ms=1966667 / out_time=00:00:01.966667 / speed=28.6x / progress=continue|end
```
**Trampa:** `out_time_ms` también viene en **microsegundos** (mismo valor que `out_time_us`). El porcentaje es `out_time_us / 1e6 / duración_esperada`.

---

## 6. Subtítulos (.ass con estilos y karaoke, quemado, .srt y .vtt)

### 6.1 Verificar libass y drawtext

```bash
ffmpeg -hide_banner -filters | grep -E ' (ass|subtitles|drawtext) '
#  ... ass        V->V  Render ASS subtitles onto input video using the libass library.
#  ... subtitles  V->V  Render text subtitles onto input video using the libass library.
#  T.C drawtext   V->V  Draw text on top of video frames using libfreetype library.
# (libass 0.17.1 según el log de -v verbose)
```
**Trampa en scripts:** `ffmpeg -filters | grep -q x` dentro de un script con `set -o pipefail` **falla aunque el filtro exista**: grep cierra la tubería y ffmpeg muere por SIGPIPE. Hay que guardar la salida en una variable primero (así lo hace el script de §14).

### 6.2 Generador probado (`subs.mjs`): palabras → grupos → ASS (3 modos) + SRT + VTT

```js
// subs.mjs — palabras con tiempos -> grupos -> .ass (karaoke/resaltado) + .srt + .vtt
// Uso: node subs.mjs words.json out_prefijo "palabra1,palabra2"
import { readFileSync, writeFileSync } from 'node:fs';

/** Agrupa palabras en "tarjetas" de subtítulo. */
export function groupWords(words, { maxChars = 18, maxLines = 2, maxGapSec = 0.6, maxDurSec = 3.2 } = {}) {
  const groups = []; let cur = null;
  const lineLens = (ws) => { // reparte en líneas de <= maxChars
    const lines = [[]]; let len = 0;
    for (const w of ws) { const l = w.word.length + (len ? 1 : 0);
      if (len + l > maxChars && lines.at(-1).length) { lines.push([]); len = 0; }
      lines.at(-1).push(w); len += w.word.length + (lines.at(-1).length > 1 ? 1 : 0); }
    return lines; };
  for (const w of words) {
    const gap = cur ? w.start - cur.words.at(-1).end : 0;
    const tryWords = cur ? [...cur.words, w] : [w];
    const tooLong = cur && (gap > maxGapSec || w.end - cur.words[0].start > maxDurSec || lineLens(tryWords).length > maxLines
      || /[.!?]$/.test(cur.words.at(-1).word));            // corta tras fin de oración
    if (!cur || tooLong) { cur = { words: [w] }; groups.push(cur); } else cur.words.push(w);
  }
  for (const g of groups) { g.start = g.words[0].start; g.end = g.words.at(-1).end; g.lines = lineLens(g.words); }
  // sin huecos de parpadeo: extiende el fin hasta el siguiente grupo si el hueco es corto
  for (let i = 0; i < groups.length - 1; i++) if (groups[i + 1].start - groups[i].end < 0.25) groups[i].end = groups[i + 1].start;
  return groups;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const assTime = (t) => { const cs = Math.round(t * 100); // ASS: H:MM:SS.cc (centésimas)
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`; };
const srtTime = (t, sep = ',') => { const ms = Math.round(t * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`; };
/** "#RRGGBB" + alfa 0..255 (0 = opaco) -> &HAABBGGRR (formato ASS) */
export const assColor = (hex, alpha = 0) => { const h = hex.replace('#', '');
  return `&H${pad(alpha.toString(16).toUpperCase())}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
/** color para etiquetas de override: \1c&HBBGGRR& (sin alfa; alfa va con \1a&HAA&) */
export const assTag = (hex) => { const h = hex.replace('#', ''); return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase(); };
const assEscape = (s) => s.replace(/\\/g, '⧵').replace(/\{/g, '(').replace(/\}/g, ')'); // ASS no tiene escape fiable para { } \

export function toAss(groups, o = {}) {
  const st = { font: 'Montserrat ExtraBold', size: 84, color: '#FFFFFF', highlight: '#FFD400', keyword: '#8B7CF0',
    outlineColor: '#000000', outline: 6, shadow: 0, boxColor: '#000000', box: false, marginV: 520, marginLR: 120,
    upper: true, mode: 'active', scaleActive: 112, ...o };
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${st.font},${st.size},${st.mode === 'karaoke' ? assColor(st.highlight) : assColor(st.color)},${assColor(st.color)},${assColor(st.box ? st.boxColor : st.outlineColor, st.box ? 0x40 : 0)},${assColor('#000000', 0x80)},0,0,0,0,100,100,0,0,${st.box ? 3 : 1},${st.box ? 18 : st.outline},${st.shadow},2,${st.marginLR},${st.marginLR},${st.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const kw = new Set((st.keywords ?? []).map((k) => k.toLowerCase()));
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const ev = groups.map((g) => {
    const t0 = g.start;
    const text = g.lines.map((line) => line.map((w) => {
      let txt = assEscape(st.upper ? w.word.toLocaleUpperCase('es') : w.word);
      const isKw = kw.has(norm(w.word));
      const base = isKw ? assTag(st.keyword) : assTag(st.color);
      if (st.mode === 'karaoke') { // \k: Secondary -> Primary al llegar su turno (no regresa). La duración incluye el hueco hasta la siguiente palabra
        const all = g.words, i = all.indexOf(w), next = all[i + 1];
        const cs = Math.max(1, Math.round(((next ? next.start : w.end) - w.start) * 100));
        return `{\\k${cs}}${isKw ? `{\\1c${assTag(st.keyword)}\\2c${assTag(st.keyword)}}` : ''}${txt}${isKw ? `{\\1c${assTag(st.highlight)}\\2c${assTag(st.color)}}` : ''}`;
      }
      if (st.mode === 'active') { // \t: resalta la palabra solo mientras se dice (color + escala) y regresa
        const a = Math.round((w.start - t0) * 1000), b = Math.round((w.end - t0) * 1000);
        return `{\\1c${base}\\t(${a},${a + 1},\\1c${assTag(st.highlight)}\\fscx${st.scaleActive}\\fscy${st.scaleActive})\\t(${b},${b + 1},\\1c${base}\\fscx100\\fscy100)}${txt}`;
      }
      return `{\\1c${base}}${txt}`; // 'phrase'
    }).join(' ')).join('\\N');
    return `Dialogue: 0,${assTime(g.start)},${assTime(g.end)},Sub,,0,0,0,,{\\fad(60,0)}${text}`;
  });
  return head + ev.join('\n') + '\n';
}

const plain = (g) => g.lines.map((l) => l.map((w) => w.word).join(' ')).join('\n');
export const toSrt = (groups) => groups.map((g, i) => `${i + 1}\n${srtTime(g.start)} --> ${srtTime(g.end)}\n${plain(g)}\n`).join('\n');
export const toVtt = (groups) => 'WEBVTT\n\n' + groups.map((g) => `${srtTime(g.start, '.')} --> ${srtTime(g.end, '.')}\n${plain(g)}\n`).join('\n');

if (process.argv[2]) {
  const words = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const out = process.argv[3] ?? 'subs'; const keywords = (process.argv[4] ?? '').split(',').filter(Boolean);
  const groups = groupWords(words);
  writeFileSync(`${out}.active.ass`, toAss(groups, { keywords, mode: 'active' }));
  writeFileSync(`${out}.karaoke.ass`, toAss(groups, { keywords, mode: 'karaoke' }));
  writeFileSync(`${out}.box.ass`, toAss(groups, { keywords, mode: 'phrase', box: true, boxColor: '#111111' }));
  writeFileSync(`${out}.srt`, toSrt(groups));
  writeFileSync(`${out}.vtt`, toVtt(groups));
  console.log(`${groups.length} grupos`);
}
```

Ejemplo real del ASS generado (modo karaoke, palabras clave `zyra` y `subtítulos`):
```
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Montserrat ExtraBold,84,&H0000D4FF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,0,2,120,120,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.05,0:00:01.22,Sub,,0,0,0,,{\fad(60,0)}{\k44}HOLA, {\k29}SOY {\k40}{\1c&HF07C8B&\2c&HF07C8B&}ZYRA.{\1c&H00D4FF&\2c&HFFFFFF&}
Dialogue: 0,0:00:01.22,0:00:03.11,Sub,,0,0,0,,{\fad(60,0)}{\k29}HOY {\k22}TE {\k29}VOY {\k15}A\N{\k58}ENSEÑAR {\k34}TRES
Dialogue: 0,0:00:03.11,0:00:05.22,Sub,,0,0,0,,{\fad(60,0)}{\k51}TRUCOS {\k36}PARA {\k51}EDITAR\N{\k44}VIDEO {\k27}CON
Dialogue: 0,0:00:05.22,0:00:06.97,Sub,,0,0,0,,{\fad(60,0)}{\k95}INTELIGENCIA\N{\k80}ARTIFICIAL.
Dialogue: 0,0:00:08.98,0:00:11.11,Sub,,0,0,0,,{\fad(60,0)}{\k66}PRIMERO, {\k44}QUITA {\k29}LOS\N{\k74}{\1c&HF07C8B&\2c&HF07C8B&}SILENCIOS.{\1c&H00D4FF&\2c&HFFFFFF&}
Dialogue: 0,0:00:11.57,0:00:13.81,Sub,,0,0,0,,{\fad(60,0)}{\k75}SEGUNDO, {\k58}AGREGA\N{\k91}{\1c&HF07C8B&\2c&HF07C8B&}SUBTÍTULOS.{\1c&H00D4FF&\2c&HFFFFFF&}
Dialogue: 0,0:00:14.33,0:00:16.16,Sub,,0,0,0,,{\fad(60,0)}{\k69}TERCERO, {\k30}USA\N{\k53}MÚSICA {\k28}CON
Dialogue: 0,0:00:16.16,0:00:16.79,Sub,,0,0,0,,{\fad(60,0)}{\k63}{\1c&HF07C8B&\2c&HF07C8B&}DUCKING.{\1c&H00D4FF&\2c&HFFFFFF&}
```

Modos (los tres se renderizaron y se revisaron a ojo):
- **`active`** (estilo TikTok): un Dialogue por grupo; cada palabra cambia a color y escala de resaltado **solo mientras se dice** (`\t(a,a+1,…)` y `\t(b,b+1,…)`, en ms relativos al inicio del Dialogue). Las palabras clave van en color de marca.
- **`karaoke`** (`\k`): el texto pasa de SecondaryColour a PrimaryColour al llegar su turno **y no regresa**. La duración de `\k` tiene que incluir el hueco hasta la siguiente palabra, o el karaoke se desfasa. Para un barrido progresivo se usa `\kf`.
- **`box`**: `BorderStyle=3` (caja opaca detrás de cada línea). **Verificado: el color de la caja sale de `OutlineColour`** (con su alfa) y `Outline` actúa como relleno interno.

Formato y trampas de ASS:
- Colores de estilo `&HAABBGGRR` (alfa primero, 00 = opaco, **orden BGR**). En etiquetas de override: `\1c&HBBGGRR&` y el alfa aparte (`\1a&H80&`).
- Tiempos `H:MM:SS.cc` (**centésimas**). `\k` también va en centésimas; `\t` y `\fad` en milisegundos.
- `PlayResX/Y` = 1080x1920, para que tamaños y márgenes estén en píxeles de salida. `ScaledBorderAndShadow: yes` evita que el contorno cambie con la resolución. `WrapStyle: 2` desactiva el ajuste automático: los saltos los pone el generador con `\N`, respetando el máximo de caracteres por línea.
- **ASS no transforma a mayúsculas:** hay que hacerlo en el generador (`toLocaleUpperCase('es')`, que maneja bien ñ y acentos).
- ASS no tiene un escape fiable para `{`, `}` y `\` en el texto: se reemplazan.
- Escalar una palabra (`\fscx112`) en una línea centrada **reacomoda a sus vecinas** (temblor leve). Conviene mantener la escala en 110 % o menos, o dibujar la palabra activa en otra capa (NO VERIFICADO).

### 6.3 Quemar con fuente propia (`fontsdir`)

```bash
ffmpeg -i base_vertical.mp4 -vf "ass=subs/demo.active.ass:fontsdir=fonts/brand" -c:v libx264 -preset veryfast -crf 20 -c:a copy out.mp4
# equivalente: subtitles=subs/demo.active.ass:fontsdir=fonts/brand   (subtitles también acepta .srt/.vtt + force_style='FontName=...,FontSize=...')

# Verificar QUÉ fuente eligió libass (obligatorio en el QA):
ffmpeg -v debug -ss 1 -copyts -i base_vertical.mp4 -frames:v 1 -vf "ass=demo.ass:fontsdir=fonts/brand" -f null - 2>&1 | grep fontselect
# fontselect: (Montserrat ExtraBold, 400, 0) -> Montserrat-ExtraBold, 0, Montserrat-ExtraBold      <- OK
```

**Trampa grave (verificada): los nombres de fuente que acepta libass 0.17.1.** El archivo es `Montserrat_800ExtraBold.ttf`; según fc-scan, su family es `Montserrat,Montserrat ExtraBold`, su fullname `Montserrat ExtraBold` y su PostScript `Montserrat-ExtraBold`.

| `Fontname` en el estilo | Resultado |
|---|---|
| `Montserrat ExtraBold` (nombre completo) | ✔ usa la fuente |
| `Montserrat` (familia tipográfica) | ✘ cae a `DejaVuSans.ttf` **sin error** |
| `Montserrat` + `\b800` | ✘ DejaVuSans |
| `Montserrat-ExtraBold` (PostScript) | ✘ DejaVuSans |
| `Anton` (familia = nombre completo sin "Regular") | ✔ |
| `Fuente Que No Existe` | ✘ DejaVuSans, sin error |

**Regla:** al subir una fuente, leer su nombre completo (`fc-scan --format "%{fullname}"` o, en Node, una librería como `fontkit`, NO VERIFICADO) y usar ese valor en `Fontname`. Luego **comprobar la línea `fontselect`** en el QA: si aparece DejaVu, el render está mal.

**Fuentes de Google Fonts sin navegador (verificado):** `curl "https://fonts.googleapis.com/css2?family=Montserrat:wght@800"` **sin User-Agent de navegador** devuelve `src: url(https://fonts.gstatic.com/…/….ttf) format('truetype')`, una TTF estática lista para libass. Con un User-Agent de Chrome devuelve WOFF2. El TTF descargado tiene fullname `Montserrat ExtraBold`.

**Trampa de tiempos:** con `-ss` como opción de entrada, los timestamps empiezan en 0 y **el ASS se desfasa**. Para previsualizar un instante: `-ss T -copyts -i …`. En el render final, **los subtítulos se queman al final del grafo, sobre la línea de tiempo de salida**, con los tiempos ya remapeados (§6.5).

Costo de quemar ASS: **+0.03 s/s** (despreciable).

### 6.4 SRT y VTT

Los genera `subs.mjs` a partir de las mismas palabras (`toSrt` y `toVtt`). ffprobe los reconoce como `subrip` y `webvtt`. Como pista suave en MP4:
```bash
ffmpeg -i video.mp4 -i demo.srt -map 0 -map 1 -c copy -c:s mov_text -metadata:s:s:0 language=spa softsubs.mp4   # verificado: pista mov_text
```
**Trampa:** convertir ASS→SRT con ffmpeg (`ffmpeg -i x.ass x.srt`) deja etiquetas `<font face=… color=…>` dentro del texto. El SRT y el VTT se generan desde las palabras, no desde el ASS.

### 6.5 Remapeo de tiempos (fuente → salida) y zonas seguras

- Una palabra en `t_src` del clip *i*, recortado `[in_i, out_i)` con velocidad `v_i`, aparece en `t_out = start_i + (t_src − in_i) / v_i`. Con xfade, `start_i = Σ_{j<i} (dur_j − T_j)`. Las palabras que caen fuera de `[in_i, out_i)` se descartan. Las que quedan dentro de una transición se pueden recortar o mantener.
- Zonas seguras 9:16 (valores **conservadores, NO VERIFICADOS contra las guías oficiales** de TikTok, Reels y Shorts): texto dentro de y ≈ 250–1450 px de 1920 y márgenes laterales de al menos 120 px. La interfaz suele ocupar ~400 px abajo (descripción y botones) y ~140 px a la derecha (iconos). En el generador se usa `Alignment=2` y `MarginV=520`. Deben ser valores de la configuración por plataforma.

---

## 7. Audio: música + voz con ducking, SFX, loudnorm a −14 LUFS y fades

### 7.1 Ducking con sidechaincompress (medido)

```bash
ffmpeg -y -i musica.wav -i voz.wav -filter_complex \
"[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=20[vsc];
 [0:a][vsc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350:makeup=1:knee=4[duck]" -map "[duck]" musica_duck.wav
```
| Tramo | Música original (RMS) | Música con ducking |
|---|---|---|
| 2–6 s (con voz) | −18.9 dB | **−32.3 dB** (−13.5 dB) |
| 7.3–8.7 s (pausa) | −18.7 dB | −18.7 dB (no se toca) |

- **`threshold` es lineal** (0.000976563–1), no está en dB: 0.02 ≈ −34 dBFS.
- La salida dura lo mismo que la **primera** entrada (la música). Las dos entradas deben tener el mismo formato y la misma cantidad de canales.
- La medición por tramos se hizo con: `ffmpeg -i x.wav -af "atrim=2:6,astats=measure_overall=RMS_level:measure_perchannel=none" -f null -` y luego `grep 'RMS level dB'`.

### 7.2 Mezcla completa: voz + música con ducking + SFX en tiempos exactos + fades

```bash
DUR=17.24; FO=15.74     # fade-out empieza en DUR-1.5
MIX="[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[voz][vsc];
[0:a]atrim=0:$DUR,asetpts=PTS-STARTPTS,volume=-8dB[mus];
[mus][vsc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350:knee=4[duck];
[2:a]adelay=delays=8900:all=1[sfx1];
[3:a]adelay=delays=780:all=1,volume=-6dB[sfx2];
[voz][duck][sfx1][sfx2]amix=inputs=4:duration=first:dropout_transition=0:normalize=0,
afade=t=in:st=0:d=0.3,afade=t=out:st=$FO:d=1.5"
IN="-i musica.wav -i voz.wav -i whoosh.wav -i pop.wav"
```
- `adelay=delays=8900:all=1`: el retardo en ms se aplica a todos los canales (sin `all=1`, solo al primero).
- **`amix` con `normalize=1` (el valor por defecto) divide entre el número de entradas.** La misma mezcla midió **−29.6 LUFS con normalize=1 contra −21.3 con normalize=0**. Siempre `normalize=0` y control de nivel con `volume`.
- `duration=first`: manda la voz (primera entrada) y los SFX no alargan la mezcla.
- Cada fuente se lleva a `aresample=48000,aformat=…stereo` para no depender de la negociación automática de formato.
- SFX sintéticos de prueba (útiles como respaldo sin red):
  `anoisesrc=c=pink:a=0.8:d=0.6:r=48000,bandpass=f=1200:width_type=o:w=2,afade=t=in:d=0.25,afade=t=out:st=0.3:d=0.3` (whoosh) y
  `aevalsrc='0.8*sin(2*PI*880*t)*exp(-20*t)':s=48000:c=stereo:d=0.25` (pop).

### 7.3 Normalización final a −14 LUFS en dos pasadas (que quede lineal)

```bash
# Pasada 0 (o la 1 de siempre): medir I de la mezcla -> -21.54 LUFS, TP -2.97
# Techo del limitador = TP_obj - (I_obj - I_medido) - 1 dB de margen = -1.5 - 7.54 - 1 = -10.04 dBFS -> 0.3148 lineal
PRE="aresample=192000,alimiter=limit=0.3148:attack=1:release=60:level=disabled,aresample=48000"
# Pasada 1: medir con el limitador en la cadena
ffmpeg -nostats $IN -filter_complex "$MIX,$PRE,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[out]" -map "[out]" -f null - 2>&1 | sed -n '/^{/,/^}/p' > p1.json
# Pasada 2: aplicar
ffmpeg -nostats -y $IN -filter_complex "$MIX,$PRE,loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true:print_format=json,aresample=48000[out]" -map "[out]" -c:a pcm_s16le mezcla_final.wav
```
| Variante | normalization_type (pasada 2) | Resultado medido (ebur128) |
|---|---|---|
| Dos pasadas sin limitador | dynamic | −14.5 LUFS, pico −1.5 dBFS |
| **Con limitador previo** | **linear** | **−13.8 LUFS, pico −1.6 dBFS** |
| Solo voz de espeak, dos pasadas | dynamic | −15.4 LUFS |
| Ganancia calculada + alimiter (sin loudnorm) | — | −15.5 LUFS (el limitador se come sonoridad) |

- `alimiter` limita por **pico de muestra**. Sobremuestrear a 192 kHz alrededor lo acerca al *true peak*. Y **`level=disabled` es obligatorio**: con el valor por defecto, alimiter renormaliza la salida a 0 dB.
- Flujo recomendado: **masterizar el audio primero a WAV** (las tres pasadas de solo audio cuestan ~0.5–1.2 s cada una para 17 s) y luego renderizar el video mapeando ese WAV. Así nunca se renderiza el video dos veces.
- Tolerancia de QA: ±1 LU respecto al objetivo y TP ≤ −1 dBTP.

---

## 8. Overlay de un clip con alfa en un rango de tiempo

```bash
# Generar un cintillo con alfa de prueba (VP9 yuva420p y ProRes 4444)
G="color=c=black@0:s=900x220:r=30:d=3,format=yuva420p,drawbox=x=0:y=40:w=900:h=140:color=0x8B7CF0@0.92:t=fill:replace=1,drawtext=fontfile=fonts/brand/Montserrat_800ExtraBold.ttf:text='ZYRA · EDITORA':fontsize=64:fontcolor=white:x='-880+min(t/0.4,1)*900+40':y=80"
ffmpeg -y -f lavfi -i "$G" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -auto-alt-ref 0 -deadline good -cpu-used 4 -row-mt 1 cintillo.webm       # 1.2 s, 25 KB
ffmpeg -y -f lavfi -i "${G/yuva420p/yuva444p10le}" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -alpha_bits 16 -vendor apl0 cintillo.mov     # 0.7 s, 7.8 MB
# ffprobe: webm -> vp9, yuv420p, TAG:alpha_mode=1   |   mov -> prores, 4444, yuva444p12le

# Superponer entre t=2 y t=5 (el clip se desplaza a t=2 con setpts)
ffmpeg -y -i v1.mp4 -c:v libvpx-vp9 -i cintillo.webm -filter_complex \
"[1:v]setpts=PTS-STARTPTS+2.0/TB[lt];[0:v][lt]overlay=x=90:y=1300:eof_action=pass:enable='between(t,2.0,5.0)',format=yuv420p[v]" \
-map "[v]" -map 0:a -c:v libx264 -preset veryfast -crf 20 -c:a copy v1_overlay.mp4

# Variante ProRes con -itsoffset (no necesita forzar decoder)
ffmpeg -y -i v1.mp4 -itsoffset 6 -i cintillo.mov -filter_complex "[0:v][1:v]overlay=x=90:y=1300:eof_action=pass,format=yuv420p[v]" -map "[v]" -map 0:a ...
```
**Trampas verificadas:**
- **El decodificador nativo `vp9` descarta el alfa**: `showinfo` reporta `fmt:yuv420p` y en el render aparecen barras negras donde debería haber transparencia. Con **`-c:v libvpx-vp9` antes de `-i`** reporta `fmt:yuva420p` y el overlay sale bien.
  **[REVISIÓN]** Sigue igual en FFmpeg 9.0.2: `libavcodec/vp9.c` no maneja alfa y `libvpxdec.c` sí (`has_alpha_channel ? AV_PIX_FMT_YUVA420P …`). Lo leí en el código; no lo ejecuté con 9.x. El truco de `-c:v libvpx-vp9` vale también en la Mac.
- `drawbox` sobre un lienzo `yuva` **no escribe el canal alfa** a menos que se use `replace=1`. Sin esa opción, la caja quedó invisible y solo se veía el texto de `drawtext`. Además, en esta prueba la `x` de drawbox con `t` **no se animó** (se evalúa una sola vez). Para animar cajas: `color` + `overlay` con x(t), o un render de HyperFrames con alfa.
- `eof_action=pass`: cuando el clip con alfa termina, el video base sigue sin el último frame congelado.
- Costo: overlay de un VP9 con alfa a 1080x1920 = **+0.13 s/s**.

---

## 9. Determinismo y rendimiento

### 9.1 Determinismo (receta de §5.1, 13.5 s, misma máquina)

| Prueba | SHA/MD5 del MP4 | MD5 de frames decodificados |
|---|---|---|
| Mismo comando 2 veces (threads por defecto) | **idénticos** | idénticos |
| Mismo comando 2 veces + flags bitexact | **idénticos** (distintos del caso anterior por los metadatos) | igual al caso por defecto |
| `-threads 1` contra `-threads 2` contra por defecto | **los tres distintos** | **distintos** (cambian los píxeles) |

- Las flags `-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1 -map_chapters -1` **solo** quitan las etiquetas `encoder=Lavf60.16.100` y `Lavc60.31.102 libx264`; los píxeles son los mismos. Sirven para que el hash no cambie con actualizaciones menores de ffmpeg *cuando* el encoder produce lo mismo.
- **x264 depende del número de hilos.** Su threading por frames es determinista para un número de hilos *dado*, pero el valor por defecto depende de los núcleos de la máquina. **Hay que fijar `-threads 4`** (como opción de salida) en la configuración del motor de render. Así, máquinas con distinta cantidad de núcleos y la misma build producen lo mismo.
- **Fuentes aleatorias:** `anoisesrc` usa una semilla aleatoria por defecto. En el script de §14, B.mp4 salió distinto en cada corrida hasta que se agregó `seed=42`. Lo mismo vale para cualquier filtro con `seed`.
- Para comparar versiones (REGLA DE ORO de `PROMPT.md`) conviene comparar **la receta** y, si hace falta, `-f framemd5` por segmento o SSIM/PSNR, no el hash del MP4 (cambia con la versión de x264, de ffmpeg o el número de hilos). También hay que guardar `ffmpeg -version` y la build de x264 en los metadatos de la versión.

```bash
ffmpeg -v error -i salida.mp4 -map 0:v -f md5 -          # MD5 de los frames decodificados
ffmpeg -i a.mp4 -i b.mp4 -lavfi ssim -f null -          # SSIM entre dos versiones (NO usado en la prueba; estándar en ffmpeg)
```

### 9.2 Rendimiento medido (alimenta el estimador de tiempo)

Fuente: 1920x1080 a 30 fps, H.264 de 15.7 Mb/s, 20 s, **con grano temporal**, que es más difícil de codificar (`mandelbrot,noise=alls=12:allf=t+u`). Salida: 1080x1920 a 30 fps, `crf 20`, AAC 192k. Cadena base B0: `fps=30,crop=608:1080,scale=1080:1920`.

**Preset de x264 (solo B0):**

| Preset | s/s | Velocidad |
|---|---|---|
| ultrafast | 0.368 | 2.72x |
| superfast | 0.459 | 2.18x |
| **veryfast** | **0.579** | 1.73x |
| faster | 0.887 | 1.13x |
| medium | 1.341 | 0.75x |

**Costo añadido por filtro (veryfast; total en s/s y delta sobre 0.579):**

| Operación | s/s | Δ |
|---|---|---|
| Subtítulos ASS quemados (fontsdir) | 0.612 | +0.03 |
| crop con x(t) por expresión | 0.596 | +0.02 |
| Fondo desenfocado (boxblur a 1/4 de resolución) | 0.724 | +0.15 |
| Fondo desenfocado (gblur a 1080x1920) | 0.974 | +0.40 |
| Punch-in con scale eval=frame | 0.824 | +0.25 |
| Punch-in con zoompan | 0.701 | +0.12 |
| Overlay de VP9 con alfa (libvpx) | 0.709 | +0.13 |
| eq solo | 0.587 | ≈0 |
| colorbalance solo | 1.314 | +0.73 |
| lut3d solo | 1.259 | +0.68 |
| eq + colorbalance + lut3d | 1.946 | +1.37 |
| Tonemap HDR→SDR (3 s de prueba) | ≈1.3 | ≈+0.7 |

**Recetas completas medidas:** grafo de §5.1 (3 fuentes, HEVC, lut3d) **1.36 s/s**. Constructor de §5.2 (4 fuentes, sin LUT) **0.90–1.16 s/s** (2 corridas). Receta del script de §14 (7.5 s) **0.85–0.98 s/s** (3 corridas). Las cifras incluyen ~0.2–0.4 s de arranque.

**Análisis (s por segundo de fuente 1080p):** ffprobe 0.13 s fijos · escenas 0.12 · sprite a 1 fps 0.11 · miniaturas de keyframes 0.017 · silencedetect 0.010 · medición de loudnorm 0.05 · extraer WAV de 16 kHz para ASR 0.011 · proxy 540p ultrafast para la vista previa 0.22.

**Fórmula sugerida para el estimador** (se recalibra sola con los renders reales, `PROMPT.md` §4.5):
```
T_render ≈ 0.4 s + D_salida × (k_preset + Σ k_filtros) × f_maquina
k_preset(veryfast, 1080x1920@30) = 0.58 ; k: subs 0.03, blur 0.15, zoom 0.25, alfa 0.13, lut/colorbalance 0.7 c/u, tonemap 0.7
T_audio (3 pasadas loudnorm) ≈ 3 × 0.06 × D_salida
f_maquina = EMA(real / estimado) de los últimos N renders en esa máquina (inicia en 1.0)
```
Margen para mostrar el rango "6–9 min": ±30 % al inicio, que se va cerrando con la EMA.

---

## 10. Transcripción con tiempos por palabra: faster-whisper

### 10.1 Instalación (verificada)

```bash
uv venv --python 3.11 .venv-asr
uv pip install --python .venv-asr/bin/python faster-whisper      # 2 s en el contenedor
.venv-asr/bin/python -c "import faster_whisper, ctranslate2; print(faster_whisper.__version__, ctranslate2.__version__, ctranslate2.get_supported_compute_types('cpu'))"
# 1.2.1 4.8.2 {'int8', 'int8_float32', 'int16', 'float32'}
```
Dependencias que trae: ctranslate2 4.8.2, av 18.1.0 (PyAV, **no hace falta ffmpeg en el sistema** para decodificar), onnxruntime 1.30.0 (para el VAD), tokenizers 0.23.2, huggingface-hub 1.33.0 y numpy 2.4.6.

### 10.2 API exacta (leída con `inspect` del paquete instalado)

```python
WhisperModel.__init__(self, model_size_or_path: str, device='auto', device_index=0, compute_type='default',
    cpu_threads=0, num_workers=1, download_root=None, local_files_only=False, files=None, revision=None,
    use_auth_token=None, **model_kwargs)

WhisperModel.transcribe(self, audio: str | BinaryIO | np.ndarray, language=None, task='transcribe', log_progress=False,
    beam_size=5, best_of=5, patience=1, length_penalty=1, repetition_penalty=1, no_repeat_ngram_size=0,
    temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0], compression_ratio_threshold=2.4, log_prob_threshold=-1.0,
    no_speech_threshold=0.6, condition_on_previous_text=True, prompt_reset_on_temperature=0.5,
    initial_prompt=None, prefix=None, suppress_blank=True, suppress_tokens=[-1], without_timestamps=False,
    max_initial_timestamp=1.0, word_timestamps=False, prepend_punctuations='"\'“¿([{-',
    append_punctuations='"\'.。,，!！?？:：”)]}、', multilingual=False, vad_filter=False, vad_parameters=None,
    max_new_tokens=None, chunk_length=None, clip_timestamps='0', hallucination_silence_threshold=None,
    hotwords=None, language_detection_threshold=0.5, language_detection_segments=1
) -> Tuple[Iterable[Segment], TranscriptionInfo]

BatchedInferencePipeline(model).transcribe(...mismos..., vad_filter=True, without_timestamps=True, batch_size=8,
    clip_timestamps: Optional[List[dict]] = None)

# dataclasses
Word(start: float, end: float, word: str, probability: float)
Segment(id: int, seek: int, start: float, end: float, text: str, tokens: List[int], avg_logprob: float,
        compression_ratio: float, no_speech_prob: float, words: Optional[List[Word]], temperature: Optional[float])
TranscriptionInfo(language: str, language_probability: float, duration: float, duration_after_vad: float,
        all_language_probs, transcription_options, vad_options)
VadOptions(threshold=0.5, neg_threshold=None, min_speech_duration_ms=0, max_speech_duration_s=inf,
        min_silence_duration_ms=2000, speech_pad_ms=400)
download_model(size_or_id, output_dir=None, local_files_only=False, cache_dir=None, revision=None, use_auth_token=None)
available_models() = ['tiny.en','tiny','base.en','base','small.en','small','medium.en','medium','large-v1','large-v2',
        'large-v3','large','distil-large-v2','distil-medium.en','distil-small.en','distil-large-v3','distil-large-v3.5',
        'large-v3-turbo','turbo']
```

Lo que dice el código (verificado leyendo `transcribe.py` y `utils.py`):
- **`segments` es un generador**: la inferencia corre al iterarlo. Se puede ir reportando progreso con `segment.end / info.duration`.
- **`hotwords`**: "Hotwords/hint phrases to provide the model with. Has no effect if prefix is not None". Se inyecta en el prompt **de cada ventana** (`get_prompt(..., hotwords=options.hotwords)` dentro del bucle). **Se trunca a `max_length // 2 - 1` tokens** (223 con el `max_length` de 448 de Whisper; verificado en `get_prompt`), así que el glosario que se manda debe ser corto: los términos del proyecto o la marca que más importan, no la lista completa.
- **`initial_prompt`**: en `WhisperModel`, si `condition_on_previous_text=False`, el prompt se reinicia (`prompt_reset_since = len(all_tokens)`) después de la primera ventana. **Solo influye en los primeros ~30 s.** Con `condition_on_previous_text=True` (el valor por defecto) sigue en el historial, pero `get_prompt` solo conserva los últimos 223 tokens, así que el texto ya transcrito lo va desplazando. En `BatchedInferencePipeline` sí se aplica a cada lote.
- **Para el glosario:** `hotwords="Zyra, HyperFrames, Kie AI"` (en todo el audio) y, además, una corrección determinista sobre las palabras al terminar (los hotwords solo "sugieren").
- **`vad_filter=True`** usa Silero VAD v6, **incluido en el paquete** (`faster_whisper/assets/silero_vad_v6.onnx`): funciona sin red. Los timestamps se devuelven en el tiempo **original** del audio. Por defecto solo quita silencios de más de 2 s; `vad_parameters=dict(min_silence_duration_ms=500)` lo hace más agresivo.
- **Modelos → repos de HF** (`utils._MODELS`): `small` → `Systran/faster-whisper-small`, `large-v3` → `Systran/faster-whisper-large-v3`, `turbo`/`large-v3-turbo` → `mobiuslabsgmbh/faster-whisper-large-v3-turbo`, `distil-large-v3.5` → `distil-whisper/distil-large-v3.5-ct2`, etc. `download_model` baja solo `config.json`, `preprocessor_config.json`, `model.bin`, `tokenizer.json` y `vocabulary.*`.
- **`download_root` se pasa como `cache_dir`** (estructura de caché de HF: `models--Systran--faster-whisper-small/snapshots/<hash>/`). Para una carpeta plana y portable: `download_model("small", output_dir="models/faster-whisper-small")` y luego `WhisperModel("models/faster-whisper-small")`. **Si `model_size_or_path` es una carpeta existente, se carga directo sin tocar la red.** Con huggingface-hub 1.33 aparece el aviso `local_dir_use_symlinks ... deprecated and ignored`, que es inofensivo.
- **Sin conexión:** `HF_HUB_OFFLINE=1` + carpeta local. Error real cuando no hay modelo: `huggingface_hub.errors.LocalEntryNotFoundError: Cannot find an appropriate cached snapshot folder ... outgoing traffic has been disabled`. Sin esa variable, desde el contenedor: `ProxyError 403 Forbidden`.
- Hilos: `cpu_threads` (o `OMP_NUM_THREADS`). En CPU conviene `compute_type="int8"`.

### 10.3 VAD sin modelo Whisper (probado aquí)

```python
from faster_whisper.audio import decode_audio
from faster_whisper.vad import get_speech_timestamps, VadOptions
audio = decode_audio("clips/A_h1080p25_voz.mp4", sampling_rate=16000)    # float32 mono 16 kHz; 0.07 s para 17 s
ts = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=300, speech_pad_ms=100))  # 0.10 s
[(c["start"]/16000, c["end"]/16000) for c in ts]
# [(0.0, 1.38), (1.53, 7.2), (8.92, 11.27), (11.55, 14.02), (14.27, 17.0)]   <- coincide con silencedetect (§4.1)
```

### 10.4 Worker de transcripción (**NO VERIFICADO con un modelo real**)

Lo que sí se probó: compila, y sin modelo termina con **código 2** y un JSON en stderr que el backend puede mostrar tal cual. Salidas reales:
- Con `HF_HUB_OFFLINE=1`: `{"error": "model_unavailable", "type": "LocalEntryNotFoundError", "detail": "Cannot find an appropriate cached snapshot folder ...", "model": "small", "looked_in": "models/faster-whisper-small"}`.
- Con red bloqueada: `{"error": "model_unavailable", "type": "ProxyError", "detail": "403 Forbidden", ...}`.

```python
"""transcribe_worker.py — faster-whisper -> JSON con tiempos por palabra.
Uso: python transcribe_worker.py entrada.(wav|mp4) --model small --models-dir ./models --language es \
       --glossary "Zyra,HyperFrames,Kie AI" > salida.json
Offline: si --models-dir/<carpeta> existe se carga por ruta (sin red). Con HF_HUB_OFFLINE=1 nunca intenta descargar."""
import argparse, json, os, re, sys, time

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="small")               # tiny|base|small|medium|large-v3|turbo
    ap.add_argument("--models-dir", default="./models")
    ap.add_argument("--language", default="es")              # None => autodetección
    ap.add_argument("--glossary", default="")                # términos separados por coma
    ap.add_argument("--compute-type", default="int8")         # CPU: int8 (rápido) | float32
    ap.add_argument("--threads", type=int, default=0)         # 0 = automático (OMP_NUM_THREADS)
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--batched", action="store_true")         # BatchedInferencePipeline (más RAM, más rápido)
    a = ap.parse_args()

    from faster_whisper import WhisperModel, BatchedInferencePipeline
    local = os.path.join(a.models_dir, f"faster-whisper-{a.model}")
    src = local if os.path.isdir(local) else a.model          # ruta local => no toca la red
    t0 = time.time()
    try:
        model = WhisperModel(src, device="cpu", compute_type=a.compute_type, cpu_threads=a.threads,
                             download_root=None if src == local else a.models_dir,
                             local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1")
    except Exception as e:                                    # sin modelo / sin red: error en JSON y código 2
        json.dump({"error": "model_unavailable", "type": type(e).__name__, "detail": str(e)[:300],
                   "model": a.model, "looked_in": local}, sys.stderr, ensure_ascii=False)
        sys.exit(2)
    load_s = time.time() - t0
    terms = [t.strip() for t in a.glossary.split(",") if t.strip()]
    kw = dict(language=a.language or None, beam_size=a.beam_size, word_timestamps=True,
              vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200),
              condition_on_previous_text=False,                # reduce bucles/alucinaciones en clips largos
              initial_prompt=("Glosario: " + ", ".join(terms) + ".") if terms else None,
              hotwords=", ".join(terms) if terms else None)
    runner = BatchedInferencePipeline(model=model) if a.batched else model
    if a.batched: kw["batch_size"] = 8
    t1 = time.time()
    segments, info = runner.transcribe(a.audio, **kw)
    segs = []
    for s in segments:                                        # generador: aquí corre la inferencia
        segs.append({"id": s.id, "start": s.start, "end": s.end, "text": s.text.strip(),
                     "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob,
                     "words": [{"word": w.word.strip(), "start": w.start, "end": w.end,
                                "probability": w.probability} for w in (s.words or [])]})
    # Corrección determinista con el glosario (los hotwords solo "sugieren"): compara sin acentos/mayúsculas
    norm = lambda x: re.sub(r"[^\w]", "", x.lower())
    fix = {norm(t): t for t in terms if " " not in t}
    for s in segs:
        for w in s["words"]:
            m = re.match(r"^(\W*)(.*?)(\W*)$", w["word"])
            if m and norm(m.group(2)) in fix: w["word"] = m.group(1) + fix[norm(m.group(2))] + m.group(3)
    json.dump({"language": info.language, "language_probability": info.language_probability,
               "duration": info.duration, "duration_after_vad": info.duration_after_vad,
               "model": a.model, "load_s": round(load_s, 2), "transcribe_s": round(time.time() - t1, 2),
               "segments": segs}, sys.stdout, ensure_ascii=False)

if __name__ == "__main__":
    main()
```

Salida (JSON) con la estructura que consume el resto de la app:
```json
{"language":"es","language_probability":0.99,"duration":17.26,"duration_after_vad":15.1,"model":"small",
 "segments":[{"id":1,"start":0.0,"end":7.04,"text":"Hola, soy Zyra. ...","avg_logprob":-0.21,"no_speech_prob":0.01,
   "words":[{"word":"Hola,","start":0.0,"end":0.42,"probability":0.97}, ...]}]}
```
(Los valores numéricos del ejemplo son ilustrativos; la forma sale de los dataclasses verificados.)

**[REVISIÓN] Límite de la corrección determinista del glosario:** el bloque `fix` solo reemplaza palabras que, sin acentos ni mayúsculas, ya son **iguales** al término (`zyra` → `Zyra`). En la prueba real de §10.8, Whisper escribió **"Sia"** donde se dijo "Zyra", y esta corrección no lo arregla. Para cumplir el criterio de aceptación ("si corrijo una palabra, la siguiente transcripción ya la escribe bien"):
- El glosario guarda **pares `{incorrecto → correcto}`** a partir de las correcciones del usuario en la transcripción (por ejemplo `"Sia" → "Zyra"`), además de la lista de términos.
- Después de transcribir, se reemplazan esas formas incorrectas observadas. Opcionalmente, coincidencia difusa (Levenshtein o fonética) **solo** contra los términos del glosario y con un umbral conservador.
- Los términos correctos se mandan como `hotwords` (faster-whisper), que solo sugieren.
- La prueba de aceptación debe usar el **mismo** audio dos veces: transcribir, corregir "Sia" → "Zyra" y volver a transcribir.

### 10.5 ¿Qué modelo en CPU?

Cifras oficiales del README de faster-whisper 1.2.1 (incluido en el METADATA del paquete): **13 min de audio con `small` en CPU (Intel Core i7-12700K, 8 hilos):**

| Implementación | Precisión | Tiempo | RAM |
|---|---|---|---|
| openai/whisper | fp32 | 6m58s | 2335 MB |
| whisper.cpp | fp32 | 2m05s | 1049 MB |
| faster-whisper | fp32 | 2m37s | 2257 MB |
| faster-whisper | **int8** | **1m42s** | 1477 MB |
| faster-whisper (`batch_size=8`) | int8 | 51s | 3608 MB |

Tamaño de descarga aproximado (ggml fp16 según `@remotion/install-whisper-cpp`; los modelos CT2 de Systran son fp16 y de tamaño similar): tiny 78 MB · base 148 MB · small 488 MB · medium 1.53 GB · large-v3 3.10 GB · large-v3-turbo 1.62 GB.

Tabla oficial de modelos de `openai/whisper` (README leído con WebFetch; velocidad relativa **medida en inglés sobre una GPU A100**, no en CPU):

| Modelo | Parámetros | VRAM | Velocidad relativa (A100) |
|---|---|---|---|
| tiny | 39 M | ~1 GB | ~10x |
| base | 74 M | ~1 GB | ~7x |
| small | 244 M | ~2 GB | ~4x |
| medium | 769 M | ~5 GB | ~2x |
| large (v3) | 1550 M | ~10 GB | 1x |
| turbo (large-v3-turbo) | 809 M | ~6 GB | ~8x |

El README aclara que `turbo` es un `large-v3` optimizado "con una degradación mínima de precisión" y que **no sirve para traducir** (solo transcribe). En CPU su ventaja se achica: el decoder baja de 32 a 4 capas, pero el encoder sigue siendo el de large-v3, de 32 capas (deducción de la arquitectura, **NO VERIFICADO** con medición).

Estimación para el estimador de tiempos en una máquina de 4 a 8 hilos, con int8, beam 5 y VAD (**NO VERIFICADO**). Se tomó el `small` del benchmark (13 min en 1m42s con 8 hilos de un i7-12700K = 0.13 s por s de audio; ~2x más en 4 vCPU como las de este contenedor) y se escaló con la velocidad relativa oficial. Para turbo se usó un rango amplio, por el encoder de 32 capas. Hay que reemplazarla con mediciones reales (§14.3):

| Modelo | s de cómputo por s de audio (aprox.) | Uso sugerido |
|---|---|---|
| tiny | 0.05–0.12 | Vista previa instantánea; se equivoca con los nombres |
| base | 0.07–0.17 | Vista previa |
| **small** | **0.13–0.30** | **Valor por defecto** |
| medium | 0.3–0.6 | Rara vez compensa frente a turbo |
| turbo | 0.3–1.0 | "Calidad alta" en CPU |
| large-v3 | 0.5–1.2 o más | Solo con GPU |

Recomendación para español en CPU (**estimaciones, NO VERIFICADAS aquí**): con int8 y 4 hilos, `small` debería rondar 0.15–0.3x tiempo real (1 min de audio ≈ 10–20 s).
- **`small`** como valor por defecto (calidad aceptable en español y rápido).
- **`turbo` / large-v3-turbo** para "calidad alta": mejor con nombres propios y spanglish, ~2–3x más lento que `small` en CPU por el encoder de 32 capas.
- **`large-v3`** solo con GPU.
- `tiny` y `base` solo para vista previa: alucinan con nombres.
- **Los `distil-*` son solo inglés**, según las model cards (el README los usa con `language="en"`). No sirven para este caso.

Siempre `language="es"` (evita una autodetección errónea en clips con mucho inglés) y `word_timestamps=True`. Para spanglish, NO forzar `multilingual=True` sin probarlo antes.

### 10.6 Alternativas

| Opción | Tiempos por palabra | Estado |
|---|---|---|
| **whisper.cpp** (binario C++) | `-ojf` (JSON completo con tokens, `t0/t1` y probabilidad), `--max-len 1 --split-on-word true`, `--dtw large.v3` (mejores timestamps de token) | Flags tomadas del código de `@remotion/install-whisper-cpp@4.0.532` (`transcribe.js`). Modelos en `huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<modelo>.bin`. **NO VERIFICADO** (github y HF bloqueados) |
| **OpenAI** `POST /v1/audio/transcriptions` | `response_format=verbose_json` + `timestamp_granularities[]=word` (y/o `segment`) | Tipos del SDK `openai@7.27.0`: los modelos son `whisper-1`, `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe(-2025-12-15)` y `gpt-4o-transcribe-diarize`. **Para `gpt-4o-(mini-)transcribe` el único formato es `json`**, así que las palabras con tiempo salen en la práctica solo con `whisper-1`. `words[]` = `{word, start, end}` **sin probabilidad**. Límite de 25 MB (según resumen de búsqueda). `gpt-4o-transcribe-diarize` devuelve hablantes con `diarized_json`. **NO VERIFICADO con llamada real** |
| **Filtro `whisper` de FFmpeg 8.0** | Opciones `model` (ruta a un modelo ggml de whisper.cpp), `language` (`auto` por defecto), `queue`, `use_gpu`, `gpu_device`, `destination`, `format` (`text`, `srt` o `json`) y `vad_model`, según la nota de lanzamiento resumida por WebSearch (Phoronix y heise). Requiere un build con whisper.cpp | **NO VERIFICADO en ejecución** (el contenedor tiene 6.1). **[REVISIÓN] Leído en el código de `libavfilter/af_whisper.c` (tag `n9.0.2`):** `format=json` escribe una línea por segmento `{"start":ms,"end":ms,"text":"…"}`, **sin probabilidad**. Con `max_len>0` activa `token_timestamps` y `split_on_word`, así que **`max_len=1` da aproximadamente una palabra por segmento**. Usa muestreo **greedy** (sin beam) y no tiene opción de prompt ni de hotwords (no sirve para el glosario). `queue` vale 3 s por defecto: procesa el audio en ventanas de 3 s salvo que se suba `queue` (máximo 30 s útil) o se use `vad_model`. Opciones extra frente a la nota de lanzamiento: `translate`, `max_len`, `vad_threshold`, `vad_min_speech_duration` y `vad_min_silence_duration`. Homebrew `ffmpeg-full` 9.0.2 se compila con `--enable-whisper` (depende de `whisper.cpp`); el `ffmpeg` normal no. Sirve como alternativa sin Python en la Mac, aunque con menos control que faster-whisper |
| `faster-whisper-ts` 1.2.1 (npm) | Port a TypeScript con la misma API (`new WhisperModel(ruta, "cpu", 0, "default")`, `transcribe(audio, {beamSize, vadFilter})`) | Leído del paquete: **solo Linux con CPU**; compila un puente C++ con `cmake` en el `postinstall` y su README declara validados solo `tiny` y `base`. **Descartado** para la Mac del usuario. No se instaló |
| **Groq** `POST https://api.groq.com/openai/v1/audio/transcriptions` | Igual (compatible con OpenAI): `verbose_json` + `timestamp_granularities: ['word','segment']` | Tipos de `groq-sdk@1.6.0`: modelos `whisper-large-v3` y `whisper-large-v3-turbo`, formatos `json`, `text` y `verbose_json`. Límite de 25 MB en plan gratis y 100 MB en el dev (según resumen de búsqueda). **NO VERIFICADO con llamada real** |

Para cualquier API: mandar el audio extraído a 16 kHz mono (`ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le asr.wav`: 0.011 s por segundo, ~1.9 MB por minuto en WAV; con `-c:a libopus -b:a 24k` en `.ogg` es mucho menos), y trocear si pasa de 25 MB. El adaptador debe normalizar todas las salidas al mismo JSON de §10.4, con `probability` opcional.

### 10.7 Diarización ligera

- **pyannote** (`pyannote/speaker-diarization-3.x`) necesita un token de HF y aceptar los términos del modelo. No es alcanzable desde aquí (**NO VERIFICADO**). Se deja como complemento opcional, apagado por defecto.
- **Sin diarización:** es el valor por defecto razonable para un talking head de una persona.
- **Por canal (probado):** con 2 micrófonos en L y R, el RMS por canal en ventanas de 0.5 s asigna hablante sin modelos:
```bash
ffmpeg -v error -i entrevista_2mics.wav -af "asetnsamples=n=24000,astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=RMS_level,ametadata=mode=print:file=-" -f null - \
 | sed 's/=-inf/=-120/' | awk '/pts_time/{split($3,a,":");t=a[2]} /astats.1.RMS/{split($0,b,"=");l=b[2]+0} /astats.2.RMS/{split($0,c,"=");r=c[2]+0;printf "%5.1fs L=%7.1f R=%7.1f -> %s\n",t,l,r,(l>r+6&&l>-50?"persona1":(r>l+6&&r>-50?"persona2":"-"))}'
#   0.0s L=  -19.2 R= -120.0 -> persona1
#   7.5s L= -120.0 R= -120.0 -> -
#   8.0s L= -120.0 R=  -20.6 -> persona2
```
  `asetnsamples=n=24000` define ventanas de 0.5 s a 48 kHz. **Trampa:** astats imprime `-inf` en silencio y awk lo convierte a 0 (parecería "fuerte"), por eso se reemplaza con -120. A cada palabra se le asigna el hablante de la ventana que contiene su punto medio.
- Alternativa futura con un solo micrófono: embeddings de hablante + clustering (por ejemplo, los modelos ONNX de sherpa-onnx o wespeaker). **NO VERIFICADO**.

### 10.8 [REVISIÓN] Prueba real con Whisper: transformers.js + ONNX (VERIFICADO aquí, sin red)

Los pesos de Hugging Face no son alcanzables desde el contenedor, pero `registry.npmjs.org` sí. El paquete npm `sts-whisper-small@1.0.0` (Apache-2.0, 253 MB) trae los archivos de `Xenova/whisper-small` en ONNX q8, y `sts-whisper-tiny` los de tiny (45 MB). **El paquete es de un tercero desconocido y sin repositorio: sirve solo para probar en el contenedor, no como dependencia de la app.** En local, los mismos modelos se bajan de HF (`onnx-community/whisper-small`, `Xenova/whisper-small`).

```bash
# scratchpad/research-critic/: npm i @huggingface/transformers@4.3.0 --ignore-scripts
#   (el postinstall de onnxruntime-node 1.30 intenta bajar binarios CUDA y aquí falla con ECONNRESET;
#    los binarios de CPU para linux-x64 ya vienen en el paquete: bin/napi-v*/linux/x64/libonnxruntime.so.1)
MODEL_DIR=./sts-small/package/models/ MODEL_ID=Xenova/whisper-small node asr-tjs.mjs voz16k.f32 word
```
```js
import { pipeline, env } from "@huggingface/transformers";
env.allowRemoteModels = false; env.localModelPath = "./sts-small/package/models/";
const asr = await pipeline("automatic-speech-recognition", "Xenova/whisper-small", { dtype: "q8", device: "cpu" });
const out = await asr(float32Mono16k, { language: "spanish", task: "transcribe", return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
// out.chunks = [{ text: " Hola,", timestamp: [0.3, 0.62] }, …]   (sin probabilidad por palabra)
```

Resultado con la misma voz de espeak-ng de §1.1 (17.24 s, 4 vCPU):

| Modelo | Modo | Tiempo | s/s | Texto |
|---|---|---|---|---|
| small q8 | palabra | 22.5 s (carga 3.5 s aparte) | **1.31** | "Hola, soy **Sia**. Hoy te voy a enseñar tres trucos para **elitar dinero** con inteligencia artificial. Primero, quita los silencios. Segundo, **arrega** subtítulos. Tercero, usa música con **duking**." |
| small q8 | segmento | 16.2 s | 0.94 | igual, en 2 segmentos `[0,7]` y `[9,17]` |
| tiny q8 | palabra | 1.5–3.3 s | ~0.1–0.2 | **inservible**: "hoy voy a enseñar 3.0 para la generalmente…", y se pierde la segunda mitad |

- **Tiempos por palabra frente a `silencedetect`:** "artificial." termina en 7.00 (el silencio empieza en 7.05) y "Primero," empieza en 9.18 (el silencio termina en 8.98). Los fines de palabra antes de una pausa salen hasta **0.4 s tarde** ("silencios." 11.56 frente a 11.17; "subtítulos." 14.30 frente a 13.89). Para cortar silencios conviene ajustar los bordes con `silencedetect` o el VAD (§4.1, §10.3), no confiar a ciegas en `end`.
- Varios errores vienen de la voz robótica de espeak. La calidad con voz humana sigue **NO VERIFICADA**, pero el mecanismo completo (modelo local, español forzado, palabras con tiempo) sí funciona.
- **Velocidad:** transformers.js (greedy, con DTW sobre atenciones para las palabras) va a 1.3 s/s con small, **más lento que tiempo real** en 4 vCPU. faster-whisper int8 debería ser varias veces más rápido según su README (§10.5, no medido aquí). Para el estimador: no usar transformers.js como motor por defecto en CPU; sirve como **respaldo sin Python** (onnxruntime-node trae binarios para macOS arm64/x64, Linux y Windows: NO VERIFICADO fuera de Linux) y para **probar en CI/contenedor** con audio real.
- Script: `scratchpad/research-critic/asr-tjs.mjs` (fuera del repo).

---

## 11. Reencuadre siguiendo a quien habla

### 11.1 Opciones locales evaluadas

| Opción | Instalación | Resultado aquí |
|---|---|---|
| **OpenCV Haar** (`haarcascade_frontalface_default.xml`) | `pip install "opencv-python-headless<5"` (4.14.0) | ✔ Detectó el rostro de `skimage.data.astronaut()` (foto real) en `[177,66,95,95]` en **37 ms** (512x512). ✔ Funcionó en el video sintético con un rostro de ~95 px en 1920x1080 |
| OpenCV 5.0 (`opencv-python-headless` actual) | `pip install opencv-python-headless` → 5.0.0.93 | ✘ **Ya no existen `cv2.CascadeClassifier` ni `cv2.data.haarcascades/*.xml`**. Trae `cv2.FaceDetectorYN` (YuNet), que necesita `face_detection_yunet_*.onnx` de opencv_zoo (GitHub/HF, **NO VERIFICADO**) |
| `opencv-contrib-python` 5.0 (lo arrastra mediapipe) | `pip install mediapipe` | ⚠ `hasattr(cv2, "CascadeClassifier") == True` (vive en contrib), pero `cv2.data` **no trae ningún XML**: habría que conseguir `haarcascade_frontalface_default.xml` por fuera. No se probó la detección con esta variante |
| **MediaPipe Tasks** FaceDetector | `pip install mediapipe` (1.0.1) + modelo `.tflite` + `libEGL.so.1` | ✔ IMAGE: bbox `177,82,95,95`, score 0.922, **3.5 ms**. ✘ No detectó el rostro pequeño del video sintético (~9 % de la altura), ni en recortes de 1080x1080 |

Detalles de MediaPipe 1.0.1 (verificados):
- `hasattr(mp, "solutions") == False`: **ya no existe la API legada `mp.solutions.face_detection`**, que traía el modelo dentro. Solo queda `mediapipe.tasks.python.vision.FaceDetector`.
- El modelo se descarga de `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite` (230 KB; **alcanzable desde el contenedor**).
- Sin `libEGL.so.1`, `create_from_options` falla con `OSError: libEGL.so.1: cannot open shared object file`. Se resolvió con `apt-get install -y libegl1 libgles2` (**se instaló en el sistema del contenedor**, fuera del scratch). En macOS no aplica (NO VERIFICADO).
- `mediapipe` arrastra **`opencv-contrib-python` 5.0**, que choca con `opencv-python-headless` (ambos instalan el módulo `cv2`). Hay que usar entornos separados o solo uno de los dos.
- Hay que usar `with vision.FaceDetector.create_from_options(opts) as det:`. Sin `close()`, al salir aparece `TypeError: 'NoneType' object is not callable` en `__del__`.
- El modelo *short-range* está pensado para rostros cercanos (selfie o talking head). Para planos abiertos conviene Haar o YuNet.

```python
import mediapipe as mp, numpy as np, cv2
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision
opts = vision.FaceDetectorOptions(base_options=mpt.BaseOptions(model_asset_path="blaze_face_short_range.tflite"),
                                  running_mode=vision.RunningMode.IMAGE, min_detection_confidence=0.5)
with vision.FaceDetector.create_from_options(opts) as det:
    rgb = cv2.cvtColor(cv2.imread("astronaut.png"), cv2.COLOR_BGR2RGB)
    res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    for d in res.detections: print(d.bounding_box.origin_x, d.bounding_box.width, d.categories[0].score)
# modo VIDEO: running_mode=vision.RunningMode.VIDEO y det.detect_for_video(img, timestamp_ms_creciente)
```

### 11.2 Script de seguimiento probado (`track_face.py`, Haar + suavizado sin retraso → expresión de crop)

```python
"""track_face.py <video> [cada_seg=0.25] -> imprime JSON {keyframes:[{t,x}], expr, cropW}
Muestrea fotogramas con ffmpeg (respeta rotación/VFR), detecta el rostro más grande con Haar (OpenCV 4.x),
suaviza y genera la expresión de crop para ffmpeg (x del borde izquierdo, 9:16)."""
import sys, json, subprocess, numpy as np, cv2

def probe(path):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", path])
    j = json.loads(out); s = j["streams"][0]
    rot = next((d.get("rotation", 0) for d in s.get("side_data_list", [])), 0)
    w, h = (s["height"], s["width"]) if abs(int(rot)) % 180 == 90 else (s["width"], s["height"])
    return w, h, float(j["format"]["duration"])

def sample_frames(path, every, width=640):
    W, H, dur = probe(path); sh = int(round(H * width / W / 2) * 2)
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps=1/{every}:round=up,scale={width}:{sh}",
           "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.check_output(cmd); n = len(raw) // (width * sh)
    frames = np.frombuffer(raw, np.uint8)[: n * width * sh].reshape(n, sh, width)
    # OJO: fps=1/P (round=near) entrega el frame de t≈k*P+P/2; con round=up entrega el de t=k*P (verificado)
    return W, H, dur, [(i * every, frames[i]) for i in range(n)], W / width

def detect_x(frames, scale):
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    xs = []
    for t, g in frames:
        f = casc.detectMultiScale(g, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
        if len(f):
            x, y, w, h = max(f, key=lambda r: r[2] * r[3]); xs.append((t, (x + w / 2) * scale))
        else:
            xs.append((t, None))
    return xs

def smooth(xs, W, win=2, deadzone=0.03):
    """Suavizado SIN retraso (offline): interpola huecos, media móvil CENTRADA de ±win muestras,
    y zona muerta (si el cambio < 3% del ancho, la cámara no se mueve)."""
    ts = np.array([t for t, _ in xs]); v = np.array([np.nan if x is None else x for _, x in xs], float)
    ok = ~np.isnan(v)
    v = np.interp(ts, ts[ok], v[ok]) if ok.any() else np.full_like(ts, W / 2)
    pad = np.pad(v, win, mode="edge"); k = np.ones(2 * win + 1) / (2 * win + 1)
    v = np.convolve(pad, k, mode="valid")
    out = []; cur = v[0]
    for t, x in zip(ts, v):
        if abs(x - cur) > deadzone * W: cur = x
        out.append((float(t), float(cur)))
    return out

def to_expr(kf, W, H):
    cw = int(H * 9 / 16) // 2 * 2
    left = [(t, min(max(cx - cw / 2, 0), W - cw)) for t, cx in kf]
    expr = f"{left[-1][1]:.1f}"
    for (t0, x0), (t1, x1) in reversed(list(zip(left, left[1:]))):  # if anidados, lineal por tramos
        expr = f"if(lt(t,{t1:.3f}),{x0:.1f}+({x1 - x0:.1f})*(t-{t0:.3f})/{t1 - t0:.3f},{expr})"
    return cw, left, expr

if __name__ == "__main__":
    path = sys.argv[1]; every = float(sys.argv[2]) if len(sys.argv) > 2 else 0.25
    W, H, dur, frames, scale = sample_frames(path, every)
    raw = detect_x(frames, scale); kf = smooth(raw, W); cw, left, expr = to_expr(kf, W, H)
    print(json.dumps({"W": W, "H": H, "cropW": cw, "detected": sum(x is not None for _, x in raw), "samples": len(raw),
                      "keyframes": [{"t": round(t, 3), "x": round(x, 1)} for t, x in left], "expr": expr}))
```

```bash
.venv-cv4/bin/python track_face.py persona_movil.mp4 0.25 > track.json        # 1.2 s para 8 s de video
EXPR=$(python3 -c "import json;print(json.load(open('track.json'))['expr'])")
printf "[0:v]crop=w=606:h=1080:x='%s':y=0,scale=1080:1920,setsar=1[v]" "$EXPR" > reframe_graph.txt
ffmpeg -y -i persona_movil.mp4 -filter_complex_script reframe_graph.txt -map "[v]" -c:v libx264 -preset veryfast -pix_fmt yuv420p reframed.mp4
```

Verificación: se volvió a detectar el rostro en la salida cada 0.5 s y se midió su desvío respecto del centro, en % del ancho de salida. El sujeto cruza el cuadro ida y vuelta en 8 s, unos 355 px/s, mucho más rápido que un talking head real.

| Variante | Desvío medido |
|---|---|
| EMA causal (α=0.35), muestreo 0.5 s, `fps=1/0.5` sin round | hasta ±37 % y el rostro **sale del cuadro** (4 muestras sin detección) |
| Media centrada, muestreo 0.5 s, **sin** `round=up` | ±27 %, desfasado según la dirección (el muestreo de §3.1 adelanta 0.23 s) |
| Media centrada, muestreo 0.5 s, `round=up` | ±14 % |
| **Media centrada, muestreo 0.25 s, `round=up`** | **±4 %**, salvo en el extremo derecho (+16 a +25 %), donde el recorte ya está pegado al borde del cuadro (es correcto) |

Conclusiones:
- Como el proceso es offline, conviene **suavizar sin retraso** (media centrada o Savitzky-Golay) y no con EMA causal.
- Muestrear cada 0.25–0.5 s con `round=up`.
- Usar una zona muerta del ~3 % para que la "cámara" no tiemble.
- Limitar a ≤80 puntos por expresión (o pasar a sendcmd, §5.3).
- Si no hay rostro: interpolar o mantener el último valor. Si nunca hubo, recorte centrado.
- Con varias personas, elegir la cara del hablante activo cruzando con la diarización o el canal (§10.7), o la más grande.
- Para A-roll contra B-roll (`PROMPT.md` §4.1): % de voz según el VAD + presencia de rostro en las muestras da una heurística barata (propuesta, **NO VERIFICADA** como clasificador).

---

## 12. Trampas encontradas (resumen)

| # | Trampa | Solución verificada |
|---|---|---|
| 1 | `fps=1/N` entrega frames desfasados N/2 | `fps=1/N:round=up` o `select` + `showinfo` |
| 2 | `packet duration_time` no revela VFR | Deltas de PTS o `r_frame_rate` contra `avg_frame_rate` |
| 3 | ffprobe da el tamaño codificado de un video rotado | Intercambiar w y h si `|rotation| % 180 == 90`; ffmpeg autorrota al decodificar |
| 4 | Un cambio de color puro puntúa bajo en `scene` | Umbral de 0.3 + duración mínima de escena |
| 5 | loudnorm sube la salida a 192 kHz | `-ar 48000` / `aresample=48000` |
| 6 | La pasada 2 de loudnorm cae a dinámica | Limitador previo con techo `TP − (I − I_medido) − 1` |
| 7 | `amix` normaliza por defecto (−8 dB) | `normalize=0` |
| 8 | `sidechaincompress threshold` es lineal | 0.02 ≈ −34 dBFS |
| 9 | `alimiter` renormaliza a 0 dB | `level=disabled` |
| 10 | El decodificador nativo de VP9 descarta el alfa | `-c:v libvpx-vp9` antes de `-i` |
| 11 | `drawbox` no escribe alfa y su `x(t)` no se animó | `replace=1`; animar con `overlay` |
| 12 | libass cae a DejaVu en silencio | `Fontname` = nombre completo + revisar `fontselect` en `-v debug` |
| 13 | `BorderStyle=3`: la caja usa OutlineColour | Poner el color de la caja en OutlineColour |
| 14 | ASS no pasa a mayúsculas ni escapa `{}` | Hacerlo en el generador |
| 15 | `-ss` de entrada desfasa los subtítulos | `-copyts` en vistas previas; en el final, quemar al final del grafo |
| 16 | ASS→SRT con ffmpeg deja `<font>` | Generar SRT y VTT desde las palabras |
| 17 | ~100 niveles de funciones anidadas en una expresión → error (98 `if` sueltos, 97 dentro de `clip`) | `sendcmd` o una expresión por segmento; ≤80 puntos por expresión |
| 18 | lut3d y colorbalance cuestan +0.7 s/s cada uno | `eq` para lo simple; un solo `.cube` horneado |
| 19 | concat con intermedios AAC acumula ~21 ms por segmento | PCM en los intermedios, AAC al final |
| 20 | x264 cambia con el número de hilos | Fijar `-threads 4` |
| 21 | `anoisesrc` es aleatorio | `seed=N` |
| 22 | `-progress` `out_time_ms` está en µs | Usar `out_time_us` |
| 23 | `grep -q` + `pipefail` = falso negativo | Guardar la salida en una variable |
| 24 | OpenCV 5 quitó Haar (headless sin la clase; contrib con la clase pero sin XML) | `opencv-python-headless<5` |
| 25 | mediapipe 1.0.1: sin `solutions`, pide libEGL, no ve rostros chicos | Tasks API + `.tflite` + `apt install libegl1 libgles2`; Haar para planos abiertos |
| 26 | mediapipe + opencv-headless chocan (`cv2`) | Venvs separados |
| 27 | faster-whisper: `initial_prompt` solo vale para la primera ventana (con `condition_on_previous_text=False`) | Usar `hotwords` para el glosario |
| 28 | faster-whisper: `segments` es un generador | Iterar o `list()` |
| 29 | `download_root` usa el formato de caché de HF | `download_model(output_dir=…)` y cargar por ruta |
| 30 | Las entradas de xfade deben coincidir en time base y tamaño | `fps=30,scale=…,setsar=1,format=yuv420p` por segmento |

---

## 13. Verificado en el contenedor

**Probado de verdad** (comando ejecutado y resultado revisado; los frames se revisaron a ojo donde se indica):
- §1–2: generación de clips (25, 60, 29.97 fps y VFR; HEVC con displaymatrix; HDR HLG; sin audio), ffprobe JSON, rotación, autorrotación, detección de VFR y `probe.mjs`.
- §3: póster, `thumbnail`, frames periódicos, solo keyframes, escenas (3 métodos), sprites y el **desfase de `fps`** (medido con un video de luminancia = n).
- §4: silencedetect (2 formas de parseo), ebur128 y loudnorm en dos pasadas (+ trampa de 192 kHz y fallback a dinámico).
- §5: grafo de 3 fuentes con crop x(t), fondo desenfocado, punch-in, color y xfade/acrossfade (contact sheet revisada a ojo). Constructor de receta con 4 fuentes (duración exacta). sendcmd. Límite de anidamiento. Caché con concat (+ deriva de AAC). Tonemap HDR. `-progress`. trim+split+concat. Errores de xfade.
- §6: libass y fontsdir. Tres modos ASS revisados a ojo. Tabla de nombres de fuente. Google Fonts → TTF. SRT/VTT reconocidos por ffprobe. mov_text. ASS→SRT.
- §7: ducking medido, SFX con adelay, amix con normalize 0 contra 1, loudnorm con y sin limitador previo (medido con ebur128).
- §8: VP9 con alfa y ProRes 4444 generados. Decoder nativo contra libvpx (revisado a ojo). Overlay en un rango con setpts y con itsoffset. drawbox replace=1.
- §9: determinismo (mismo comando, hilos, bitexact, semilla). Benchmarks de presets y filtros. Análisis.
- §10: instalación de faster-whisper, firmas con `inspect`, lectura de código (hotwords, initial_prompt, download_model), **VAD Silero offline sobre la voz real** y error sin conexión. Tipos de los SDK `openai@7.27.0` y `groq-sdk@1.6.0` y flags de whisper.cpp leídos de paquetes npm.
- §10.7: asignación de hablante por canal.
- §11: Haar (OpenCV 4.14) sobre una foto real y sobre video. Seguimiento completo con medición del error en la salida. MediaPipe Tasks (IMAGE ✔, rostro pequeño ✘). OpenCV 5 sin Haar.
- §14: el script `verificar-media.sh` corrió completo (`TODO OK`) **tres veces** (la tercera en la segunda pasada). Las tres dieron el mismo SHA-256 en `det1.mp4` (`7f60ee66724e75b3…`) y en `out.mp4` (`94736d67ae3fe113…`), aunque los clips de origen se regeneraron cada vez (espeak-ng y `anoisesrc` con `seed` son deterministas).
- **Re-verificado a mano en la segunda pasada:** qué frame entrega `fps=1/0.5` con `round=near`, `up` y `down` (7/22/37…, 0/15/30…, 14/29/44…, sobre un video FFV1 sin pérdida donde Y = 2·n), la caída a DejaVu con `Montserrat` y `Montserrat-ExtraBold`, el alfa de VP9 (nativo `yuv420p` contra libvpx `yuva420p`), el límite de anidamiento (corregido: 97 `if` dentro de `clip`), `CascadeClassifier` en OpenCV 4.14, headless 5.0 y contrib 5.0, y la lógica de `hotwords`, `initial_prompt` y `download_root` en `transcribe.py`.

**No se pudo probar (y por qué):**
- **[REVISIÓN] Ya hay una transcripción real** con Whisper small (ONNX q8, transformers.js) y tiempos por palabra (§10.8). Lo que sigue sin probarse es **faster-whisper** y whisper.cpp con modelo real: `huggingface.co` responde `ProxyError 403` y no hay espejo alcanzable. En la segunda pasada también se probaron `openaipublic.azureedge.net` (pesos `.pt` de openai-whisper, que se podrían convertir a CTranslate2), `hf-mirror.com`, `modelscope.cn` y `download.pytorch.org`: todos dieron `CONNECT tunnel failed, response 403`. Se buscaron paquetes de PyPI y npm que incluyan los pesos (`whisper-tiny`, `faster-whisper-tiny`, `faster-whisper-ts` y otros) y ninguno los trae. Tampoco se midieron los tiempos de tiny/base/small/medium/large-v3/turbo; las cifras de §10.5 vienen del README oficial y de estimaciones.
- APIs en la nube (OpenAI, Groq): sin llaves y con `platform.openai.com`, `developers.openai.com` y `console.groq.com` bloqueados para WebFetch. Las firmas salen de los tipos de sus SDK de npm y los límites de resúmenes de búsqueda.
- pyannote (necesita token de HF), YuNet (modelo en GitHub/HF) y la diarización por embeddings.
- Videos reales de iPhone (rotation −90, Dolby Vision), voz humana real (solo espeak-ng) y footage real para afinar umbrales de escena y silencio.
- FFmpeg 7/8 (CLI multihilo, `-/filter_complex`, filtro `whisper` de la 8.0), macOS y GPU. `ffmpeg.org` está bloqueado incluso para WebFetch.
- Guías oficiales de zonas seguras de TikTok, Reels y Shorts.
- Cambio de sistema: se instalaron `libegl1` y `libgles2` con apt para probar MediaPipe.

---

## 14. Llevarlo a local (Warp) y seguir usándolo

### 14.1 Requisitos

```bash
# macOS (Homebrew)
brew install ffmpeg-full espeak-ng uv node@22     # [REVISIÓN] ffmpeg-full (keg-only), NO ffmpeg: el normal no trae libass/freetype. Luego: export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
                                                  # espeak-ng es opcional: si falta, el script usa `say -v Paulina`
# Ubuntu/Debian
sudo apt-get install -y ffmpeg espeak-ng python3 && curl -LsSf https://astral.sh/uv/install.sh | sh

ffmpeg -hide_banner -filters | grep -E ' (ass|subtitles|drawtext|xfade|loudnorm|sidechaincompress) '   # TODOS deben aparecer
ffmpeg -hide_banner -encoders | grep -E 'libx264|libvpx-vp9'
```
~~Si en macOS falta `ass`, `subtitles` o `drawtext`… Lo que trae hoy la fórmula está NO VERIFICADO.~~

**[REVISIÓN] VERIFICADO leyendo las fórmulas de homebrew-core** (commit `619eaea`, 2026-10-04; `Formula/f/ffmpeg.rb` y `ffmpeg-full.rb`):
- **`brew install ffmpeg` (9.0.2) NO sirve para este proyecto.** Sus dependencias son dav1d, lame, libvmaf, libvpx, openssl, opus, sdl2, svt-av1, x264, x265 y xz, y compila con `--enable-libx264 --enable-libvpx …`. **No trae libass, freetype, fontconfig ni harfbuzz**, así que no tiene los filtros `ass`, `subtitles` ni `drawtext`, y los subtítulos quemados fallarían (criterio de aceptación n.º 1).
- **`brew install ffmpeg-full`** (misma versión 9.0.2, 53 dependencias) sí trae `libass`, `freetype`, `fontconfig`, `harfbuzz`, `libvpx`, `x264` y `whisper.cpp` (`--enable-whisper`). Es **`keg_only :versioned_formula`**: no se enlaza al `PATH`. El binario queda en `$(brew --prefix ffmpeg-full)/bin/ffmpeg` (en Apple Silicon, `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`).
  - `scripts/setup.mjs` debe recomendar `brew install ffmpeg-full` en macOS. Después debe autodetectar esa ruta y escribirla en `FFMPEG_PATH`/`FFPROBE_PATH` del `.env`, o anteponerla al `PATH` de los procesos hijos (también la usa HyperFrames vía `HYPERFRAMES_FFMPEG_PATH`).
  - Hoy `setup.mjs` sugiere `brew install ffmpeg` y, si faltan filtros, **solo avisa** (`c.warn`). Debería contarlo como **problema**, porque sin `ass`/`subtitles` no hay V1 con subtítulos.
  - Las botellas listadas de `ffmpeg-full` son arm64 (tahoe, sequoia, golden_gate) y Linux. **En una Mac Intel se compilaría desde el código fuente** (lento). Para ese caso conviene un build estático. NO VERIFICADO.
- Ambas fórmulas instalan **FFmpeg 9.x**, no 6.1 como el contenedor: cuidado con `-filter_complex_script`, que ya no existe (ver la nota de §5.1). El script de humo de §14.2 usa `-filter_complex_script` y **fallará en la Mac** tal como está: cambiarlo por `-filter_complex "$(cat g.txt)"`.

### 14.2 Prueba de humo en un comando (`verificar-media.sh`, probado aquí)

Se guarda como `scripts/verificar-media.sh` (o donde convenga) y se corre con `bash verificar-media.sh ./_media_smoke`. Genera los clips y prueba ffprobe, escenas, silencios, loudness, el render de la receta con xfade, ASS con fuente de Google Fonts (verifica `fontselect`), ducking + loudnorm, alfa VP9 y determinismo. Al final imprime `TODO OK` o el número de fallas. Es compatible con macOS: no usa `date +%N`, `sed -i` ni `md5sum`.

```bash
#!/usr/bin/env bash
# verificar-media.sh — prueba de humo del pipeline de medios (Linux y macOS). Uso: bash verificar-media.sh [carpeta]
set -euo pipefail
D="${1:-./_media_smoke}"; mkdir -p "$D"; cd "$D"
now(){ python3 -c 'import time;print(time.time())'; }
ok(){ printf '  \033[32mOK\033[0m  %s\n' "$*"; }
falla(){ printf '  \033[31mFALLA\033[0m %s\n' "$*"; FALLAS=$((FALLAS+1)); }
FALLAS=0; Q="-hide_banner -v error -y"
echo "== 0. Herramientas"; ffmpeg -version | head -1
FILTROS=$(ffmpeg -hide_banner -filters 2>/dev/null); ENCS=$(ffmpeg -hide_banner -encoders 2>/dev/null)  # (no usar "| grep -q" con pipefail: SIGPIPE)
for f in ass subtitles drawtext xfade acrossfade sidechaincompress loudnorm zoompan lut3d; do
  grep -qE " $f " <<<"$FILTROS" && ok "filtro $f" || falla "filtro $f (falta: instala un ffmpeg con libass/libfreetype)"; done
grep -q libx264 <<<"$ENCS" && ok "libx264" || falla "libx264"
grep -q libvpx-vp9 <<<"$ENCS" && ok "libvpx-vp9" || falla "libvpx-vp9"

echo "== 1. Clips de prueba"
T1="Hola, soy Zyra. Hoy te voy a enseñar tres trucos para editar video."
if command -v espeak-ng >/dev/null; then espeak-ng -v es-419 -s 150 -w voz_raw.wav "$T1"
elif command -v say >/dev/null; then say -v Paulina -o voz_raw.aiff "$T1" && ffmpeg $Q -i voz_raw.aiff voz_raw.wav
else ffmpeg $Q -f lavfi -i "sine=f=220:d=6" voz_raw.wav; fi
ffmpeg $Q -i voz_raw.wav -af "aresample=48000,apad=pad_dur=1.5" -ac 1 voz.wav
DV=$(ffprobe -v error -show_entries format=duration -of csv=p=0 voz.wav)
ffmpeg $Q -f lavfi -i "testsrc2=s=1920x1080:r=25:d=$DV" -i voz.wav -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest A.mp4
ffmpeg $Q -f lavfi -i "color=c=red:s=1280x720:r=60:d=2" -f lavfi -i "color=c=blue:s=1280x720:r=60:d=2" -f lavfi -i "anoisesrc=c=pink:a=0.1:d=4:seed=42" \
  -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map "[v]" -map 2:a -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac B.mp4
ffmpeg $Q -f lavfi -i "testsrc2=s=1920x1080:r=30000/1001:d=4" -c:v libx264 -preset veryfast -pix_fmt yuv420p C_raw.mp4
ffmpeg $Q -display_rotation 90 -i C_raw.mp4 -c copy C_rot.mp4
ffmpeg $Q -f lavfi -i "testsrc2=s=1280x720:r=30:d=4" -vf "select='lt(t\,2)+not(mod(n\,3))'" -fps_mode vfr -c:v libx264 -preset veryfast -pix_fmt yuv420p D_vfr.mp4
ok "clips generados (voz: $(command -v espeak-ng || command -v say || echo seno))"

echo "== 2. ffprobe"
R=$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation -of csv=p=0 C_rot.mp4 | head -1)
[ "${R%%,*}" = "90" ] || [ "${R%%,*}" = "-90" ] && ok "rotación displaymatrix = $R" || falla "rotación ($R)"
ffmpeg $Q -i C_rot.mp4 -frames:v 1 c.png; WH=$(ffprobe -v error -show_entries stream=width,height -of csv=p=0 c.png)
[ "$WH" = "1080,1920" ] && ok "autorrotación al decodificar -> $WH" || falla "autorrotación ($WH)"
F=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,avg_frame_rate -of csv=p=0 D_vfr.mp4)
[ "${F%%,*}" != "${F##*,}" ] && ok "VFR detectado (r_frame_rate,avg_frame_rate = $F)" || falla "VFR ($F)"

echo "== 3. Escenas, silencios, loudness"
SC=$(ffmpeg -hide_banner -i B.mp4 -an -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep -oE 'pts_time:[0-9.]+' | head -1)
[ "$SC" = "pts_time:2" ] && ok "cambio de escena en $SC" || falla "escena ($SC)"
SI=$(ffmpeg -hide_banner -nostats -i A.mp4 -vn -af "silencedetect=noise=-35dB:d=0.4" -f null - 2>&1 | grep -c silence_start || true)
[ "$SI" -ge 1 ] && ok "silencedetect: $SI silencios" || falla "silencedetect"
ffmpeg -hide_banner -nostats -i A.mp4 -vn -af "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p' > ln.json
python3 -c "import json;d=json.load(open('ln.json'));print('  OK  loudnorm pasada 1: input_i',d['input_i'],'input_tp',d['input_tp'])"

echo "== 4. Render receta (3 fuentes distintas -> 1080x1920 30fps, xfade + acrossfade)"
cat > g.txt <<'G'
[0:v]setpts=PTS-STARTPTS,fps=30,crop=w=606:h=1080:x='clip(300+200*t,0,iw-606)':y=0,scale=1080:1920,setsar=1,format=yuv420p[v0];
[1:v]setpts=PTS-STARTPTS,fps=30,split[b][f];[b]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920[bg];[f]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v1];
[2:v]setpts=PTS-STARTPTS,fps=30,scale=1080:1920,scale=w='trunc(1080*(1+0.15*min(t/0.6\,1))/2)*2':h=-2:eval=frame,crop=1080:1920,eq=contrast=1.06:saturation=1.1,setsar=1,format=yuv420p[v2];
[v0][v1]xfade=transition=fade:duration=0.5:offset=2.5[x];[x][v2]xfade=transition=slideleft:duration=0.5:offset=4.5[v];
[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];
[1:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];
anullsrc=r=48000:cl=stereo,atrim=0:3,aformat=sample_fmts=fltp:channel_layouts=stereo[a2];
[a0][a1]acrossfade=d=0.5[ax];[ax][a2]acrossfade=d=0.5[a]
G
t0=$(now)
ffmpeg $Q -ss 0 -to 3 -i A.mp4 -ss 1 -to 3.5 -i B.mp4 -ss 0.5 -to 3.5 -i C_rot.mp4 -filter_complex_script g.txt -map "[v]" -map "[a]" \
  -c:v libx264 -preset veryfast -crf 20 -threads 4 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -ar 48000 -movflags +faststart out.mp4
t1=$(now); OD=$(ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4)
python3 -c "d=float('$OD');w=$t1-$t0;print(('  OK ' if abs(d-7.5)<0.05 else '  FALLA ')+f' duración {d:.3f}s (esperada 7.5) · render {w:.2f}s = {w/d:.2f} s por s de video')"

echo "== 5. Subtítulos ASS con fuente propia"
FONTDIR=fonts; mkdir -p $FONTDIR
U=$(curl -sS -m 15 "https://fonts.googleapis.com/css2?family=Montserrat:wght@800" | grep -oE 'https://fonts.gstatic.com/[^)]+' | head -1 || true)
[ -n "$U" ] && curl -sS -m 30 -o $FONTDIR/Montserrat-800.ttf "$U" && FN="Montserrat ExtraBold" || FN="DejaVu Sans"
cat > s.ass <<A
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,$FN,84,&H0000D4FF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,0,2,120,120,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:03.00,Sub,,0,0,0,,{\k40}HOLA, {\k30}SOY {\k60}{\1c&HF07C8B&}ZYRA
A
SEL=$(ffmpeg -hide_banner -v debug -y -i out.mp4 -t 1 -vf "ass=s.ass:fontsdir=$FONTDIR" -f null - 2>&1 | grep -m1 fontselect | sed 's/.*-> //')
case "$SEL" in *DejaVu*) [ "$FN" = "DejaVu Sans" ] && ok "libass (sin red: fuente del sistema)" || falla "libass usó fuente de respaldo: $SEL";; *) ok "libass eligió: $SEL";; esac
ffmpeg $Q -i out.mp4 -vf "ass=s.ass:fontsdir=$FONTDIR" -c:v libx264 -preset veryfast -c:a copy out_subs.mp4 && ok "subtítulos quemados -> out_subs.mp4"

echo "== 6. Audio: ducking + SFX + loudnorm 2 pasadas"
ffmpeg $Q -f lavfi -i "aevalsrc='0.2*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*2*t))':s=48000:c=stereo:d=12" musica.wav
ffmpeg $Q -f lavfi -i "aevalsrc='0.8*sin(2*PI*880*t)*exp(-20*t)':s=48000:c=stereo:d=0.25" pop.wav
MIX="[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[v][sc];[0:a]volume=-8dB[m];[m][sc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[d];[2:a]adelay=delays=800:all=1[s];[v][d][s]amix=inputs=3:duration=first:normalize=0,afade=t=in:d=0.3"
ffmpeg -hide_banner -nostats -i musica.wav -i voz.wav -i pop.wav -filter_complex "$MIX,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[o]" -map "[o]" -f null - 2>&1 | sed -n '/^{/,/^}/p' > p1.json
P=$(python3 -c "import json;d=json.load(open('p1.json'));print(f\"measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}:measured_thresh={d['input_thresh']}:offset={d['target_offset']}\")")
ffmpeg -hide_banner -nostats -y -i musica.wav -i voz.wav -i pop.wav -filter_complex "$MIX,loudnorm=I=-14:TP=-1.5:LRA=11:$P:linear=true:print_format=json,aresample=48000[o]" -map "[o]" mezcla.wav 2>&1 | grep -o '"normalization_type" : "[a-z]*"' | sed 's/^/  pasada 2: /'
ffmpeg -hide_banner -nostats -i mezcla.wav -af ebur128=peak=true:framelog=quiet -f null - 2>&1 | grep -E '^\s+(I|Peak):' | sed 's/^ */  medido: /'

echo "== 7. Overlay con alfa (VP9 yuva420p)"
ffmpeg $Q -f lavfi -i "color=c=black@0:s=600x160:r=30:d=2,format=yuva420p,drawbox=x=0:y=20:w=600:h=120:color=0x8B7CF0@0.9:t=fill:replace=1" -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 lt.webm
PF=$(ffmpeg -hide_banner -c:v libvpx-vp9 -i lt.webm -frames:v 1 -vf showinfo -f null - 2>&1 | grep -oE 'fmt:[a-z0-9]+' | head -1)
[ "$PF" = "fmt:yuva420p" ] && ok "libvpx-vp9 decodifica con alfa ($PF)" || falla "alfa ($PF)"
ffmpeg $Q -i out.mp4 -c:v libvpx-vp9 -i lt.webm -filter_complex "[1:v]setpts=PTS-STARTPTS+2/TB[l];[0:v][l]overlay=x=240:y=1300:eof_action=pass:enable='between(t,2,4)',format=yuv420p[v]" -map "[v]" -map 0:a -c:v libx264 -preset veryfast -c:a copy out_alpha.mp4 && ok "overlay 2-4 s -> out_alpha.mp4"

echo "== 8. Determinismo"
RUN(){ ffmpeg $Q -ss 0 -to 3 -i A.mp4 -ss 1 -to 3.5 -i B.mp4 -ss 0.5 -to 3.5 -i C_rot.mp4 -filter_complex_script g.txt -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 20 -threads 4 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1 "$1"; }
RUN det1.mp4; RUN det2.mp4
H1=$(shasum -a 256 det1.mp4 | cut -c1-16); H2=$(shasum -a 256 det2.mp4 | cut -c1-16)
[ "$H1" = "$H2" ] && ok "2 renders idénticos byte a byte ($H1)" || falla "renders distintos ($H1 vs $H2)"

echo; [ $FALLAS -eq 0 ] && echo "TODO OK. Archivos en $(pwd)" || { echo "$FALLAS falla(s)"; exit 1; }
```

Salida real en el contenedor (extracto):
```
== 2. ffprobe
  OK  rotación displaymatrix = 90
  OK  autorrotación al decodificar -> 1080,1920
  OK  VFR detectado (r_frame_rate,avg_frame_rate = 30/1,400/19)
== 4. Render receta (3 fuentes distintas -> 1080x1920 30fps, xfade + acrossfade)
  OK  duración 7.500s (esperada 7.5) · render 7.33s = 0.98 s por s de video     (3.ª corrida: 6.41 s = 0.85)
== 5. Subtítulos ASS con fuente propia
  OK  libass eligió: Montserrat-ExtraBold, 0, Montserrat-ExtraBold
== 6. Audio: ducking + SFX + loudnorm 2 pasadas
  pasada 2: "normalization_type" : "dynamic"
  medido: I: -14.8 LUFS / Peak: -1.5 dBFS
== 7. Overlay con alfa (VP9 yuva420p)
  OK  libvpx-vp9 decodifica con alfa (fmt:yuva420p)
== 8. Determinismo
  OK  2 renders idénticos byte a byte
TODO OK.
```
(La sección 6 del script deja el modo dinámico a propósito, para mostrar el caso de §4.3. La versión con limitador previo está en §7.3.)

### 14.3 Transcripción real en local (lo que faltó verificar aquí)

```bash
uv venv --python 3.11 .venv-asr && uv pip install --python .venv-asr/bin/python faster-whisper
# 1) Descargar UNA vez a carpeta plana (requiere acceso a huggingface.co)
.venv-asr/bin/python -c "from faster_whisper import download_model; print(download_model('small', output_dir='models/faster-whisper-small'))"
# 2) Transcribir sin red (con el worker de §10.4 y la voz que generó el script de humo)
HF_HUB_OFFLINE=1 .venv-asr/bin/python transcribe_worker.py _media_smoke/voz.wav --model small --models-dir models --glossary "Zyra" > voz.json
python3 -c "import json;d=json.load(open('voz.json'));print(d['language'],d['transcribe_s'],'s');[print(w) for s in d['segments'] for w in s['words'][:5]]"
# 3) Medir tiempos por modelo para el estimador (repetir con tiny/base/small/medium/turbo; anotar transcribe_s / duration)
```
Lo que hay que confirmar en local y anotar en `docs/DECISIONES.md`:
- ¿Las palabras traen `probability`? ¿Los tiempos caen dentro de ±100 ms de los cortes de silencedetect?
- ¿`hotwords` corrige "Zyra"?
- Tiempo real por modelo en la máquina del usuario.

### 14.4 Rostros en local

```bash
uv venv --python 3.11 .venv-cv && uv pip install --python .venv-cv/bin/python "opencv-python-headless<5" numpy scikit-image
.venv-cv/bin/python track_face.py video_horizontal.mp4 0.25 > track.json     # luego el bloque ffmpeg de §11.2
# MediaPipe (opcional, venv aparte):
uv venv --python 3.11 .venv-mp && uv pip install --python .venv-mp/bin/python mediapipe
curl -sSLo blaze_face_short_range.tflite https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite
```

---

## 15. Fuentes

- Ejecución local en el contenedor: ffmpeg 6.1.1, libass 0.17.1, x264 0.164 y libvpx 1.14. Todas las cifras y salidas citadas salen de corridas reales.
- faster-whisper 1.2.1 (PyPI): código fuente instalado (`transcribe.py`, `utils.py`, `vad.py`) y README incluido en `METADATA` (benchmarks, uso de `word_timestamps`, `vad_filter` y `BatchedInferencePipeline`).
- `openai@7.27.0` (npm): `resources/audio/transcriptions.d.ts` y `audio.d.ts` (modelos, `response_format`, `timestamp_granularities`, `TranscriptionVerbose`/`TranscriptionWord`).
- `groq-sdk@1.6.0` (npm): `resources/audio/transcriptions.d.ts` y `.js` (endpoint `/openai/v1/audio/transcriptions`, modelos y formatos).
- `@remotion/install-whisper-cpp@4.0.532` (npm): `dist/transcribe.js` (flags de whisper.cpp: `-ojf`, `--dtw`, `--max-len`, `--split-on-word`) y `dist/download-whisper-model.js` (URLs y tamaños de los modelos ggml).
- `@expo-google-fonts/montserrat` y `@expo-google-fonts/anton` (npm): archivos TTF de prueba. Google Fonts CSS2 API (`fonts.googleapis.com/css2`, alcanzable).
- MediaPipe 1.0.1 (PyPI) y modelo `blaze_face_short_range.tflite` (storage.googleapis.com). OpenCV 4.14.0 y 5.0.0.93 (PyPI). `skimage.data.astronaut()` (scikit-image 0.26.0) como foto real con rostro.
- `openai/whisper` README (github.com, leído con WebFetch): tabla de modelos (parámetros, VRAM, velocidad relativa en A100) y notas sobre `turbo`.
- `faster-whisper-ts@1.2.1` (npm): `package.json` y README (plataformas, compilación en `postinstall`, API).
- Filtro `whisper` de FFmpeg 8.0: resumen de WebSearch de [Phoronix — FFmpeg 8.0 Merges OpenAI Whisper Filter](https://www.phoronix.com/news/FFmpeg-Lands-Whisper) y [heise — FFmpeg 8.0 integrates Whisper](https://www.heise.de/en/news/FFmpeg-8-0-integrates-Whisper-Local-audio-transcription-without-the-cloud-10522091.html). La documentación oficial (`ffmpeg.org/ffmpeg-filters.html#whisper`) está bloqueada para WebFetch.
- Resúmenes de WebSearch (no se pudo abrir el HTML original): límites de 25 MB de OpenAI ([developers.openai.com — createTranscription](https://developers.openai.com/api/docs/api-reference/audio/createTranscription)) y de Groq (25 MB gratis / 100 MB dev, [console.groq.com/docs/speech-to-text](https://console.groq.com/docs/speech-to-text)).
