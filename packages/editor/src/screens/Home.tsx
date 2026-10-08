/**
 * Inicio: "Nuevo video" (grande), "Usar un estilo" (lista de estilos) y proyectos recientes con
 * miniatura y fecha. Si no hay servidor, aviso discreto y botón "Ver demo de la interfaz".
 */
import type { Project, Style } from "@autoeditor/shared";
import clsx from "clsx";
import { ArrowRight, Clapperboard, Film, Palette, Plus, RotateCcw, Sparkles, WandSparkles, WifiOff } from "lucide-react";
import { useState } from "react";
import { formatRelative } from "../lib/format.js";
import { useApi, useController, useEditorShallow } from "../store/context.js";
import { Button, EmptyState, PurpleButton } from "../ui/index.js";
import { studioDefaultSettings } from "../studio/logic.js";
import { Logo } from "./TopBar.js";

export function HomeScreen({ onDemo, onRetry }: { onDemo: () => void; onRetry: () => void }) {
  const { projects, styles, loaded, connection, demo } = useEditorShallow((s) => ({ projects: s.projects, styles: s.styles, loaded: s.projectsLoaded, connection: s.connection, demo: s.demo }));
  const controller = useController();
  const [showStyles, setShowStyles] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const offline = connection === "sin-conexion" && !demo;

  const create = async (key: string, styleId?: string) => {
    setCreating(key);
    await controller.createProject(styleId ? { name: "Video nuevo con estilo", styleId } : { name: "Video nuevo", settings: studioDefaultSettings() });
    setCreating(null);
  };

  return (
    <div className="ae-home">
      <header className="ae-home__bar">
        <Logo />
        {demo && <span className="ae-demo-badge">Demo de la interfaz</span>}
      </header>

      <main className="ae-home__main">
        {offline && (
          <div className="ae-offline" role="status">
            <WifiOff size={16} aria-hidden />
            <span>
              <b>Sin conexión con el servidor.</b> Arranca el servidor con <code>pnpm dev</code> o recorre la interfaz con datos de ejemplo.
            </span>
            <div className="ae-offline__actions">
              <Button size="sm" tone="ghost" icon={<RotateCcw size={14} />} onClick={onRetry}>
                Reintentar
              </Button>
              <Button size="sm" tone="ink" icon={<Sparkles size={14} />} onClick={onDemo}>
                Ver demo de la interfaz
              </Button>
            </div>
          </div>
        )}

        <section className="ae-hero">
          <h1>¿Qué video hacemos hoy?</h1>
          <p>Sube tu video, toca GENERAR y corrige con texto. Claude edita solo: quita lo que sobra y arma tu V1.</p>
        </section>

        <section className="ae-start" aria-label="Empezar">
          <button type="button" className="ae-start-card ae-start-card--new" onClick={() => void create("nuevo")} disabled={offline || !!creating}>
            <div className="ae-start-card__art" aria-hidden>
              <MiniFlow />
            </div>
            <div className="ae-start-card__text">
              <span className="ae-start-card__icon">
                <Plus size={18} />
              </span>
              <span>
                <span className="ae-start-card__title">Nuevo video</span>
                <span className="ae-start-card__desc">Arrastra tu clip y pulsa GENERAR. No hay nada que configurar.</span>
              </span>
              <ArrowRight size={18} className="ae-start-card__go" />
            </div>
          </button>
          <button
            type="button"
            className={clsx("ae-start-card ae-start-card--style", showStyles && "is-open")}
            onClick={() => setShowStyles((v) => !v)}
            aria-expanded={showStyles}
            disabled={offline}
          >
            <div className="ae-start-card__art ae-start-card__art--style" aria-hidden>
              <span className="ae-swatch-dot" style={{ background: "#FBE88A" }} />
              <span className="ae-swatch-dot" style={{ background: "#EE6B6B" }} />
              <span className="ae-swatch-dot" style={{ background: "#8B7CF0" }} />
              <span className="ae-swatch-dot" style={{ background: "#BFEFD3" }} />
              <span className="ae-style-sample">Aa</span>
            </div>
            <div className="ae-start-card__text">
              <span className="ae-start-card__icon ae-start-card__icon--coral">
                <Palette size={18} />
              </span>
              <span>
                <span className="ae-start-card__title">Usar un estilo</span>
                <span className="ae-start-card__desc">Misma tipografía, colores, ritmo y subtítulos; solo cambia el material.</span>
              </span>
              <ArrowRight size={18} className="ae-start-card__go" />
            </div>
          </button>
        </section>

        {showStyles && (
          <section className="ae-styles" aria-label="Tus estilos">
            {styles.length === 0 ? (
              <EmptyState compact icon={<Palette size={20} />} title="Todavía no tienes estilos">
                Cuando te guste una versión, pulsa GUARDAR ESTILO y aparecerá aquí.
              </EmptyState>
            ) : (
              styles.map((s) => <StyleCard key={s.id} style={s} busy={creating === s.id} onUse={() => void create(s.id, s.id)} />)
            )}
          </section>
        )}

        <section className="ae-recent" aria-label="Proyectos recientes">
          <div className="ae-recent__head">
            <h2>Proyectos recientes</h2>
            {projects.length > 0 && <span className="ae-count">{projects.length}</span>}
          </div>
          {!loaded ? (
            <div className="ae-recent__grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="ae-projcard is-skeleton" aria-hidden />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <EmptyState icon={<Clapperboard size={22} />} title="Aquí verás tus proyectos">
              {offline ? "Cuando haya conexión con el servidor aparecerán aquí." : "Empieza con “Nuevo video”. Todo se guarda solo."}
            </EmptyState>
          ) : (
            <div className="ae-recent__grid">
              {projects.slice(0, 12).map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const controller = useController();
  const api = useApi();
  // El servidor manda `coverAssetId` (primer video) en la lista; si no, la miniatura del proyecto.
  const cover = project.thumbnailAssetId ?? (project as Project & { coverAssetId?: string | null }).coverAssetId ?? null;
  const thumb = cover ? api.assetThumbnailUrl(cover) : null;
  const [broken, setBroken] = useState(false);
  const status = project.status === "listo" ? "Con versiones" : project.status === "procesando" ? "Generando…" : project.status === "error" ? "Con error" : "Borrador";
  return (
    <button type="button" className="ae-projcard" onClick={() => void controller.openProject(project.id)}>
      <span className="ae-projcard__thumb">
        {thumb && !broken ? <img src={thumb} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Film size={22} aria-hidden />}
        <span className={clsx("ae-projcard__status", `is-${project.status}`)}>{status}</span>
      </span>
      <span className="ae-projcard__body">
        <span className="ae-projcard__name">{project.name}</span>
        <span className="ae-projcard__date">Editado {formatRelative(project.updatedAt)}</span>
      </span>
    </button>
  );
}

function StyleCard({ style, onUse, busy }: { style: Style; onUse: () => void; busy: boolean }) {
  return (
    <div className="ae-stylecard">
      <div className="ae-stylecard__main">
        <div className="ae-stylecard__name">{style.name}</div>
        {style.description && <div className="ae-stylecard__desc">{style.description}</div>}
        <div className="ae-stylecard__meta">
          v{style.currentVersion} · usado {style.timesUsed} {style.timesUsed === 1 ? "vez" : "veces"}
        </div>
      </div>
      <PurpleButton size="sm" icon={<WandSparkles size={14} />} loading={busy} onClick={onUse}>
        Usar
      </PurpleButton>
    </div>
  );
}

/** Ilustración: mini diagrama MATERIAL → INSTRUCCIÓN → V1. */
function MiniFlow() {
  return (
    <span className="ae-miniflow">
      <span className="ae-miniflow__card">
        <span className="ae-miniflow__tab">Material</span>
        <span className="ae-miniflow__note" />
        <span className="ae-miniflow__note ae-miniflow__note--b" />
      </span>
      <span className="ae-miniflow__arrow" />
      <span className="ae-miniflow__card">
        <span className="ae-miniflow__tab">Instrucción</span>
        <span className="ae-miniflow__line" />
        <span className="ae-miniflow__line ae-miniflow__line--s" />
        <span className="ae-miniflow__btn" />
      </span>
      <span className="ae-miniflow__arrow" />
      <span className="ae-miniflow__card ae-miniflow__card--v">
        <span className="ae-miniflow__tab ae-miniflow__tab--mint">V1</span>
        <span className="ae-miniflow__screen" />
      </span>
    </span>
  );
}
