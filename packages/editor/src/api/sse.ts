/**
 * Suscripción a eventos en vivo (Server-Sent Events) con reconexión automática.
 *
 * Usamos fetch + ReadableStream en lugar de EventSource porque EventSource no permite mandar
 * encabezados (X-Owner-Id o el token de la app anfitriona). Al caerse la conexión reintenta con
 * espera exponencial (1 s, 2 s, 4 s… hasta 15 s) y avisa con `onReconnect` para resincronizar.
 */
import type { ServerEvent } from "@autoeditor/shared";
import type { EventSubscription, SubscribeOptions } from "./types.js";

export interface SseConnectOptions extends SubscribeOptions {
  url: string;
  headers: () => Record<string, string>;
  fetch: typeof fetch;
  /** Espera máxima entre reintentos (ms). */
  maxBackoffMs?: number;
}

/** Parte un bloque de texto SSE en eventos `{ event, data }` (acepta \n y \r\n). */
export function parseSseChunk(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: { event: string; data: string }[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue; // comentario / keep-alive
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

export function connectSse(opts: SseConnectOptions): EventSubscription {
  const maxBackoff = opts.maxBackoffMs ?? 15_000;
  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let everConnected = false;

  const schedule = () => {
    if (closed) return;
    opts.onStatus?.("reconectando");
    const wait = Math.min(maxBackoff, 1000 * 2 ** Math.min(attempt, 4));
    attempt++;
    timer = setTimeout(run, wait);
  };

  const run = async () => {
    if (closed) return;
    controller = new AbortController();
    opts.onStatus?.(everConnected ? "reconectando" : "conectando");
    try {
      const res = await opts.fetch(opts.url, {
        headers: { Accept: "text/event-stream", ...opts.headers() },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      const wasReconnect = everConnected;
      everConnected = true;
      attempt = 0;
      opts.onStatus?.("conectado");
      if (wasReconnect) opts.onReconnect?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          try {
            const payload = JSON.parse(ev.data) as ServerEvent;
            if (payload && typeof payload === "object" && "type" in payload) opts.onEvent(payload);
          } catch {
            // Evento mal formado: lo ignoramos sin romper la conexión.
          }
        }
      }
      // El servidor cerró la conexión: reconectamos.
      schedule();
    } catch {
      if (closed) return;
      schedule();
    }
  };

  void run();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      opts.onStatus?.("cerrado");
    },
  };
}
