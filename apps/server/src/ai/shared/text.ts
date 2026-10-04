/**
 * Utilidades de texto en español: normalización, palabras vacías, números, muletillas y llamados a la acción.
 * Todo es determinista (sin IA) y lo comparten el editor demo, los prompts y las pruebas.
 */

/** Minúsculas, sin acentos ni puntuación (conserva % y $). */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}%$]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normaliza una sola palabra (sin espacios). */
export function normWord(s: string): string {
  return normalize(s).replace(/\s+/g, "");
}

/** Quita la puntuación pegada al inicio/fin de una palabra ("¿Zyra," → "Zyra"). */
export function stripPunctuation(s: string): string {
  return s.replace(/^[^\p{L}\p{N}%$#@]+|[^\p{L}\p{N}%$]+$/gu, "");
}

/** ¿La palabra termina una oración? */
export function endsSentence(text: string): boolean {
  return /[.!?…]["»”']?$/.test(text.trim());
}

/** Hash FNV-1a de 32 bits (ids y semillas deterministas). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Palabras vacías del español (no aportan como palabra clave). */
export const STOPWORDS_ES = new Set(
  (
    "a al algo algun alguna algunas alguno algunos ante antes aqui asi aun aunque bajo bien cada casi como con contra cual cuales cuando " +
    "de del desde donde dos el ella ellas ello ellos en entre era eran eres es esa esas ese eso esos esta estaba estado estan estar estas este esto estos " +
    "estoy fue fueron ha hace hacen hacer hacia han has hasta hay he hoy la las le les lo los mas me mi mis mucho muchos muy nada ni no nos nosotros " +
    "o os otra otras otro otros para pero poco por porque que quien quienes se sea ser si sin sobre sois solo somos son soy su sus tambien tan tanto te " +
    "tenemos tener tengo ti tiene tienen todo todos tu tus un una unas uno unos usted ustedes va vamos van voy y ya yo " +
    "hola gracias bueno pues entonces ahora aqui alli eh em mmm este osea tipo digamos verdad ok okay vale " +
    "primero segundo tercero cuarto quinto ultimo luego despues ademas finalmente tambien siempre nunca vez veces cosa cosas manera forma " +
    "hoy ayer manana dia dias ano anos mes meses semana semanas momento tiempo poder puede puedes pueden quiero quieres quiere ver dar decir dice " +
    "les nuestra nuestro nuestras nuestros tuya tuyo vuestra vuestro mio mia esto eso aquello asi tal cual cuanto cuanta cuantos cuantas"
  ).split(/\s+/),
);

/** Números escritos en español → valor. */
export const NUMBER_WORDS: Record<string, number> = {
  cero: 0, uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, quinientos: 500, mil: 1000, millon: 1_000_000, millones: 1_000_000,
};

/** ¿Es una cifra? (dígitos, porcentaje, dinero o número escrito; "un/una/uno" no cuentan solos). */
export function isNumberToken(word: string): boolean {
  const n = normWord(word);
  if (!n) return false;
  if (/\d/.test(n)) return true;
  return n in NUMBER_WORDS && !["un", "una", "uno"].includes(n);
}

/** Muletillas que siempre se pueden quitar. */
export const STRONG_FILLERS = new Set(["eh", "ehh", "ehhh", "em", "emm", "emmm", "mm", "mmm", "mmmm", "ah", "ahh", "esteee", "esteeee", "eeeh", "eeh", "uhm", "um", "uh"]);
/** Muletillas ambiguas: solo se quitan si están aisladas (coma o pausa alrededor). */
export const AMBIGUOUS_FILLERS = new Set(["este", "pues", "bueno", "osea", "tipo", "digamos", "verdad", "no", "vale", "sea", "entonces"]);

/** Verbos y frases típicas de un llamado a la acción. */
export const CTA_PATTERNS = [
  /\bsiguenos\b/, /\bsigueme\b/, /\bsuscribete\b/, /\bsuscribanse\b/, /\bcomenta\b/, /\bcomparte\b/, /\bdale like\b/, /\blink\b/,
  /\benlace\b/, /\bdescarga\b/, /\bvisita\b/, /\bescribenos\b/, /\bescribeme\b/, /\bcompra\b/, /\bregistrate\b/, /\bcampanita\b/,
  /\bguarda este\b/, /\bmandame\b/, /\bcontactanos\b/, /\bagenda\b/,
];

export function looksLikeCta(text: string): boolean {
  const n = normalize(text);
  return CTA_PATTERNS.some((re) => re.test(n));
}

/** Palabras que suelen anunciar un beneficio ("más rápido", "gratis", "fácil"…). */
export const BENEFIT_WORDS = new Set([
  "rapido", "rapida", "facil", "facilmente", "gratis", "ahorra", "ahorrar", "mejor", "mejores", "simple", "sencillo", "profesional",
  "potente", "seguro", "barato", "economico", "eficiente", "automatico", "automatica", "efectivo", "increible", "unico", "exclusivo",
]);

/** Palabras que suelen marcar un gancho ("trucos", "secreto", "error"…). */
export const HOOK_WORDS = new Set([
  "truco", "trucos", "secreto", "secretos", "error", "errores", "consejo", "consejos", "tip", "tips", "claves", "pasos", "nunca", "deja",
  "descubre", "aprende", "como", "por que", "porque", "mejor", "peor", "verdad", "mito", "mitos", "increible",
]);

/** Primera letra en mayúscula. */
export function capitalizeFirst(s: string): string {
  return s.length ? s.charAt(0).toLocaleUpperCase("es") + s.slice(1) : s;
}

/** Recorta un texto a `maxWords` palabras (sin puntuación final colgando). */
export function limitWords(s: string, maxWords: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  const cut = words.slice(0, maxWords).join(" ");
  return cut.replace(/[,;:.…\s]+$/u, "");
}

/** "tres trucos" → "3 trucos" (convierte números escritos a dígitos; no inventa nada). */
export function digitsForNumberWords(s: string): string {
  return s
    .split(/(\s+)/)
    .map((tok) => {
      const n = normWord(tok);
      const v = NUMBER_WORDS[n];
      if (v === undefined || ["un", "una", "uno"].includes(n)) return tok;
      const [, pre = "", , post = ""] = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(tok) ?? [];
      return `${pre}${v}${post}`;
    })
    .join("");
}

/** Texto a hashtag: "edición de video" → "#EdicionDeVideo". */
export function toHashtag(s: string): string {
  const words = normalize(s)
    .split(" ")
    .filter((w) => w && !STOPWORDS_ES.has(w));
  if (!words.length) return "";
  return "#" + words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Lee un tiempo escrito en la corrección: "0:12", "1:05.5", "en el segundo 12", "12 s", "12.5 segundos". */
export function parseTimeMention(text: string): number | null {
  const mmss = /(\d{1,2}):(\d{2})(?:[.,](\d+))?/.exec(text);
  if (mmss) {
    const frac = mmss[3] ? Number(`0.${mmss[3]}`) : 0;
    return Number(mmss[1]) * 60 + Number(mmss[2]) + frac;
  }
  const sec = /(?:segundo|seg\.?)\s+(\d+(?:[.,]\d+)?)/i.exec(text) ?? /(\d+(?:[.,]\d+)?)\s*(?:s\b|seg\b|segs\b|segundos?\b)/i.exec(text);
  if (sec?.[1]) return Number(sec[1].replace(",", "."));
  return null;
}

/** Lee una duración pedida: "que dure 30 segundos", "de 45 s", "un minuto", "1:30". */
export function parseDurationMention(text: string): number | null {
  const n = normalize(text);
  if (/\bmedio minuto\b/.test(n)) return 30;
  if (/\bun minuto\b/.test(n)) return 60;
  const min = /(\d+(?:[.,]\d+)?)\s*(?:min|minutos?)\b/.exec(n);
  if (min?.[1]) return Number(min[1].replace(",", ".")) * 60;
  const mmss = /(\d{1,2}):(\d{2})/.exec(text);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const sec = /(\d+(?:[.,]\d+)?)\s*(?:s|seg|segs|segundos?)\b/.exec(n);
  if (sec?.[1]) return Number(sec[1].replace(",", "."));
  const words = /\b(?:dure|duracion de|de)\s+([a-z]+)\s+segundos?\b/.exec(n);
  if (words?.[1] && NUMBER_WORDS[words[1]] !== undefined) return NUMBER_WORDS[words[1]]!;
  return null;
}
