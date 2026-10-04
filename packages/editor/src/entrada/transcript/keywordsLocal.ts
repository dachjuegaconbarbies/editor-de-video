/**
 * Detección LOCAL de palabras clave (heurística, sin IA). La usa la demostración sin servidor para
 * que "Detectar de nuevo" haga algo real con la transcripción; el servidor usa a Claude.
 * Categorías: gancho, cta, cifra, nombre, beneficio y tema. Se conservan las que agregó la persona.
 */
import type { Keyword, PublishCopy, Transcript } from "@autoeditor/shared";
import { splitPunctuation, wordKey } from "./model.js";

const STOP = new Set(
  "a al algo ante antes aqui asi aun bien cada como con cual cuando de del desde donde dos el ella ellos en entre era es esa ese eso esta este esto estos fue ha hace hacemos hasta hay hoy la las le les lo los luego mas me mi mis muy nada ni no nos nuestra nuestro o otra otro para pero poco por porque que quien se sea ser si sin sobre solo son su sus tambien te tiene todo todos tu tus un una uno unos y ya yo eh este pues bueno listo cuando".split(
    " ",
  ),
);

const CTA_START = /^(visitanos|siguenos|suscribete|escribenos|compra|compralo|comenta|comparte|descarga|registrate|pruebalo|llamanos|agenda|reserva|pidelo|unete|dale|guarda)$/;
const NUMBER_WORDS = /^(\d+([.,]\d+)?%?|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|cien|cientos|mil|millon|millones|medio|media)$/;
const UNITS = /^(minutos?|segundos?|horas?|dias?|semanas?|meses|anos?|pasos?|veces|pesos|dolares|por ?ciento|%|kilos?|litros?|tazas?|personas|clientes)$/;
const BENEFITS = ["paso a paso", "en menos de", "facil", "rapido", "gratis", "sin esfuerzo", "ahorra", "mejor", "natural", "casero", "garantizado"];

const capitalized = (s: string) => /^\p{Lu}/u.test(s);

interface Candidate {
  text: string;
  category: Keyword["category"];
  score: number;
}

