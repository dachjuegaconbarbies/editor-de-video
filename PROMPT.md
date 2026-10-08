# Autoeditor de video con IA · prompt end-to-end

(📎 AQUÍ VA LA IMAGEN DE REFERENCIA: mi diagrama original. También está en `docs/referencia/diagrama-original.png`)

---

## 0. Cómo vas a trabajar

Eres ingeniero full-stack senior y editor de video profesional. Vas a construir, de principio a fin y en una sola corrida, una aplicación de **edición automática de video** donde **Claude es el editor**. Primero corre en mi computadora; después se va a montar en un servidor e integrar al backend de la página web de **Zyra**.

Reglas de trabajo:

1. **Este documento dice QUÉ hace la app y CÓMO se debe sentir. El CÓMO técnico es tuyo.** Tú eliges stack, librerías, motores de render, transcripción, base de datos y arquitectura. Las herramientas que menciono (HyperFrames, Kie AI, Remotion, etc.) son las que me interesan o ya tengo: úsalas si son la mejor opción; si encuentras algo mejor o más confiable, cámbialo y explícame por qué. Prefiero que funcione al 100% a que siga una herramienta al pie de la letra.
2. **Construye todo end-to-end sin detenerte a pedirme OK.** No me hagas preguntas al inicio. Cuando tengas una duda, elige la opción más sensata, anótala en `docs/DECISIONES.md` y sigue.
3. **Lo que solo yo te puedo dar** (llaves de API, cuentas, licencias) no te detiene: deja esa parte lista, funcionando en modo demo, y anótala en "Lo que necesito de ti" del reporte final.
4. **Antes de programar, lee la documentación actual** de todo lo que vayas a usar (Claude Agent SDK, HyperFrames, Kie AI, Remotion o lo que elijas). Cambian seguido: no confíes en tu memoria. Si usas HyperFrames, instala sus skills para Claude Code (`npx skills add heygen-com/hyperframes`).
5. **No avances con algo roto.** Cierra cada hito con pruebas automáticas, una prueba real con video, capturas de la interfaz revisadas por ti y un commit.
6. Todo en español: interfaz, mensajes, README y reporte.

## 1. Qué es

Una app donde armo un video recorriendo un diagrama de izquierda a derecha:

**subo material → doy contexto (si quiero) → prendo las herramientas que quiero → escribo la instrucción → Claude edita → V1 → corrijo con texto → V2, V3… → exporto → guardo el estilo.**

La próxima vez elijo el estilo, subo material nuevo y sale igual. Y con cada proyecto la app **aprende** mis gustos y deja de repetir errores.

**Camino feliz (lo mínimo):** arrastro mis videos → escribo qué quiero → GENERAR. Todo lo demás es opcional, trae valores por defecto sensatos y solo se despliega si lo pido.

## 2. Diseño y experiencia (prioridad alta)

La interfaz tiene que ser **limpia, bonita e intuitiva**: un producto pulido, no un boceto ni una pizarra saturada. Mi diagrama es referencia de la idea y del lenguaje visual, no un plano para copiar tal cual. Si algo no coincide con la imagen, manda este texto.

**Principios**
- **El flujo es la navegación.** Tarjetas conectadas por flechas, de izquierda a derecha: MATERIAL → CONTEXTO → TRANSCRIPCIÓN → HERRAMIENTAS → INSTRUCCIÓN → (PLAN) → RESULTADO → VERSIONES. Siempre se lee completo, de principio a fin.
- **Divulgación progresiva.** Un interruptor apagado se ve como un chip pequeño sobre la línea ("Guion: no"). Al prenderlo, su nodo se despliega con animación, muestra sus campos y el diagrama crece y se reacomoda solo, sin que nada se encime. Al apagarlo, vuelve a ser chip.
- **Cero configuración obligatoria.** Valores por defecto inteligentes en todo; un usuario nuevo llega a su V1 sin leer instrucciones.
- **Siempre sé dónde estoy.** Arriba, un mini-diagrama de todo el flujo marca la etapa actual y me lleva a cualquiera. Cada nodo muestra su estado (vacío / listo / procesando / error) y qué le falta.
- **Trabajo cómodo.** Zoom y arrastre del lienzo; doble clic abre una tarjeta en vista enfocada (pantalla completa) y Esc regresa al diagrama. Decide tú si conviene lienzo libre, flujo guiado o una mezcla: lo importante es que se sienta como mi diagrama y sea fácil.
- **Todo se puede previsualizar:** miniaturas, reproducir clips, escuchar la música, ver el estilo de subtítulos sobre un fotograma de mi video.
- **Todo se autoguarda,** con deshacer en la configuración. Estados vacíos que explican qué hacer. Atajos de teclado básicos, buen contraste y foco visible.

