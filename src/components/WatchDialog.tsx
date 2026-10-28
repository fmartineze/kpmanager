import { useCallback, useEffect, useState } from "react";
import { api, errMsg, WatchedView } from "../api";
import { useT } from "../i18n";
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
  const t = useT();
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
      setMsg(t("watch.removed"));
    });

  const resetIgnored = () =>
    run(async () => {
      await api.clearIgnored();
      setMsg(t("watch.reproposed"));
    });

  const folders = view?.folders ?? [];

  const footer = (
    <>
      <button className="btn btn-secondary" onClick={onAdd}><IconPlus className="s16" /> {t("list.addFolder")}</button>
      <span className="grow" />
      <button className="btn btn-primary" disabled={folders.length === 0} onClick={onCheck}>{t("watch.checkNow")}</button>
    </>
  );

  return (
    <Modal
      title={t("watch.title")}
      subtitle={t("watch.sub")}
      icon={<IconFolder className="s16" />}
      onClose={onClose}
      footer={footer}
    >
      {folders.length === 0 ? (
        <div className="empty" style={{ padding: "12px 8px" }}>
          <div className="empty-art neutral"><IconFolder /></div>
          <h2>{t("watch.emptyTitle")}</h2>
          <p>{t("watch.emptyText")}</p>
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
                {f.reachable ? t(f.vaults === 1 ? "watch.vaultOne" : "watch.vaultMany", { n: f.vaults }) : t("watch.unreachable")}
              </span>
              <div className="res-actions">
                <button className="btn btn-secondary btn-sm" disabled={!f.reachable} title={t("watch.rescanTitle")} onClick={() => onRescan(f.path)}>
                  {t("watch.rescan")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(f.path)}>{t("common.remove")}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {view && view.ignoredCount > 0 && (
        <div className="hello-row">
          <span className="help">{t("watch.ignoredNote", { n: view.ignoredCount })}</span>
          <button className="btn btn-link" onClick={resetIgnored}>{t("watch.repropose")}</button>
        </div>
      )}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert kind="err">{error}</Alert>}
    </Modal>
  );
}
