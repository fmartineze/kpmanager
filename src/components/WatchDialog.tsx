import { useCallback, useEffect, useState } from "react";
import { api, errMsg, WatchedView } from "../api";
import { Modal } from "./Modal";
import { IconFolder, IconPlus } from "./Icons";
import { Alert } from "./ui";

interface Props {
  onClose: () => void;
  onAdd: () => void;
  onRescan: (path: string) => void;
  onCheck: () => void;
}

export function WatchDialog({ onClose, onAdd, onRescan, onCheck }: Props) {
  const [view, setView] = useState<WatchedView | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => setView(await api.listWatched()), []);
  useEffect(() => {
    load().catch((e) => setError(errMsg(e)));
  }, [load]);

  async function run(fn: () => Promise<void>) {
    setError("");
    setMsg("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const remove = (path: string) =>
    run(async () => {
      await api.removeWatched(path);
      setMsg("Carpeta quitada del seguimiento. Sus vaults siguen en la lista.");
    });

  const resetIgnored = () =>
    run(async () => {
      await api.clearIgnored();
      setMsg("Los vaults descartados volverán a proponerse en la próxima revisión.");
    });

  const folders = view?.folders ?? [];

  const footer = (
    <>
      <button className="btn btn-secondary" onClick={onAdd}><IconPlus className="s16" /> Añadir carpeta</button>
      <span className="grow" />
      <button className="btn btn-primary" disabled={folders.length === 0} onClick={onCheck}>Revisar ahora</button>
    </>
  );

  return (
    <Modal
      title="Carpetas"
      subtitle="Importa vaults y vigila carpetas en busca de cambios."
      icon={<IconFolder className="s16" />}
      onClose={onClose}
      footer={footer}
    >
      {folders.length === 0 ? (
        <div className="empty" style={{ padding: "12px 8px" }}>
          <div className="empty-art neutral"><IconFolder /></div>
          <h2>Sin carpetas en seguimiento</h2>
          <p>Añade una carpeta y elige mantenerla en seguimiento: te avisaré de los .kdbx nuevos y de los que desaparezcan.</p>
        </div>
      ) : (
        <div className="results">
          {folders.map((f) => (
            <div key={f.path} className="res wrap static">
              <span className="res-txt">
                <span className="res-name">{f.path.split(/[\\/]/).filter(Boolean).pop() ?? f.path}</span>
                <span className="res-path" title={f.path}>{f.path}</span>
              </span>
              <span className={`badge ${f.reachable ? "badge-ok" : "badge-err"}`}>
                <span className="dot" />
                {f.reachable ? `${f.vaults} ${f.vaults === 1 ? "vault" : "vaults"}` : "No accesible"}
              </span>
              <div className="res-actions">
                <button className="btn btn-secondary btn-sm" disabled={!f.reachable} title="Escaneo completo, incluidos los vaults descartados" onClick={() => onRescan(f.path)}>
                  Re-escanear
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(f.path)}>Quitar</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {view && view.ignoredCount > 0 && (
        <div className="hello-row">
          <span className="help">{view.ignoredCount} vault(s) descartado(s) no se vuelven a proponer.</span>
          <button className="btn btn-link" onClick={resetIgnored}>Volver a proponerlos</button>
        </div>
      )}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert kind="err">{error}</Alert>}
    </Modal>
  );
}