**Lenguaje visual heredado del diagrama** (afínalo para que se vea premium y con buen contraste)
- Fondo gris claro (#F2F2F2) con cuadrícula sutil.
- Cada etapa es una "tarjeta-pantalla": contenedor vertical redondeado con borde gris oscuro y su título en una etiqueta durazno (#F6D5B3) encima.
- Contenido y notas en post-its amarillos (#FBE88A) con sombra suave.
- Interruptores "TENGO …": píldoras negras con texto blanco.
- Estados ON/OFF: banderines coral (#EE6B6B) en forma de flecha.
- IA y motion graphics: botones morados (#8B7CF0). Los motores agrupados en un recuadro rosa claro (#F6C6C6), cada uno con su ON/OFF.
- Versiones (V1, V2…) y EXPORTAR en verde menta (#BFEFD3); GUARDAR ESTILO y CORRECCIÓN en coral.
- Conectores grises en ángulo recto con flecha; el de la etapa que se está procesando se anima.
- Tipografía sans limpia, etiquetas en mayúsculas.

## 2.1 Dirección actual de la interfaz (pedido del usuario — manda sobre lo anterior)

El diagrama original era solo referencia del flujo; **no hay que copiarlo**. La interfaz debe tener **pocas opciones a la
vista** y funcionar así:

- **La pizarra (fondo gris con cuadrícula) contiene un ESTUDIO: un panel blanco, limpio y centrado** donde pasa todo:
  1. **Arriba, separado, SOLO EL CLIP BASE** — el video principal que se va a editar (normalmente la persona hablando).
     Zona grande para arrastrarlo (o tocar para elegir); si suben varios, se usan en orden como columna del video.
     Se puede quitar/vaciar con un botón. Es lo ÚNICO que va separado arriba.
     - **Si son varios clips desordenados, la app los revisa y los ORDENA sola** (por el sentido de lo que se dice y
       el guion si existe; como apoyo, hora de grabación y nombre del archivo) y muestra el orden sugerido con el
       porqué; el usuario puede reacomodarlos.
     - **Si es una grabación larga sin cortar (p. ej. una hora) o varios clips crudos**, la limpia: detecta tomas
       repetidas de la misma frase y se queda con la mejor (normalmente la última completa), quita arranques en falso,
       silencios, muletillas y tiempos muertos, y arma una edición coherente a la duración pedida.
  2. **Abajo, todo lo demás junto:** otros clips y tomas de apoyo (B-roll), fotos, música, logos, imágenes, efectos y
     **referencias visuales** (imágenes o links con "qué me gusta de esto"). Vaciable.
  3. **"¿Cómo quieres el video?"** (una caja de texto, opcional) + formato y duración en chips.
  4. **Opciones apagadas por defecto que se van habilitando** (subtítulos/estilo de texto, B-roll, música, motion
     graphics, IA…). Con solo subir material y tocar GENERAR, Claude edita en automático.
  5. **GENERAR** → progreso en vivo dentro del estudio → **Resultado**: reproductor del video, **DESCARGAR**, corregir
     con texto. Las versiones (V1 → V2 → V3) aparecen a la derecha del estudio sobre la pizarra, conectadas con la
     corrección sobre la flecha.
- Real, no simulado: el usuario sube SU media, genera SUS videos, ve el resultado en tiempo real y lo descarga.

### Estilo de texto de referencia (`docs/referencia/estilos/`)
- **Cinético mixto** (`antes-despues-cinetico.jpg`, `serif-mas-bold-remodel.jpg`, `cursiva-color-mas-bold-cerca.jpg`):
  frases cortas centradas en el tercio medio, apiladas en 2–3 líneas; palabras de entrada pequeñas en una fuente ligera o
  serif, y la **palabra clave GRANDE** en una display gruesa (blanca con brillo suave o en color de marca) o en cursiva
  serif de color; punch-in (zoom) en la palabra clave.
- **Título script** (`titulo-script-cafesito.jpg`): títulos en letra script/cursiva elegante con sombra suave sobre
  B-roll, en el tercio superior.
- Formato vertical 9:16 respetando las **zonas seguras** de Reels/TikTok (`reels-zonas-seguras.jpg`).

## 3. Inicio

- **Nuevo desde cero**, **Usar un estilo** y proyectos recientes con miniatura.
- Con estilo, el diagrama arranca corto: ESTILO → MATERIAL → interruptores ya precargados (todo editable) → INSTRUCCIÓN (opcional) → GENERAR.

## 4. El flujo, etapa por etapa

### 4.1 MATERIAL (obligatorio)
Zonas de arrastre por categoría a la izquierda, conectadas al contenedor "Material":
- **Material en crudo:** videos (cada uno marcable como "debe aparecer" u "opcional"), fotos y notas de voz.
- **Elementos del video:** música, efectos de sonido propios, imágenes, gráficos y logos extra, videos que quiero que aparezcan.
- Cada archivo con miniatura, duración, peso y una nota opcional ("abre con este").
- Acepta lo que sale de un celular o una cámara (vertical u horizontal, distintos códecs y framerates) y archivos pesados, con barra de progreso.
- El análisis (transcripción, escenas, calidad de audio) arranca en segundo plano al subir, sin esperar a GENERAR.
- **Detección de B-roll:** el análisis clasifica cada toma como A-roll (alguien hablando) o B-roll (toma de apoyo: paisaje, producto, detalle, ambiente) y marca los fragmentos aprovechables como B-roll, para usarlos de fondo de las tomas o como cortes sobre lo que se dice.

### 4.2 CONTEXTO (opcional; cada nodo con su interruptor "TENGO …")
- **TENGO GUION** → subir PDF / DOCX / TXT o pegar texto. Claude lo sigue como estructura (orden, textos en pantalla, subtítulos). Apagado: Claude arma la estructura solo.
- **TENGO IDENTIDAD DE MARCA** → logos (variantes), tipografías (archivos o Google Fonts), paleta (hex + selector), cortinillas / intro / outro, transiciones y plantillas de cintillos. Las marcas se guardan en una biblioteca para reusarlas (voy a manejar varias). Apagado: estilo neutro y limpio.
- **TENGO REFERENCIAS VISUALES** → recuadro grande para imágenes o videos de referencia y botones "+ LINK DE RED SOCIAL" y "+ PÁGINA WEB", cada uno con un campo "qué me gusta de esto". Claude saca ritmo, estilo de textos, colores y transiciones. Si un link no se puede analizar, pide capturas o el archivo; no descargues contenido de redes contra sus términos.

### 4.3 TRANSCRIPCIÓN, SUBTÍTULOS Y PALABRAS CLAVE
Aparece en cuanto subo material con voz.
- **Transcripción automática** de todo lo que tenga voz: palabra por palabra con tiempos exactos, puntuación, detección de idioma (español por default, sin romperse con spanglish o términos en inglés) y separación por hablante cuando haya varios.
- **Transcripción editable y sincronizada con el video:** clic en una palabra salta a ese momento. Corrijo palabras (nombres propios, marcas, términos técnicos) y esas correcciones se guardan en mi **glosario**, para que en los siguientes videos ya salgan bien.
- **Marcas desde el texto:** selecciono frases y las marco como "quitar", "debe ir" o "resaltar". Claude las respeta.
- **Palabras clave:** Claude detecta palabras y frases clave (tema, nombres, cifras, beneficios, llamado a la acción, el gancho) y me las muestra como chips editables (agrego, quito, cambio). Se usan para:
  - resaltarlas en los subtítulos;
  - decidir dónde van motion graphics, zooms, SFX y títulos en pantalla;
  - elegir b-roll o escribir los prompts de imágenes y videos con IA;
  - sugerir título, descripción, hashtags y portada para publicar (solo el texto; no publico desde la app).
- **Subtítulos** (con su ON/OFF):
  - Estilos: palabra por palabra (tipo karaoke), por frase o por bloque; tipografía, tamaño, colores, contorno o fondo, mayúsculas, emojis opcionales y animación de entrada.
  - Palabras clave resaltadas (color de marca, escala o animación).
  - Posición dentro de las zonas seguras de cada plataforma (que no los tape la interfaz de TikTok, Reels o Shorts) y máximo de caracteres por línea.
  - Vista previa en vivo sobre un fotograma de mi video.
  - Opcional: subtítulos traducidos a otro idioma.
  - Exportar quemados en el video y/o como archivo aparte (.srt y .vtt), además de la transcripción en texto.

### 4.4 ELEMENTOS Y HERRAMIENTAS
Paleta flotante arriba (como los botones morados de mi diagrama): cada botón agrega o quita su nodo en esta etapa, con su banderín ON/OFF.
- **Edición:** quitar silencios y muletillas, ritmo (lento / medio / rápido), transiciones, zooms y punch-ins, reencuadre automático a vertical siguiendo a quien habla, corrección de color.
- **B-roll automático:** usa los fragmentos detectados como B-roll (o generados con IA) de fondo o como corte sobre lo que se dice: pantalla completa, de fondo con la persona en un recuadro, o en recuadro. Fuente: mi material, IA o ambos; frecuencia baja / media / alta.
- **Texto:** subtítulos (4.3), títulos en pantalla, cintillos (nombre / cargo), llamado a la acción final.
- **Audio:** música (mía o de biblioteca), SFX automáticos (whoosh en cortes, golpes en textos; de mi biblioteca o generados con IA), bajar la música cuando alguien habla, volumen parejo, limpieza de voz y voz en off con IA.
- **MOTION GRAPHICS** → modo AUTOMÁTICO (Claude decide qué y dónde) o MANUAL (yo describo cada uno y su momento). Motores en el recuadro rosa, cada uno con su ON/OFF: HyperFrames es mi preferido; Remotion u otro, opcional.
- **IA IMÁGENES** → máximo de imágenes, estilo y uso (b-roll, fondos, portada).
- **IA VIDEOS** → máximo de clips, duración y modelo.
- La generación con IA (imágenes, video, SFX, voz) va con **Kie AI**, que es el proveedor que tengo (su skill se instala con `npx skills add https://kie.ai`), pero detrás de una capa que permita cambiar de proveedor. Si no hay créditos, la app lo dice claro y sigue sin esa parte. Prender IA IMÁGENES, IA VIDEOS, SFX con IA o voz con IA prende Kie AI en el recuadro de motores. Kie AI cambia modelos y precios seguido: léelos de una configuración editable, nunca fijos en el código.

### 4.5 INSTRUCCIÓN PARA CLAUDE
- Caja de texto grande "Describe el video que quieres", con ejemplos que puedo tocar para empezar.
- Selectores rápidos: formato (9:16, 1:1, 4:5, 16:9), plataforma y tono.
- **Duración del video final:** atajos 15 / 30 / 45 / 60 / 90 s, libre o personalizada, con modo automático (Claude decide según el material), aproximada (±15 %) o exacta (±0.5 s). Claude la respeta y la revisión de calidad la verifica.
- Resumen de lo que Claude va a usar: material, contexto, herramientas prendidas y lo aprendido de mí que aplica.
- **Tiempo estimado y costo estimado** (Claude + Kie AI): un rango tipo "6–9 min" que se recalcula al prender o apagar cualquier cosa, con desglose por paso. Se recalibra solo con los tiempos reales de cada render.
- Avisos antes de generar si algo no cuadra (ej. pido 60 s y solo hay 20 s de material).
- Interruptor "Revisar plan antes de renderizar" y botón **GENERAR**.

### 4.6 PLAN DE EDICIÓN (solo si prendí "Revisar plan")
Storyboard de Claude: escenas, duración, clips, textos, subtítulos, música, gráficos y lo que se va a generar con IA (con sus prompts y costo). Lo apruebo o pido ajustes con texto antes del render, para no gastar tiempo ni créditos en un video mal planteado.

### 4.7 PROCESO
- El diagrama se ilumina etapa por etapa: Analizando material → Transcribiendo → Planeando edición → Generando con IA → Motion graphics → Render → Revisión de calidad.
- Barra de progreso con tiempo transcurrido y restante. Puedo cerrar la pestaña y regresar, y puedo cancelar.
- Si un paso falla, lo dice claro, permite reintentar y no se pierde lo demás.

### 4.8 RESULTADO Y VERSIONES
- Tarjeta **V1** con el video (vertical u horizontal según el formato) y debajo: **EXPORTAR**, **GUARDAR ESTILO**, una caja de **CORRECCIÓN** y 👍 / 👎.
- Una corrección puede ser texto general ("cambia la tipografía por una más bonita", "no usaste la tipografía que te pedí") o anclada a un momento: pauso el video, toco y escribo ("aquí quita este corte").
- Al mandarla aparece **V2** a la derecha, conectada desde V1 con la corrección escrita sobre la flecha: V1 → V2 → V3…
- **REGLA DE ORO: una corrección SOLO cambia lo que pido.** Material, cortes, textos, música y ajustes se quedan idénticos. Debe ser comprobable comparando las versiones.
- Si una corrección es ambigua, Claude pregunta antes de renderizar.
- Cada versión dice "qué cambió". Puedo volver a cualquier versión, corregir desde ahí y comparar dos lado a lado, sincronizadas. Las versiones viejas se apilan para no saturar el lienzo.
- **Exportar:** resolución y calidad, subtítulos aparte (.srt / .vtt), portada y textos para publicar.

### 4.9 GUARDAR ESTILO Y REUSARLO
- **GUARDAR ESTILO** (desde cualquier versión) → nombre + qué incluir: marca, tipografías, colores, música, transiciones, plantillas de motion graphics, ritmo, estilo de subtítulos y palabras clave, intro / outro, herramientas prendidas e instrucción base.
- Claude escribe una **ficha de reglas del estilo**, sacada del video final Y de todas mis correcciones (ej. "títulos siempre en X y en mayúsculas", "un corte cada ~1.5 s"), para no repetir errores.
- Se guarda como preset reutilizable (con sus assets y plantillas) y también como **Skill de Claude** (carpeta con SKILL.md + assets + plantillas) que el editor carga y que puedo exportar e importar.
- **Debe salir igual:** mismas plantillas y reglas; solo cambia el contenido. De lo generado con IA guarda prompts, modelos y semillas.
- Si corrijo un video hecho con un estilo, me ofrece "Actualizar estilo" o "Guardar como estilo nuevo". Los estilos tienen versiones.

## 5. Que la app aprenda conmigo

"Entrenar" aquí no es reentrenar el modelo: es una **memoria persistente** que Claude consulta antes de cada edición y que mejora con cada proyecto.
- **Capas:** mis gustos generales, por marca o cliente y por estilo.
- **Aprende de:** mis correcciones (sobre todo las que repito), el glosario de transcripción, las palabras clave que agrego o quito, las versiones que exporto (aprobadas) contra las que descarto, los 👍 / 👎, los planes que apruebo o ajusto y los tiempos reales de render.
- Claude convierte eso en **reglas cortas y verificables** ("subtítulos siempre en mayúsculas", "nunca transiciones de zoom", "Zyra se escribe así").
- Después de una corrección me pregunta con un toque: "¿Lo recuerdo? Solo este proyecto / este estilo / siempre".
- Panel **"Lo que Claude aprendió"**: veo cada regla y de dónde salió, y puedo editarla, apagarla o borrarla. Nada se aprende sin que lo pueda revisar.
- Antes de entregarme una versión, Claude la revisa contra esas reglas para no repetir errores.
- Una métrica simple que muestre si cada vez necesito menos correcciones por video.

## 6. Claude como editor

- El editor es **Claude Opus 5.5** (`claude-opus-5-5`), configurable. Para tareas simples (describir fotogramas, clasificar) puedes usar un modelo más barato como `claude-sonnet-5-5`, también configurable.
- Claude debe editar como trabaja en Claude Code: revisa el material (fotogramas, transcripción, audio), planea, arma la edición, escribe plantillas de motion graphics, **mira fotogramas de su propio render**, detecta errores (texto cortado, subtítulo fuera de zona segura, tipografía equivocada, audio saturado, palabra cortada a la mitad) y se corrige antes de entregarme.
- Criterio de editor profesional: gancho en los primeros segundos, cortes con ritmo y a tiempo con la música, respeta lo marcado como "debe aparecer" y no inventa datos en pantalla.
- **Cada versión tiene una "receta" completa y estructurada** (tú diseñas el formato) de la que el video sale igual cada vez que se renderiza. Es la fuente de verdad para correcciones, comparaciones y estilos.
- Una corrección es un cambio mínimo sobre la receta + un resumen de lo que cambió. Re-renderiza solo lo que cambió cuando se pueda.
- Los estilos guardados se cargan como Skills de Claude.

## 7. Requisitos técnicos no negociables

(Es el "qué", no el "cómo": cómo cumplirlos lo decides tú.)
- Corre en mi computadora con un comando para instalar y otro para arrancar; dime qué necesito tener instalado. Después debe poder ir a un servidor sin reescribirse.
- **Independiente, modular y API-first:** todo lo que hace la interfaz también se puede hacer por una API documentada; el editor se puede montar como componente o ruta dentro de otra app (Zyra).
- **Listo para integrar:** cada registro con dueño (owner_id), nada de rutas de archivo fijas, base de datos y almacenamiento de archivos intercambiables (local ahora, nube después).
- Trabajos largos en segundo plano con progreso en vivo, que sobrevivan a recargar la página.
- Llaves (ANTHROPIC_API_KEY, KIE_API_KEY y las que hagan falta) solo en el backend (.env). **Ninguna llega al navegador.**
- **Modo demo sin llaves:** la app se puede recorrer de punta a punta sin gastar créditos, para probar la interfaz y el flujo.
- Modelos, precios y proveedores en una configuración editable sin tocar código.
- Después de cada render, muestra el costo y el tiempo reales junto al estimado.
- **Remotion** pide licencia de empresa a partir de 4 personas y, para renders automatizados, comprar "Renders". Si lo usas, déjalo opcional y apagado por default, y explícame en el README qué implica.

## 8. Cómo construirlo

1. Investiga, decide el stack y escribe `docs/DECISIONES.md` (qué elegiste, por qué y qué descartaste) y `docs/PLAN.md` con los hitos.
2. Orden sugerido de hitos, sin detenerte entre ellos:
   1. Interfaz y lenguaje visual con datos de prueba: todos los nodos, interruptores, desplegar / colapsar y reacomodo.
   2. Backend: proyectos, subida de archivos, autoguardado y estimador de tiempo.
   3. Primer video real: análisis + transcripción + plan de Claude + render (cortes, música, subtítulos) → V1.
   4. Palabras clave, motion graphics, identidad de marca, IA con Kie AI y SFX.
   5. Correcciones y versiones: cambio mínimo, "qué cambió", comparar.
   6. Estilos y aprendizaje: ficha de reglas, Skill exportable, nuevo video desde estilo, glosario y panel de lo aprendido.
   7. Pulido: progreso en vivo, errores y reintentos, calibración de tiempos y documentación.
3. Al cerrar cada hito: pruebas automáticas, prueba real con material de prueba, capturas de la interfaz en un navegador revisadas por ti con ojo de diseñador (itera hasta que se vea bien) y commit.
4. Material de prueba: consigue o genera tú material libre de derechos, con al menos un clip con voz en español, para probar todo de punta a punta.

## 9. Entregables

- La app corriendo en mi computadora con un comando.
- README en español: instalación, cómo configurar las llaves, uso paso a paso, cómo probar cada criterio de aceptación y cómo integrarla a Zyra (API, montaje del componente, paso a base de datos y almacenamiento en la nube).
- Documentación de la API.
- `docs/DECISIONES.md`.
- Reporte final honesto: qué probaste y con qué evidencia (capturas y un video de ejemplo generado), qué funciona, qué no, limitaciones y "Lo que necesito de ti".

## 10. Fuera de alcance por ahora

- Editor manual tipo Premiere con línea de tiempo arrastrable.
- Publicar directo en redes sociales.
- Varias personas editando el mismo proyecto al mismo tiempo.

## 11. Criterios de aceptación (compruébalos tú antes de decir que terminaste)

- Con solo material + instrucción sale un V1 con subtítulos sincronizados que se reproduce y se descarga.
- Un usuario nuevo llega de "subir videos" a "V1" sin instrucciones y sin configurar nada.
- Prender o apagar cualquier interruptor despliega o colapsa su nodo y el diagrama se reacomoda sin encimarse.
- La transcripción tiene tiempos por palabra; si corrijo una palabra, se guarda en el glosario y la siguiente transcripción ya la escribe bien.
- Las palabras clave se detectan, se pueden editar y salen resaltadas en los subtítulos; los subtítulos se exportan en .srt y .vtt.
- Una corrección cambia únicamente lo pedido (comprobable comparando las recetas de V1 y V2).
- Una regla aprendida (ej. una tipografía que corregí) se aplica sola en el siguiente proyecto sin volver a pedirla.
- Un estilo guardado + material nuevo da un video con la misma tipografía, colores, ritmo, transiciones, subtítulos y gráficos, sin volver a llenar el contexto.
- Con material que tiene A-roll y B-roll, el análisis distingue las tomas y el B-roll aparece de fondo o como corte sobre la voz.
- Si pido una duración exacta (p. ej. 30 s), el video final dura eso (±0.5 s); en modo aproximado, ±15 %.
- El tiempo estimado aparece antes de generar y, después de 5 renders, queda a ±30% del real.
- Ninguna llave de API llega al navegador.
