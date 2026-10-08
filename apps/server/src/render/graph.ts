/**
 * Constructor incremental del filter_complex de ffmpeg: entradas (`-i` con sus opciones),
 * etiquetas únicas y cadenas legibles (una por línea). Se pasa INLINE a `spawn` (sin shell) y, si
 * pasa de ~100 KB, se escribe a archivo (ver `filterGraphArgs`).
 */

/** Número con pocos decimales y sin notación exponencial (para expresiones y opciones). */
export function num(n: number, decimals = 6): string {
  if (!Number.isFinite(n)) return "0";
  const r = Number(n.toFixed(decimals));
  return Object.is(r, -0) ? "0" : String(r);
}

/** Entero par (requisito de yuv420p). */
export const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export class FilterGraph {
  private readonly inputArgsList: string[][] = [];
  private readonly chains: string[] = [];
  private counter = 0;

  /** Agrega una entrada (opciones previas a `-i` + la ruta) y devuelve su índice. */
  addInput(options: string[], file: string): number {
    this.inputArgsList.push([...options, "-i", file]);
    return this.inputArgsList.length - 1;
  }

  /** Etiqueta única `[prefijoN]` (sin corchetes). */
  label(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  /** `[in1][in2]filtros[out]` */
  chain(inputs: string[], filters: string | string[], output: string): string {
    const f = Array.isArray(filters) ? filters.filter(Boolean).join(",") : filters;
    this.chains.push(`${inputs.map((l) => `[${l}]`).join("")}${f || "null"}[${output}]`);
    return output;
  }

  /** Como `chain` pero con varias salidas (split, asplit…). */
  multi(inputs: string[], filters: string, outputs: string[]): string[] {
    this.chains.push(`${inputs.map((l) => `[${l}]`).join("")}${filters}${outputs.map((l) => `[${l}]`).join("")}`);
    return outputs;
  }

  /** Divide un flujo de video en `n` copias. */
  split(input: string, n: number, kind: "v" | "a" = "v"): string[] {
    if (n <= 1) return [input];
    const outs = Array.from({ length: n }, () => this.label(kind === "v" ? "sp" : "asp"));
    return this.multi([input], `${kind === "v" ? "split" : "asplit"}=${n}`, outs);
  }

  get inputCount(): number {
    return this.inputArgsList.length;
  }

  inputArgs(): string[] {
    return this.inputArgsList.flat();
  }

  toString(): string {
    return this.chains.join(";\n");
  }
}

/** Base de tiempo exacta de 1 fotograma (`30` → `1/30`, `30000/1001` → `1001/30000`). */
export function frameTimebase(fpsArg: string): string {
  const [n, d] = fpsArg.split("/");
  return d ? `${d}/${n}` : `1/${n}`;
}

/** Marca de tiempo = número de fotograma (base exacta, sin redondeos: evita perder el primer cuadro). */
export const frameIndexPts = (fpsArg: string): string[] => [`settb=${frameTimebase(fpsArg)}`, "setpts=N"];
