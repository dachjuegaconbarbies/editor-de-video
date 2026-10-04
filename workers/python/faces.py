#!/usr/bin/env python3
"""Detección de rostros con OpenCV Haar (sin red, sin modelos externos).

Uso:
  python faces.py img1.jpg img2.jpg …          # rutas como argumentos
  python faces.py --list lista.txt             # una ruta por línea

Imprime UNA línea JSON por stdout:
  {"type": "result", "images": [{"path": "…", "width": 640, "height": 360,
     "faces": [{"x": 0.42, "y": 0.38, "w": 0.12, "h": 0.21, "size": 0.21, "score": 7}]}]}
Las coordenadas están normalizadas (0..1): x/y = centro del rostro, w/h = ancho/alto relativos,
size = alto del rostro relativo al alto de la imagen, score = vecinos que confirmaron la detección.
Los rostros se ordenan del más grande al más chico.
Errores: {"type": "error", "code": "…", "message": "…en español…"} y código de salida 2.

Usa la cascada `haarcascade_frontalface_default.xml` incluida en opencv-python-headless 4.x
(cv2.data.haarcascades). OpenCV 5 ya no la trae: por eso requirements.txt fija <5.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

MAX_SIDE = 960  # se reduce la imagen antes de detectar (más rápido y suficiente para rostros)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str, detail: str = "") -> None:
    emit({"type": "error", "code": code, "message": message, "detail": detail[:500]})
    sys.exit(2)


def load_cascades(cv2):
    if not hasattr(cv2, "CascadeClassifier") or not hasattr(cv2, "data"):
        fail(
            "opencv-sin-haar",
            "Esta versión de OpenCV no trae los clasificadores Haar. Corre «pnpm instalar» (instala opencv-python-headless 4.x).",
            getattr(cv2, "__version__", "?"),
        )
    base = cv2.data.haarcascades
    front = os.path.join(base, "haarcascade_frontalface_default.xml")
    alt = os.path.join(base, "haarcascade_frontalface_alt2.xml")
    if not os.path.isfile(front):
        fail("opencv-sin-haar", "No se encontró la cascada Haar de rostros. Corre «pnpm instalar».", front)
    cascades = [cv2.CascadeClassifier(front)]
    if os.path.isfile(alt):
        cascades.append(cv2.CascadeClassifier(alt))
    return cascades


def detect(cv2, cascades, path: str) -> dict:
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return {"path": path, "width": 0, "height": 0, "faces": [], "error": "No se pudo leer la imagen"}
    h0, w0 = img.shape[:2]
    scale = 1.0
    if max(h0, w0) > MAX_SIDE:
        scale = MAX_SIDE / float(max(h0, w0))
        img = cv2.resize(img, (int(round(w0 * scale)), int(round(h0 * scale))), interpolation=cv2.INTER_AREA)
    h, w = img.shape[:2]
    gray = cv2.equalizeHist(img)
    min_side = max(24, int(min(w, h) * 0.05))
    found = []
    for casc in cascades:
        rects, _levels, weights = casc.detectMultiScale3(
            gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_side, min_side), outputRejectLevels=True
        )
        for (x, y, fw, fh), score in zip(rects, weights):
            found.append((int(x), int(y), int(fw), int(fh), float(score)))
        if found:
            break  # la cascada principal ya encontró algo; la alternativa solo es respaldo
    # Supresión simple de duplicados (rectángulos muy solapados).
    found.sort(key=lambda r: r[2] * r[3], reverse=True)
    kept: list[tuple[int, int, int, int, float]] = []
    for r in found:
        if all(_iou(r, k) < 0.4 for k in kept):
            kept.append(r)
    faces = [
        {
            "x": round((x + fw / 2) / w, 4),
            "y": round((y + fh / 2) / h, 4),
            "w": round(fw / w, 4),
            "h": round(fh / h, 4),
            "size": round(fh / h, 4),
            "score": round(score, 3),
        }
        for (x, y, fw, fh, score) in kept[:8]
    ]
    return {"path": path, "width": w0, "height": h0, "faces": faces}


def _iou(a, b) -> float:
    ax, ay, aw, ah = a[:4]
    bx, by, bw, bh = b[:4]
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description="Detección de rostros (OpenCV Haar) → JSON")
    ap.add_argument("images", nargs="*", help="Rutas de imágenes")
    ap.add_argument("--list", help="Archivo con una ruta de imagen por línea")
    args = ap.parse_args()
    paths = list(args.images)
    if args.list:
        with open(args.list, encoding="utf-8") as f:
            paths += [line.strip() for line in f if line.strip()]
    if not paths:
        fail("sin-imagenes", "No se recibieron imágenes para buscar rostros.")
    try:
        import cv2
    except Exception as e:  # noqa: BLE001
        fail("falta-opencv", "Falta OpenCV en el entorno de Python. Corre «pnpm instalar».", f"{type(e).__name__}: {e}")
    cascades = load_cascades(cv2)
    results = [detect(cv2, cascades, p) for p in paths]
    emit({"type": "result", "opencv": cv2.__version__, "images": results})


if __name__ == "__main__":
    main()
