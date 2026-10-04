# Kie AI (kie.ai): investigación para el adaptador de IA generativa

> **Fecha:** 2026-10-04 · **Para:** el ingeniero que implementa la capa `providers/kie` del autoeditor (imágenes, video, música, voz y SFX con IA; ver `PROMPT.md` §4.4 y §7).
> **Estado:** investigación de escritorio, más código TypeScript compilado y probado **contra un servidor simulado**. **No se hizo ninguna llamada real a Kie**: el contenedor no llega a `kie.ai` y no hay `KIE_API_KEY` (ver §10).
> Todo lo marcado **NO VERIFICADO** hay que confirmarlo con la primera llamada real. La receta para hacerlo en local (Warp) está en §11.

> **Revisión crítica (2026-10-04).** Cambios marcados con **[REVISIÓN]**:
> - **Bug corregido en el adaptador (§9.2):** reintentaba `createTask` ante errores de red o timeout, con riesgo de **doble cobro**. Corregido y probado contra el mock.
> - **Riesgo con Suno (§9.2):** la `callBackUrl` placeholder podría dejar la tarea en `CALLBACK_EXCEPTION` aunque el audio exista. Ahora se acepta como éxito si hay `audio_url` (NO VERIFICADO con la API).
> - **Hueco: la skill de Kie (`npx skills add https://kie.ai`, `PROMPT.md` §4.4) no estaba investigada.** Según el código del CLI `skills@1.7.0` (`dist/cli.mjs`), con una URL que no es de git el CLI busca `https://kie.ai/.well-known/agent-skills/index.json` (o `/.well-known/skills/`) y, si no existe, intenta descarga directa. **Qué instala está NO VERIFICADO**: `kie.ai` está bloqueado aquí y la búsqueda web no dio nada. Hay que tener claro que es una skill **para agentes** (Claude Code/Warp), no código que use la app en runtime: el adaptador de §9 no depende de ella. `scripts/setup.mjs` la corre con `--yes` pero sin `-a claude-code`, así que probablemente termina solo en `.agents/skills/`, con el mismo problema que HyperFrames (`skills-remotion-warp.md` §5.6). Además, no queda registrada en `skills-lock.json` (hoy solo tiene `heygen-com/hyperframes`).
> - **Faltan variables en `.env.example`** para lo que usa este documento: `KIE_CALLBACK_URL` (URL pública de callbacks; vacía = solo polling) y `KIE_WEBHOOK_HMAC_KEY` (para `verifyKieWebhook`).
> - Sigue sin haber **ninguna llamada real** a Kie: todo lo demás conserva su etiqueta original.

---

## 0. Resumen (lo que hay que saber antes de programar)

1. **Autenticación:** `Authorization: Bearer <KIE_API_KEY>` y `Content-Type: application/json`. URL base `https://api.kie.ai`. Las subidas de archivos van a otro host, `https://kieai.redpandaai.co`. [DOC-GS]
2. **Envoltorio de respuesta:** siempre `{ code, msg, data }`. Kie puede responder **HTTP 200 con `code` ≠ 200** (por ejemplo `{"code":402,"msg":"..."}`), así que el error hay que detectarlo en las dos capas. [DOC-GS][PKG]
3. **Tres "familias" de API asíncrona.** Cada una crea, consulta y entrega el resultado de forma distinta:
   - **Market** (la mayoría de modelos): `POST /api/v1/jobs/createTask {model, input, callBackUrl?}` → `GET /api/v1/jobs/recordInfo?taskId=` → `state ∈ waiting|queuing|generating|success|fail`, y el resultado sale de `JSON.parse(resultJson).resultUrls[]`. [DOC-TASK]
   - **Veo 3.1:** `POST /api/v1/veo/generate` (cuerpo plano) → `GET /api/v1/veo/record-info` → `successFlag 0/1/2/3` → `response.resultUrls[]`. [DOC-VEO][PKG]
   - **Suno** (música y efectos "sounds"): `POST /api/v1/generate` o `/api/v1/generate/sounds` → `GET /api/v1/generate/record-info` → `status PENDING…SUCCESS` → `response.sunoData[].audio_url`. [DOC-SUNO][PKG]
4. **Las URLs de resultado expiran (~24 h): hay que descargarlas de inmediato** a nuestro almacenamiento. Los archivos subidos a Kie se borran a los **3 días**. [DOC-TASK][DOC-UP]
5. **Límite de uso:** 20 tareas nuevas cada 10 s por cuenta (más de 100 en paralelo). Si se pasa, Kie responde 429. Códigos clave: 401 llave, **402 sin créditos**, 422 validación, 429 límite, 455 mantenimiento, 500 error de servidor, 501 generación fallida. [DOC-GS]
6. **Saldo:** `GET /api/v1/chat/credit` → `data` = créditos restantes (número). [DOC-CREDIT]
7. **1 crédito = 0.005 USD** (1000 créditos = 5 USD). Lo confirma el endpoint público de precios: `usdPrice/creditPrice = 0.005` en todas las filas. [PRICE-API][reseñas]
8. **Los precios y los esquemas cambian cada semana.** Las fuentes se contradicen en varios modelos (§7.3). Kie expone **descubrimiento en vivo**: `GET /api/v1/models`, `/api/v1/models/{model}/schema`, `/price` y `/success-rate` (con llave). También existe un endpoint público de precios, `POST /client/v1/model-pricing/page` (sin llave). Úsalos para sincronizar `kie-models.json`, no para codificar precios a mano. [DOC-MODELS][PKG]
9. **El costo real lo da `creditsConsumed` en `recordInfo`** (familia Market). El estimado sale de la configuración (§8). Para Veo y Suno no hay ese campo documentado, así que el costo se reconstruye con la diferencia de saldo (NO VERIFICADO).
10. **Nunca reenvíes `createTask` para "reintentar" una tarea viva:** se cobra dos veces. El `taskId` se persiste **antes** de empezar a consultar. Las tareas fallidas no se cobran, según la documentación y las reseñas (NO VERIFICADO de primera mano).
11. **SFX:** `elevenlabs/sound-effect-v2` **probablemente está retirado**: no aparece en la lista de precios del 2026-09-25, y kie-mcp reporta que createTask lo acepta pero la tarea falla con 500. El SFX principal propuesto es **Suno Sounds** (`/api/v1/generate/sounds`). **Sora 2 ya no está disponible** (según kie-mcp: "OpenAI API sunset Sept 2026").
12. **Recomendación:** escribir un **adaptador propio, delgado y sin dependencias** (código verificado en §9) que lea los modelos de `kie-models.json`. `@apicity/kie` (MIT, Zod) es una alternativa, pero sus esquemas a veces contradicen otras fuentes.

---

## 1. Fuentes y cómo leer este documento

**Acceso desde el contenedor:** `curl` a `api.kie.ai`, `docs.kie.ai` y `kie.ai` responde `CONNECT tunnel failed, response 403` (política del proxy). `WebFetch` a `docs.kie.ai` y `kie.ai` responde `EGRESS_BLOCKED`. Lo que **sí** funcionó:

| Etiqueta | Fuente | Qué aporta | Fiabilidad |
|---|---|---|---|
| **[DOC-…]** | Páginas oficiales de `docs.kie.ai`, leídas como resúmenes de **WebSearch (modo extended)**. No se vio el HTML crudo | Auth, códigos, estados, retención, firmas de webhooks, ejemplo curl de Veo | Alta, pero es un resumen de un motor de búsqueda |
| **[PRICE-API 2026-09-25]** | Snapshot de `POST https://api.kie.ai/client/v1/model-pricing/page` (el endpoint que usa la página kie.ai/pricing), guardado en `@nodetool-ai/kie-nodes@0.8.1` → `dist/generated/kie-unit-pricing.json` (`writtenAt: 2026-09-25T16:12:22Z`, 144 modelos) | Precio **mínimo** por modelo (tier más barato), unidad y USD | Alta para el mínimo. El desglose por tier no viene |
| **[PKG:kie-mcp]** | `kie-mcp@5.3.0` (2026-09-28): servidor MCP con tablas de precios, varias **medidas con llamadas reales** (fechas en comentarios) y reglas de error y reintento | Precios empíricos, peculiaridades de la API, taxonomía de errores | Media-alta. Algunos precios están desactualizados |
| **[PKG:apicity]** | `@apicity/kie@0.13.2` (2026-10-02, MIT): SDK TypeScript con esquemas Zod por modelo; algunos ejemplos se reprodujeron contra grabaciones HAR reales | Esquemas de campos, endpoints de descubrimiento, webhook HMAC | Media-alta |
| **[PKG:uxdata]** | `@uxdata-co/kie@0.8.0` (2026-09-07), `skills/kie-media/references/kie-api.md` | Resumen de la API y precios de lista del 2026-08-30 | Media |
| **[PKG:babylon]** | `@babylonjs-toolkit/kie@1.0.1` (2026-09-19), `docs/sound-research.md` (revisado contra docs oficiales el 2026-09-05) | Suno sounds/music, TTS ElevenLabs | Media-alta |
| **[PKG:otros]** | `dainami-kie-mcp@0.5.3`, `@ulmeanuadrian/kie-mcp@0.3.0`, `gcv-kie@0.5.0`, `kie-media-cli@0.3.1`, `@felores/kie-ai-mcp-server@5.0.0`, `dsh-kie-credit-monitor@0.1.0` | Validación cruzada | Media |
| **[reseñas]** | aisofting.com, aireiter.com, bitdoze.com (reseñas 2026) | Paquetes de créditos y bono | Baja-media |

Las URLs están en §13.

---

## 2. Autenticación, hosts, formato de respuesta y errores

### 2.1 Hosts y headers

| Uso | Host | Auth |
|---|---|---|
| API (tareas, saldo, modelos) | `https://api.kie.ai` | `Authorization: Bearer $KIE_API_KEY` + `Content-Type: application/json` [DOC-GS] |
| Subida de archivos | `https://kieai.redpandaai.co` | `Authorization: Bearer $KIE_API_KEY` (multipart o JSON) [DOC-UP][PKG:dainami] |
| CDN de resultados (observado) | `tempfile.aiquickdraw.com`, `tempfile.redpandaai.co` | **Sin** header de auth: no mandes la llave a la CDN [PKG:apicity][PKG:babylon] |
| Precios públicos | `POST https://api.kie.ai/client/v1/model-pricing/page` | Sin llave. Endpoint interno de la web, **no documentado oficialmente** [PKG:gcv-kie][PKG:kie-media-cli] |

La llave se crea en `https://kie.ai/api-key`. Según la documentación, la consola permite poner **topes por llave** (por hora, día y total) y **lista blanca de IPs**. [DOC-GS] Para el servidor de producción conviene una llave propia con tope.

### 2.2 Envoltorio

```json
{ "code": 200, "msg": "success", "data": { "taskId": "..." } }
```

- `code` ≠ 200 es error **aunque el HTTP sea 200**. También puede llegar un HTTP 4xx o 5xx con el mismo envoltorio. [PKG:uxdata][PKG:apicity][PKG:nodetool]
- Un 502 del gateway puede llegar como **HTML**, y `recordInfo` a veces devuelve cuerpo **no JSON** en estados intermedios. Hay que parsear con `try/catch` y tratarlo como transitorio. [PKG:kie-mcp][PKG:nodetool]

### 2.3 Códigos de error y política de reintento

| code | Significado [DOC-GS] | ¿Reintentar? |
|---|---|---|
| 200 | OK | n/a |
| 400 | Violación de política de contenido / "English prompts only" | No: cambiar el prompt |
| 401 | Llave inválida | No |
| **402** | **Créditos insuficientes** | No: avisar "recarga Kie" y pausar la cola |
| 404 | Recurso no encontrado | No |
| 422 | Validación (campos, `record is null`, modelo no soportado) | No: corregir entrada. En la doc de upload, una URL externa devuelve 422 |
| **429** | **Límite de tasa** | Sí, con backoff (2 s, 5 s, 10 s…) |
| 433 | Límite de sub-llave (solo [PKG:kie-mcp]; NO VERIFICADO en doc) | Sí, con backoff |
| 455 | Mantenimiento | Sí, con backoff largo |
| 500 | Error de servidor o timeout. **Ojo:** Kie también lo usa para errores de validación ("is required", "not within the range of allowed options") [PKG:kie-mcp] | Sí, salvo que el `msg` indique validación |
| 501 | Generación fallida | No reenviar igual; quizá con otros parámetros |
| 505 | Función deshabilitada ([PKG:kie-mcp][PKG:nodetool]; NO VERIFICADO en doc) | No |

**Cobro:** el costo se genera al crear la tarea. Consultar es gratis. kie-mcp observó créditos **retenidos al enviar y reembolsados** cuando la tarea falló río arriba. **Regla:** un error HTTP *explícito* (con envoltorio `{code,msg}`) *al crear* no generó `taskId`, así que se puede reintentar. Un error *al consultar* no mata la tarea, así que se sigue consultando y nunca se reenvía. [PKG:dainami][PKG:kie-mcp] **[REVISIÓN]** Una falla de red o un timeout *al crear* es ambigua: la petición pudo llegar. No se reintenta en automático (ver §9.2).

### 2.4 Límites de tasa

- **20 creaciones cada 10 s por cuenta**, normalmente más de 100 tareas corriendo en paralelo. Si se excede, 429. [DOC-GS]
- Los 4 endpoints `/api/v1/models*` comparten **1 petición por segundo** por cuenta. [PKG:apicity]
- Recomendación: un semáforo de creaciones (por ejemplo 4–8 simultáneas; kie-mcp usa 4 por defecto porque la tasa de fallos subió con el paralelismo) y un *token bucket* de 20/10 s.

### 2.5 Saldo

```bash
curl -s https://api.kie.ai/api/v1/chat/credit -H "Authorization: Bearer $KIE_API_KEY"
# → {"code":200,"msg":"success","data":100}    (data = créditos restantes)
```

[DOC-CREDIT] (lo confirman también `dsh-kie-credit-monitor` y `@apicity/kie`).

