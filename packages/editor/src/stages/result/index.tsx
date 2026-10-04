/**
 * RESULTADO y VERSIONES (versión base; la ola 2 agrega comparar lado a lado, corrección anclada a
 * un momento, "¿lo recuerdo?" y exportación completa).
 * - Tarjeta V1, V2… con el video (vertical u horizontal según el formato).
 * - Debajo: EXPORTAR (menta), GUARDAR ESTILO (coral), CORRECCIÓN (coral) y 👍 / 👎.
 */
import type { AspectRatio, Version } from "@autoeditor/shared";
import clsx from "clsx";
import { Download, Layers, Play, Save, Send, ThumbsDown, ThumbsUp, WandSparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatDuration, truncate } from "../../lib/format.js";
import { useActions, useActiveJob, useApi, useController, useEditor, useEditorShallow } from "../../store/context.js";
import { Button, Chip, CoralButton, EmptyState, IconButton, MintButton, Modal, StageCard } from "../../ui/index.js";
import { ProcessView } from "../process/index.js";

function aspectOf(v: Version | null, fallback: AspectRatio): AspectRatio {
  return v?.recipe.format.aspect ?? fallback;
}

/** Marco tipo pantalla con la proporción del formato. */
function ScreenFrame({ aspect, children, className }: { aspect: AspectRatio; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("ae-screen", `ae-screen--${aspect.replace(":", "x")}`, className)}>
      <div className="ae-screen__inner">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Nodo RESULTADO (antes de V1 o mientras se crea una versión)

export function ResultPlaceholder({ mode, nextNumber, status, hint }: { mode: "vacio" | "proceso" | "pendiente"; nextNumber: number; status: "vacio" | "procesando" | "error" | "esperando" | "listo" | "opcional"; hint: string }) {
  const job = useActiveJob();
  const format = useEditor((s) => s.settings.instruction.format);
  const { openFocus } = useActions();
  const title = mode === "pendiente" ? `V${nextNumber}` : "Resultado";
  return (
    <StageCard title={title} variant="compact" status={status} hint={mode === "vacio" ? hint : undefined} onOpen={() => openFocus(mode === "pendiente" ? "versiones" : "resultado")} width={264} tone={mode === "pendiente" ? "dashed" : "default"}>
      <ScreenFrame aspect={format} className={clsx(mode === "vacio" && "is-empty")}>
        {job && mode !== "vacio" ? (
          <ProcessView job={job} compact />
        ) : (
          <EmptyState compact icon={<WandSparkles size={20} />} title="Tu V1 aparecerá aquí">
            Sube material, describe el video y pulsa GENERAR.
          </EmptyState>
        )}
      </ScreenFrame>
    </StageCard>
  );
}

// ---------------------------------------------------------------------------- Nodo de versión

export function VersionCard({ versionId, latest, variant = "compact" }: { versionId: string; latest: boolean; variant?: "compact" | "focus" }) {
  const { version, format, total } = useEditorShallow((s) => ({ version: s.versions.find((v) => v.id === versionId) ?? null, format: s.settings.instruction.format, total: s.versions.length }));
  const { openFocus } = useActions();
  if (!version) return null;
  const aspect = aspectOf(version, format);
  const title = version.number === 1 ? "Resultado · V1" : `V${version.number}`;
  const status = version.status === "error" ? "error" : version.status === "renderizando" ? "procesando" : "listo";
  return (
    <StageCard
      title={title}
      variant="compact"
      status={status}
      statusLabel={status === "listo" ? (version.exported ? "Exportada" : "Lista") : undefined}
      onOpen={variant === "compact" ? () => openFocus(version.number === 1 && total === 1 ? "resultado" : "versiones", version.id) : undefined}
      width={variant === "focus" ? undefined : aspect === "16:9" ? 312 : 264}
      tone="mint"
      className="ae-version"
    >
      <VersionPlayer version={version} aspect={aspect} />
      {version.number > 1 && (version.changeSummary || version.changes.length > 0) && (
        <div className="ae-changes">
          <span className="ae-changes__label">Qué cambió</span>
          <span>{truncate(version.changeSummary || version.changes.map((c) => c.label).join(", "), 120)}</span>
        </div>
      )}
      <VersionActions version={version} latest={latest} />
    </StageCard>
  );
}

function VersionPlayer({ version, aspect }: { version: Version; aspect: AspectRatio }) {
  const api = useApi();
  const toast = useActions().toast;
  const src = api.versionVideoUrl(version);
  const poster = api.versionPosterUrl(version);
  const [playing, setPlaying] = useState(false);
  return (
    <ScreenFrame aspect={aspect}>
      {src && playing ? (
        <video className="ae-video nodrag" src={src} poster={poster ?? undefined} controls autoPlay playsInline />
      ) : (
        <button
          type="button"
          className="ae-poster nodrag"
          style={poster ? { backgroundImage: `url("${poster}")` } : undefined}
          onClick={() => (src ? setPlaying(true) : toast({ kind: "info", text: version.status === "lista" ? "Vista previa no disponible en la demo." : "El video aún se está renderizando." }))}
          aria-label={`Reproducir V${version.number}`}
        >
          {src && <video className="ae-video ae-video--still" src={`${src}#t=0.1`} preload="metadata" muted playsInline aria-hidden tabIndex={-1} />}
          <span className="ae-poster__play" aria-hidden>
            <Play size={18} fill="currentColor" />
          </span>
          <span className="ae-poster__badge">V{version.number}</span>
          {version.recipe.duration > 0 && <span className="ae-poster__dur">{formatDuration(version.recipe.duration)}</span>}
        </button>
      )}
    </ScreenFrame>
  );
}

function VersionActions({ version, latest }: { version: Version; latest: boolean }) {
  const controller = useController();
  const api = useApi();
  const toast = useActions().toast;
  const job = useActiveJob();
  const [text, setText] = useState("");
  const [styleOpen, setStyleOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [styleName, setStyleName] = useState("");
  const busy = !!job && (job.status === "corriendo" || job.status === "en-cola");
  const ready = version.status === "lista";
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    if (await controller.correct(version.id, t)) setText("");
  };
  return (
    <div className="ae-vactions">
      <div className="ae-row">
        <MintButton size="sm" icon={<Download size={14} />} disabled={!ready} onClick={() => setExportOpen(true)} className="nodrag ae-grow">
          Exportar
        </MintButton>
        <CoralButton size="sm" icon={<Save size={14} />} disabled={!ready} onClick={() => setStyleOpen(true)} className="nodrag ae-grow">
          Guardar estilo
        </CoralButton>
      </div>
      <div className="ae-row ae-row--between">
        <div className="ae-rate" role="group" aria-label="¿Te gustó?">
          <IconButton label="Me gusta" icon={<ThumbsUp size={15} />} active={version.rating === "arriba"} aria-pressed={version.rating === "arriba"} onClick={() => void controller.rate(version.id, version.rating === "arriba" ? null : "arriba")} className="nodrag" />
          <IconButton label="No me gusta" icon={<ThumbsDown size={15} />} active={version.rating === "abajo"} aria-pressed={version.rating === "abajo"} onClick={() => void controller.rate(version.id, version.rating === "abajo" ? null : "abajo")} className="nodrag" />
        </div>
        {version.qa.length > 0 && (
          <Chip size="sm" tone={version.qa.every((q) => q.ok) ? "mint" : "coral"} title={version.qa.map((q) => `${q.ok ? "✓" : "✗"} ${q.check}`).join("\n")}>
            Revisión {version.qa.filter((q) => q.ok).length}/{version.qa.length}
          </Chip>
        )}
      </div>
      {latest && (
        <div className="ae-correction">
          <label className="ae-correction__label" htmlFor={`corr-${version.id}`}>
            Corrección
          </label>
          <textarea
            id={`corr-${version.id}`}
            className="ae-input ae-textarea ae-correction__text nodrag nowheel"
            rows={2}
            placeholder="p. ej. “cambia la tipografía por una más bonita”"
            value={text}
            disabled={busy || !ready}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <CoralButton size="sm" block icon={<Send size={14} />} disabled={!text.trim() || busy || !ready} onClick={() => void send()} className="nodrag">
            Enviar corrección
          </CoralButton>
          <div className="ae-help">Solo cambia lo que pidas; todo lo demás queda idéntico.</div>
        </div>
      )}
      <Modal
        open={styleOpen}
        onClose={() => setStyleOpen(false)}
        title="Guardar estilo"
        footer={
          <>
            <Button tone="ghost" onClick={() => setStyleOpen(false)}>
              Cancelar
            </Button>
            <CoralButton
              icon={<Save size={15} />}
              disabled={!styleName.trim()}
              onClick={() => {
                void controller.saveStyle(version.id, styleName.trim());
                setStyleOpen(false);
                setStyleName("");
              }}
            >
              Guardar estilo
            </CoralButton>
          </>
        }
      >
        <p className="ae-help">Claude escribe una ficha de reglas a partir de este video y de tus correcciones, para que la próxima vez salga igual.</p>
        <input className="ae-input" placeholder="Nombre del estilo (p. ej. “Reels de Zyra”)" value={styleName} onChange={(e) => setStyleName(e.target.value)} data-autofocus aria-label="Nombre del estilo" />
      </Modal>
      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title={`Exportar V${version.number}`}
        footer={
          <Button tone="ghost" onClick={() => setExportOpen(false)}>
            Cerrar
          </Button>
        }
      >
        <div className="ae-exports">
          {[
            { type: "mp4" as const, label: "Video MP4 (1080p)" },
            { type: "srt" as const, label: "Subtítulos .srt" },
            { type: "vtt" as const, label: "Subtítulos .vtt" },
            { type: "txt" as const, label: "Transcripción .txt" },
            { type: "copy" as const, label: "Título, descripción y hashtags" },
          ].map((d) =>
            api.isDemo ? (
              <button key={d.type} type="button" className="ae-export" onClick={() => toast({ kind: "info", text: "Las descargas no están disponibles en la demo." })}>
                <Download size={15} aria-hidden /> {d.label}
              </button>
            ) : (
              <a key={d.type} className="ae-export" href={api.downloadUrl(version.id, d.type)} download onClick={() => d.type === "mp4" && void controller.exportVersion(version.id)}>
                <Download size={15} aria-hidden /> {d.label}
              </a>
            ),
          )}
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------- Pila "+N versiones"

export function VersionStack({ count, fromNumber, toNumber }: { count: number; fromNumber: number; toNumber: number }) {
  const { set } = useActions();
  return (
    <button type="button" className="ae-vstack nodrag" onClick={() => set({ showAllVersions: true })} aria-label={`Mostrar ${count} versiones anteriores`}>
      <span className="ae-vstack__cards" aria-hidden>
        <span />
        <span />
        <span>
          <Layers size={18} />
        </span>
      </span>
      <span className="ae-vstack__title">+{count} {count === 1 ? "versión" : "versiones"}</span>
      <span className="ae-vstack__range">
        V{fromNumber}
        {toNumber !== fromNumber ? `–V${toNumber}` : ""}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------- Vista enfocada

export function ResultStage({ variant, target }: { variant: "compact" | "focus"; target?: string }) {
  const { versions, showAll } = useEditorShallow((s) => ({ versions: s.versions, showAll: s.showAllVersions }));
  const { set } = useActions();
  const job = useActiveJob();
  if (variant === "compact") return null;
  const sorted = [...versions].sort((a, b) => b.number - a.number);
  const latestId = versions[versions.length - 1]?.id;
  if (!sorted.length) {
    return (
      <div className="ae-result-focus">
        {job ? (
          <div className="ae-panel">
            <ProcessView job={job} />
          </div>
        ) : (
          <EmptyState icon={<WandSparkles size={24} />} title="Todavía no hay versiones">
            Sube tu material, escribe qué quieres y pulsa GENERAR. Tu V1 aparecerá aquí.
          </EmptyState>
        )}
      </div>
    );
  }
  const ordered = target ? [...sorted.filter((v) => v.id === target), ...sorted.filter((v) => v.id !== target)] : sorted;
  return (
    <div className="ae-result-focus">
      {job && job.type !== "generar" && (
        <div className="ae-panel">
          <ProcessView job={job} />
        </div>
      )}
      <div className="ae-result-focus__grid">
        {ordered.map((v) => (
          <div key={v.id} className="ae-result-focus__item">
            {v.correction && (
              <div className="ae-corr-note">
                <span>Corrección:</span> “{v.correction}”
              </div>
            )}
            <VersionCard versionId={v.id} latest={v.id === latestId && !(job && job.type !== "generar")} variant="focus" />
          </div>
        ))}
      </div>
      {versions.length > 3 && (
        <Button tone="ghost" onClick={() => set({ showAllVersions: !showAll })}>
          {showAll ? "Apilar versiones viejas en el diagrama" : "Mostrar todas las versiones en el diagrama"}
        </Button>
      )}
    </div>
  );
}
