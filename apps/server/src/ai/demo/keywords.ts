/**
 * Palabras clave SIN IA (heurística en español) + texto para publicar.
 *
 * Fuentes de candidatos: términos del glosario, nombres propios (mayúscula a mitad de oración), cifras
 * ("tres trucos"), beneficios ("más rápido"), el gancho (primera frase con número o palabra de gancho),
 * el llamado a la acción ("Síguenos…") y temas (palabras de contenido frecuentes o largas, y pares).
 * Cada palabra clave lleva sus apariciones REALES en la transcripción (assetId + índice + tiempo).
 */
import type { Keyword, PublishCopy } from "@autoeditor/shared";
import type { KeywordInput } from "../../services/types.js";
import { findOccurrences, splitPhrases, wordsByAsset, type Phrase, type TWord } from "../shared/transcript.js";
import {
  BENEFIT_WORDS,
  capitalizeFirst,
  CTA_PATTERNS,
  digitsForNumberWords,
  endsSentence,
  hashString,
  HOOK_WORDS,
  isNumberToken,
  limitWords,
  looksLikeCta,
  normalize,
  STOPWORDS_ES,
  stripPunctuation,
  toHashtag,
} from "../shared/text.js";

type Category = Keyword["category"];

interface Candidate {
  text: string;
  norm: string;
  category: Category;
  score: number;
}

const CTA_VERBS = new Set(["siguenos", "sigueme", "suscribete", "comenta", "comparte", "descarga", "visita", "escribenos", "registrate", "compra"]);

const stem = (n: string) => (n.length > 4 && n.endsWith("es") ? n.slice(0, -2) : n.length > 3 && n.endsWith("s") ? n.slice(0, -1) : n);
/** Infinitivos y verbos con pronombre pegado ("reutilizarlo", "editar") no suelen ser buenas palabras clave. */
const isVerbLike = (n: string) => /(ar|er|ir)(lo|la|le|los|las|les|se|nos|me|te)?$/.test(n) && n.length >= 5;
const isContent = (w: TWord) => w.norm.length >= 4 && !STOPWORDS_ES.has(w.norm) && !isNumberToken(w.text) && !CTA_VERBS.has(w.norm);

export function keywordId(text: string): string {
  return `kw-${hashString(normalize(text)).toString(36)}`;
}

/** Frase "gancho": la primera oración (primeros ~10 s) con una cifra o palabra de gancho; si no, la primera. */
export function findHookPhrase(phrases: Phrase[]): { text: string; phrase: Phrase } | null {
  const early = phrases.filter((p) => p.start < 10);
  for (const p of early) {
    const idx = p.words.findIndex((w) => isNumberToken(w.text) || HOOK_WORDS.has(w.norm));
    if (idx >= 0) {
      const from = Math.max(0, isNumberToken(p.words[idx]!.text) ? idx : idx - 1);
      const words = p.words.slice(from).map((w) => stripPunctuation(w.text)).filter(Boolean);
      return { text: limitWords(words.join(" "), 8), phrase: p };
    }
  }
  const first = phrases.find((p) => p.words.length >= 3) ?? phrases[0];
  if (!first) return null;
  return { text: limitWords(first.words.map((w) => stripPunctuation(w.text)).filter(Boolean).join(" "), 8), phrase: first };
}

/** Frase con llamado a la acción (la última que lo parezca). */
export function findCtaPhrase(phrases: Phrase[]): { text: string; phrase: Phrase } | null {
  for (let k = phrases.length - 1; k >= 0; k--) {
    const p = phrases[k]!;
    if (looksLikeCta(p.text)) {
      const n = p.words.map((w) => normalize(w.text));
      const startIdx = Math.max(0, n.findIndex((w) => CTA_PATTERNS.some((re) => re.test(w))));
      const text = limitWords(p.words.slice(startIdx).map((w) => stripPunctuation(w.text)).filter(Boolean).join(" "), 6);
      return { text, phrase: p };
    }
  }
  return null;
}

