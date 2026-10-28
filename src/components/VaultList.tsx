import { Vault } from "../api";
import { useEffect } from "react";
import { IconCheck, IconEdit, IconFolder, IconPlus, IconSearch, IconStar } from "./Icons";

export type OpenState = { id: string; phase: "opening" | "done" } | null;

interface Props {
  vaults: Vault[];
  total: number;
  query: string;
  opening: OpenState;
  /** Fila resaltada por el teclado (-1 = ninguna). */
  cursor: number;
  onToggleFavorite: (v: Vault) => void;
  onOpen: (v: Vault) => void;
  onEdit: (v: Vault) => void;
  onAdd: () => void;
  onFolders: () => void;
}

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

/** Mismo cliente, mismo color de avatar. */
const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;

export function VaultList({ vaults, total, query, opening, cursor, onToggleFavorite, onOpen, onEdit, onAdd, onFolders }: Props) {
  // Mantiene visible la fila resaltada al moverse con las flechas.
  useEffect(() => {
    if (cursor >= 0) document.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (total === 0) {
    return (
      <div className="empty">
        <div className="empty-art"><IconFolder /></div>
        <h2>Aún no hay vaults</h2>
        <p>Añade un vault a mano o importa una carpeta con tus ficheros .kdbx; el cliente toma el nombre de la carpeta.</p>
        <div className="stack">
          <button className="btn btn-primary" onClick={onAdd}><IconPlus /> Añadir vault</button>
          <button className="btn btn-secondary" onClick={onFolders}><IconFolder /> Añadir carpeta</button>
        </div>
      </div>
    );
  }
  if (vaults.length === 0) {
    return (
      <div className="empty">
        <div className="empty-art neutral"><IconSearch /></div>
        <h2>Sin resultados</h2>
        <p>Ningún cliente coincide con «{query.trim()}».</p>
      </div>
    );
  }
  return (
    <div className="list">
      {vaults.map((v, i) => {
        const phase = opening?.id === v.id ? opening.phase : null;
        const cls = phase === "opening" ? "is-opening" : phase === "done" ? "is-open" : opening ? "is-disabled" : i === cursor ? "is-focus" : "";
        return (
          <div
            key={v.id}
            data-idx={i}
            className={`row ${cls}`}
            style={{ animation: "kp-fade-up var(--kp-dur-base) var(--kp-ease-out) backwards", animationDelay: `${Math.min(i, 12) * 22}ms` }}
          >
            <button className="row-main" onClick={() => onOpen(v)} disabled={!!opening} title={v.path}>
              <span className={`avatar av-${hue(v.client)}`}>{phase === "done" ? <IconCheck className="s16" /> : initial(v.client)}</span>
              <span className="row-name">{v.client}</span>
              {phase && (
                <span className={`row-status ${phase === "done" ? "ok" : ""}`}>
                  {phase === "opening" ? <span className="spin" /> : <IconCheck className="s14" />}
                  {phase === "opening" ? "Abriendo…" : "Abierto"}
                </span>
              )}
            </button>
            <button
              className={`row-edit fav ${v.favorite ? "on" : ""}`}
              onClick={() => onToggleFavorite(v)}
              aria-label={v.favorite ? `Quitar ${v.client} de favoritos` : `Marcar ${v.client} como favorito`}
              aria-pressed={v.favorite}
              title={v.favorite ? "Quitar de favoritos" : "Favorito"}
              disabled={!!opening}
            >
              <IconStar className="s16" />
            </button>
            <button className="row-edit" onClick={() => onEdit(v)} aria-label={`Editar ${v.client}`} title="Editar" disabled={!!opening}>
              <IconEdit className="s16" />
            </button>
            {phase === "opening" && <span className="row-progress" />}
          </div>
        );
      })}
    </div>
  );
}
