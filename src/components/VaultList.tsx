import { useEffect } from "react";
import { Vault } from "../api";
import { useT } from "../i18n";
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
  const t = useT();

  // Mantiene visible la fila resaltada al moverse con las flechas.
  useEffect(() => {
    if (cursor >= 0) document.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (total === 0) {
    return (
      <div className="empty">
        <div className="empty-art"><IconFolder /></div>
        <h2>{t("list.emptyTitle")}</h2>
        <p>{t("list.emptyText")}</p>
        <div className="stack">
          <button className="btn btn-primary" onClick={onAdd}><IconPlus /> {t("list.addVault")}</button>
          <button className="btn btn-secondary" onClick={onFolders}><IconFolder /> {t("list.addFolder")}</button>
        </div>
      </div>
    );
  }
  if (vaults.length === 0) {
    return (
      <div className="empty">
        <div className="empty-art neutral"><IconSearch /></div>
        <h2>{t("list.noResults")}</h2>
        <p>{t("list.noResultsText", { q: query.trim() })}</p>
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
                  {phase === "opening" ? t("list.opening") : t("list.opened")}
                </span>
              )}
            </button>
            <button
              className={`row-edit fav ${v.favorite ? "on" : ""}`}
              onClick={() => onToggleFavorite(v)}
              aria-label={v.favorite ? t("list.favRemove", { name: v.client }) : t("list.favAdd", { name: v.client })}
              aria-pressed={v.favorite}
              title={v.favorite ? t("list.favTitleOff") : t("list.favTitle")}
              disabled={!!opening}
            >
              <IconStar className="s16" />
            </button>
            <button className="row-edit" onClick={() => onEdit(v)} aria-label={t("list.editAria", { name: v.client })} title={t("list.edit")} disabled={!!opening}>
              <IconEdit className="s16" />
            </button>
            {phase === "opening" && <span className="row-progress" />}
          </div>
        );
      })}
    </div>
  );
}