export function detectKeywordsHeuristic(input: KeywordInput): { keywords: Keyword[]; publishCopy: PublishCopy } {
  const byAsset = wordsByAsset(input.transcripts);
  const allPhrases: Phrase[] = [];
  for (const words of byAsset.values()) allPhrases.push(...splitPhrases(words));
  const cands = new Map<string, Candidate>();
  const add = (text: string, category: Category, score: number) => {
    const clean = text.trim().replace(/\s+/g, " ");
    const norm = normalize(clean);
    if (!norm || norm.length < 2) return;
    const prev = cands.get(norm);
    if (prev) {
      prev.score += score * 0.5;
      // Una categoría más específica gana a "tema".
      if (prev.category === "tema" && category !== "tema") prev.category = category;
    } else cands.set(norm, { text: clean, norm, category, score });
  };

  // 1) Glosario: siempre relevante si aparece.
  for (const g of input.glossary) {
    if (findOccurrences(g.term, byAsset).length) add(g.term, "nombre", 6);
  }

  const instruction = ` ${normalize(input.settings.instruction.text)} `;
  const freq = new Map<string, { count: number; display: string; len: number }>();
  const personNames = new Set<string>();

  for (const words of byAsset.values()) {
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!;
      const prev = words[k - 1];
      const next = words[k + 1];
      const display = stripPunctuation(w.text);
      const sentenceStart = !prev || endsSentence(prev.text);
      // 2) Nombres propios: mayúscula a mitad de oración.
      if (!sentenceStart && /^\p{Lu}/u.test(display) && !STOPWORDS_ES.has(w.norm) && display.length >= 2) {
        add(display, "nombre", 4);
        if (prev && ["soy", "llamo"].includes(prev.norm)) personNames.add(w.norm);
      }
      // 3) Cifras: número + sustantivo siguiente.
      if (isNumberToken(w.text)) {
        const noun = next && isContent(next) ? ` ${stripPunctuation(next.text)}` : "";
        add(`${display}${noun}`, "cifra", noun ? 3.5 : 2);
      }
      // 4) Beneficios: "más/muy/súper + adjetivo" o adjetivo de beneficio.
      if (["mas", "muy", "super"].includes(w.norm) && next && (BENEFIT_WORDS.has(next.norm) || next.norm.length >= 5) && !STOPWORDS_ES.has(next.norm)) {
        add(`${display} ${stripPunctuation(next.text)}`, "beneficio", BENEFIT_WORDS.has(next.norm) ? 3 : 1.5);
      } else if (BENEFIT_WORDS.has(w.norm) && !(prev && ["mas", "muy", "super"].includes(prev.norm))) {
        add(display, "beneficio", 2);
      }
      // 5) Temas: frecuencia por raíz simple.
      if (isContent(w)) {
        const key = stem(w.norm);
        const f = freq.get(key) ?? { count: 0, display: display.toLocaleLowerCase("es"), len: w.norm.length };
        f.count++;
        freq.set(key, f);
      }
    }
  }

  // 6) Pares de palabras de contenido seguidas ("palabras clave", "editar videos"): restan a sus palabras sueltas.
  const inPairs = new Map<string, number>();
  for (const words of byAsset.values()) {
    let k = 0;
    while (k < words.length - 1) {
      const a = words[k]!;
      const b = words[k + 1]!;
      if (isContent(a) && isContent(b) && !endsSentence(a.text) && !/,$/.test(a.text) && b.start - a.end < 0.4 && !isVerbLike(a.norm)) {
        add(`${stripPunctuation(a.text).toLocaleLowerCase("es")} ${stripPunctuation(b.text).toLocaleLowerCase("es")}`, "tema", 3);
        for (const w of [a, b]) inPairs.set(stem(w.norm), (inPairs.get(stem(w.norm)) ?? 0) + 1);
        k += 2;
      } else k++;
    }
  }

  // Temas sueltos: frecuencia + largo (graduado) + instrucción; se castigan verbos/participios y las palabras
  // que solo aparecen dentro del llamado a la acción ("Síguenos para más consejos").
  const ctaEarly = findCtaPhrase(allPhrases);
  const ctaWords = new Set(ctaEarly ? ctaEarly.phrase.words.map((w) => stem(w.norm)) : []);
  for (const [key, f] of freq) {
    const inInstruction = instruction.includes(` ${key}`);
    if (f.count >= 2 || f.len >= 8 || inInstruction) {
      let score = 1 + f.count * 1.5 + (f.len >= 7 ? (f.len - 6) * 0.25 : 0) + (inInstruction ? 2 : 0);
      if (isVerbLike(key)) score -= 1.5;
      else if (/(ad|id)[oa]s?$/.test(key)) score -= 0.75;
      if (ctaWords.has(key) && f.count < 2) score -= 1;
      score -= (inPairs.get(key) ?? 0) * 1;
      add(f.display, "tema", score);
    }
  }

  // 7) Gancho y llamado a la acción.
  const hook = findHookPhrase(allPhrases);
  if (hook && hook.text.split(" ").length >= 2) add(hook.text, "gancho", 4);
  const cta = findCtaPhrase(allPhrases);
  if (cta && cta.text.split(" ").length >= 2) add(cta.text, "cta", 3);

  // Selección: cupos por categoría para que haya variedad.
  const caps: Record<Category, number> = { nombre: 4, cifra: 3, gancho: 1, cta: 1, beneficio: 3, tema: 6, otro: 2 };
  const used: Record<Category, number> = { nombre: 0, cifra: 0, gancho: 0, cta: 0, beneficio: 0, tema: 0, otro: 0 };
  const sorted = [...cands.values()].sort((x, y) => y.score - x.score || x.norm.localeCompare(y.norm));
  const chosen: (Candidate & { occurrences: Keyword["occurrences"] })[] = [];
  for (const c of sorted) {
    if (used[c.category] >= caps[c.category] || chosen.length >= 14) continue;
    const occurrences = findOccurrences(c.text, byAsset);
    if (!occurrences.length) continue;
    used[c.category]++;
    chosen.push({ ...c, occurrences });
  }
  const maxScore = chosen.reduce((m, c) => Math.max(m, c.score), 1);
  const disabledByUser = new Set(input.existing.filter((k) => !k.enabled).map((k) => normalize(k.text)));
  const keywords: Keyword[] = chosen.map((c) => ({
    id: keywordId(c.text),
    text: c.text,
    category: c.category,
    source: "auto",
    enabled: !disabledByUser.has(c.norm),
    occurrences: c.occurrences,
    score: Math.round((c.score / maxScore) * 100) / 100,
  }));

  return { keywords, publishCopy: buildPublishCopy(allPhrases, keywords, personNames, hook?.text ?? null, cta?.text ?? null) };
}