---

## 3. API "Market" genérica (jobs)

### 3.1 Crear tarea

```bash
curl -s -X POST https://api.kie.ai/api/v1/jobs/createTask \
  -H "Authorization: Bearer $KIE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-2",
    "input": { "prompt": "taza de café humeante, luz de mañana", "aspect_ratio": "9:16", "resolution": "1K" },
    "callBackUrl": "https://mi-servidor/api/kie/callback"
  }'
# → {"code":200,"msg":"success","data":{"taskId":"task_..."}}
```

- `model`: slug exacto del market. **Ojo, los nombres no son uniformes:** `nano-banana-2` no lleva prefijo, `google/nano-banana` sí; `kling-3.0/video` frente a `kling/v3-turbo-text-to-video`. La URL de la doc puede no coincidir con el slug (por ejemplo `/market/google/pro-image-to-image` corresponde a `nano-banana-pro`). [PKG:dainami] Guarda siempre el slug exacto en configuración y valídalo con `GET /api/v1/models`.
- `input`: específico de cada modelo (§6).
- `callBackUrl`: opcional en Market. [DOC-MARKET]

### 3.2 Consultar estado

```bash
curl -s "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_..." -H "Authorization: Bearer $KIE_API_KEY"
```

```jsonc
// Ejemplo ILUSTRATIVO: los campos son los de [DOC-TASK]; los valores son inventados
{
  "code": 200, "msg": "success",
  "data": {
    "taskId": "task_...", "model": "nano-banana-2",
    "state": "success",                 // waiting | queuing | generating | success | fail
    "param": "{...}",                    // eco del cuerpo enviado (string JSON)
    "resultJson": "{\"resultUrls\":[\"https://tempfile.aiquickdraw.com/....png\"]}",  // STRING: hay que parsearlo
    "failCode": null, "failMsg": null,
    "costTime": 9000, "createTime": 1759570000000, "completeTime": 1759570009000, "updateTime": 1759570009000,
    "progress": 100,
    "creditsConsumed": 8                 // costo real en créditos
  }
}
```

- Estados `waiting | queuing | generating | success | fail`. Campos de la doc: `taskId, model, state, param, resultJson, failCode, failMsg, costTime, completeTime, createTime, updateTime, progress, creditsConsumed`. [DOC-TASK]
- `resultJson` suele ser un **string JSON** y a veces llega como objeto. Hay que aceptar los dos casos. Algunos modelos añaden `resultObject` (por ejemplo máscaras de OmniHuman). [PKG:dainami][PKG:kie-mcp]
- Ejemplo real de URL de un video Kling 3.0, grabado en HAR: `https://tempfile.aiquickdraw.com/k/<taskId>_1_<ts>_<n>.mp4`. En ese caso el trabajo tardó unos 127 s. [PKG:apicity]
- **Cadencia recomendada por la doc:** empezar con 2–3 s, backoff exponencial, rendirse a los 10–15 min, preferir callbacks en producción y descargar de inmediato porque las URLs expiran en ~24 h. [DOC-TASK] Para video, usar 15–20 min de presupuesto (kie-mcp usa 900 s).

### 3.3 Callbacks (webhooks)

- Kie hace `POST` a `callBackUrl` cuando la tarea termina. El cuerpo tiene la forma de `recordInfo` (el `taskId` puede venir en `taskId`, `data.taskId` o `data.task_id`). [PKG:dainami][PKG:apicity] La forma exacta por familia está **NO VERIFICADA**.
- **Verificación HMAC** (hay que activarla en Settings y generar la `webhookHmacKey`). [DOC-WH]
  - Headers: `X-Webhook-Timestamp` (segundos Unix) y `X-Webhook-Signature`.
  - Firma: `base64( HMAC-SHA256( taskId + "." + timestamp, webhookHmacKey ) )`.
  - Implementación en §9 (`verifyKieWebhook`), verificada contra la de `@apicity/kie`.
- **En local (sin URL pública) se usa polling.** En servidor se usan callbacks más un polling de respaldo lento, por si un callback se pierde.

### 3.4 Otras utilidades comunes

| Endpoint | Para qué | Fuente |
|---|---|---|
| `POST /api/v1/common/download-url` `{ "url": "<url generada por kie>" }` → `data` = URL temporal | Convierte una URL generada por Kie en un enlace descargable válido **20 min**. Solo sirve para archivos generados por Kie: una URL externa da 422 | [DOC-DL] |
| `GET /api/v1/models[?taskType=Text%20to%20Image&provider=Kling&q=...]` | Catálogo vivo: `data.models[] = {model, slug, title, provider, taskType[], description, pricingDesc}` | [DOC-MODELS][PKG:apicity] |
| `GET /api/v1/models/{model}/schema` | Documento OpenAPI 3.1 del modelo (`data.openapi`, o `null` si no está sincronizado) | [DOC-MODELS][PKG:apicity] |
| `GET /api/v1/models/{model}/price` | `data.pricingDesc`: precio en **prosa**, no numérico | [DOC-MODELS][PKG:apicity] |
| `GET /api/v1/models/{model}/success-rate` | Tasa de éxito de las últimas 24 h en tramos de 10 min (`points[]`). Útil para elegir modelo de respaldo | [DOC-MODELS][PKG:apicity] |
| `POST /client/v1/model-pricing/page` `{pageNum, pageSize≤100}` (sin auth) | Lista pública de precios: `data.records[] = {modelDescription, creditPrice, creditUnit, usdPrice, anchor, interfaceType, provider}`, `data.total`, `data.pages`. El slug viene a veces en `anchor` (`?model=...`) | [PKG:gcv-kie][PKG:kie-media-cli]; **no documentado** |

Valores de `taskType` vistos: `Text to Video, Image to Video, Image Editing, Text to Image, Image to Image, Speech to Video, Text to Speech, Lip Sync, Video to Video, Text to Music, Audio to Audio, Chat, Video Editing`. [PKG:apicity]

---

## 4. Subida de archivos (referencias: fotos del usuario, primer frame, audio)

Los modelos reciben **URLs públicas**, no bytes. Para usar un archivo local hay que subirlo primero. [DOC-UP][PKG:apicity]

| Endpoint (host `kieai.redpandaai.co`) | Cuerpo | Notas |
|---|---|---|
| `POST /api/file-stream-upload` | multipart: `file`, `uploadPath`, `fileName?` | Recomendado para más de 10 MB |
| `POST /api/file-url-upload` | JSON `{fileUrl, uploadPath, fileName?}` | Kie descarga la URL |
| `POST /api/file-base64-upload` | JSON `{base64Data, uploadPath, fileName?}` | Solo para archivos pequeños |

- Respuesta (doc): `fileId, fileName, originalName, fileSize, mimeType, uploadPath, fileUrl, downloadUrl, uploadTime, expiresAt`. `@apicity/kie` usa `data.downloadUrl`; otros clientes usan `fileUrl`. Toma el primero que exista. [DOC-UP][PKG]
- **Se borran a los 3 días** (`expiresAt`). Si `fileName` coincide con uno existente, **lo sobrescribe**: usa nombres únicos (hash). [DOC-UP]
- Hay que cachear `(sha256 del archivo → url, expiresAt)` por proyecto y volver a subir si expiró.
- Las imágenes deben servirse con el `Content-Type` correcto. kie-mcp lo reporta como causa de fallos en Veo I2V.

---

## 5. APIs dedicadas

### 5.1 Veo 3.1 (Google): `veo3`, `veo3_fast`, `veo3_lite`

```bash
curl -s -X POST https://api.kie.ai/api/v1/veo/generate \
  -H "Authorization: Bearer $KIE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "prompt": "plano cenital de una ciudad al amanecer", "model": "veo3_fast",
        "aspect_ratio": "9:16", "generationType": "TEXT_2_VIDEO",
        "enableTranslation": true, "callBackUrl": "https://mi-servidor/api/kie/callback" }'
```

- **Cuerpo plano** (sin `input`). `model` es obligatorio en el cuerpo: sin él, Kie responde 422 "Invalid model". [PKG:ulmeanuadrian]
- Campos (doc): `prompt, imageUrls[], model, watermark, callBackUrl, aspect_ratio, seeds, enableFallback, enableTranslation, generationType`. [DOC-VEO] `@apicity/kie` añade `resolution` (`720p|1080p|4k`) y `duration` (`4|6|8`). La doc confirma 4/6/8 s y salidas 1080P/4K (4K cuesta créditos extra). [DOC-VEO][PKG:apicity]
- `generationType`: `TEXT_2_VIDEO`, `FIRST_AND_LAST_FRAMES_2_VIDEO` (1–2 imágenes en `imageUrls`) y `REFERENCE_2_VIDEO` (solo Fast y Lite). [DOC-VEO] El máximo de imágenes de referencia está **NO VERIFICADO**.
- `aspect_ratio`: `16:9 | 9:16 | Auto`. **Conflicto:** el curl actual de la doc usa `aspect_ratio` (snake_case), igual que kie-mcp y babylon; `@apicity/kie` y versiones anteriores usaban `aspectRatio`. **Usar `aspect_ratio`.** Si un video sale 16:9 cuando pediste 9:16, revisa `paramJson` en el record y prueba `aspectRatio`. **NO VERIFICADO**.
- Estado: `GET /api/v1/veo/record-info?taskId=` → `data.successFlag` (0 generando, 1 éxito, 2 CREATE_TASK_FAILED, 3 GENERATE_FAILED), `data.response.resultUrls[]` (más `originUrls`, `fullResultUrls`, `resolution`), `data.errorCode` y `data.errorMessage`. dainami dice que `resultUrls` puede venir como string JSON: el normalizador de §9 acepta ambos.
- Extras: `GET /api/v1/veo/get-1080p-video?taskId=&index=` responde `code 500` **mientras procesa** y `200 + data.resultUrl` al terminar. `POST /api/v1/veo/get-4k-video {taskId, index?, callBackUrl?}` responde `422` **tanto procesando como al terminar**; la URL viene en `data.resultUrls`. Son peculiaridades documentadas por kie-mcp. `POST /api/v1/veo/extend {taskId, prompt, model: fast|quality, seeds?, watermark?, callBackUrl?}`. [PKG:kie-mcp][PKG:apicity]
- Consejo de kie-mcp: en I2V incluye una pista de sonido en el prompt ("SFX: room tone"), porque Veo a veces falla el pase de audio sin ella. NO VERIFICADO.

### 5.2 Suno: música (`/api/v1/generate`) y efectos (`/api/v1/generate/sounds`)

**Música:**

```bash
curl -s -X POST https://api.kie.ai/api/v1/generate \
  -H "Authorization: Bearer $KIE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "prompt": "lo-fi cálido para vlog de viajes, sin voz", "model": "V5",
        "customMode": false, "instrumental": true,
        "callBackUrl": "https://mi-servidor/api/kie/callback" }'
```

- Campos: `prompt, model (V4|V4_5|V4_5PLUS|V4_5ALL|V5|V5_5; @apicity añade V3_5), customMode, instrumental, callBackUrl`, y opcionalmente `style, title (≤80), negativeTags, vocalGender (m|f), styleWeight, weirdnessConstraint, audioWeight (0–1), personaId`. [PKG:apicity][PKG:babylon][DOC-SUNO]
- **`callBackUrl` es obligatorio en el esquema** aunque se haga polling. Si no hay servidor público, se manda una URL propia o un placeholder y se consulta igual. [PKG:babylon][PKG:kie-mcp]
- Límites según babylon (revisado contra la doc): `prompt` ≤ 3000 (no custom, o V4 custom) y ≤ 5000 (custom, no V4); `style` ≤ 200 (V4) o ≤ 1000. `duration` (10–360 s) **solo en V5_5 con customMode** (NO VERIFICADO). Normalmente devuelve **2 pistas**.
- Estado: `GET /api/v1/generate/record-info?taskId=` → `data.status`: `PENDING → TEXT_SUCCESS → FIRST_SUCCESS → SUCCESS`. Son terminales con error `CREATE_TASK_FAILED`, `GENERATE_AUDIO_FAILED`, `CALLBACK_EXCEPTION` y `SENSITIVE_WORD_ERROR`. Las URLs están en `data.response.sunoData[].audio_url` (snake_case actual; `audioUrl` en respuestas antiguas). No uses las URLs de *streaming*: espera a `SUCCESS`. [PKG:babylon][PKG:kie-mcp][PKG:dainami]
- Otras operaciones (wav, mp4, midi, vocal-removal) tienen **su propio** `.../record-info` con `successFlag: "SUCCESS"`. [PKG:kie-mcp]

**Efectos / ambientes / loops (SFX):**

```bash
curl -s -X POST https://api.kie.ai/api/v1/generate/sounds \
  -H "Authorization: Bearer $KIE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "prompt": "whoosh corto y limpio para transición, 0.5 segundos", "model": "V5", "soundLoop": false }'
```

- Campos: `prompt` (≤ 500), `model` (`V5|V5_5`), `soundLoop`, `soundTempo` (1–300 BPM), `soundKey` (`C…B` y menores `Cm…Bm`; omitir para cualquiera), `grabLyrics`, `callBackUrl?` (opcional). [PKG:apicity][PKG:babylon][DOC-SUNO]
- **No hay control exacto de duración.** La duración deseada se pone en el texto del prompt y luego **se recorta con ffmpeg**.
- Se consulta igual que la música (`/api/v1/generate/record-info`). La doc recomienda consultar cada ~30 s. [PKG:babylon]

### 5.3 Runway

- `POST /api/v1/runway/generate {prompt (≤1800), duration: 5|10, quality: "720p"|"1080p", imageUrl?, aspectRatio? (16:9|4:3|1:1|3:4|9:16, obligatorio sin imageUrl), waterMark?, callBackUrl?}`. 10 s no es compatible con 1080p. [PKG:apicity]
- Estado: `GET /api/v1/runway/record-detail?taskId=` → `data.state`, `data.videoInfo.videoUrl`, `failCode/failMsg`, `expireFlag`. [PKG:apicity][PKG:kie-mcp]

