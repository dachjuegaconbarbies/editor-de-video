# Fuentes de fábrica

Estas fuentes vienen incluidas para que subtítulos, textos y gráficos se vean bien sin depender de las
fuentes del sistema. Todas son libres bajo la **SIL Open Font License 1.1 (OFL)**: se pueden usar,
incrustar en videos y redistribuir con el programa, siempre que la licencia las acompañe (texto completo
en [`OFL.txt`](OFL.txt)) y que no se vendan solas.

Se descargaron como TTF estáticos desde la API CSS de Google Fonts (`fonts.googleapis.com/css2?family=…`,
pedida sin User-Agent de navegador, que así responde TTF).

| Familia | Archivos (peso) | Copyright | Proyecto |
|---|---|---|---|
| Inter | `Inter-400/500/600/700/800/900.ttf` | Copyright 2016 The Inter Project Authors | https://github.com/rsms/inter |
| Montserrat | `Montserrat-500/700/800/900.ttf` | Copyright 2011 The Montserrat Project Authors | https://github.com/JulietaUla/Montserrat |
| Poppins | `Poppins-500/700/800.ttf` | Copyright 2020 The Poppins Project Authors | https://github.com/itfoundry/Poppins |
| Anton | `Anton-400.ttf` | Copyright 2020 The Anton Project Authors | https://github.com/googlefonts/AntonFont |
| Bebas Neue | `BebasNeue-400.ttf` | Copyright 2019 The Bebas Neue Project Authors | https://github.com/dharmatype/Bebas-Neue |

Notas:

- libass busca las fuentes por su **nombre completo** (p. ej. «Inter ExtraBold»); el render lo lee de la
  tabla `name` de cada archivo (`apps/server/src/render/fonts.ts`), así que se pueden agregar más TTF/OTF
  aquí sin tocar código.
- Si una receta pide una familia de Google Fonts que no está aquí, el servidor la descarga una vez a
  `data/fonts-cache/` (las fuentes de Google Fonts también son OFL o Apache 2.0).
- Las fuentes que sube cada persona (`FontRef.assetId`) son responsabilidad de quien las sube.
