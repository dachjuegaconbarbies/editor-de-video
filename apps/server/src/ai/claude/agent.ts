/**
 * Bucle agéntico con el tool runner del SDK (client.beta.messages.toolRunner + betaZodTool).
 *
 * - Streaming por turno (finalMessage) con max_tokens generoso.
 * - Cada respuesta: suma uso, revisa rechazo (stop_reason "refusal") antes de mirar el contenido.
 * - Cuando la sesión termina (la herramienta "terminar"/"enviar_parche" lo marca), corta sin hacer una
 *   petición extra: ejecuta las herramientas del turno con generateToolResponse() y sale del bucle.
 * - Si Claude se detiene sin terminar, se le recuerda una vez qué falta (mensaje nuevo al final: el
 *   historial solo crece, así el razonamiento preservado y la caché siguen valiendo).
 */
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { UserFacingError } from "../../services/types.js";
import { assertNotRefused, baseParams, MAX_TOKENS_STREAMING, systemBlocks, textOf, toClaudeUserError, type ClaudeRuntime, type UsageMeter } from "./client.js";

export interface AgentRun {
  system: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: BetaRunnableTool<any>[];
  userContent: string | BetaContentBlockParam[];
  maxTurns: number;
  /** ¿La sesión ya entregó su resultado? */
  isDone: () => boolean;
  /** Si Claude se detuvo sin terminar: recordatorio a enviar (o null para no insistir). */
  nudge?: (lastText: string) => string | null;
  /** Qué hace Claude (para errores: "planear la edición"). */
  what: string;
  signal?: AbortSignal;
  onTurn?: (turn: number) => void;
}

export interface AgentOutcome {
  turns: number;
  lastText: string;
  stopReason: BetaMessage["stop_reason"] | null;
  /** Se acabaron los turnos sin terminar. */
  exhausted: boolean;
}

export async function runAgent(rt: ClaudeRuntime, meter: UsageMeter, run: AgentRun): Promise<AgentOutcome> {
  const base = baseParams(rt.models, "editor");
  let messages: BetaMessageParam[] = [{ role: "user", content: run.userContent }];
  let turns = 0;
  let lastText = "";
  let stopReason: BetaMessage["stop_reason"] | null = null;
  let nudged = false;

  for (;;) {
    const runner = rt.client.beta.messages.toolRunner(
      {
        ...base,
        max_tokens: rt.stream ? MAX_TOKENS_STREAMING : 16_000,
        system: systemBlocks(run.system),
        tools: run.tools,
        tool_choice: { type: "auto" },
        messages,
        max_iterations: Math.max(1, run.maxTurns - turns),
        stream: rt.stream,
      },
      { signal: run.signal },
    );
    try {
      for await (const item of runner) {
        const message: BetaMessage = "finalMessage" in item ? await item.finalMessage() : item;
        turns++;
        meter.add(message);
        assertNotRefused(message, run.what);
        stopReason = message.stop_reason;
        const text = textOf(message);
        if (text) lastText = text;
        run.onTurn?.(turns);
        if (message.stop_reason === "tool_use") {
          // Ejecuta ya las herramientas de este turno (el runner reutiliza la respuesta si sigue).
          await runner.generateToolResponse(run.signal);
          if (run.isDone()) break;
        }
      }
    } catch (err) {
      throw toClaudeUserError(err, run.what);
    }
    if (run.isDone()) return { turns, lastText, stopReason, exhausted: false };
    if (stopReason === "max_tokens") {
      throw new UserFacingError("claude-respuesta-cortada", `La respuesta de Claude se cortó por largo al ${run.what}. Vuelve a intentarlo.`, 502);
    }
    const reminder = !nudged && turns < run.maxTurns && stopReason === "end_turn" ? run.nudge?.(lastText) ?? null : null;
    if (!reminder) return { turns, lastText, stopReason, exhausted: turns >= run.maxTurns };
    nudged = true;
    messages = [...runner.params.messages, { role: "user", content: reminder }];
  }
}
