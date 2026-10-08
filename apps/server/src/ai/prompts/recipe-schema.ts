/**
 * Descripción compacta del esquema de la RECETA para los prompts de Claude.
 * Debe coincidir con `packages/shared/src/recipe.ts` (fuente de verdad). Es texto fijo: forma parte del
 * prefijo cacheado, así que no se le agregan datos variables.
 */
export const RECIPE_SCHEMA_GUIDE = `# Esquema de la receta (JSON)

Todos los tiempos en SEGUNDOS (decimales). "sourceIn/sourceOut" = tiempos dentro del archivo original.
"start/end" de las pistas superpuestas = tiempos en la línea de tiempo FINAL. Colores "#RRGGBB" o "#RRGGBBAA".
Los campos con valor por defecto se pueden omitir. Los ids son textos cortos únicos ("c1", "t-gancho"…).

{
  "format": { "aspect": "9:16"|"16:9"|"1:1"|"4:5", "width", "height", "fps": 30, "platform": "tiktok"|"reels"|"shorts"|"youtube"|"linkedin"|"generico" },
  "style": {
    "titleFont": FontRef, "bodyFont": FontRef,            // FontRef = { "family", "weight": 100-900, "assetId": id|null, "googleFont": nombre|null }
    "palette": { "primary", "secondary", "accent", "text", "background" },
    "defaultTransition": Transition,                      // Transition = { "type": "corte"|"fundido"|"fundido-negro"|"deslizar-izq"|"deslizar-der"|"zoom"|"barrido"|"desenfoque", "duration": 0-3 }
    "targetShotLength": segundos por plano (lento ~4, medio ~2.5, rápido ~1.5),
    "textCase": "original"|"mayusculas"|"titulo"
  },
  "tracks": {
    "video": [ VideoClip ],          // secuencia principal EN ORDEN; el servidor recalcula "start" y "duration"
    "overlays": [ OverlayItem ],     // b-roll, imágenes, resultados de IA y logo por encima de la secuencia
    "text": [ TextItem ],
    "graphics": [ GraphicItem ],     // motion graphics (plantillas)
    "captions": CaptionTrack,
    "audio": { "music": [ MusicItem ], "sfx": [ SfxItem ], "voiceover": [ VoiceItem ], "mix": { "targetLufs": -14, "duckingDb": -12, "voiceEnhance": false, "normalize": true } }
  },
  "ai": [ AiRequest ],
  "target": { "duration": segundos|null, "mode": "auto"|"aproximada"|"exacta" },
  "notes": "resumen editorial breve"
}

VideoClip = { "id", "assetId", "sourceIn", "sourceOut", "speed": 0.25-4 (1),
  "reframe": { "mode": "ajustar"|"llenar"|"fondo-desenfocado"|"seguir", "focusX": 0-1, "focusY": 0-1, "keyframes": [{ "t" (relativo al clip), "x", "y" }] },
  "zoom": null | { "from": 1-3, "to": 1-3, "start" (relativo al clip), "end": número|null, "ease": "lineal"|"suave"|"golpe" },
  "color": { "look": "natural"|"calido"|"frio"|"vivo"|"blanco-negro"|"cine", "brightness": -1..1, "contrast": 0-3, "saturation": 0-3 },
  "volume": 0-4 (1), "transitionIn": Transition (entrada desde el clip anterior), "stillDuration": segundos|null (solo fotos),
  "label": "", "reason": "por qué elegiste este fragmento (se muestra en el storyboard)" }

OverlayItem = { "id", "kind": "broll"|"imagen"|"ia-imagen"|"ia-video"|"logo", "assetId", "start", "end", "sourceIn" (dentro del archivo del overlay),
  "layout": "pantalla-completa"|"fondo-con-orador"|"pip-arriba-der"|"pip-arriba-izq"|"pip-abajo-der"|"pip-abajo-izq"|"mitad-superior"|"mitad-inferior",
  "opacity": 0-1, "kenBurns": true, "transition": Transition (fundido 0.25), "reason": "" }
  ("fondo-con-orador" = b-roll a pantalla completa y la persona que habla en un recuadro.)

TextItem = { "id", "kind": "titulo"|"cintillo"|"cta"|"palabra-clave"|"etiqueta", "text", "subtitle": "", "start", "end",
  "position": "centro"|"arriba"|"abajo"|"cintillo"|"arriba-izq"|"arriba-der", "font": FontRef|null, "fontSize": 12-300 (96, px sobre 1080 de ancho),
  "color": color|null, "background": color|null, "uppercase": bool|null, "animation": "ninguna"|"fundido"|"pop"|"subir"|"maquina-escribir"|"deslizar",
  "engine": "builtin"|"hyperframes" }

GraphicItem = { "id", "templateId", "engine": "hyperframes"|"builtin", "props": { ... según la plantilla }, "start", "end",
  "layout": "superpuesto"|"pantalla-completa", "renderedAssetId": null, "description": "" }

CaptionTrack = { "enabled": true, "style": CaptionStyle, "words": [] (LAS MATERIALIZA EL SERVIDOR: no las escribas),
  "overrides": { "índice de palabra": "texto corregido" }, "language": "es", "burnIn": true }
CaptionStyle = { "mode": "palabra"|"frase"|"bloque", "font": FontRef, "fontSize": 16-200 (72), "uppercase": bool, "primaryColor", "highlightColor",
  "outlineColor", "outlineWidth": 0-20, "background": "ninguno"|"caja"|"sombra", "boxColor", "position": "abajo"|"centro"|"arriba", "marginV": 0-800,
  "maxCharsPerLine": 8-60, "maxLines": 1-3, "emojis": bool, "animation": "ninguna"|"pop"|"fundido"|"rebote", "highlightKeywords": bool,
  "highlightStyle": "color"|"escala"|"caja" }

MusicItem = { "id", "assetId", "start": 0, "end": número|null, "sourceIn": 0, "gainDb": -60..12 (-16), "fadeIn": 0.5, "fadeOut": 1.5, "duck": true }
SfxItem = { "id", "assetId", "at", "gainDb": (-6), "kind": "whoosh"|"golpe"|"pop"|"subida"|"clic"|"otro", "origin": "biblioteca"|"usuario"|"ia" }
VoiceItem = { "id", "assetId", "start", "gainDb": 0, "text": "" }

AiRequest = { "id", "kind": "imagen"|"video"|"sfx"|"voz"|"musica", "provider": "kie", "model", "prompt", "negativePrompt": "", "params": {},
  "seed": entero|null, "status": "pendiente", "resultAssetId": null, "costUsd": número|null, "usage": "broll"|"fondo"|"portada"|"sfx"|"voz"|"musica",
  "placeAt": { "start", "end" } | null }
  (Usa la herramienta pedir_generacion_ia para crearlos: elige modelo y calcula el costo.)
`;