### 5.4 APIs "legacy" dedicadas de imagen (no recomendadas para empezar)

- **Flux Kontext:** `POST /api/v1/flux/kontext/generate {prompt, model: flux-kontext-pro|flux-kontext-max, aspectRatio, inputImage?, outputFormat, promptUpsampling, safetyTolerance 0–6, enableTranslation}` → `GET /api/v1/flux/kontext/record-info` (`successFlag`). [PKG:apicity][PKG:kie-mcp]
- **GPT-4o Image:** `POST /api/v1/gpt4o-image/generate {prompt?, filesUrl[] ≤5, size: 1:1|3:2|2:3, maskUrl?, isEnhance?, enableFallback?}` → `GET /api/v1/gpt4o-image/record-info` (`successFlag`, `status`, `response.resultUrls`). [PKG:apicity] Para texto en imagen conviene más `gpt-image-2-*` en Market.

### 5.5 Voz (TTS), en Market

- `elevenlabs/text-to-speech-multilingual-v2` y `elevenlabs/text-to-speech-turbo-2-5`. `input`: `text` (≤ 5000, obligatorio), `voice` (**obligatorio en la práctica**: sin él Kie responde 422 "voiceId cannot be empty"), `stability` (0–1, 0.5), `similarity_boost` (0–1, 0.75), `style` (0–1, 0), `speed` (0.7–1.2, 1), `timestamps` (bool), `previous_text`, `next_text`, `language_code`. [PKG:apicity][PKG:uxdata][PKG:kie-mcp]
- **Voces:** Kie solo acepta un **catálogo curado** (unas 67 voces, por nombre o ID). Un ID arbitrario de ElevenLabs falla con "This voice is not within the range of allowed options". Voz por defecto documentada: James, `EkK5I93UQWFDigLMpZcX`. [PKG:kie-mcp][PKG:babylon] Para español se recomienda Multilingual v2. Elegir la voz probando.
- `language_code`: **conflicto.** babylon dice que solo funciona en Turbo 2.5 (en Multilingual v2 "falla"); kie-mcp lo manda solo a Multilingual v2. **NO VERIFICADO.**
- `timestamps: true` podría servir para subtitular la voz en off. Formato **NO VERIFICADO**.
- `google/gemini-3-1-flash-tts` (también `google/gemini-2-5-pro-tts`): `input = { speakers: [{speaker_id, voice_name}], dialogue_turns: [{speaker_id, text}], scene?, sample_context?, temperature? (0–2) }`, máximo 2 hablantes, unas 30 voces con nombre (por ejemplo `Zephyr`). [PKG:apicity][PKG:kie-mcp]
- El resultado viene en `resultUrls` (mp3 o wav).

### 5.6 Efectos con ElevenLabs y Sora: estado

- `elevenlabs/sound-effect-v2` (`input: {text, loop?, prompt_influence?, output_format?}` según [PKG:apicity]). La página de marketing `kie.ai/.../elevenlabs-sound-effect` sigue indexada, pero **no aparece en [PRICE-API 2026-09-25]** y kie-mcp 5.3.0 dice: "createTask still accepts the slug but every generation fails server-side with code 500, and the docs page is gone". → **Queda deshabilitado en la configuración (`enabled: false`)** hasta probarlo con una llamada real.
- **Sora 2:** kie-mcp 5.3.0: "Sora 2 family removed (OpenAI API sunset Sept 2026)". No aparece en [PRICE-API]. No se incluye.

---

## 6. Parámetros clave por modelo

Leyenda: **T2I/T2V** = texto a imagen o video, **I2V** = imagen a video, **ref** = imágenes de referencia, **neg** = negative prompt. Los esquemas salen de [PKG:apicity] y se cruzaron con [PKG:kie-mcp] y [PKG:uxdata]. **(!) = conflicto entre fuentes.** Para cualquier modelo, la verdad final es `GET /api/v1/models/{model}/schema`.

### 6.1 Imagen (todos en Market)

| Modelo (`model`) | Aspect ratio (`aspect_ratio`) | Resolución | Seed / neg | Referencias | Notas |
|---|---|---|---|---|---|
| `nano-banana-2` | 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9, auto (por defecto auto) | `resolution` 1K/2K/4K (1K) | no / no | `image_input[]` ≤ 14 | prompt ≤ 20000; `output_format` png/jpg; `google_search` (bool) [uxdata] |
| `nano-banana-2-lite` | igual que nano-banana-2 | n/a | no / no | `image_urls[]` ≤ 10 | el más barato de la familia |
| `nano-banana-pro` | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, auto | 1K/2K/4K | no / no | `image_input[]` | calidad alta para portadas |
| `google/nano-banana` / `google/nano-banana-edit` | 1:1, 9:16, 16:9, 3:4, 4:3, 3:2, 2:3, 5:4, 4:5, 21:9, auto | n/a | no / no | edit: `image_urls[]` 1–10 (obligatorio) | (!) kie-mcp manda `image_size` (campo antiguo, todavía aceptado) |
| `google/imagen4-fast` | 1:1, 16:9, 9:16, 3:4, 4:3, auto (16:9) | n/a | `seed` **entero** / `negative_prompt` ≤ 5000 | no | buena reproducibilidad (seed) |
| `google/imagen4`, `google/imagen4-ultra` | igual (1:1) | n/a | `seed` **string** ≤ 500 / `negative_prompt` | no | (!) el tipo de seed difiere de fast |
| `seedream/4.5-text-to-image`, `seedream/5-lite-text-to-image` | 1:1, 4:3, 3:4, 16:9, 9:16, 2:3, 3:2, 21:9 | `quality` basic (2K) / high (4K), **obligatorio** | no / no | edit: `image_urls[]` ≤ 14 | prompt 3–3000 |
| `gpt-image-2-text-to-image` | auto, 1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 9:16, 16:9, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21 | 1K/2K/4K (auto solo 1K; 1:1 sin 4K) | no / no | i2i: `input_urls[]` ≤ 16 | el mejor para **texto dentro de la imagen** |
| `gpt-image-2-5-flare-text-to-image` | auto, 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9, 27:16, 16:27, 9:8, 8:9 | 1K/2K/4K (1K) | no / no | i2i: `input_urls[]` | `background` transparent/opaque/auto (PNG con alfa: útil para overlays) |
| `flux-2/pro-text-to-image` | 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3 (**obligatorio**) | 1K/2K (**obligatorio**) | no / no | i2i: `input_urls[]` | |
| `ideogram/v3-text-to-image` | `image_size`: square, square_hd, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9 | `rendering_speed` TURBO/BALANCED/QUALITY | `seed` / `negative_prompt` | no | `style` AUTO/GENERAL/REALISTIC/DESIGN; bueno para tipografía |
| `z-image` | 1:1, 4:3, 3:4, 16:9, 9:16 (**obligatorio**) | n/a | no / no | no | prompt ≤ 1000; borradores y modo "previsualizar" |

### 6.2 Video

| Modelo | API | Aspect ratio | Duración | Resolución | Seed / neg | Referencias / frames | Audio |
|---|---|---|---|---|---|---|---|
| `veo3` / `veo3_fast` / `veo3_lite` | **veo** | `aspect_ratio` 16:9, 9:16, Auto (!) | `duration` 4/6/8 | `resolution` 720p/1080p/4k | `seeds` / no | `imageUrls[]` + `generationType` | nativo |
| `bytedance/seedance-2-mini` | market | 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, adaptive (16:9) | `duration` **entero** 4–15 (5) | 480p/720p (720p) | no / no | `first_frame_url`, `last_frame_url`, `reference_image_urls[]`, `reference_video_urls[]` ≤ 3 (≤ 15 s en total), `reference_audio_urls[]` ≤ 3 | `generate_audio` (true por defecto en el esquema) |
| `bytedance/seedance-2`, `-2-fast`, `-2-5` | market | igual | 2/2-fast: 4–15; **2.5: 4–30** | 480p/720p (2.5 añade 1080p [uxdata]) | no | igual. (!) En 2 y 2-fast las referencias **no se combinan** con first/last frame | `generate_audio` |
| `bytedance/seedance-1.5-pro` | market | 1:1, 4:3, 3:4, 16:9, 9:16, 21:9 (obligatorio) | (!) entero 4–12 [apicity] frente a "8"/"10" [kie-mcp] | 480p/720p/1080p | no | `input_urls[]` 0–2 | `generate_audio` |
| `grok-imagine/text-to-video` | market | 2:3, 3:2, 1:1, 16:9, 9:16 | **entero 6–30** (6) | 480p/720p/1080p (480p) | no | i2v: `image_urls[]` ≤ 7 (1 a 1080p) | sí |
| `kling-3.0/video` | market | 16:9, 9:16, 1:1 | `duration` **string** "3"…"15" (obligatorio) | `mode` std/pro/4K (obligatorio) | no | `image_urls[]`, `kling_elements[]` (≤ 3 sujetos, 2–4 imágenes cada uno, referenciados como `[nombre]` en el prompt) | `sound` |
| `kling-2.6/text-to-video` / `image-to-video` | market | 16:9, 9:16, 1:1 (obligatorio en T2V) | string "5"/"10" | n/a | no | i2v: `image_urls[]` exactamente 1 | `sound` (obligatorio) |
| `kling/v2-5-turbo-text-to-video-pro` | market | 16:9, 9:16, 1:1 | "5"/"10" | n/a | no / **`negative_prompt`** ≤ 2500, `cfg_scale` 0–1 | i2v aparte | no |
| `hailuo/2-3-image-to-video-standard` (y `-pro`) | market | (de la imagen) | string "6"/"10" (10 s no a 1080P) | 768P/1080P | no | `image_url` (obligatorio) | no |
| `hailuo/02-text-to-video-standard` | market | n/a | "6"/"10" | n/a | no | `end_image_url` en I2V | `prompt_optimizer` |
| `wan/2-6-text-to-video` / `image-to-video` | market | (!) apicity no tiene aspect ratio en T2V; kie-mcp manda `aspect_ratio` | string "5"/"10"/"15" | 720p/1080p (1080p) | no | i2v: `image_urls[]` exactamente 1 | `multi_shots` |
| `wan/2-7-text-to-video` | market | (!) `ratio` [apicity] frente a `aspect_ratio` [kie-mcp] | entero 2–15 (5) [apicity] / "5","10" [kie-mcp] | 720p/1080p | **`seed`** / **`negative_prompt`** ≤ 500 | `audio_url` | sí |
| `wan/3-0-video` (y `-prime`) | market | adaptive, 16:9, 9:16, 1:1 | 2–30 o -1 [uxdata] / 3–15 [kie-mcp] | 480P/720P/1080P | `seed` | `first_frame_url`, `last_frame_url`, `reference_*_urls[]` | `audio` |
| `minimax-h3/text-to-video` (y i2v/r2v) | market | 16:9, 9:16, 1:1, adaptive | 3–10 o 4–15 (!) | 768P/2K | no | r2v: `reference_image_urls[]` 1–9 | estéreo |
| Runway | **runway** | `aspectRatio` | 5/10 | `quality` 720p/1080p | no | `imageUrl` | no |

### 6.3 Audio

| Modelo | API | Campos clave | Duración |
|---|---|---|---|
| Suno V5 / V5_5 (música) | suno | `prompt`, `model`, `customMode`, `instrumental`, `style`, `title`, `negativeTags`, `vocalGender`, `callBackUrl` | V5_5 custom: `duration` 10–360 (NO VERIFICADO); si no, la decide el modelo (recortar o hacer loop con ffmpeg) |
| Suno Sounds (SFX) | suno | `prompt` ≤ 500, `model` V5/V5_5, `soundLoop`, `soundTempo`, `soundKey` | sin control: se indica en el prompt y se recorta |
| ElevenLabs TTS v2 / Turbo 2.5 | market | `text`, `voice`, `stability`, `similarity_boost`, `style`, `speed`, `language_code`, `timestamps` | según el texto |
| Gemini 3.1 Flash TTS | market | `speakers[]`, `dialogue_turns[]`, `scene`, `temperature` | según el texto (calidad baja en tomas de más de 60 s según kie-mcp) |

---

## 7. Precios (créditos y USD), con fuente

### 7.1 Conversión y recargas

- **1 crédito = 0.005 USD**; 1000 créditos = 5 USD. Fuentes: [PRICE-API 2026-09-25] (`usdPrice = creditPrice × 0.005` en todas las filas; gcv-kie calcula la moda de esa razón) y [reseñas].
- Recargas de 5, 20, 50 y 200 USD. Hay un bono del 10 % con un depósito de 1250 USD, unos 80 créditos gratis al registrarse, los créditos no caducan y no hay suscripción. Fuente: solo [reseñas], **NO VERIFICADO** en kie.ai/pricing (bloqueado).

### 7.2 Tabla por modelo

USD = créditos × 0.005. Cuando solo se conoce el mínimo de [PRICE-API], los demás tiers quedan **NO VERIFICADOS**.

**Imagen** (por imagen salvo que se indique otra unidad)

