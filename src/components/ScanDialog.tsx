import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Candidate, errMsg } from "../api";
import { useT } from "../i18n";
import { Modal } from "./Modal";
import { IconFolder } from "./Icons";
import { Alert, Box, Note } from "./ui";

interface Props {
  onClose: () => void;
  onImported: () => void;
  /** Carpeta ya en seguimiento que se vuelve a escanear por completo (incluye los descartados). */
  rescan?: string;
}

export function ScanDialog({ onClose, onImported, rescan }: Props) {
  const t = useT();
  const [root, setRoot] = useState(rescan ?? "");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // null = aún sin responder; hay que elegir explícitamente antes de confirmar.
  // En un re-escaneo la carpeta ya se sigue: no hay nada que preguntar.
  const [watch, setWatch] = useState<boolean | null>(rescan ? true : null);

  async function scan(dir: string) {
    setRoot(dir);
    setBusy(true);
    setError("");
    try {
      const res = await api.scanFolder(dir);
      setFound(res);
      // Los descartados antes quedan sin marcar: el usuario decide si los recupera.
      setSelected(new Set(res.filter((c) => !c.already && !c.ignored).map((c) => c.path)));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") await scan(dir);
  }

  useEffect(() => {
    if (rescan) scan(rescan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectable = (found ?? []).filter((c) => !c.already);
  const allOn = selectable.length > 0 && selectable.every((c) => selected.has(c.path));

  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const toggleAll = () => setSelected(allOn ? new Set() : new Set(selectable.map((c) => c.path)));

  async function importSelected() {
    const items = (found ?? []).filter((c) => selected.has(c.path)).map(({ client, path }) => ({ client, path }));
    try {
      if (items.length) await api.importCandidates(items);
      // Con seguimiento, lo que se deja sin marcar se descarta para que la revisión no lo proponga luego.
      const rejected = (found ?? []).filter((c) => !c.already && !selected.has(c.path)).map((c) => c.path);
      if (watch && rejected.length) await api.ignorePaths(rejected);
      if (watch && root) await api.addWatched(root);
      onImported();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const footer = (
    <>
      <span className="grow" />
      <button className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
      <button
        className="btn btn-primary"
        disabled={!found || watch === null || (selected.size === 0 && !watch)}
        onClick={importSelected}
      >
        {selected.size ? t("scan.add", { n: selected.size }) : t("common.save")}
      </button>
    </>
  );

  return (
    <Modal
      title={rescan ? t("scan.titleRescan") : t("scan.titleAdd")}
      subtitle={t("scan.sub")}
      icon={<IconFolder className="s16" />}
      onClose={onClose}
      footer={footer}
    >
      <Note>{t("scan.note")}</Note>
      <div className="input-row">
        <div className="input"><input className="input-el mono" readOnly value={root} placeholder={t("scan.noFolder")} /></div>
        {rescan ? (
          <button className="btn btn-secondary" onClick={() => scan(rescan)} disabled={busy}>{t("common.retry")}</button>
        ) : (
          <button className="btn btn-secondary" onClick={choose} disabled={busy}>{t("common.choose")}</button>
        )}
      </div>
      {busy && (
        <>
          <div className="scanbar" />
          <div className="skel" style={{ width: "70%" }} />
          <div className="skel" style={{ width: "50%" }} />
        </>
      )}
      {error && <Alert kind="err">{error}</Alert>}

      {found && !busy && (
        <div className="results">
          <div className="results-head">
            <span>{t(found.length === 1 ? "scan.foundOne" : "scan.foundMany", { n: found.length })}</span>
            {selectable.length > 0 && (
              <button className="btn btn-link" onClick={toggleAll}>{allOn ? t("common.none") : t("common.all")}</button>
            )}
          </div>
          <div className="results-list">
            {found.map((c, i) => (
              <label key={c.path} className={`res ${c.already ? "is-added" : ""}`} style={{ animationDelay: `${Math.min(i, 10) * 20}ms` }}>
                <input type="checkbox" className="sr" disabled={c.already} checked={selected.has(c.path)} onChange={() => toggle(c.path)} />
                <Box on={selected.has(c.path)} disabled={c.already} />
                <span className="res-txt">
                  <span className="res-name">{c.client}</span>
                  <span className="res-path" title={c.path}>{c.path}</span>
                </span>
                {c.already && <span className="badge badge-neutral">{t("scan.already")}</span>}
                {c.ignored && <span className="badge badge-neutral">{t("scan.ignored")}</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      {found && !busy && !rescan && (
        <fieldset className="choice">
          <legend>{t("scan.watchQ")}</legend>
          <label className={`choice-card ${watch === true ? "on" : ""}`}>
            <input type="radio" className="sr" name="watch" checked={watch === true} onChange={() => setWatch(true)} />
            <span className="radio" />
            <span className="txt">
              <strong>{t("scan.watchYes")}</strong>
              <small>{t("scan.watchYesDesc")}</small>
            </span>
          </label>
          <label className={`choice-card ${watch === false ? "on" : ""}`}>
            <input type="radio" className="sr" name="watch" checked={watch === false} onChange={() => setWatch(false)} />
            <span className="radio" />
            <span className="txt">
              <strong>{t("scan.watchNo")}</strong>
              <small>{t("scan.watchNoDesc")}</small>
            </span>
          </label>
        </fieldset>
      )}
    </Modal>
  );
}
