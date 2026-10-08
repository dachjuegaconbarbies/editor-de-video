/**
 * RESULTADO: a la derecha del estudio, tarjetas de versión verticales (V1 → V2 → V3) conectadas
 * por flechas con la corrección escrita encima. Cada una con reproductor real, DESCARGAR (.mp4 y
 * .srt), 👍/👎, "Corregir" (con "anclar a este momento") y "Qué cambió". Se abren en grande.
 */
import { groupCaptionLines, toSrt, type AspectRatio, type Job, type Version } from "@autoeditor/shared";
import clsx from "clsx";
import { ArrowRight, ChevronDown, Download, Expand, LoaderCircle, MapPin, MessageCircleQuestion, Play, Save, Send, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { formatDuration, truncate } from "../lib/format.js";
import { AREA_LABELS, changeHeadline, clarifyingQuestionOf, groupChangesByArea, isActive, jobClock } from "../salida/logic.js";
import { useActions, useApi, useController, useEditor, useEditorShallow } from "../store/context.js";
import { Button, CoralButton, Modal, ProgressBar } from "../ui/index.js";
import { useNow } from "./hooks.js";

/** Versiones visibles; las más viejas se apilan para no saturar la pizarra. */
const MAX_VISIBLE = 2;

function aspectOf(v: Version, fallback: AspectRatio): AspectRatio {
  return v.recipe.format?.aspect ?? fallback;
}

export function VersionsLane() {
  const { versions, jobs, activeJobId, showAll, format } = useEditorShallow((s) => ({ versions: s.versions, jobs: s.jobs, activeJobId: s.activeJobId, showAll: s.showAllVersions, format: s.settings.instruction.format }));
  const { set } = useActions();
  const job = activeJobId ? (jobs[activeJobId] ?? null) : null;
  const correcting = job && job.type === "corregir" && isActive(job) ? job : null;
  const generating = job && job.type === "generar" && isActive(job) ? job : null;
  const [big, setBig] = useState<string | null>(null);
  const hidden = showAll ? 0 : Math.max(0, versions.length - MAX_VISIBLE);
  const visible = versions.slice(hidden);
  const latestId = versions[versions.length - 1]?.id ?? null;
  const laneRef = useRef<HTMLElement>(null);
  const seen = useRef<string | null>(latestId);
  const pendingKey = generating ? `g-${generating.id}` : correcting ? `c-${correcting.id}` : null;
  // Cuando aparece una versión nueva (o empieza una corrección) la pizarra se desplaza para mostrarla.
  useEffect(() => {
    if (latestId === seen.current && !pendingKey) return;
    seen.current = latestId;
    const lane = laneRef.current;
    const last = lane?.querySelector<HTMLElement>(".ae-lane__item:last-of-type");
    if (last && typeof last.scrollIntoView === "function") last.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [latestId, pendingKey]);

  if (!versions.length && !generating) {
    return (
      <aside className="ae-lane ae-lane--empty" aria-label="Resultado">
        <div className="ae-ghostcard" style={{ aspectRatio: format === "16:9" ? "16 / 9" : format === "1:1" ? "1 / 1" : format === "4:5" ? "4 / 5" : "9 / 16" }}>
          <Play size={22} aria-hidden />
          <span className="ae-ghostcard__title">Tu video aparecerá aquí</span>
          <span className="ae-ghostcard__text">Sube tu clip base y toca GENERAR.</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="ae-lane" aria-label="Versiones" ref={laneRef}>
      {hidden > 0 && (
        <button type="button" className="ae-svstack" onClick={() => set({ showAllVersions: true })}>
          <span className="ae-svstack__cards" aria-hidden>
            <span />
            <span />
          </span>
          <span>
            V1–V{hidden}
            <small>{hidden === 1 ? "1 versión anterior" : `${hidden} versiones anteriores`}</small>
          </span>
        </button>
      )}
      {showAll && versions.length > MAX_VISIBLE && (
        <button type="button" className="ae-textbtn ae-lane__collapse" onClick={() => set({ showAllVersions: false })}>
          Apilar versiones viejas
        </button>
      )}
      {visible.map((v, i) => (
        <div key={v.id} className="ae-lane__item">
          {(i > 0 || hidden > 0) && <Arrow text={v.correction} at={v.correctionAt} />}
          <VersionCard version={v} latest={v.id === latestId} aspect={aspectOf(v, format)} onOpen={() => setBig(v.id)} />
        </div>
      ))}
      {generating && !versions.length && (
        <div className="ae-lane__item">
          <PendingCard job={generating} title="V1" text="Claude está editando tu video" format={format} />
        </div>
      )}
      {correcting && (
        <div className="ae-lane__item">
          <Arrow text={typeof correcting.input.text === "string" ? correcting.input.text : null} at={null} />
          <PendingCard job={correcting} title={`V${(versions[versions.length - 1]?.number ?? 0) + 1}`} text="Aplicando tu corrección (solo cambia lo que pediste)" format={format} />
        </div>
      )}
      <BigVersion versionId={big} onClose={() => setBig(null)} />
    </aside>
  );
}

function Arrow({ text, at }: { text: string | null; at: number | null }) {
  return (
    <div className="ae-varrow">
      {text && (
        <span className="ae-varrow__label" title={text}>
          {at != null && <span className="ae-varrow__at">{formatDuration(at)}</span>}“{truncate(text, 90)}”
        </span>
      )}
      <span className="ae-varrow__line" aria-hidden>
        <ArrowRight size={18} />
      </span>
    </div>
  );
}

function PendingCard({ job, title, text, format }: { job: Job; title: string; text: string; format: AspectRatio }) {
  const now = useNow(true);
  const { remaining } = jobClock(job, now);
  return (
    <article className={clsx("ae-vcard ae-vcard--pending", format === "16:9" && "is-wide")} aria-live="polite">
      <header className="ae-vcard__head">
        <span className="ae-vbadge">{title}</span>
        <span className="ae-vcard__state">
          <LoaderCircle size={13} className="ae-spin" aria-hidden /> En proceso
        </span>
      </header>
      <div className="ae-vcard__screen is-pending" style={{ aspectRatio: format.replace(":", " / ") }}>
        <span className="ae-shimmer" aria-hidden />
        <span className="ae-vcard__pendtext">{text}</span>
        <ProgressBar value={job.status === "en-cola" ? null : job.progress} label="Progreso" size="sm" />
        {remaining != null && <span className="ae-vcard__eta">~{Math.max(1, Math.round(remaining))} s</span>}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------- Tarjeta de versión

function VersionCard({ version, latest, aspect, onOpen }: { version: Version; latest: boolean; aspect: AspectRatio; onOpen: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ready = version.status === "lista";
  return (
    <article className={clsx("ae-vcard", aspect === "16:9" && "is-wide", latest && "is-latest")} aria-label={`Versión ${version.number}`}>
      <header className="ae-vcard__head">
        <span className="ae-vbadge">V{version.number}</span>
        <span className="ae-vcard__state">{version.status === "error" ? "Con error" : !ready ? "Renderizando…" : version.recipe.duration > 0 ? formatDuration(version.recipe.duration) : "Lista"}</span>
        <button type="button" className="ae-iconbtn" aria-label={`Abrir V${version.number} en grande`} title="Ver en grande" onClick={onOpen}>
          <Expand size={15} aria-hidden />
        </button>
      </header>
      <Player version={version} aspect={aspect} videoRef={videoRef} />
      <VersionBody version={version} latest={latest} videoRef={videoRef} />
    </article>
  );
}

function Player({ version, aspect, videoRef, large }: { version: Version; aspect: AspectRatio; videoRef: RefObject<HTMLVideoElement | null>; large?: boolean }) {
  const api = useApi();
  const src = api.versionVideoUrl(version);
  const poster = api.versionPosterUrl(version);
  return (
    <div className={clsx("ae-vcard__screen", large && "is-large")} style={{ aspectRatio: aspect.replace(":", " / ") }}>
      {src ? (
        <video ref={videoRef} src={src} poster={poster ?? undefined} controls playsInline preload="metadata" aria-label={`Video de la versión ${version.number}`} />
      ) : (
        <div className="ae-vcard__noplay" style={poster ? { backgroundImage: `url("${poster}")` } : undefined}>
          <span>{version.status === "renderizando" ? "Renderizando…" : version.status === "error" ? "No se pudo renderizar" : "Vista previa no disponible"}</span>
        </div>
      )}
    </div>
  );
}

/** Descargas reales: del servidor; en la demo, el video local y un .srt armado con la receta. */
function useDownloads(version: Version) {
  const api = useApi();
  const src = api.versionVideoUrl(version);
  const srtUrl = useMemo(() => {
    if (!api.isDemo || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    const words = version.recipe.tracks.captions.words;
    if (!words.length) return null;
    const lines = groupCaptionLines(words, version.recipe.tracks.captions.style);
    return URL.createObjectURL(new Blob([toSrt(lines, version.recipe.tracks.captions.style.uppercase)], { type: "application/x-subrip" }));
  }, [api, version]);
  useEffect(() => () => void (srtUrl && URL.revokeObjectURL(srtUrl)), [srtUrl]);
  if (api.isDemo) return { mp4: src, srt: srtUrl };
  return { mp4: version.status === "lista" ? api.downloadUrl(version.id, "mp4") : null, srt: version.status === "lista" ? api.downloadUrl(version.id, "srt") : null };
}

function VersionBody({ version, latest, videoRef, large }: { version: Version; latest: boolean; videoRef: RefObject<HTMLVideoElement | null>; large?: boolean }) {
  const controller = useController();
  const { toast } = useActions();
  const dl = useDownloads(version);
  const ready = version.status === "lista";
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleName, setStyleName] = useState("");
  const name = `V${version.number}`;
  return (
    <div className={clsx("ae-vbody", large && "is-large")}>
      <div className="ae-vbody__actions">
        {dl.mp4 ? (
          <a className={clsx("ae-btn ae-btn--mint ae-btn--md ae-vdl", !ready && "is-disabled")} href={dl.mp4} download={`${name}.mp4`} aria-disabled={!ready}>
            <Download size={15} aria-hidden />
            <span className="ae-btn__label">Descargar</span>
          </a>
        ) : (
          <Button tone="mint" icon={<Download size={15} />} disabled={!ready} className="ae-vdl" onClick={() => toast({ kind: "info", text: "La descarga estará lista cuando termine el render." })}>
            Descargar
          </Button>
        )}
        {dl.srt && (
          <a className="ae-textbtn ae-textbtn--sm" href={dl.srt} download={`${name}.srt`}>
            .srt
          </a>
        )}
        <span className="ae-vbody__spacer" />
        <div className="ae-rate" role="group" aria-label="¿Te gustó?">
          <button type="button" className={clsx("ae-iconbtn", version.rating === "arriba" && "is-on")} aria-label="Me gusta" aria-pressed={version.rating === "arriba"} onClick={() => void controller.rate(version.id, version.rating === "arriba" ? null : "arriba")}>
            <ThumbsUp size={15} aria-hidden />
          </button>
          <button type="button" className={clsx("ae-iconbtn", version.rating === "abajo" && "is-on is-down")} aria-label="No me gusta" aria-pressed={version.rating === "abajo"} onClick={() => void controller.rate(version.id, version.rating === "abajo" ? null : "abajo")}>
            <ThumbsDown size={15} aria-hidden />
          </button>
        </div>
      </div>
      {version.number > 1 && <Changes version={version} />}
      <Clarify versionId={version.id} />
      {latest && <Correct version={version} videoRef={videoRef} disabled={!ready} />}
      <div className="ae-vbody__foot">
        <button type="button" className="ae-textbtn ae-textbtn--sm" disabled={!ready} onClick={() => setStyleOpen(true)}>
          <Save size={13} aria-hidden /> Guardar estilo
        </button>
      </div>
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
        <p className="ae-help">Claude guarda la tipografía, los colores, el ritmo y tus correcciones para que la próxima vez salga igual.</p>
        <input className="ae-input" placeholder="Nombre del estilo (p. ej. “Reels de mi marca”)" value={styleName} onChange={(e) => setStyleName(e.target.value)} data-autofocus aria-label="Nombre del estilo" />
      </Modal>
    </div>
  );
}

function Changes({ version }: { version: Version }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupChangesByArea(version.changes).filter((g) => g.direct.length > 0), [version.changes]);
  const headline = changeHeadline(version);
  if (!headline && !groups.length) return null;
  return (
    <div className="ae-vchanges">
      <button type="button" className="ae-vchanges__head" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={!groups.length}>
        <span className="ae-vchanges__label">Qué cambió</span>
        <span className="ae-vchanges__text">{headline || `${version.changes.length} cambios`}</span>
        {groups.length > 0 && <ChevronDown size={14} className={clsx("ae-chev", open && "is-open")} aria-hidden />}
      </button>
      {open && (
        <ul className="ae-vchanges__list">
          {groups.map((g) => (
            <li key={g.area}>
              <b>{g.label || AREA_LABELS[g.area]}:</b> {g.direct.map((c) => c.label).join(", ")}
            </li>
          ))}
          <li className="ae-vchanges__same">Todo lo demás quedó idéntico.</li>
        </ul>
      )}
    </div>
  );
}

/** Si Claude no entendió una corrección, pregunta antes de renderizar. */
function Clarify({ versionId }: { versionId: string }) {
  const job = useEditor((s) => {
    const list = Object.values(s.jobs).filter((j) => j.type === "corregir" && j.input.versionId === versionId && j.status === "listo");
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  });
  const controller = useController();
  const [answer, setAnswer] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const question = clarifyingQuestionOf(job);
  if (!job || !question || dismissed === job.id) return null;
  const original = typeof job.input.text === "string" ? job.input.text : "";
  const at = typeof job.input.at === "number" ? job.input.at : null;
  return (
    <div className="ae-clarify" role="status">
      <div className="ae-clarify__q">
        <MessageCircleQuestion size={15} aria-hidden /> <span>{question}</span>
        <button type="button" className="ae-iconbtn" aria-label="Descartar pregunta" onClick={() => setDismissed(job.id)}>
          <X size={13} aria-hidden />
        </button>
      </div>
      <div className="ae-clarify__row">
        <input className="ae-input ae-input--sm" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Tu respuesta" aria-label="Respuesta a Claude" />
        <Button
          size="sm"
          tone="ink"
          disabled={!answer.trim()}
          onClick={async () => {
            if (await controller.correct(versionId, `${original} (aclaración: ${answer.trim()})`, at)) {
              setDismissed(job.id);
              setAnswer("");
            }
          }}
        >
          Responder
        </Button>
      </div>
    </div>
  );
}

function Correct({ version, videoRef, disabled }: { version: Version; videoRef: RefObject<HTMLVideoElement | null>; disabled: boolean }) {
  const controller = useController();
  const job = useEditor((s) => (s.activeJobId ? (s.jobs[s.activeJobId] ?? null) : null));
  const busy = isActive(job);
  const [text, setText] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const send = async () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    if (await controller.correct(version.id, t, at)) {
      setText("");
      setAt(null);
    }
  };
  const anchor = () => {
    if (at != null) return setAt(null);
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setAt(Math.round(v.currentTime * 10) / 10);
  };
  return (
    <div className="ae-correct">
      <div className="ae-correct__top">
        <label className="ae-correct__label" htmlFor={`corr-${version.id}`}>
          Corregir
        </label>
        <button
          type="button"
          className={clsx("ae-anchor", at != null && "is-on")}
          aria-pressed={at != null}
          aria-label={at != null ? `Anclada en ${formatDuration(at)} (toca para quitar)` : "Anclar a este momento del video"}
          onClick={anchor}
          disabled={disabled}
          title="Anclar a este momento: pausa el video donde quieras el cambio y toca aquí"
        >
          <MapPin size={13} aria-hidden />
          {at != null ? `En ${formatDuration(at)}` : "Anclar momento"}
          {at != null && <X size={12} aria-hidden />}
        </button>
      </div>
      <textarea
        id={`corr-${version.id}`}
        className="ae-input ae-correct__text"
        rows={2}
        placeholder={at != null ? `Qué cambio en ${formatDuration(at)}, p. ej. “aquí quita este corte”` : "p. ej. “cambia la tipografía por una más bonita”"}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="ae-correct__row">
        <p className="ae-correct__help">Solo cambia lo que pidas; lo demás queda idéntico.</p>
        <CoralButton size="sm" icon={busy ? <LoaderCircle size={14} className="ae-spin" /> : <Send size={14} />} disabled={!text.trim() || busy || disabled} onClick={() => void send()}>
          Corregir
        </CoralButton>
      </div>
    </div>
  );
}

function BigVersion({ versionId, onClose }: { versionId: string | null; onClose: () => void }) {
  const { version, latestId, format } = useEditorShallow((s) => ({ version: s.versions.find((v) => v.id === versionId) ?? null, latestId: s.versions[s.versions.length - 1]?.id ?? null, format: s.settings.instruction.format }));
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <Modal open={!!version} onClose={onClose} title={version ? `Versión ${version.number}` : "Versión"} width={1040}>
      {version && (
        <div className={clsx("ae-bigv", aspectOf(version, format) === "16:9" && "is-wide")}>
          <Player version={version} aspect={aspectOf(version, format)} videoRef={videoRef} large />
          <div className="ae-bigv__side">
            {version.correction && (
              <p className="ae-bigv__corr">
                Corrección: <b>“{version.correction}”</b>
              </p>
            )}
            <VersionBody version={version} latest={version.id === latestId} videoRef={videoRef} large />
          </div>
        </div>
      )}
    </Modal>
  );
}
