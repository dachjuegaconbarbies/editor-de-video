#!/usr/bin/env python3
"""Transcripción local con faster-whisper y tiempos por palabra.

Protocolo (JSON-lines por stdout, una línea por evento):
  {"type": "progress", "p": 0.42, "message": "Transcribiendo… 42 %"}
  {"type": "result", "language": "es", "duration": 24.2, "model": "small", "words": [...], "segments": [...]}
  {"type": "error", "code": "modelo-no-disponible", "message": "…en español…", "detail": "…"}

Uso:
  python transcribe.py --file clip.mp4 --model small --language auto --hotwords "Zyra,HyperFrames"
  python transcribe.py --model small --download-only          # solo descarga el modelo
  python transcribe.py --model small --check                  # diagnóstico: ¿importa? ¿modelo? ¿red?

Modelos: se guardan en una carpeta plana por modelo dentro de --models-dir
(<models-dir>/faster-whisper-<modelo>). Si esa carpeta existe se carga sin tocar la red.
Con HF_HUB_OFFLINE=1 nunca intenta descargar.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import warnings

# Avisos de dependencias (p. ej. huggingface_hub) a stderr no aportan nada al usuario.
warnings.filterwarnings("ignore")

# Que los mensajes de huggingface_hub/tqdm no ensucien stdout (stdout es solo para JSON-lines).
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TQDM_DISABLE", "1")

# Tamaño aproximado de descarga de cada modelo (para los mensajes).
APPROX_SIZE = {
    "tiny": "75 MB",
    "base": "145 MB",
    "small": "490 MB",
    "medium": "1.5 GB",
    "large-v3": "3.1 GB",
    "turbo": "1.6 GB",
    "large-v3-turbo": "1.6 GB",
}

# Máximo de términos de glosario que se envían como hotwords (faster-whisper trunca a ~223 tokens).
MAX_HOTWORDS_CHARS = 400


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str, detail: str = "", exit_code: int = 2) -> None:
    emit({"type": "error", "code": code, "message": message, "detail": detail[:500]})
    sys.exit(exit_code)


def progress(p: float, message: str) -> None:
    emit({"type": "progress", "p": round(max(0.0, min(1.0, p)), 4), "message": message})


def model_dir(models_dir: str, model: str) -> str:
    return os.path.join(models_dir, f"faster-whisper-{model}")


def is_network_error(err: BaseException) -> bool:
    """¿El error viene de no poder hablar con Hugging Face (sin red, proxy, modo offline)?"""
    names = {type(e).__name__ for e in _chain(err)}
    text = " ".join(str(e) for e in _chain(err)).lower()
    net_names = {
        "LocalEntryNotFoundError",
        "ConnectionError",
        "ProxyError",
        "ConnectTimeout",
        "ReadTimeout",
        "ConnectError",
        "HfHubHTTPError",
        "OfflineModeIsEnabled",
        "RepositoryNotFoundError",
        "SSLError",
        "TimeoutException",
    }
    hints = ("connection", "proxy", "403", "offline", "cannot find an appropriate cached snapshot", "timed out", "name resolution")
    return bool(names & net_names) or any(h in text for h in hints)


def _chain(err: BaseException):
    seen = set()
    cur: BaseException | None = err
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        cur = cur.__cause__ or cur.__context__


def ensure_model(model: str, models_dir: str) -> str:
    """Devuelve la ruta local del modelo; lo descarga si hace falta (y si se puede)."""
    if os.path.isdir(model) and os.path.isfile(os.path.join(model, "model.bin")):
        return model  # ya es una ruta a un modelo CTranslate2
    target = model_dir(models_dir, model)
    if os.path.isfile(os.path.join(target, "model.bin")):
        return target
    size = APPROX_SIZE.get(model, "varios cientos de MB")
    if os.environ.get("HF_HUB_OFFLINE") == "1":
        fail(
            "modelo-no-disponible",
            f"El modelo de voz «{model}» no está descargado y el modo sin conexión está activo. "
            f"Conéctate a internet y corre «pnpm instalar» (descarga ~{size}).",
            f"Se buscó en {target}",
        )
    from faster_whisper.utils import download_model

    progress(0.0, f"Descargando el modelo de voz «{model}» (~{size}, solo la primera vez)…")
    os.makedirs(models_dir, exist_ok=True)
    try:
        download_model(model, output_dir=target)
    except Exception as e:  # noqa: BLE001 — se traduce a un mensaje claro
        if is_network_error(e):
            fail(
                "modelo-no-disponible",
                f"No se pudo descargar el modelo de voz «{model}»: no hay conexión con Hugging Face "
                f"(huggingface.co). Conéctate a internet y corre «pnpm instalar», o copia el modelo a "
                f"{target}.",
                f"{type(e).__name__}: {e}",
            )
        fail("modelo-no-disponible", f"No se pudo descargar el modelo de voz «{model}».", f"{type(e).__name__}: {e}")
    if not os.path.isfile(os.path.join(target, "model.bin")):
        fail("modelo-no-disponible", f"La descarga del modelo «{model}» quedó incompleta. Vuelve a correr «pnpm instalar».", target)
    return target


def repo_id(model: str) -> str:
    try:
        from faster_whisper.utils import _MODELS  # type: ignore[attr-defined]

        return _MODELS.get(model, model if "/" in model else f"Systran/faster-whisper-{model}")
    except Exception:  # noqa: BLE001
        return f"Systran/faster-whisper-{model}"


def check(model: str, models_dir: str) -> None:
    """Diagnóstico: versión de faster-whisper, si el modelo está descargado y si se podría descargar."""
    import faster_whisper

    local = model if os.path.isdir(model) else model_dir(models_dir, model)
    present = os.path.isfile(os.path.join(local, "model.bin"))
    can_download = None
    detail = ""
    if not present and os.environ.get("HF_HUB_OFFLINE") != "1":
        try:
            from huggingface_hub import HfApi

            HfApi().model_info(repo_id(model), timeout=5)
            can_download = True
        except Exception as e:  # noqa: BLE001
            can_download = False
            detail = f"{type(e).__name__}: {e}"[:300]
    elif not present:
        can_download = False
        detail = "HF_HUB_OFFLINE=1"
    emit(
        {
            "type": "check",
            "fasterWhisper": getattr(faster_whisper, "__version__", "?"),
            "model": model,
            "modelPresent": present,
            "path": local,
            "canDownload": can_download,
            "approxSize": APPROX_SIZE.get(model, ""),
            "detail": detail,
        }
    )


def parse_hotwords(raw: str) -> list[str]:
    terms: list[str] = []
    seen = set()
    for t in raw.split(","):
        t = t.strip()
        if t and t.lower() not in seen:
            seen.add(t.lower())
            terms.append(t)
    out: list[str] = []
    total = 0
    for t in terms:
        if total + len(t) + 2 > MAX_HOTWORDS_CHARS:
            break
        out.append(t)
        total += len(t) + 2
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Transcripción con faster-whisper (JSON-lines por stdout)")
    ap.add_argument("--file", help="Archivo de audio o video")
    ap.add_argument("--model", default="small", help="tiny|base|small|medium|large-v3|turbo o ruta a un modelo")
    ap.add_argument("--language", default="auto", help="'auto' (detección) o código ISO: es, en…")
    ap.add_argument("--hotwords", default="", help="Términos del glosario separados por coma")
    ap.add_argument("--device", default="auto", help="auto|cpu|cuda")
    ap.add_argument("--compute-type", default="int8", help="int8 (CPU), float16 (GPU), float32…")
    ap.add_argument("--threads", type=int, default=0, help="Hilos de CPU (0 = automático)")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--models-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "whisper"))
    ap.add_argument("--download-only", action="store_true", help="Solo descarga el modelo y termina")
    ap.add_argument("--check", action="store_true", help="Diagnóstico rápido (no descarga ni transcribe)")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except Exception as e:  # noqa: BLE001
        fail(
            "falta-faster-whisper",
            "Falta el entorno de Python con faster-whisper. Corre «pnpm instalar».",
            f"{type(e).__name__}: {e}",
        )

    models_dir = os.path.abspath(args.models_dir)
    if args.check:
        check(args.model, models_dir)
        return
    path = ensure_model(args.model, models_dir)
    if args.download_only:
        emit({"type": "result", "downloaded": True, "model": args.model, "path": path, "language": "", "words": [], "segments": []})
        return

    if not args.file or not os.path.isfile(args.file):
        fail("archivo-no-encontrado", "No encontré el archivo a transcribir.", str(args.file))

    from faster_whisper import WhisperModel

    progress(0.01, "Cargando el modelo de voz…")
    t0 = time.time()
    try:
        model = WhisperModel(path, device=args.device, compute_type=args.compute_type, cpu_threads=args.threads)
    except ValueError:
        # p. ej. int8 no soportado en ese dispositivo: reintento con el tipo por defecto.
        model = WhisperModel(path, device=args.device, compute_type="default", cpu_threads=args.threads)
    except Exception as e:  # noqa: BLE001
        fail("modelo-invalido", f"No se pudo cargar el modelo de voz «{args.model}». Vuelve a descargarlo con «pnpm instalar».", f"{type(e).__name__}: {e}")
    load_s = time.time() - t0

    terms = parse_hotwords(args.hotwords)
    language = None if args.language in ("", "auto") else args.language
    kwargs = dict(
        language=language,
        beam_size=args.beam_size,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200),
        # Reduce bucles/alucinaciones en clips largos.
        condition_on_previous_text=False,
        hotwords=", ".join(terms) if terms else None,
        initial_prompt=("Glosario: " + ", ".join(terms) + ".") if terms else None,
    )
    progress(0.03, "Transcribiendo…")
    t1 = time.time()
    try:
        segments, info = model.transcribe(args.file, **kwargs)
        duration = float(info.duration or 0) or 1.0
        words: list[dict] = []
        segs: list[dict] = []
        last_p = 0.0
        for s in segments:  # generador: la inferencia corre aquí
            first = len(words)
            for w in s.words or []:
                text = w.word.strip()
                if not text:
                    continue
                words.append({"text": text, "start": round(float(w.start), 3), "end": round(float(w.end), 3), "probability": round(float(w.probability), 4)})
            if len(words) > first:
                segs.append({"start": round(float(s.start), 3), "end": round(float(s.end), 3), "text": s.text.strip(), "firstWord": first, "lastWord": len(words) - 1})
            p = 0.03 + 0.96 * min(1.0, float(s.end) / duration)
            if p - last_p >= 0.02:
                last_p = p
                progress(p, f"Transcribiendo… {int(p * 100)} %")
    except Exception as e:  # noqa: BLE001
        fail("transcripcion-fallida", "Falló la transcripción del audio.", f"{type(e).__name__}: {e}")

    emit(
        {
            "type": "result",
            "language": info.language,
            "languageProbability": round(float(info.language_probability or 0), 3),
            "duration": round(float(info.duration or 0), 3),
            "model": args.model,
            "loadSeconds": round(load_s, 2),
            "transcribeSeconds": round(time.time() - t1, 2),
            "words": words,
            "segments": segs,
        }
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