/** Título, descripción, hashtags y texto de portada (solo texto; no se publica desde la app). */
export function buildPublishCopy(phrases: Phrase[], keywords: Keyword[], personNames: Set<string>, hook: string | null, cta: string | null): PublishCopy {
  const sentences = phrases.map((p) => p.text.replace(/\s+([,.!?;:])/g, "$1").trim()).filter(Boolean);
  const titleBase = hook ? capitalizeFirst(digitsForNumberWords(hook)) : sentences[0] ? limitWords(sentences[0], 9) : "";
  const title = titleBase.length > 70 ? `${titleBase.slice(0, 67).trimEnd()}…` : titleBase;
  let description = sentences.slice(0, 2).join(" ");
  if (cta && !normalize(description).includes(normalize(cta))) description += ` ${capitalizeFirst(cta)}.`;
  if (description.length > 220) description = `${description.slice(0, 217).trimEnd()}…`;
  const tagSources = [
    ...keywords.filter((k) => k.category === "nombre" && !personNames.has(normalize(k.text))),
    ...keywords.filter((k) => k.category === "tema"),
    ...keywords.filter((k) => k.category === "beneficio"),
  ];
  const hashtags: string[] = [];
  for (const k of tagSources) {
    const tag = toHashtag(k.text);
    if (tag.length > 2 && !hashtags.some((h) => h.toLowerCase() === tag.toLowerCase())) hashtags.push(tag);
    if (hashtags.length >= 5) break;
  }
  const coverText = hook ? limitWords(digitsForNumberWords(hook), 5).toLocaleUpperCase("es") : title.toLocaleUpperCase("es");
  return { title, description, hashtags, coverText };
}
