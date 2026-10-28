import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Candidate, errMsg } from "../api";
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
      <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
      <button
        className="btn btn-primary"
        disabled={!found || watch === null || (selected.size === 0 && !watch)}
        onClick={importSelected}
      >
        {selected.size ? `Añadir ${selected.size}` : "Guardar"}
      </button>
    </>
  );

  return (
    <Modal
      title={rescan ? "Re-escanear carpeta" : "Añadir carpeta"}
      subtitle="Busca ficheros .kdbx de forma recursiva."
      icon={<IconFolder className="s16" />}
      onClose={onClose}
      footer={footer}
    >
      <Note>El nombre del cliente será el de la carpeta que contiene cada fichero.</Note>
      <div className="input-row">
        <div className="input"><input className="input-el mono" readOnly value={root} placeholder="Ninguna carpeta seleccionada" /></div>
        {rescan ? (
          <button className="btn btn-secondary" onClick={() => scan(rescan)} disabled={busy}>Reintentar</button>
        ) : (
          <button className="btn btn-secondary" onClick={choose} disabled={busy}>Elegir</button>
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
            <span>{found.length} {found.length === 1 ? "vault encontrado" : "vaults encontrados"}</span>
            {selectable.length > 0 && (
              <button className="btn btn-link" onClick={toggleAll}>{allOn ? "Ninguno" : "Todos"}</button>
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
                {c.already && <span className="badge badge-neutral">ya añadido</span>}
                {c.ignored && <span className="badge badge-neutral">descartado antes</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      {found && !busy && !rescan && (
        <fieldset className="choice">
          <legend>¿Poner esta carpeta en seguimiento?</legend>
          <label className={`choice-card ${watch === true ? "on" : ""}`}>
            <input type="radio" className="sr" name="watch" checked={watch === true} onChange={() => setWatch(true)} />
            <span className="radio" />
            <span className="txt">
              <strong>Sí, mantenerla en seguimiento</strong>
              <small>
                Cada vez que abras la app (y al volver a ella) se revisa la carpeta. Si aparece un .kdbx nuevo te
                preguntaré si añadirlo, y si uno registrado ya no existe, si quitarlo de la lista.
              </small>
            </span>
          </label>
          <label className={`choice-card ${watch === false ? "on" : ""}`}>
            <input type="radio" className="sr" name="watch" checked={watch === false} onChange={() => setWatch(false)} />
            <span className="radio" />
            <span className="txt">
              <strong>No, solo importar ahora</strong>
              <small>Se añaden los vaults seleccionados y no se vuelve a mirar la carpeta.</small>
            </span>
          </label>
        </fieldset>
      )}
    </Modal>
  );
}