| Modelo | Créditos | USD | Fuente | Confianza |
|---|---|---|---|---|
| `z-image` | 0.8 | 0.004 | [PRICE-API]; (!) kie-mcp: 3 | baja |
| `recraft/remove-background` | 1 | 0.005 | [PRICE-API]; kie-mcp medido 1.0 | alta |
| `ideogram/v3-text-to-image` | 3.5 (mínimo, 3 tiers) | 0.0175 | [PRICE-API]; (!) kie-mcp: 5 | media |
| `nano-banana-2-lite` | 4 | 0.02 | [PRICE-API] + kie-mcp medido 4.00 (2026-07-02) | alta |
| `google/nano-banana`, `google/nano-banana-edit` | 4 | 0.02 | [PRICE-API] | alta |
| `google/imagen4-fast` | 4 | 0.02 | [PRICE-API] + kie-mcp medido 4.0 (2026-09-22) | alta |
| `grok-imagine-image-2-0/text-to-image` | 4 | 0.02 | [PRICE-API] + kie-mcp medido 4.0 | alta |
| `flux-2/pro-text-to-image` | 5 (1K; 2K NO VERIFICADO) | 0.025 | [PRICE-API] | media |
| `seedream/5-lite-text-to-image` | 5.5 | 0.0275 | [PRICE-API]; (!) kie-mcp: 5 | media |
| `gpt-image-2-text-to-image` | 6 (mínimo, 3 tiers) | 0.03 | [PRICE-API]; (!) kie-mcp: 8 | media |
| `gpt-image-2-5-flare-text-to-image` | 6 / 10 / 16 (1K/2K/4K) | 0.03 / 0.05 / 0.08 | kie-mcp ("kie published", 2026-09-22) + [PRICE-API] mínimo 6 | media |
| GPT-4o Image (`4o-image-api`) | 6 | 0.03 | [PRICE-API] | media |
| `seedream/4.5-text-to-image` | 6.5 | 0.0325 | [PRICE-API]; (!) kie-mcp: 5 | media |
| `seedream/5-pro-text-to-image` | 7 (1K) / 14 (2K) | 0.035 / 0.07 | kie-mcp (publicado, 2026-08-26) + [PRICE-API] mínimo 7 | media |
| `nano-banana-2` | **8 / 12 / 18** (1K/2K/4K) | 0.04 / 0.06 / 0.09 | [PRICE-API] mínimo 8 + [PKG:uxdata] (lista 2026-08-30) | alta |
| `google/imagen4` / `imagen4-ultra` | 8 / 12 | 0.04 / 0.06 | [PRICE-API] + kie-mcp | alta |
| `nano-banana-pro` | 18 (24 en 4K NO VERIFICADO) | 0.09 (0.12) | [PRICE-API] mínimo 18, 2 tiers; kie-mcp: 24 | media |
| `flux-kontext-api` (dedicada) | 5 mínimo (2 tiers) | 0.025 | [PRICE-API]; (!) kie-mcp: 50 (pro) y 100 (max), una diferencia enorme | baja |

**Video**

| Modelo | Créditos | USD | Fuente | Confianza |
|---|---|---|---|---|
| `bytedance/seedance-1.5-pro` | 1.75/s mínimo (6 tiers) | 0.00875/s | [PRICE-API] | baja (tiers) |
| `grok-imagine/text-to-video`, `/image-to-video` | 2.4 / 4.5 / 8 por s (480p/720p/1080p) | 0.012 / 0.0225 / 0.04 por s | kie-mcp (tiers publicados, 2026-08-10) + [PRICE-API] mínimo 2.4 | media |
| `bytedance/seedance-2-mini` | 3.8 / 8.2 por s (480p/720p); 2.4 / 5 con video de referencia | 0.019 / 0.041 por s | kie-mcp (publicado, 2026-08-26; 480p medido) + [PRICE-API] mínimo 2.4 | alta |
| `bytedance/seedance-2-fast` | 6.8/s mínimo (4 tiers) | 0.034/s | [PRICE-API] | baja (tiers) |
| `wan/3-0-video` | 8 / 16 / 32 por s (480P/720P/1080P). Se cobra (duración de entrada + salida) | 0.04 / 0.08 / 0.16 por s | [PKG:uxdata] + kie-mcp + [PRICE-API] mínimo 8 | media |
| `minimax-h3/*` | 8/s (768P), 13/s (2K); +4 por imagen de referencia después de la 5.ª | 0.04 / 0.065 por s | [PKG:uxdata] + kie-mcp (medido 6 s = 48) + [PRICE-API] | alta |
| `bytedance/seedance-2` | 11.5/s mínimo (8 tiers) | 0.0575/s | [PRICE-API] | baja (tiers) |
| `kling-3.0/video` | 14/s mínimo (6 tiers) | 0.07/s | [PRICE-API]; (!) kie-mcp: 12 | baja |
| `kling-3.0-omni/*` | 720p 14 / 18 / 20 (mudo / audio / video de entrada); 1080p 18 / 23 / 27; 4k 67 por s | 0.07–0.335 por s | [PKG:uxdata] + kie-mcp | media |
| `wan/2-7-text-to-video` | 16/s mínimo (2 tiers) | 0.08/s | [PRICE-API]; (!) kie-mcp: 5 | media |
| `bytedance/seedance-2-5` | 28 / 63 / 114 por s (480p/720p/1080p); 17 / 38 / 68.5 con video de entrada. **1080p tenía promo hasta el 2026-09-17** | 0.14 / 0.315 / 0.57 por s | [PKG:uxdata] + kie-mcp (480p medido: 4 s = 112) + [PRICE-API] mínimo 17 | media |
| `kling/v3-turbo-*` | 18 / 22.5 por s (720p/1080p) | 0.09 / 0.1125 por s | kie-mcp + [PRICE-API] mínimo 18 | media |
| `happyhorse-1-1/*` | 22.5 / 29 por s (720p/1080p) | 0.1125 / 0.145 por s | kie-mcp + [PRICE-API] | media |
| Runway | 12 por video (5 s 720p, mínimo de 6 tiers) | 0.06 | [PRICE-API] + kie-mcp | media |
| `hailuo/2-3-image-to-video-standard` | 30 por video mínimo (3 tiers) | 0.15 | [PRICE-API] | media |
| `hailuo/02-text-to-video-standard` | 30 por video mínimo (2 tiers) | 0.15 | [PRICE-API]; (!) kie-mcp: 4/s | media |
| `veo3_lite` | **unos 30 por clip de 8 s** | 0.15 | kie-mcp (medido 2026-06-01) = [PRICE-API] mínimo "veo-3-1" 30 (24 tiers) | media |
| `kling-2.6/text-to-video` | 55 por video mínimo (5 s; 4 tiers) | 0.275 | [PRICE-API] | media |
| `hailuo/02-*-pro` | 57 por video | 0.285 | [PRICE-API] | media |
| `wan/2-6-text-to-video` / `image-to-video` | 70 por video mínimo (6 tiers) | 0.35 | [PRICE-API]; (!) kie-mcp: 4/s | media |
| `veo3_fast` | **60–168 por clip de 8 s (NO VERIFICADO)** | 0.30–0.84 | kie-mcp midió 168 (2026-06-01); las reseñas dicen 60 | baja |
| `veo3` (Quality) | **250–400 por clip de 8 s (NO VERIFICADO)** | 1.25–2.00 | kie-mcp midió 250; las reseñas dicen 400 | baja |
| Veo → 1080p / 4K | 5 / unos 120 | 0.025 / 0.60 | [PRICE-API] (`veo/get-1080p-video` = 5) / kie-mcp (4K medido) | media / baja |
| `omnihuman-1-5` | 27/s | 0.135/s | [PRICE-API] + kie-mcp | alta |

**Audio**

| Modelo | Créditos | USD | Fuente | Confianza |
|---|---|---|---|---|
| Suno música (`/api/v1/generate`) | 12 por petición (unas 2 pistas) | 0.06 | [PRICE-API] (`ai-music-api/generate`, `suno-api`); (!) kie-mcp: 10 | media |
| Suno extend / add-instrumental / upload-cover | 12 | 0.06 | [PRICE-API] | media |
| Suno Sounds (SFX) | 2.5 por petición | 0.0125 | [PRICE-API]; (!) kie-mcp: 5 | baja |
| Suno convert-to-wav / timestamped-lyrics / music-video | 0.4 / 0.5 / 2 | 0.002 / 0.0025 / 0.01 | [PRICE-API] | media |
| ElevenLabs Turbo 2.5 | 6 por cada 1000 caracteres (redondeo hacia arriba) | 0.03 | [PRICE-API] + kie-mcp (35/150/600 caracteres → 6; 1500 → 12) | alta |
| ElevenLabs Multilingual v2 | 12 por cada 1000 caracteres (redondeo hacia arriba) | 0.06 | [PRICE-API] + kie-mcp (medido 2026-06-11) | alta |
| ElevenLabs text-to-dialogue v3 | 14 por cada 1000 caracteres (lineal) | 0.07 | [PRICE-API] + kie-mcp | alta |
| Gemini 3.1 Flash TTS | 140 por millón de tokens de entrada + 2800 por millón de tokens de audio de salida (≈ 4.2 por minuto de audio) | ≈ 0.021/min | kie-mcp + [PRICE-API] mínimo 140 | media |
| `elevenlabs/sound-effect-v2` | N/D | N/D | no figura en [PRICE-API] | n/a |

### 7.3 Discrepancias detectadas: por qué los precios deben vivir en configuración

kie-mcp (2026-09-28) y el endpoint de precios (2026-09-25) **no coinciden** en z-image (3 frente a 0.8), Seedream 4.5 (5 frente a 6.5), GPT Image 2 (8 frente a 6), Kling 3.0 (12 frente a 14), Suno (10 frente a 12), Suno Sounds (5 frente a 2.5), Wan 2.6 y 2.7, Hailuo 02 y Flux Kontext. Veo Fast y Quality varían hasta 2.8× según la fuente. Conclusiones:

1. El **estimado** se calcula desde `kie-models.json` y se recalibra con `creditsConsumed` real (Market) o con la diferencia de saldo (Veo y Suno; ojo con trabajos en paralelo).
2. Hay que añadir un script `pnpm kie:sync` que llame a `POST /client/v1/model-pricing/page` y a `GET /api/v1/models/{id}/price`, y marque deriva de más del 25 % (es lo que hace kie-mcp).
3. En la interfaz conviene mostrar el estimado como **rango** cuando `confidence` sea `baja`.

---

## 8. Propuesta de configuración: `config/kie-models.json`

Los modelos, precios y valores por defecto viven aquí, **no en el código**. El adaptador traduce los **parámetros normalizados de la app** (`aspectRatio`, `durationSec`, `resolution`, `seed`, `negativePrompt`, `referenceImages`, `firstFrame`, `lastFrame`…) al campo real de cada modelo (`params.<clave>.field`), valida `enum`, `min`, `max`, `maxLength` y `maxItems`, aplica `defaults` y elige el endpoint según `api`.

Reglas:

- `api ∈ market | veo | suno | runway` decide cómo crear y consultar (`apiStyles`).
- Un parámetro que el modelo no declara en `params` **se ignora** (por ejemplo `seed` en nano-banana-2).
- `pricing.unit ∈ image | second | video | request | 1000_chars | million_tokens`. `tiers[].match` se compara contra el `input` final (más hechos de contexto como `hasVideoInput`). Se usa el tier más específico que coincida.
- `estimate` es el costo con los `defaults`. Lo verifica el script de §10.
- `enabled: false` deja el modelo visible pero no seleccionable (por ejemplo SFX de ElevenLabs).
- `confidence` (`alta | media | baja`) indica si en la interfaz se muestra un rango.

