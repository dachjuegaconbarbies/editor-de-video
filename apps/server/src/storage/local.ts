/**
 * Almacenamiento local de archivos sobre `<dataDir>/storage`, direccionado por CLAVES RELATIVAS.
 *
 * - Las claves se validan: nada de "..", rutas absolutas, barras invertidas ni bytes nulos.
 * - Escritura atómica: se escribe en `<dataDir>/tmp` y se renombra al destino (mismo disco).
 * - El sha256 se calcula en streaming mientras se escribe (sin cargar el archivo en memoria).
 * - Lecturas parciales (Range) con `createReadStream(key, { start, end })`.
 *
 * Para pasar a la nube basta con otra implementación de `StorageAdapter` (S3, R2, GCS) que use las
 * mismas claves; `localPath()` descargaría a un caché temporal.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Env } from "../env.js";
import type { StorageAdapter, StoredFile } from "../services/types.js";
import { safeSegment } from "./keys.js";

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Clave de almacenamiento inválida: ${JSON.stringify(key).slice(0, 80)}`);
    this.name = "InvalidStorageKeyError";
  }
}

/** Valida una clave relativa y la devuelve normalizada con "/" como separador. */
export function validateKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) throw new InvalidStorageKeyError(String(key));
  if (key.includes("\0") || key.includes("\\")) throw new InvalidStorageKeyError(key);
  if (key.startsWith("/") || /^[A-Za-z]:/.test(key)) throw new InvalidStorageKeyError(key);
  const parts = key.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw new InvalidStorageKeyError(key);
  }
  return parts.join("/");
}

export interface LocalStorageOptions {
  dataDir: string;
}

export class LocalStorage implements StorageAdapter {
  readonly root: string;
  readonly tmpRoot: string;

  constructor(opts: LocalStorageOptions) {
    this.root = path.resolve(opts.dataDir, "storage");
    this.tmpRoot = path.resolve(opts.dataDir, "tmp");
  }

  /** Crea las carpetas base y limpia temporales viejos (de corridas anteriores). */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.tmpRoot, { recursive: true });
    const cutoff = Date.now() - 6 * 3600_000;
    const entries = await fs.readdir(this.tmpRoot).catch(() => [] as string[]);
    await Promise.all(
      entries.map(async (name) => {
        const p = path.join(this.tmpRoot, name);
        const st = await fs.stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
      }),
    );
  }

  key(...parts: string[]): string {
    const segments = parts
      .flatMap((p) => String(p).split("/"))
      .filter((s) => s.length > 0)
      .map((s) => safeSegment(s));
    if (segments.length === 0) throw new InvalidStorageKeyError(parts.join("/"));
    return segments.join("/");
  }

  /** Ruta absoluta (dentro de la raíz) para una clave válida. */
  private resolve(key: string): string {
    const clean = validateKey(key);
    const abs = path.resolve(this.root, ...clean.split("/"));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new InvalidStorageKeyError(key);
    return abs;
  }

  private tmpFile(): string {
    return path.join(this.tmpRoot, `up-${randomUUID()}`);
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream): Promise<StoredFile> {
    const dest = this.resolve(key);
    await fs.mkdir(this.tmpRoot, { recursive: true });
    const tmp = this.tmpFile();
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    const source = Buffer.isBuffer(data) ? Readable.from([data]) : (data as NodeJS.ReadableStream);
    try {
      await pipeline(source, meter, createWriteStream(tmp));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    return { key: validateKey(key), sizeBytes: size, sha256: hash.digest("hex") };
  }

  async putFile(key: string, srcPath: string, opts: { move?: boolean } = {}): Promise<StoredFile> {
    const dest = this.resolve(key);
    if (opts.move) {
      // Hash en streaming del archivo de origen y luego un rename (rápido si es el mismo disco).
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(srcPath) as AsyncIterable<Buffer>) {
        hash.update(chunk);
        size += chunk.length;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.rename(srcPath, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        // Distinto disco: copia atómica y borra el origen.
        const stored = await this.put(key, createReadStream(srcPath));
        await fs.rm(srcPath, { force: true });
        return stored;
      }
      return { key: validateKey(key), sizeBytes: size, sha256: hash.digest("hex") };
    }
    return this.put(key, createReadStream(srcPath));
  }

  createReadStream(key: string, range?: { start: number; end?: number }): NodeJS.ReadableStream {
    const abs = this.resolve(key);
    return range ? createReadStream(abs, { start: range.start, end: range.end }) : createReadStream(abs);
  }

  async stat(key: string): Promise<{ sizeBytes: number; mtimeMs: number } | null> {
    try {
      const st = await fs.stat(this.resolve(key));
      return st.isFile() ? { sizeBytes: st.size, mtimeMs: st.mtimeMs } : null;
    } catch (err) {
      if (err instanceof InvalidStorageKeyError) throw err;
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const abs = this.resolve(prefix.replace(/\/+$/, ""));
    if (abs === this.root) throw new InvalidStorageKeyError(prefix);
    await fs.rm(abs, { recursive: true, force: true });
  }

  async localPath(key: string): Promise<string> {
    return this.resolve(key);
  }

  async tempDir(prefix: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    await fs.mkdir(this.tmpRoot, { recursive: true });
    const dir = await fs.mkdtemp(path.join(this.tmpRoot, `${safeSegment(prefix, "tmp")}-`));
    return {
      path: dir,
      cleanup: async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }
}

/** Fábrica usada por `services/container.ts`. */
export async function createLocalStorage(env: Pick<Env, "dataDir">): Promise<LocalStorage> {
  const storage = new LocalStorage({ dataDir: env.dataDir });
  await storage.init();
  return storage;
}
