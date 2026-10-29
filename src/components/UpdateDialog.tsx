import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "../i18n";
import { Release } from "../updates";
import { Modal } from "./Modal";
import { IconRefresh } from "./Icons";
import { Alert } from "./ui";

interface Props {
  release: Release;
  current: string;
  onLater: () => void;
  onIgnore: () => void;
}

/** Abre el enlace de la release en el navegador. Devuelve false si no se pudo. */
export async function openRelease(url: string): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function UpdateDialog({ release, current, onLater, onIgnore }: Props) {
  const t = useT();
  const [failed, setFailed] = useState(false);

  const footer = (
    <>
      <span className="grow" />
      <button className="btn btn-ghost" onClick={onLater}>{t("update.later")}</button>
      <button
        className="btn btn-primary"
        onClick={async () => {
          const ok = await openRelease(release.url);
          setFailed(!ok);
          if (ok) onLater(); // ya la tiene delante: no insistimos hasta la próxima comprobación
        }}
      >
        {t("update.download")}
      </button>
    </>
  );

  return (
    <Modal
      title={t("update.title")}
      subtitle={t("update.sub", { latest: release.version, current })}
      icon={<IconRefresh className="s16" />}
      onClose={onLater}
      footer={footer}
    >
      <p className="muted">{t("update.text")}</p>
      <div className="field">
        <span className="label">{t("update.link")}</span>
        <div className="input"><input className="input-el mono" readOnly value={release.url} onFocus={(e) => e.currentTarget.select()} /></div>
      </div>
      <div className="hello-row">
        <span className="help">{t("update.ignoreHelp")}</span>
        <button className="btn btn-link" onClick={onIgnore}>{t("update.ignore")}</button>
      </div>
      {failed && <Alert kind="err">{t("update.openFail", { url: release.url })}</Alert>}
    </Modal>
  );
}