```json
{
  "schemaVersion": 1,
  "provider": "kie",
  "updatedAt": "2026-10-04",
  "baseUrl": "https://api.kie.ai",
  "uploadBaseUrl": "https://kieai.redpandaai.co",
  "usdPerCredit": 0.005,
  "usdPerCreditSource": "Tarifa de lista: 1000 créditos = 5 USD; usdPrice/creditPrice = 0.005 en todas las filas de POST https://api.kie.ai/client/v1/model-pricing/page (snapshot 2026-09-25)",
  "defaults": {
    "image": "nano-banana-2",
    "video": "bytedance/seedance-2-mini",
    "music": "suno-v5",
    "tts": "elevenlabs/text-to-speech-multilingual-v2",
    "sfx": "suno-sounds-v5"
  },
  "polling": {
    "initialIntervalMs": 3000,
    "maxIntervalMs": 30000,
    "timeoutMs": {
      "image": 600000,
      "video": 1200000,
      "music": 900000,
      "tts": 300000,
      "sfx": 600000
    }
  },
  "apiStyles": {
    "market": {
      "create": "POST /api/v1/jobs/createTask",
      "status": "GET /api/v1/jobs/recordInfo?taskId={taskId}",
      "bodyShape": "{ model, input, callBackUrl? }",
      "doneField": "data.state in [success, fail]",
      "resultField": "JSON.parse(data.resultJson).resultUrls[]"
    },
    "veo": {
      "create": "POST /api/v1/veo/generate",
      "status": "GET /api/v1/veo/record-info?taskId={taskId}",
      "bodyShape": "plano: { prompt, model, aspect_ratio, imageUrls?, generationType?, ... }",
      "doneField": "data.successFlag: 0 generando, 1 ok, 2-3 fallo",
      "resultField": "data.response.resultUrls[]"
    },
    "suno": {
      "create": "POST {endpoint} (/api/v1/generate o /api/v1/generate/sounds)",
      "status": "GET /api/v1/generate/record-info?taskId={taskId}",
      "bodyShape": "plano: { prompt, model, ..., callBackUrl }",
      "doneField": "data.status == SUCCESS (fallo: *FAILED, SENSITIVE_WORD_ERROR)",
      "resultField": "data.response.sunoData[].audio_url (o audioUrl)"
    },
    "runway": {
      "create": "POST /api/v1/runway/generate",
      "status": "GET /api/v1/runway/record-detail?taskId={taskId}",
      "bodyShape": "plano: { prompt, duration, quality, aspectRatio?, imageUrl?, waterMark?, callBackUrl? }",
      "doneField": "data.state (success | fail)",
      "resultField": "data.videoInfo.videoUrl"
    }
  },
  "models": [
    {
      "id": "nano-banana-2",
      "type": "image",
      "label": "Nano Banana 2 (Google)",
      "enabled": true,
      "api": "market",
      "apiModel": "nano-banana-2",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 20000, "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9", "auto"] },
        "resolution": { "field": "resolution", "enum": ["1K", "2K", "4K"] },
        "referenceImages": { "field": "image_input", "maxItems": 14 },
        "outputFormat": { "field": "output_format", "enum": ["png", "jpg"] }
      },
      "defaults": { "aspect_ratio": "9:16", "resolution": "1K", "output_format": "png" },
      "pricing": { "unit": "image", "base": 8, "tiers": [{"match": {"resolution": "2K"}, "credits": 12},{"match": {"resolution": "4K"}, "credits": 18}], "source": "pricing endpoint (snapshot 2026-09-25: mínimo 8, 3 tiers) + @uxdata-co/kie (lista KIE 2026-08-30: 8/12/18)", "confidence": "alta" },
      "estimate": { "credits": 8, "usd": 0.04, "for": "1 imagen 1K" }
    },
    {
      "id": "nano-banana-2-lite",
      "type": "image",
      "label": "Nano Banana 2 Lite (borradores baratos)",
      "enabled": true,
      "api": "market",
      "apiModel": "nano-banana-2-lite",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 20000, "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9", "auto"] },
        "referenceImages": { "field": "image_urls", "maxItems": 10 }
      },
      "defaults": { "aspect_ratio": "9:16" },
      "pricing": { "unit": "image", "base": 4, "tiers": [], "source": "pricing endpoint (2026-09-25) = 4; kie-mcp 5.3.0 medición real 4.00 (2026-07-02)", "confidence": "alta" },
      "estimate": { "credits": 4, "usd": 0.02, "for": "1 imagen" }
    },
    {
      "id": "nano-banana-pro",
      "type": "image",
      "label": "Nano Banana Pro (portadas / calidad)",
      "enabled": true,
      "api": "market",
      "apiModel": "nano-banana-pro",
      "params": {
        "prompt": { "field": "prompt", "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"] },
        "resolution": { "field": "resolution", "enum": ["1K", "2K", "4K"] },
        "referenceImages": { "field": "image_input" },
        "outputFormat": { "field": "output_format", "enum": ["png", "jpg"] }
      },
      "defaults": { "aspect_ratio": "9:16", "resolution": "1K", "output_format": "png" },
      "pricing": { "unit": "image", "base": 18, "tiers": [{"match": {"resolution": "4K"}, "credits": 24}], "source": "pricing endpoint (2026-09-25): mínimo 18, 2 tiers; kie-mcp tabla 24. Que 24 sea el tier 4K es NO VERIFICADO", "confidence": "media" },
      "estimate": { "credits": 18, "usd": 0.09, "for": "1 imagen 1K" }
    },
    {
      "id": "google/imagen4-fast",
      "type": "image",
      "label": "Imagen 4 Fast (negative prompt + seed)",
      "enabled": true,
      "api": "market",
      "apiModel": "google/imagen4-fast",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 5000, "required": true },
        "negativePrompt": { "field": "negative_prompt", "maxLength": 5000 },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["1:1", "16:9", "9:16", "3:4", "4:3", "auto"] },
        "seed": { "field": "seed", "type": "integer" }
      },
      "defaults": { "aspect_ratio": "9:16" },
      "pricing": { "unit": "image", "base": 4, "tiers": [], "source": "pricing endpoint (2026-09-25) = 4; kie-mcp medición 4.0 (2026-09-22)", "confidence": "alta" },
      "estimate": { "credits": 4, "usd": 0.02, "for": "1 imagen" }
    },
    {
      "id": "seedream/4.5-text-to-image",
      "type": "image",
      "label": "Seedream 4.5 (ByteDance)",
      "enabled": true,
      "api": "market",
      "apiModel": "seedream/4.5-text-to-image",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 3000, "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"] },
        "quality": { "field": "quality", "enum": ["basic", "high"], "required": true }
      },
      "defaults": { "aspect_ratio": "9:16", "quality": "basic" },
      "pricing": { "unit": "image", "base": 6.5, "tiers": [], "source": "pricing endpoint (2026-09-25) = 6.5; kie-mcp tabla dice 5 (discrepancia)", "confidence": "media" },
      "estimate": { "credits": 6.5, "usd": 0.0325, "for": "1 imagen basic (2K)" }
    },
    {
      "id": "gpt-image-2-text-to-image",
      "type": "image",
      "label": "GPT Image 2 (texto en imagen)",
      "enabled": true,
      "api": "market",
      "apiModel": "gpt-image-2-text-to-image",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 20000, "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "9:16", "16:9", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"] },
        "resolution": { "field": "resolution", "enum": ["1K", "2K", "4K"] }
      },
      "defaults": { "aspect_ratio": "9:16", "resolution": "1K" },
      "pricing": { "unit": "image", "base": 6, "tiers": [], "source": "pricing endpoint (2026-09-25): mínimo 6, 3 tiers (2K/4K NO VERIFICADO); kie-mcp tabla 8", "confidence": "media" },
      "estimate": { "credits": 6, "usd": 0.03, "for": "1 imagen 1K" }
    },
    {
      "id": "z-image",
      "type": "image",
      "label": "Z-Image (el más barato)",
      "enabled": true,
      "api": "market",
      "apiModel": "z-image",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 1000, "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["1:1", "4:3", "3:4", "16:9", "9:16"], "required": true }
      },
      "defaults": { "aspect_ratio": "9:16" },
      "pricing": { "unit": "image", "base": 0.8, "tiers": [], "source": "pricing endpoint (2026-09-25) = 0.8; kie-mcp tabla dice 3 (discrepancia fuerte)", "confidence": "baja" },
      "estimate": { "credits": 0.8, "usd": 0.004, "for": "1 imagen" }
    },
    {
      "id": "bytedance/seedance-2-mini",
      "type": "video",
      "label": "Seedance 2 Mini (barato, con audio)",
      "enabled": true,
      "api": "market",
      "apiModel": "bytedance/seedance-2-mini",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 20000 },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] },
        "durationSec": { "field": "duration", "type": "integer", "min": 4, "max": 15 },
        "resolution": { "field": "resolution", "enum": ["480p", "720p"] },
        "firstFrame": { "field": "first_frame_url" },
        "lastFrame": { "field": "last_frame_url" },
        "referenceImages": { "field": "reference_image_urls" },
        "referenceVideos": { "field": "reference_video_urls", "maxItems": 3 },
        "referenceAudios": { "field": "reference_audio_urls", "maxItems": 3 },
        "generateAudio": { "field": "generate_audio", "type": "boolean" }
      },
      "defaults": { "aspect_ratio": "9:16", "duration": 5, "resolution": "720p", "generate_audio": false },
      "pricing": { "unit": "second", "base": 8.2, "tiers": [{"match": {"resolution": "480p"}, "credits": 3.8},{"match": {"resolution": "480p", "hasVideoInput": true}, "credits": 2.4},{"match": {"resolution": "720p", "hasVideoInput": true}, "credits": 5}], "source": "kie-mcp 5.3.0 (precio publicado por kie, revisado 2026-08-26) + pricing endpoint (2026-09-25: mínimo 2.4, 4 tiers)", "confidence": "alta" },
      "estimate": { "credits": 41, "usd": 0.205, "for": "5 s 720p sin video de referencia" }
    },
    {
      "id": "grok-imagine/text-to-video",
      "type": "video",
      "label": "Grok Imagine T2V (barato, hasta 30 s)",
      "enabled": true,
      "api": "market",
      "apiModel": "grok-imagine/text-to-video",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 5000, "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["2:3", "3:2", "1:1", "16:9", "9:16"] },
        "durationSec": { "field": "duration", "type": "integer", "min": 6, "max": 30 },
        "resolution": { "field": "resolution", "enum": ["480p", "720p", "1080p"] },
        "mode": { "field": "mode", "enum": ["fun", "normal", "spicy"] }
      },
      "defaults": { "aspect_ratio": "9:16", "duration": 6, "resolution": "720p", "mode": "normal" },
      "pricing": { "unit": "second", "base": 4.5, "tiers": [{"match": {"resolution": "480p"}, "credits": 2.4},{"match": {"resolution": "1080p"}, "credits": 8}], "source": "kie-mcp 5.3.0 (tiers publicados por kie 2.4/4.5/8, revisado 2026-08-10) + pricing endpoint (2026-09-25: mínimo 2.4, 4 tiers)", "confidence": "media" },
      "estimate": { "credits": 27, "usd": 0.135, "for": "6 s 720p" }
    },
    {
      "id": "kling-3.0/video",
      "type": "video",
      "label": "Kling 3.0",
      "enabled": true,
      "api": "market",
      "apiModel": "kling-3.0/video",
      "params": {
        "prompt": { "field": "prompt" },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["16:9", "9:16", "1:1"] },
        "durationSec": { "field": "duration", "type": "string", "enum": ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"], "required": true },
        "mode": { "field": "mode", "enum": ["std", "pro", "4K"], "required": true },
        "referenceImages": { "field": "image_urls" },
        "sound": { "field": "sound", "type": "boolean" },
        "multiShots": { "field": "multi_shots", "type": "boolean", "required": true }
      },
      "defaults": { "aspect_ratio": "9:16", "duration": "5", "mode": "std", "sound": false, "multi_shots": false },
      "pricing": { "unit": "second", "base": 14, "tiers": [], "source": "pricing endpoint (2026-09-25): mínimo 14 cr/s, 6 tiers (desglose pro/4K/audio NO VERIFICADO); kie-mcp tabla 12", "confidence": "baja" },
      "estimate": { "credits": 70, "usd": 0.35, "for": "5 s std sin audio" }
    },
    {
      "id": "kling-2.6/text-to-video",
      "type": "video",
      "label": "Kling 2.6 T2V",
      "enabled": true,
      "api": "market",
      "apiModel": "kling-2.6/text-to-video",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 1000, "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["16:9", "9:16", "1:1"], "required": true },
        "durationSec": { "field": "duration", "type": "string", "enum": ["5", "10"], "required": true },
        "sound": { "field": "sound", "type": "boolean", "required": true }
      },
      "defaults": { "aspect_ratio": "9:16", "duration": "5", "sound": false },
      "pricing": { "unit": "video", "base": 55, "tiers": [], "source": "pricing endpoint (2026-09-25): mínimo 55 por video, 4 tiers (10 s / sonido NO VERIFICADO)", "confidence": "media" },
      "estimate": { "credits": 55, "usd": 0.275, "for": "5 s sin sonido" }
    },
    {
      "id": "hailuo/2-3-image-to-video-standard",
      "type": "video",
      "label": "Hailuo 2.3 Standard I2V",
      "enabled": true,
      "api": "market",
      "apiModel": "hailuo/2-3-image-to-video-standard",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 5000, "required": true },
        "firstFrame": { "field": "image_url", "required": true },
        "durationSec": { "field": "duration", "type": "string", "enum": ["6", "10"] },
        "resolution": { "field": "resolution", "enum": ["768P", "1080P"] }
      },
      "defaults": { "duration": "6", "resolution": "768P" },
      "pricing": { "unit": "video", "base": 30, "tiers": [], "source": "pricing endpoint (2026-09-25): mínimo 30 por video, 3 tiers (10 s y 1080P NO VERIFICADO)", "confidence": "media" },
      "estimate": { "credits": 30, "usd": 0.15, "for": "6 s 768P" }
    },
    {
      "id": "veo3_lite",
      "type": "video",
      "label": "Veo 3.1 Lite (Google)",
      "enabled": true,
      "api": "veo",
      "apiModel": "veo3_lite",
      "params": {
        "prompt": { "field": "prompt", "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["16:9", "9:16", "Auto"] },
        "referenceImages": { "field": "imageUrls" },
        "generationType": { "field": "generationType", "enum": ["TEXT_2_VIDEO", "FIRST_AND_LAST_FRAMES_2_VIDEO", "REFERENCE_2_VIDEO"] },
        "seed": { "field": "seeds", "type": "integer" },
        "durationSec": { "field": "duration", "type": "integer", "enum": [4,6,8] },
        "resolution": { "field": "resolution", "enum": ["720p", "1080p", "4k"] },
        "enableTranslation": { "field": "enableTranslation", "type": "boolean" }
      },
      "defaults": { "aspect_ratio": "9:16", "enableTranslation": true },
      "pricing": { "unit": "video", "base": 30, "tiers": [], "source": "kie-mcp: medición real 30 cr por 8 s 720p (2026-06-01); coincide con mínimo 30 del pricing endpoint (2026-09-25, 24 tiers). Precio con duration/resolution distintos NO VERIFICADO", "confidence": "media" },
      "estimate": { "credits": 30, "usd": 0.15, "for": "8 s por defecto" }
    },
    {
      "id": "veo3_fast",
      "type": "video",
      "label": "Veo 3.1 Fast (Google)",
      "enabled": true,
      "api": "veo",
      "apiModel": "veo3_fast",
      "params": {
        "prompt": { "field": "prompt", "required": true },
        "aspectRatio": { "field": "aspect_ratio", "enum": ["16:9", "9:16", "Auto"] },
        "referenceImages": { "field": "imageUrls" },
        "generationType": { "field": "generationType", "enum": ["TEXT_2_VIDEO", "FIRST_AND_LAST_FRAMES_2_VIDEO", "REFERENCE_2_VIDEO"] },
        "seed": { "field": "seeds", "type": "integer" },
        "durationSec": { "field": "duration", "type": "integer", "enum": [4,6,8] },
        "resolution": { "field": "resolution", "enum": ["720p", "1080p", "4k"] },
        "enableTranslation": { "field": "enableTranslation", "type": "boolean" }
      },
      "defaults": { "aspect_ratio": "9:16", "enableTranslation": true },
      "pricing": { "unit": "video", "base": 168, "tiers": [], "source": "NO VERIFICADO: kie-mcp midió 168 cr/8 s (2026-06-01); reseñas de terceros citan 60 cr/8 s. Se usa el peor caso para presupuestar", "confidence": "baja" },
      "estimate": { "credits": 168, "usd": 0.84, "for": "8 s (peor caso conocido)" }
    },
    {
      "id": "runway-gen",
      "type": "video",
      "label": "Runway (API dedicada)",
      "enabled": false,
      "api": "runway",
      "apiModel": null,
      "endpoint": { "create": "POST /api/v1/runway/generate", "status": "GET /api/v1/runway/record-detail?taskId={taskId}", "result": "data.videoInfo.videoUrl" },
      "params": {
        "prompt": { "field": "prompt", "maxLength": 1800, "required": true },
        "durationSec": { "field": "duration", "type": "integer", "enum": [5,10], "required": true },
        "resolution": { "field": "quality", "enum": ["720p", "1080p"], "required": true },
        "aspectRatio": { "field": "aspectRatio", "enum": ["16:9", "4:3", "1:1", "3:4", "9:16"] },
        "firstFrame": { "field": "imageUrl" }
      },
      "defaults": { "duration": 5, "quality": "720p", "aspectRatio": "9:16" },
      "pricing": { "unit": "video", "base": 12, "tiers": [], "source": "pricing endpoint (2026-09-25): mínimo 12 (5 s 720p), 6 tiers; resto NO VERIFICADO", "confidence": "media" },
      "estimate": { "credits": 12, "usd": 0.06, "for": "5 s 720p" }
    },
    {
      "id": "suno-v5",
      "type": "music",
      "label": "Suno V5 (música)",
      "enabled": true,
      "api": "suno",
      "endpoint": { "create": "POST /api/v1/generate" },
      "apiModel": "V5",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 3000, "required": true },
        "model": { "field": "model", "enum": ["V4", "V4_5", "V4_5PLUS", "V4_5ALL", "V5", "V5_5"], "required": true },
        "customMode": { "field": "customMode", "type": "boolean", "required": true },
        "instrumental": { "field": "instrumental", "type": "boolean", "required": true },
        "style": { "field": "style" },
        "title": { "field": "title", "maxLength": 80 },
        "negativeTags": { "field": "negativeTags" },
        "callBackUrl": { "field": "callBackUrl", "required": true }
      },
      "defaults": { "model": "V5", "customMode": false, "instrumental": true },
      "pricing": { "unit": "request", "base": 12, "tiers": [], "source": "pricing endpoint (2026-09-25): ai-music-api/generate = 12 por petición (devuelve normalmente 2 pistas); kie-mcp tabla 10", "confidence": "media" },
      "estimate": { "credits": 12, "usd": 0.06, "for": "1 petición (≈2 pistas)" }
    },
    {
      "id": "elevenlabs/text-to-speech-multilingual-v2",
      "type": "tts",
      "label": "ElevenLabs Multilingual v2",
      "enabled": true,
      "api": "market",
      "apiModel": "elevenlabs/text-to-speech-multilingual-v2",
      "params": {
        "text": { "field": "text", "maxLength": 5000, "required": true },
        "voice": { "field": "voice", "required": true },
        "stability": { "field": "stability", "type": "number", "min": 0, "max": 1 },
        "similarityBoost": { "field": "similarity_boost", "type": "number", "min": 0, "max": 1 },
        "style": { "field": "style", "type": "number", "min": 0, "max": 1 },
        "speed": { "field": "speed", "type": "number", "min": 0.7, "max": 1.2 },
        "timestamps": { "field": "timestamps", "type": "boolean" },
        "languageCode": { "field": "language_code" }
      },
      "defaults": { "voice": "EkK5I93UQWFDigLMpZcX", "stability": 0.5, "similarity_boost": 0.75, "speed": 1 },
      "pricing": { "unit": "1000_chars", "rounding": "ceil", "base": 12, "tiers": [], "source": "pricing endpoint (2026-09-25) = 12 cr/1000 caracteres; kie-mcp mediciones 2026-06-11 (redondeo hacia arriba por bloque de 1000)", "confidence": "alta" },
      "estimate": { "credits": 12, "usd": 0.06, "for": "hasta 1000 caracteres" }
    },
    {
      "id": "elevenlabs/text-to-speech-turbo-2-5",
      "type": "tts",
      "label": "ElevenLabs Turbo 2.5 (barato)",
      "enabled": true,
      "api": "market",
      "apiModel": "elevenlabs/text-to-speech-turbo-2-5",
      "params": {
        "text": { "field": "text", "maxLength": 5000, "required": true },
        "voice": { "field": "voice", "required": true },
        "stability": { "field": "stability", "type": "number", "min": 0, "max": 1 },
        "similarityBoost": { "field": "similarity_boost", "type": "number", "min": 0, "max": 1 },
        "speed": { "field": "speed", "type": "number", "min": 0.7, "max": 1.2 },
        "languageCode": { "field": "language_code" }
      },
      "defaults": { "voice": "EkK5I93UQWFDigLMpZcX", "language_code": "es" },
      "pricing": { "unit": "1000_chars", "rounding": "ceil", "base": 6, "tiers": [], "source": "pricing endpoint (2026-09-25) = 6 cr/1000 caracteres; kie-mcp mediciones 2026-06-11", "confidence": "alta" },
      "estimate": { "credits": 6, "usd": 0.03, "for": "hasta 1000 caracteres" }
    },
    {
      "id": "suno-sounds-v5",
      "type": "sfx",
      "label": "Suno Sounds V5 (efectos / ambientes / loops)",
      "enabled": true,
      "api": "suno",
      "endpoint": { "create": "POST /api/v1/generate/sounds" },
      "apiModel": "V5",
      "params": {
        "prompt": { "field": "prompt", "maxLength": 500, "required": true },
        "model": { "field": "model", "enum": ["V5", "V5_5"], "required": true },
        "loop": { "field": "soundLoop", "type": "boolean" },
        "tempo": { "field": "soundTempo", "type": "integer", "min": 1, "max": 300 },
        "key": { "field": "soundKey" }
      },
      "defaults": { "model": "V5", "soundLoop": false },
      "pricing": { "unit": "request", "base": 2.5, "tiers": [], "source": "pricing endpoint (2026-09-25): ai-music-api/sounds = 2.5; kie-mcp tabla 5 (discrepancia). Sin control exacto de duración", "confidence": "baja" },
      "estimate": { "credits": 2.5, "usd": 0.0125, "for": "1 petición" }
    },
    {
      "id": "elevenlabs/sound-effect-v2",
      "type": "sfx",
      "label": "ElevenLabs SFX v2 (probablemente retirado)",
      "enabled": false,
      "api": "market",
      "apiModel": "elevenlabs/sound-effect-v2",
      "params": {
        "text": { "field": "text", "required": true },
        "loop": { "field": "loop", "type": "boolean" },
        "promptInfluence": { "field": "prompt_influence", "type": "number" },
        "outputFormat": { "field": "output_format" }
      },
      "defaults": {},
      "pricing": { "unit": "request", "base": null, "tiers": [], "source": "NO VERIFICADO: no aparece en el pricing endpoint (2026-09-25); kie-mcp 5.3.0 reporta que createTask lo acepta pero falla con 500", "confidence": "baja" },
      "estimate": { "credits": null, "usd": null, "for": "desconocido" }
    }
  ]
}
```

