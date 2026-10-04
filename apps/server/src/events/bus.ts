/**
 * Bus de eventos en memoria, por proyecto. La cola de trabajos, el pipeline y las rutas publican
 * aquí; el endpoint SSE reenvía al navegador. (Con varios servidores se cambiaría por Redis pub/sub
 * manteniendo esta misma interfaz.)
 */
import { EventEmitter } from "node:events";
import type { ServerEvent } from "@autoeditor/shared";

export type EventListener = (event: ServerEvent) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Cada pestaña abierta es un oyente; no hay un límite razonable fijo.
    this.emitter.setMaxListeners(0);
  }

  /** Publica un evento para todos los oyentes del proyecto. Nunca lanza. */
  emit(projectId: string | null | undefined, event: ServerEvent): void {
    if (!projectId) return;
    try {
      this.emitter.emit(`project:${projectId}`, event);
    } catch {
      // Un oyente roto no debe tumbar a quien publica.
    }
  }

  /** Se suscribe a los eventos de un proyecto; devuelve la función para desuscribirse. */
  subscribe(projectId: string, listener: EventListener): () => void {
    const channel = `project:${projectId}`;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  listenerCount(projectId: string): number {
    return this.emitter.listenerCount(`project:${projectId}`);
  }
}
