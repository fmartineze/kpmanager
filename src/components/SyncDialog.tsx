import { useState } from "react";
import { api, errMsg, SyncReport } from "../api";
import { useT } from "../i18n";
import { Modal } from "./Modal";
import { IconEye } from "./Icons";
import { Alert, Box } from "./ui";

interface Props {
  report: SyncReport;
  onClose: () => void;
  onDone: (msg: string) => void;
}

export function SyncDialog({ report, onClose, onDone }: Props) {
  const t = useT();
  const [add, setAdd] = useState(new Set(report.new.map((c) => c.path)));
  const [remove, setRemove] = useState(new Set(report.missing.map((v) => v.id)));
  const [error, setError] = useState("");

  const flip = (set: Set<string>, setter: (s: Set<string>) => void, x: string) => {
    const n = new Set(set);
    if (n.has(x)) n.delete(x);
    else n.add(x);
    setter(n);
  };

  async function apply() {
    try {
      const toAdd = report.new.filter((c) => add.has(c.path));
      // Lo que se deja sin marcar se ignora para no volver a preguntar.
      const ignored = report.new.filter((c) => !add.has(c.path)).map((c) => c.path);
      if (toAdd.length) await api.importCandidates(toAdd.map(({ client, path }) => ({ client, path })));
      if (ignored.length) await api.ignorePaths(ignored);
      if (remove.size) await api.deleteVaults([...remove]);
      const parts = [];
      if (toAdd.length) parts.push(t("sync.added", { n: toAdd.length }));
      if (remove.size) parts.push(t("sync.removed", { n: remove.size }));
      onDone(parts.join(", ") || t("sync.noChange"));
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const footer = (
    <>
      <span className="grow" />
      <button className="btn btn-ghost" onClick={onClose}>{t("common.later")}</button>
      <button className="btn btn-primary" onClick={apply}>{t("common.apply")}</button>
    </>
  );

  return (
    <Modal
      title={t("sync.title")}
      subtitle={t("sync.sub")}
      icon={<IconEye className="s16" />}
      onClose={onClose}
      footer={footer}
    >
      {report.new.length > 0 && (
        <div className="section">
          <span className="section-title">{t("sync.newTitle")}</span>
          <div className="help">{t("sync.newHelp")}</div>
          <div className="results">
            <div className="results-list">
              {report.new.map((c) => (
                <label key={c.path} className="res">
                  <input type="checkbox" className="sr" checked={add.has(c.path)} onChange={() => flip(add, setAdd, c.path)} />
                  <Box on={add.has(c.path)} />
                  <span className="res-txt">
                    <span className="res-name">{c.client}</span>
                    <span className="res-path" title={c.path}>{c.path}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
      {report.missing.length > 0 && (
        <div className="section">
          <span className="section-title">{t("sync.missingTitle")}</span>
          <div className="help">{t("sync.missingHelp")}</div>
          <div className="results">
            <div className="results-list">
              {report.missing.map((v) => (
                <label key={v.id} className="res">
                  <input type="checkbox" className="sr" checked={remove.has(v.id)} onChange={() => flip(remove, setRemove, v.id)} />
                  <Box on={remove.has(v.id)} danger />
                  <span className="res-txt">
                    <span className="res-name">{v.client}</span>
                    <span className="res-path" title={v.path}>{v.path}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
      {error && <Alert kind="err">{error}</Alert>}
    </Modal>
  );
}