### 8.1 Estimador de costo (verificado en §10)

```ts
type Tier = { match: Record<string, unknown>; credits: number };
type Model = {
  id: string; type: string; enabled: boolean; api: string;
  defaults: Record<string, unknown>;
  params: Record<string, { field: string }>;
  pricing: { unit: string; base: number | null; tiers: Tier[]; rounding?: string };
  estimate: { credits: number | null; usd: number | null };
};
/** Costo estimado: tier más específico que coincida; unidades por segundo × duración; TTS por bloques de 1000 caracteres. */
export function estimateCredits(m: Model, input: Record<string, unknown>, ctx: { chars?: number; hasVideoInput?: boolean } = {}): number | null {
  if (m.pricing.base == null) return null;
  const facts: Record<string, unknown> = { ...input, hasVideoInput: ctx.hasVideoInput ?? false };
  let best: Tier | undefined;
  for (const t of m.pricing.tiers) {
    const ok = Object.entries(t.match).every(([k, v]) => facts[k] === v);
    if (ok && (!best || Object.keys(t.match).length > Object.keys(best.match).length)) best = t;
  }
  const unitPrice = best?.credits ?? m.pricing.base;
  const durField = m.params.durationSec?.field;
  switch (m.pricing.unit) {
    case "second": return unitPrice * Number(durField ? input[durField] : 0);
    case "1000_chars": return unitPrice * Math.max(1, Math.ceil((ctx.chars ?? 1) / 1000));
    default: return unitPrice;
  }
}
```

> Veo (`unit: "video"`) se estima por clip. Que el precio cambie con `duration` 4/6/8 o con la resolución está **NO VERIFICADO**.

### 8.2 Construcción del cuerpo HTTP desde la configuración (verificado en §10)

```ts
// Construye el cuerpo HTTP a partir de la configuración (kie-models.json) y de parámetros normalizados de la app.

export interface ParamSpec {
  field: string;
  type?: "string" | "integer" | "number" | "boolean";
  enum?: Array<string | number>;
  min?: number;
  max?: number;
  maxLength?: number;
  maxItems?: number;
  required?: boolean;
}
export interface ModelCfg {
  id: string;
  type: "image" | "video" | "music" | "tts" | "sfx";
  enabled: boolean;
  api: "market" | "veo" | "suno" | "runway";
  apiModel: string | null;
  endpoint?: { create?: string };
  params: Record<string, ParamSpec>;
  defaults: Record<string, unknown>;
}

export class ConfigValidationError extends Error {}

/** params usa claves normalizadas de la app (aspectRatio, durationSec, seed, negativePrompt, referenceImages...). */
export function buildRequest(m: ModelCfg, params: Record<string, unknown>, callBackUrl?: string): { path: string; body: Record<string, unknown> } {
  if (!m.enabled) throw new ConfigValidationError(`${m.id} está deshabilitado en la configuración`);
  const input: Record<string, unknown> = { ...m.defaults };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const spec = m.params[key];
    if (!spec) continue; // el modelo no soporta ese parámetro: se ignora (p. ej. seed en un modelo sin seed)
    let v: unknown = value;
    if (spec.type === "string" && typeof v === "number") v = String(v);
    if (spec.type === "integer" && typeof v === "string") v = Number.parseInt(v, 10);
    if (spec.enum && !spec.enum.includes(v as string | number)) throw new ConfigValidationError(`${m.id}.${key}=${String(v)} no está en ${spec.enum.join("|")}`);
    if (typeof v === "number" && ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)))
      throw new ConfigValidationError(`${m.id}.${key}=${v} fuera de rango ${spec.min}..${spec.max}`);
    if (typeof v === "string" && spec.maxLength && v.length > spec.maxLength) throw new ConfigValidationError(`${m.id}.${key} excede ${spec.maxLength} caracteres`);
    if (Array.isArray(v) && spec.maxItems && v.length > spec.maxItems) throw new ConfigValidationError(`${m.id}.${key} admite máximo ${spec.maxItems}`);
    input[spec.field] = v;
  }
  for (const [key, spec] of Object.entries(m.params)) {
    if (spec.required && input[spec.field] === undefined && key !== "callBackUrl") throw new ConfigValidationError(`${m.id}: falta ${key} (${spec.field})`);
  }
  switch (m.api) {
    case "market":
      return { path: "/api/v1/jobs/createTask", body: { model: m.apiModel, input, ...(callBackUrl ? { callBackUrl } : {}) } };
    case "veo":
      return { path: "/api/v1/veo/generate", body: { model: m.apiModel, ...input, ...(callBackUrl ? { callBackUrl } : {}) } };
    case "suno": {
      // Suno exige callBackUrl en /api/v1/generate aunque se haga polling: usar una URL propia (o un placeholder) y seguir con polling.
      const path = (m.endpoint?.create ?? "POST /api/v1/generate").replace(/^POST\s+/, "");
      return { path, body: { ...input, callBackUrl: callBackUrl ?? "https://example.invalid/kie-callback" } };
    }
    case "runway":
      return { path: "/api/v1/runway/generate", body: { ...input, ...(callBackUrl ? { callBackUrl } : {}) } };
  }
}
```

---

## 9. Adaptador TypeScript recomendado

### 9.1 Diseño

```
providers/
  media-provider.ts      ← interfaz común (permite cambiar de proveedor, PROMPT §4.4)
  kie/
    kie-client.ts        ← HTTP + reintentos + normalizadores (abajo)
    kie-provider.ts      ← implementa MediaProvider usando kie-models.json + buildRequest + estimateCredits
    kie-demo-provider.ts ← modo demo: mismas respuestas simuladas que el test de §10, sin red ni créditos
config/kie-models.json
```

```ts
// interfaz sugerida (no depende de Kie)
export interface GenerationJob { kind: "image" | "video" | "music" | "tts" | "sfx"; modelId: string; params: Record<string, unknown>; projectId: string; ownerId: string }
export interface SubmittedJob { provider: "kie"; family: "market" | "veo" | "suno" | "runway"; providerTaskId: string; estimatedCredits: number | null }
export interface MediaProvider {
  estimate(job: GenerationJob): { credits: number | null; usd: number | null; confidence: string };
  submit(job: GenerationJob, callBackUrl?: string): Promise<SubmittedJob>;  // persistir SubmittedJob en BD ANTES de volver
  status(s: SubmittedJob): Promise<{ state: "pending" | "success" | "fail"; resultUrls: string[]; creditsConsumed?: number; error?: string }>;
}
```

Flujo con reintentos (trabajo en segundo plano que sobrevive a reinicios, PROMPT §7):

