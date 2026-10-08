# Worker de Python (transcripción y rostros)

Dos scripts que el servidor ejecuta con `spawn` (nunca por shell). Ambos imprimen JSON por stdout y
mensajes de error en español.

| Script | Qué hace | Lo usa |
|---|---|---|
| `transcribe.py` | Transcripción local con **faster-whisper** y tiempos por palabra. | `apps/server/src/transcription/whisper.ts` |
| `faces.py` | Rostros con **OpenCV Haar** (sin red ni modelos externos) sobre fotogramas clave. | `apps/server/src/media/faces.ts` |

## Instalación

`pnpm instalar` crea el entorno en `workers/python/.venv`. A mano:

```bash
uv venv workers/python/.venv
uv pip install --python workers/python/.venv/bin/python -r workers/python/requirements.txt
# sin uv: python3 -m venv workers/python/.venv && workers/python/.venv/bin/pip install -r workers/python/requirements.txt
```

El servidor usa ese Python automáticamente (o el de `PYTHON_PATH` en `.env`).

## Modelos de voz

Se guardan en `models/whisper/faster-whisper-<modelo>` (carpeta ignorada por git). El primer uso
descarga el modelo de Hugging Face; para descargarlo antes:

```bash
workers/python/.venv/bin/python workers/python/transcribe.py --model small --download-only
# o: pnpm instalar -- --modelo small
```

Tamaños aproximados: tiny 75 MB · base 145 MB · small 490 MB · medium 1.5 GB · turbo 1.6 GB · large-v3 3.1 GB.
Sin conexión con huggingface.co el script responde con un error claro; también puedes copiar la
carpeta del modelo (con su `model.bin`) a mano. Con `HF_HUB_OFFLINE=1` nunca intenta descargar.

## Protocolo de `transcribe.py`

```bash
python transcribe.py --file clip.mp4 --model small --language auto --hotwords "Zyra,HyperFrames" \
  --device auto --compute-type int8 [--models-dir models/whisper]
python transcribe.py --model small --check        # diagnóstico: ¿importa? ¿modelo? ¿se puede descargar?
```

Una línea JSON por evento:

```json
{"type": "progress", "p": 0.42, "message": "Transcribiendo… 42 %"}
{"type": "result", "language": "es", "duration": 24.2, "words": [{"text": "Hola,", "start": 0.6, "end": 0.93, "probability": 0.98}], "segments": [...]}
{"type": "error", "code": "modelo-no-disponible", "message": "…en español…", "detail": "…"}
```

Usa `word_timestamps`, `vad_filter`, detección de idioma con `--language auto` y los términos del
glosario como `hotwords` + `initial_prompt`. Códigos de error: `falta-faster-whisper`,
`modelo-no-disponible`, `modelo-invalido`, `archivo-no-encontrado`, `transcripcion-fallida`.

## Protocolo de `faces.py`

```bash
python faces.py kf-000.jpg kf-001.jpg …        # o: python faces.py --list lista.txt
```

```json
{"type": "result", "images": [{"path": "kf-000.jpg", "width": 640, "height": 360,
  "faces": [{"x": 0.42, "y": 0.38, "w": 0.12, "h": 0.21, "size": 0.21, "score": 7}]}]}
```

Coordenadas normalizadas 0..1 (x/y = centro; size = alto del rostro ÷ alto de la imagen), del rostro
más grande al más chico. Usa `haarcascade_frontalface_default.xml` de `cv2.data.haarcascades`
(por eso `opencv-python-headless` queda en la serie 4.x).