function sentencesOf(words: { text: string }[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w.text);
    if (/[.!?…]$/.test(w.text)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const clean = (s: string) => splitPunctuation(s)[1];

export function detectKeywordsLocal(transcripts: Pick<Transcript, "words" | "status">[], existing: Keyword[] = []): { keywords: Keyword[]; publishCopy: PublishCopy } {
  const ready = transcripts.filter((t) => t.status === "listo" && t.words.length);
  const cands: Candidate[] = [];
  const allWords = ready.flatMap((t) => t.words);
  const sentences = ready.flatMap((t) => sentencesOf(t.words));

  // Gancho: la primera frase si es pregunta (o empieza con "¿"), recortada.
  const first = sentences[0];
  if (first && (first[0]!.startsWith("¿") || /\?$/.test(first[first.length - 1]!))) {
    const head = first.slice(0, Math.min(3, first.length)).map(clean).join(" ");
    cands.push({ text: `¿${head.charAt(0).toUpperCase()}${head.slice(1)}…?`, category: "gancho", score: 1 });
  } else if (first) {
    cands.push({ text: first.slice(0, Math.min(4, first.length)).map(clean).join(" "), category: "gancho", score: 0.7 });
  }

  for (let p = 0; p < allWords.length; p++) {
    const raw = allWords[p]!.text;
    const k = wordKey(raw);
    const next = allWords[p + 1];
    const nextKey = next ? wordKey(next.text) : "";
    // Llamado a la acción: verbo + hasta 3 palabras (hasta la puntuación).
    if (CTA_START.test(k)) {
      const parts = [clean(raw)];
      for (let j = 1; j <= 3 && p + j < allWords.length; j++) {
        const t = allWords[p + j - 1]!.text;
        if (/[.,!?;:]$/.test(t)) break;
        parts.push(clean(allWords[p + j]!.text));
      }
      cands.push({ text: parts.join(" ").toLowerCase(), category: "cta", score: 0.9 });
    }
    // Cifras: número + unidad.
    if (NUMBER_WORDS.test(k) && !/^(una?|uno)$/.test(k)) {
      cands.push({ text: next && UNITS.test(nextKey) ? `${clean(raw)} ${clean(next.text)}` : clean(raw), category: "cifra", score: 0.85 });
    }
    // Nombres propios: mayúscula que no abre frase.
    const prev = allWords[p - 1];
    const opensSentence = !prev || /[.!?…]$/.test(prev.text) || raw.startsWith("¿") || raw.startsWith("¡");
    if (!opensSentence && capitalized(clean(raw)) && clean(raw).length > 2) cands.push({ text: clean(raw), category: "nombre", score: 0.8 });
  }

  // Beneficios conocidos.
  const joined = allWords.map((w) => wordKey(w.text)).join(" ");
  for (const b of BENEFITS) if (joined.includes(b)) cands.push({ text: b === "facil" ? "fácil" : b === "rapido" ? "rápido" : b, category: "beneficio", score: 0.75 });

  // Temas: bigramas y palabras frecuentes (sin palabras vacías).
  const freq = new Map<string, { text: string; n: number }>();
  const bump = (key: string, text: string, w = 1) => {
    const cur = freq.get(key);
    freq.set(key, { text: cur?.text ?? text, n: (cur?.n ?? 0) + w });
  };
  for (let p = 0; p < allWords.length; p++) {
    const a = wordKey(allWords[p]!.text);
    if (a.length < 4 || STOP.has(a)) continue;
    bump(a, clean(allWords[p]!.text).toLowerCase());
    const b1 = allWords[p + 1];
    const b2 = allWords[p + 2];
    // "café de olla": palabra + de + palabra.
    if (b1 && b2 && wordKey(b1.text) === "de" && wordKey(b2.text).length >= 3 && !STOP.has(wordKey(b2.text)) && !/[.,!?]$/.test(allWords[p]!.text) && !/[.,!?]$/.test(b1.text)) {
      bump(`${a} de ${wordKey(b2.text)}`, `${clean(allWords[p]!.text)} de ${clean(b2.text)}`.toLowerCase(), 2.5);
    }
  }
  const temas = [...freq.values()].filter((f) => f.n >= 2 || f.text.includes(" de ")).sort((x, y) => y.n - x.n).slice(0, 3);
  for (const t of temas) cands.push({ text: t.text, category: "tema", score: Math.min(1, 0.5 + t.n / 10) });

  // Une: primero las de la persona, luego las detectadas (sin repetir textos).
  const user = existing.filter((k) => k.source === "usuario");
  const seen = new Set(user.map((k) => wordKey(k.text.replace(/[¿?…]/g, " "))));
  const out: Keyword[] = [...user];
  let n = 0;
  for (const c of cands) {
    const key = wordKey(c.text.replace(/[¿?…]/g, " "));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const prev = existing.find((k) => wordKey(k.text.replace(/[¿?…]/g, " ")) === key);
    out.push({ id: prev?.id ?? `kd-${Date.now().toString(36)}-${n++}`, text: c.text, category: c.category, source: "auto", enabled: prev?.enabled ?? true, occurrences: [], score: c.score });
    if (out.length >= 14) break;
  }

  const tema = out.find((k) => k.category === "tema")?.text ?? "";
  const gancho = out.find((k) => k.category === "gancho")?.text ?? "";
  const description = sentences
    .slice(0, 2)
    .map((s) => s.join(" "))
    .join(" ")
    .slice(0, 180)
    .trim();
  const publishCopy: PublishCopy = {
    title: tema ? `${tema.charAt(0).toUpperCase()}${tema.slice(1)}: lo que nadie te cuenta` : "Mira esto",
    description,
    hashtags: out
      .filter((k) => k.category === "tema" || k.category === "nombre")
      .slice(0, 4)
      .map((k) => `#${wordKey(k.text).replace(/[^a-z0-9]+/g, "")}`)
      .filter((h) => h.length > 2),
    coverText: (gancho || tema).toUpperCase(),
  };
  return { keywords: out, publishCopy };
}