1. `estimate`: mostrar el costo y cortar si `credits > presupuesto del proyecto`. Opcionalmente `GET /chat/credit` para avisar antes de un 402.
2. Subir referencias locales (con caché por hash y TTL de 3 días).
3. `submit` → guardar en BD `{jobId, providerTaskId, family, modelId, input, estimatedCredits, status:"submitted"}`. Si falla al crear: reintentar solo con 429, 455 o 5xx **con envoltorio JSON** (no hubo `taskId`). **[REVISIÓN]** Un error de red, un timeout, un 502/504 o un cuerpo no JSON al crear **no** se reintenta: es ambiguo (la tarea pudo crearse y cobrarse). Se marca como `creacion_incierta`, se avisa al usuario y se compara el saldo (`/chat/credit`) antes de permitir un "Reintentar" manual.
4. Polling (`waitFor`) o callback. Al reiniciar el servidor, **reanudar** todas las tareas `submitted` consultando su `taskId` (nunca reenviar).
5. `success` → **descargar de inmediato** los `resultUrls` al almacenamiento propio (sin header de auth; reintentar la descarga ante 5xx, porque el resultado ya está pagado). Guardar `prompt`, `model`, `seed` e `input` completo en la receta (PROMPT §4.9: "guarda prompts, modelos y semillas").
6. `fail` → mostrar `failMsg`, permitir "Reintentar" (que crea una tarea **nueva** con confirmación del costo) o cambiar a un modelo de respaldo (consultar `success-rate`).
7. Costo real: `creditsConsumed` (Market). Para Veo y Suno, diferencia de saldo (NO VERIFICADO) o el estimado.
8. La llave solo vive en el backend (`KIE_API_KEY` en `.env`). Nunca se expone al navegador.

### 9.2 `kie-client.ts` (compilado con `tsc --strict` y probado contra el mock de §10)

> **[REVISIÓN]** Versión corregida por la revisión crítica, compilada con `tsc` (`strict`, `noUncheckedIndexedAccess`) y probada contra el mock de §10 más 3 casos nuevos (`scratchpad/research-critic/kie/`):
> 1. **Antes, `request()` reintentaba cualquier error de red o timeout también en `createTask`.** Si la petición llegó a Kie pero la respuesta se perdió (timeout de 30 s, conexión cortada, 502/504, HTML de gateway), el reintento creaba y **cobraba una segunda tarea**, contra la regla de §0.10 y §2.3. Ahora un fallo **ambiguo** solo se reintenta en GET. En un POST de creación se propaga, y el trabajo debe quedar como "creación incierta": avisar, consultar el saldo, nunca reenviar en automático. Los errores explícitos con envoltorio (429, 455, 5xx con `code`) se siguen reintentando. Verificado: un corte de red en `createTask` da 1 sola llamada y un corte en `recordInfo` se reintenta (2 llamadas).
> 2. **Suno exige `callBackUrl`, y `buildRequest` manda el placeholder `https://example.invalid/...`.** Si Kie no puede entregar el callback y marca `CALLBACK_EXCEPTION`, el normalizador anterior daba `fail` aunque el audio ya existiera (pagado). Ahora `CALLBACK_EXCEPTION` con `audio_url` cuenta como `success`. Es defensivo: **NO VERIFICADO** que Kie use ese estado así. En servidor, lo mejor es mandar una `callBackUrl` real (`KIE_CALLBACK_URL`).

