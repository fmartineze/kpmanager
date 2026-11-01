import { useState } from "react";
import { api, EntryRow, errMsg, Prefs, Vault } from "../api";
import { getLang, useT } from "../i18n";
import { Modal } from "./Modal";
import { IconReport } from "./Icons";
import { Alert, Box, Check, Note } from "./ui";

interface Props {
  vault: Vault;
  /** Entradas que se pueden incluir. Con una sola no se muestra la lista. */
  rows: EntryRow[];
  prefs: Prefs;
  /** Nombre de la carpeta de la que salen las entradas (si procede). */
  where?: string;
  onClose: () => void;
  notify: (msg: string, kind?: "ok" | "error") => void;
}

/**
 * Informe en texto con las credenciales de unas entradas, para pegarlo en una herramienta de compartir secretos.
 * El texto lo construye y lo copia Rust: aquí solo se elige qué entradas y qué campos entran.
 */
export function ReportDialog({ vault, rows, prefs, where, onClose, notify }: Props) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.map((r) => r.id)));
  const [custom, setCustom] = useState(false);
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false); // explicación completa del aviso de seguridad
  const [error, setError] = useState("");

  const single = rows.length === 1;
  const allOn = selected.size === rows.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  async function copy() {
    setBusy(true);
    setError("");
    try {
      // Se envía el orden de la lista, no el de marcado.
      const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
      const n = await api.copyReport(vault.id, ids, custom, notes, getLang());
      const secs = prefs.clipboardClearSecs;
      notify(secs > 0 ? t("report.copiedClear", { n, s: secs }) : t("report.copied", { n }));
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  const footer = (
    <>
      <span className="grow" />
      <button className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn-primary" onClick={copy} disabled={busy || selected.size === 0}>
        {t("report.copy", { n: selected.size })}
      </button>
    </>
  );

  return (
    <Modal
      title={t("report.title")}
      subtitle={single ? rows[0].title || t("vault.untitled") : [vault.client, where].filter(Boolean).join(" › ")}
      icon={<IconReport className="s16" />}
      onClose={onClose}
      footer={footer}
    >
      <Alert kind="err">
        <b>{t("report.warnTitle")}</b> {t("report.warnShort")}{" "}
        <button type="button" className="link-btn warn-toggle" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {more ? t("report.less") : t("report.more")}
        </button>
        {more && <div className="warn-more">{t("report.warn")}</div>}
      </Alert>

      {!single && (
        <div className="results">
          <div className="results-head">
            <span>{t("report.selected", { n: selected.size, total: rows.length })}</span>
            <button className="btn btn-link" onClick={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))}>
              {allOn ? t("common.none") : t("common.all")}
            </button>
          </div>
          <div className="results-list">
            {rows.map((r) => (
              <label key={r.id} className="res">
                <input type="checkbox" className="sr" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                <Box on={selected.has(r.id)} />
                <span className="res-txt">
                  <span className="res-name">{r.title || t("vault.untitled")}</span>
                  {r.username && <span className="res-path">{r.username}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <span className="section-title">{t("report.include")}</span>
        <div className="help">{t("report.always")}</div>
        <Check checked={custom} onChange={setCustom}>{t("report.custom")}</Check>
        <Check checked={notes} onChange={setNotes}>{t("report.notes")}</Check>
        {notes && <div className="help">{t("report.notesHelp")}</div>}
      </div>

      <Note>{prefs.clipboardClearSecs > 0 ? t("report.clipboardNote", { s: prefs.clipboardClearSecs }) : t("report.clipboardNoteNever")}</Note>
      {error && <Alert kind="err">{error}</Alert>}
    </Modal>
  );
}