```ts
// Adaptador mínimo para Kie AI (kie.ai). Sin dependencias: usa fetch nativo de Node 22.
// Contrato derivado de docs.kie.ai + clientes open source (ver docs/research/kie-ai.md).

import { createHmac, timingSafeEqual } from "node:crypto";

export type TaskState = "waiting" | "queuing" | "generating" | "success" | "fail";
export type ApiFamily = "market" | "veo" | "suno";

export interface KieEnvelope<T> {
  code: number;
  msg: string;
  data?: T | null;
}

export interface NormalizedTask {
  taskId: string;
  family: ApiFamily;
  state: TaskState;
  resultUrls: string[];
  failCode?: string;
  failMsg?: string;
  creditsConsumed?: number;
  progress?: number;
  raw: unknown;
}

/** 429/455/5xx y fallos de red se reintentan; 400/401/402/404/422/433/505 no.
 *  `ambiguous` = no sabemos si Kie procesó la petición (red caída, timeout, 502/504, cuerpo no JSON). */
export class KieApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly body: unknown,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = "KieApiError";
  }
}

const RETRYABLE = new Set([408, 425, 429, 455, 500, 502, 503, 504]);
const FATAL = new Set([400, 401, 402, 404, 405, 413, 422, 433, 501, 505]);

export function isRetryable(code: number, msg = ""): boolean {
  const m = msg.toLowerCase();
  // Kie reutiliza 500 para errores de validación: el mensaje los distingue.
  if (code === 500 && /required|not within the range|allowed options|invalid/.test(m)) return false;
  if (FATAL.has(code)) return false;
  return RETRYABLE.has(code) || /try again later|server is busy/.test(m);
}

export interface KieClientOptions {
  apiKey: string;
  baseUrl?: string; // https://api.kie.ai
  uploadBaseUrl?: string; // https://kieai.redpandaai.co
  fetchImpl?: typeof fetch;
  timeoutMs?: number; // por petición
  maxRetries?: number; // para errores reintentables
  retryBaseMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });

export class KieClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly opts: KieClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.kie.ai").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
  }

  /**
   * Una petición JSON con reintentos. Kie señala errores con HTTP != 200 *o* con HTTP 200 + code != 200.
   * Un fallo AMBIGUO (red, timeout, 502/504, cuerpo no JSON) solo se reintenta si la petición es idempotente
   * (por defecto: GET). En un POST de creación podría haberse creado y cobrado la tarea: NO se reintenta;
   * el llamador debe marcar el trabajo como "creación incierta" y avisar, nunca reenviar en automático.
   */
  async request<T>(method: "GET" | "POST", path: string, body?: unknown, o: { retryAmbiguous?: boolean } = {}): Promise<KieEnvelope<T>> {
    const retryAmbiguous = o.retryAmbiguous ?? method === "GET";
    let attempt = 0;
    for (;;) {
      try {
        return await this.once<T>(method, path, body);
      } catch (err) {
        const isKie = err instanceof KieApiError;
        const ambiguous = !isKie || err.ambiguous; // !isKie = red/timeout de fetch
        const retryable = ambiguous ? retryAmbiguous : isKie && err.retryable;
        if (!retryable || attempt >= this.maxRetries) throw err;
        const delay = this.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * 250);
        attempt++;
        await sleep(delay);
      }
    }
  }

  private async once<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<KieEnvelope<T>> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: KieEnvelope<T>;
    try {
      json = JSON.parse(text) as KieEnvelope<T>;
    } catch {
      // Observado en estados intermedios de recordInfo y en 502 de gateway (HTML).
      throw new KieApiError(`Respuesta no JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status, res.status, true, text, true);
    }
    const code = res.status !== 200 ? res.status : typeof json.code === "number" ? json.code : 200;
    if (code !== 200) {
      const msg = json.msg ?? "";
      throw new KieApiError(`Kie ${code}: ${msg}`, code, res.status, isRetryable(code, msg), json, res.status === 502 || res.status === 504);
    }
    return json;
  }

  // ---------- Market (genérica): la mayoría de modelos ----------

  /** POST /api/v1/jobs/createTask. Persistir el taskId ANTES de hacer polling. */
  async createMarketTask(model: string, input: Record<string, unknown>, callBackUrl?: string): Promise<string> {
    const env = await this.request<{ taskId: string }>("POST", "/api/v1/jobs/createTask", {
      model,
      input,
      ...(callBackUrl ? { callBackUrl } : {}),
    });
    const taskId = env.data?.taskId;
    if (!taskId) throw new KieApiError("createTask sin taskId", 500, 200, false, env);
    return taskId;
  }

  async getMarketTask(taskId: string): Promise<NormalizedTask> {
    const env = await this.request<Record<string, unknown>>("GET", `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
    return normalizeMarket(taskId, env.data ?? {});
  }

  // ---------- Veo 3.1 (API dedicada) ----------

  async createVeoTask(body: Record<string, unknown>): Promise<string> {
    const env = await this.request<{ taskId: string }>("POST", "/api/v1/veo/generate", body);
    const taskId = env.data?.taskId;
    if (!taskId) throw new KieApiError("veo/generate sin taskId", 500, 200, false, env);
    return taskId;
  }

  async getVeoTask(taskId: string): Promise<NormalizedTask> {
    const env = await this.request<Record<string, unknown>>("GET", `/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`);
    return normalizeVeo(taskId, env.data ?? {});
  }

  // ---------- Suno (música y "sounds") ----------

  async createSunoTask(path: "/api/v1/generate" | "/api/v1/generate/sounds", body: Record<string, unknown>): Promise<string> {
    const env = await this.request<{ taskId: string }>("POST", path, body);
    const taskId = env.data?.taskId;
    if (!taskId) throw new KieApiError("suno sin taskId", 500, 200, false, env);
    return taskId;
  }

  async getSunoTask(taskId: string): Promise<NormalizedTask> {
    const env = await this.request<Record<string, unknown>>("GET", `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`);
    return normalizeSuno(taskId, env.data ?? {});
  }

  // ---------- Subida de archivos (host distinto) ----------

  /**
   * POST {uploadBaseUrl}/api/file-stream-upload (multipart: file, uploadPath, fileName?).
   * El archivo se borra a los ~3 días: cachear (hash → url, expiresAt) y re-subir si expiró.
   */
  async uploadFile(bytes: Uint8Array<ArrayBuffer>, filename: string, mimeType: string, uploadPath = "editor-de-video"): Promise<string> {
    const form = new FormData();
    form.append("file", new File([bytes], filename, { type: mimeType }));
    form.append("uploadPath", uploadPath);
    const base = (this.opts.uploadBaseUrl ?? "https://kieai.redpandaai.co").replace(/\/$/, "");
    const res = await this.fetchImpl(`${base}/api/file-stream-upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` }, // sin Content-Type: fetch pone el boundary
      body: form,
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
    });
    const json = (await res.json()) as KieEnvelope<{ downloadUrl?: string; fileUrl?: string }> & { success?: boolean };
    const url = json.data?.downloadUrl ?? json.data?.fileUrl;
    if (res.status !== 200 || json.code !== 200 || !url) {
      throw new KieApiError(`Upload falló: ${json.msg}`, json.code ?? res.status, res.status, isRetryable(json.code ?? res.status), json);
    }
    return url;
  }

  // ---------- Utilidades ----------

  /** GET /api/v1/chat/credit → data = créditos restantes (número). */
  async getCredits(): Promise<number> {
    const env = await this.request<number>("GET", "/api/v1/chat/credit");
    return Number(env.data ?? 0);
  }

  /**
   * Polling con intervalo creciente. Un error reintentable durante el polling NO aborta:
   * la tarea sigue viva (y cobrada) en Kie. Nunca reenviar createTask para "reintentar".
   */
  async waitFor(
    family: ApiFamily,
    taskId: string,
    o: { intervalMs?: number; maxIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal; onUpdate?: (t: NormalizedTask) => void } = {},
  ): Promise<NormalizedTask> {
    const get = family === "market" ? this.getMarketTask : family === "veo" ? this.getVeoTask : this.getSunoTask;
    let interval = o.intervalMs ?? 3_000;
    const maxInterval = o.maxIntervalMs ?? 30_000;
    const deadline = Date.now() + (o.timeoutMs ?? 15 * 60_000);
    while (Date.now() < deadline) {
      try {
        const t = await get.call(this, taskId);
        o.onUpdate?.(t);
        if (t.state === "success") return t;
        if (t.state === "fail") throw new KieApiError(`Tarea ${taskId} falló: ${t.failMsg ?? "?"}`, 501, 200, false, t.raw);
      } catch (err) {
        if (err instanceof KieApiError && !err.retryable) throw err;
        // transitorio: seguir esperando
      }
      await sleep(interval, o.signal);
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
    }
    throw new KieApiError(`Timeout esperando ${taskId}; puede terminar después: consultar de nuevo, no reenviar`, 408, 0, true, null);
  }
}

// ---------- Normalizadores ----------

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function urlsFrom(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  const r = obj as Record<string, unknown>;
  const list = r.resultUrls ?? r.result_urls;
  const out = Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : [];
  for (const k of ["resultImageUrl", "url"]) if (typeof r[k] === "string") out.push(r[k] as string);
  return [...new Set(out)];
}

const MARKET_STATES = new Set<TaskState>(["waiting", "queuing", "generating", "success", "fail"]);

export function normalizeMarket(taskId: string, d: Record<string, unknown>): NormalizedTask {
  const s = String(d.state ?? "waiting").toLowerCase() as TaskState;
  return {
    taskId,
    family: "market",
    state: MARKET_STATES.has(s) ? s : "waiting",
    resultUrls: urlsFrom(parseMaybeJson(d.resultJson)),
    failCode: d.failCode ? String(d.failCode) : undefined,
    failMsg: d.failMsg ? String(d.failMsg) : undefined,
    creditsConsumed: typeof d.creditsConsumed === "number" ? d.creditsConsumed : undefined,
    progress: typeof d.progress === "number" ? d.progress : undefined,
    raw: d,
  };
}

/** Veo: successFlag 0 generando · 1 éxito · 2 CREATE_TASK_FAILED · 3 GENERATE_FAILED. */
export function normalizeVeo(taskId: string, d: Record<string, unknown>): NormalizedTask {
  const flag = Number(d.successFlag ?? 0);
  const resp = parseMaybeJson(d.response) as Record<string, unknown> | null;
  return {
    taskId,
    family: "veo",
    state: flag === 1 ? "success" : flag === 0 ? "generating" : "fail",
    resultUrls: urlsFrom(resp ? { resultUrls: parseMaybeJson(resp.resultUrls) } : null),
    failCode: d.errorCode != null ? String(d.errorCode) : undefined,
    failMsg: d.errorMessage ? String(d.errorMessage) : undefined,
    raw: d,
  };
}

/** Suno: PENDING → TEXT_SUCCESS → FIRST_SUCCESS → SUCCESS; *_FAILED / SENSITIVE_WORD_ERROR son terminales. */
export function normalizeSuno(taskId: string, d: Record<string, unknown>): NormalizedTask {
  const status = String(d.status ?? "PENDING").toUpperCase();
  const resp = (d.response ?? {}) as { sunoData?: Array<Record<string, unknown>> };
  const tracks = Array.isArray(resp.sunoData) ? resp.sunoData : [];
  const urls = tracks
    .map((t) => (t.audio_url ?? t.audioUrl) as string | undefined)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  const failed = status.includes("FAIL") || status === "SENSITIVE_WORD_ERROR" || status === "CALLBACK_EXCEPTION";
  return {
    taskId,
    family: "suno",
    // Solo SUCCESS es final con URLs definitivas (FIRST_SUCCESS = 1ª pista lista).
    // CALLBACK_EXCEPTION = Kie no pudo entregar el callback (p. ej. URL placeholder). Si ya hay audio, la generación
    // sí terminó (defensivo, NO VERIFICADO con la API real): no tirar un resultado pagado.
    state: status === "SUCCESS" || (status === "CALLBACK_EXCEPTION" && urls.length > 0) ? "success" : failed ? "fail" : "generating",
    resultUrls: urls,
    failMsg: d.errorMessage ? String(d.errorMessage) : failed ? status : undefined,
    raw: d,
  };
}

// ---------- Webhooks (callBackUrl) ----------

/** Firma = Base64(HMAC-SHA256(`${taskId}.${timestampSegundos}`, webhookHmacKey)). Headers: X-Webhook-Timestamp, X-Webhook-Signature. */
export function verifyKieWebhook(secret: string, taskId: string, timestamp: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(`${taskId}.${timestamp}`, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### 9.3 Uso

`db.saveJob`, `progress` y `download` son pseudocódigo de la app; el resto es la API del cliente de §9.2.

```ts
import { KieClient } from "./kie-client.js";
const kie = new KieClient({ apiKey: process.env.KIE_API_KEY! });

// Imagen (Market)
const id = await kie.createMarketTask("nano-banana-2", { prompt: "portada minimalista, taza de café", aspect_ratio: "9:16", resolution: "1K" });
await db.saveJob({ providerTaskId: id, family: "market" });            // ← antes de consultar
const t = await kie.waitFor("market", id, { timeoutMs: 10 * 60_000, onUpdate: (s) => progress(s.state) });
await download(t.resultUrls[0]);                                         // URL válida ~24 h
console.log("costo real", t.creditsConsumed, "créditos");

// Video Veo 3.1 Lite
const v = await kie.createVeoTask({ model: "veo3_lite", prompt: "b-roll de manos escribiendo en laptop", aspect_ratio: "9:16" });
const vr = await kie.waitFor("veo", v, { timeoutMs: 20 * 60_000 });

// Música (Suno exige callBackUrl aunque se consulte)
const m = await kie.createSunoTask("/api/v1/generate", { prompt: "lo-fi cálido", model: "V5", customMode: false, instrumental: true, callBackUrl: process.env.KIE_CALLBACK_URL ?? "https://example.invalid/kie-callback" });
const mr = await kie.waitFor("suno", m, { intervalMs: 10_000, timeoutMs: 15 * 60_000 });  // mr.resultUrls = [pista1, pista2]
```

### 9.4 ¿Usar `@apicity/kie` en vez del adaptador propio?

- Ventajas: esquemas Zod para unos 147 modelos, webhook HMAC, endpoints de descubrimiento, MIT, mantenido (versión 0.13.2 del 2026-10-02).
- Desventajas: sus esquemas **difieren** de otras fuentes en varios modelos (Veo `aspectRatio`, Wan 2.7 `ratio`, duraciones de Seedance 1.5), sube de versión casi cada día (riesgo de cambios incompatibles), trae una "paygate" propia y nos ata a su forma de API.
- **Decisión sugerida:** adaptador propio de unas 300 líneas (arriba) con `kie-models.json`. `@apicity/kie` se puede usar como **referencia** o en un script de sincronización, no como dependencia del runtime.

---

## 10. Verificado en el contenedor

**Lo que sí se probó** (carpeta de trabajo `scratchpad/research-kie-ai/`, Node 22.22.0):

| Prueba | Comando | Resultado |
|---|---|---|
| Alcance de red a Kie | `curl https://api.kie.ai/api/v1/chat/credit`, `curl https://docs.kie.ai/` | FALLA `CONNECT tunnel failed, response 403` (política del proxy) |
| WebFetch a la documentación | `WebFetch https://docs.kie.ai/`, `https://kie.ai/pricing` | FALLA `EGRESS_BLOCKED` |
| WebSearch (extended) sobre docs.kie.ai | 12 búsquedas | OK Resúmenes de las páginas oficiales: auth, códigos, estados, créditos, upload, download-url, webhook, Veo, Suno, models |
| Código fuente de clientes | `npm pack` de 13 paquetes (kie-mcp, @apicity/kie, @nodetool-ai/kie-nodes, @uxdata-co/kie, @babylonjs-toolkit/kie, dainami-kie-mcp, @ulmeanuadrian/kie-mcp, gcv-kie, kie-media-cli, velsvisual, @felores/*, dsh-kie-credit-monitor) | OK Leídos; volcado de registros y esquemas con scripts de Node |
| Instalación SDK | `npm install @apicity/kie@0.13.2 typescript@5 tsx @types/node@22` | OK |
| Tipado del adaptador | `npx tsc -p .` (`strict`, `noUncheckedIndexedAccess`) sobre `kie-client.ts`, `mock-test.ts`, `estimate.ts`, `build-request.ts` | OK exit 0 |
| Adaptador contra servidor HTTP simulado | `npx tsx src/mock-test.ts` | OK Pasan: header `Bearer`; cuerpo `{model,input}`; **reintento ante HTTP 200 + code 429**; polling `waiting → (respuesta no JSON tolerada) → generating → success`; `resultJson` string → `resultUrls`; `creditsConsumed`; **402 sin reintento**; `chat/credit`; subida multipart (`file`, `uploadPath`) → `downloadUrl`; normalizadores Veo (`successFlag`) y Suno (`audio_url`/`audioUrl`); firma de webhook idéntica a `verifyKieWebhookSignature` de `@apicity/kie` |
| Configuración | `npx tsx src/estimate.ts` | OK JSON válido, 20 modelos, ids únicos, cada `default` mapeado en `params`, `estimate` = cálculo desde `pricing` (créditos y USD), defaults por tipo válidos; casos Seedance 480p con video (2.4 × 7) y TTS de 1500 caracteres (24) |
| buildRequest | `npx tsx src/build-request.ts` | OK nano-banana-2 (seed ignorado, refs → `image_input`), Kling `duration` → string, Veo cuerpo plano con `seeds`, Suno con `callBackUrl`, Sounds → `soundLoop`; rechaza duración fuera de rango, modelo deshabilitado y prompt demasiado largo |
| **[REVISIÓN]** Adaptador corregido | `npx tsc -p . && npx tsx src/mock-test.ts` en `scratchpad/research-critic/kie/` | OK: las pruebas originales siguen pasando. Corte de red en `createTask`: 1 sola llamada (sin reintento). Corte en `recordInfo`: reintentado (2 llamadas). Suno `CALLBACK_EXCEPTION` con `audio_url` da `success` |

**Lo que NO se pudo probar, y por qué:**

- **Ninguna llamada real a Kie** (ni crear, ni consultar, ni subir, ni saldo): no hay salida de red a `*.kie.ai` y no hay `KIE_API_KEY`. Las formas de respuesta vienen de la documentación (vía resúmenes de búsqueda) y de clientes de terceros, no de respuestas que yo haya visto.
- **Precios actuales al 2026-10-04:** el dato más reciente es el snapshot del endpoint de precios del **2026-09-25** más las tablas de kie-mcp del 2026-09-28. Los precios con (!) o confianza "baja" pueden haber cambiado.
- **HTML crudo de la documentación:** solo se vieron resúmenes, que pueden omitir campos.
- Callbacks reales, formato de `timestamps` de ElevenLabs, si existe `creditsConsumed` en Veo y Suno, tiempos reales de generación y vida útil exacta de las URLs de Suno.

---

## 11. Cómo verificar en local (Warp) cuando tengas la llave

```bash
export KIE_API_KEY=...   # de https://kie.ai/api-key (solo en .env del backend)
H="Authorization: Bearer $KIE_API_KEY"

# 1) Saldo
curl -s https://api.kie.ai/api/v1/chat/credit -H "$H"

# 2) Catálogo y esquema vivos (1 petición/s)
curl -s "https://api.kie.ai/api/v1/models?taskType=Text%20to%20Image" -H "$H" | jq '.data.models[] | {model, pricingDesc}'
curl -s https://api.kie.ai/api/v1/models/nano-banana-2/schema -H "$H" | jq '.data.openapi.components'
curl -s https://api.kie.ai/api/v1/models/veo3_fast/price -H "$H"      # ¿id de catálogo "veo3_fast"? confirmar con el listado

# 3) Precios públicos (sin llave)
curl -s -X POST https://api.kie.ai/client/v1/model-pricing/page -H 'Content-Type: application/json' \
  -d '{"pageNum":1,"pageSize":100}' | jq '.data.records[] | {modelDescription, creditPrice, creditUnit, usdPrice, anchor}'

# 4) Prueba barata end-to-end (~0.8 créditos)
TASK=$(curl -s -X POST https://api.kie.ai/api/v1/jobs/createTask -H "$H" -H 'Content-Type: application/json' \
  -d '{"model":"z-image","input":{"prompt":"taza de café, fondo liso","aspect_ratio":"9:16"}}' | jq -r .data.taskId)
curl -s "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=$TASK" -H "$H" | jq '.data | {state, creditsConsumed, resultJson}'
```

Lista de cosas por confirmar con la primera tanda real (de la más barata a la más cara):

1. `z-image` (0.8 frente a 3 créditos), `nano-banana-2-lite` (4) y `nano-banana-2` 1K (8): ¿coincide `creditsConsumed`?
2. Forma exacta de `recordInfo` y de `resultJson` (string u objeto).
3. ElevenLabs Multilingual v2 con texto en español: ¿acepta `language_code: "es"`? ¿Formato de `timestamps`?
4. Suno Sounds: costo real (2.5 o 5), duración típica, ¿`callBackUrl` opcional de verdad?
5. Suno música sin `callBackUrl`: ¿lo rechaza?
6. `veo3_lite` 9:16 con `aspect_ratio` (snake_case): ¿sale vertical? ¿Costo por 8 s? ¿Aparece `creditsConsumed` en `veo/record-info`?
7. `elevenlabs/sound-effect-v2`: ¿sigue fallando con 500?
8. Webhook: activar HMAC, exponer un túnel (por ejemplo `cloudflared`) y validar `X-Webhook-Signature`.

---

## 12. Riesgos y pendientes para DECISIONES.md

- **Volatilidad:** los modelos aparecen y desaparecen en semanas (Sora retirado, SFX de ElevenLabs roto, HappyHorse y Seedance 2.5 nuevos). Mitigación: configuración más sincronización, `success-rate` para elegir respaldo, y `enabled: false` sin tocar código.
- **Diferencias de esquema entre modelos "hermanos"** (`duration` string frente a entero, `aspect_ratio` frente a `ratio` frente a `image_size`). Mitigación: `params.*.type` y `field` por modelo, más validación previa.
- **Moderación:** el error 400 por política de contenido y `SENSITIVE_WORD_ERROR` en Suno deben mostrarse como "cambia el prompt", no como error del sistema.
- **Costos que se disparan:** Veo Quality, Seedance 2.5 a 1080p y Kling 4K. Conviene un tope por proyecto y confirmación en el plan (PROMPT §4.6).
- **Privacidad:** el material del usuario se sube a un host de terceros (redpandaai.co) con TTL de 3 días. Hay que mencionarlo en el README.
- **Modo demo:** reutilizar el mock de §10 (mismas formas de respuesta) devolviendo assets locales de prueba.

---

## 13. Referencias

Documentación oficial (leída vía resúmenes de WebSearch; el acceso directo está bloqueado en el contenedor):

- [DOC-GS] Getting Started: https://docs.kie.ai/ (alternativa: https://kieai.mintlify.app/)
- [DOC-MARKET] Market quickstart: https://docs.kie.ai/market/quickstart
- [DOC-TASK] Get Task Details: https://docs.kie.ai/market/common/get-task-detail
- [DOC-CREDIT] Get Remaining Credits: https://docs.kie.ai/common-api/get-account-credits
- [DOC-DL] Download URL: https://docs.kie.ai/common-api/download-url
- [DOC-UP] File Upload: https://docs.kie.ai/file-upload-api/quickstart · https://docs.kie.ai/file-upload-api/upload-file-stream
- [DOC-WH] Webhook verification: https://docs.kie.ai/common-api/webhook-verification
- [DOC-VEO] Veo 3.1: https://docs.kie.ai/veo3-api/generate-veo-3-video · https://docs.kie.ai/veo3-api/get-veo-3-video-details
- [DOC-SUNO] Suno: https://docs.kie.ai/suno-api/generate-music · https://docs.kie.ai/suno-api/generate-sounds
- [DOC-MODELS] Descubrimiento de modelos: https://docs.kie.ai/ai-agent/install-kie-models
- Índice para agentes: https://docs.kie.ai/llms.txt (cada página tiene versión `.md` con bloque OpenAPI, según gcv-kie)
- Por modelo: `https://docs.kie.ai/market/<proveedor>/<modelo>` (por ejemplo `/market/kling/text-to-video`, `/market/google/nano-banana-2-lite`, `/market/elevenlabs/text-to-speech-multilingual-v2`)

Paquetes npm analizados (código fuente):

- kie-mcp@5.3.0 · @apicity/kie@0.13.2 (github.com/justintanner/apicity) · @nodetool-ai/kie-nodes@0.8.1 · @uxdata-co/kie@0.8.0 · @babylonjs-toolkit/kie@1.0.1 · dainami-kie-mcp@0.5.3 · @ulmeanuadrian/kie-mcp@0.3.0 · gcv-kie@0.5.0 · kie-media-cli@0.3.1 · velsvisual@0.2.1 · @felores/kie-ai-mcp-server@5.0.0 · @felores/kie-cli@0.8.0 · dsh-kie-credit-monitor@0.1.0

Reseñas (solo para paquetes de créditos y bono):

- https://aisofting.com/kie-ai-review/ · https://aireiter.com/blog/kie-ai-review-2026 · https://www.bitdoze.com/kie-ai-review/
