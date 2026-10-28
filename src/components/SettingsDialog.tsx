import { useEffect, useState } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, errMsg, HelloStatus, ImportMode, Prefs, PrefsUpdate } from "../api";
import { useT } from "../i18n";
import { Modal } from "./Modal";
import { IconFingerprint, IconKey, IconSettings, IconTrash } from "./Icons";
import { Alert, Check, Segmented } from "./ui";
import { comboFromEvent, DEFAULT_SHORTCUT } from "../shortcut";

interface Props {
  onClose: () => void;
  /** El tema y el idioma se aplican en cuanto cambian, sin esperar a cerrar. */
  onPrefs: (p: Prefs) => void;
  /** Se borraron todos los datos: la app debe volver al primer uso. */
  onReset: () => void;
  /** Se importó una configuración: la lista y las preferencias deben recargarse. */
  onImported: () => void;
}

export function SettingsDialog({ onClose, onPrefs, onReset, onImported }: Props) {
  const t = useT();
  const [exe, setExe] = useState("");
  const [keyfile, setKeyfile] = useState("");
  const [newPw, setNewPw] = useState("");
  const [helloPw, setHelloPw] = useState("");
  const [hello, setHello] = useState<HelloStatus | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [combo, setCombo] = useState("");
  const [shortcutErr, setShortcutErr] = useState("");
  const [confirmErase, setConfirmErase] = useState(false);
  // Importación en curso: fichero elegido, su contraseña y el modo.
  const [importFile, setImportFile] = useState<string | null>(null);
  const [importPw, setImportPw] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.getPrefs().then((p) => {
      setPrefs(p);
      setCombo(p.shortcut ?? "");
    });
    api.getSettings().then((s) => {
      setExe(s.keepassxcPath ?? "");
      setKeyfile(s.defaultKeyfile ?? "");
    });
    api.helloStatus().then(setHello);
    api.shortcutStatus().then((e) => setShortcutErr(e ? errMsg(e) : ""));
  }, []);

  async function run(fn: () => Promise<void>) {
    setMsg("");
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const save = () =>
    run(async () => {
      const s = await api.setKeepassxcPath(exe || null);
      setExe(s.keepassxcPath ?? "");
      setMsg(s.keepassxcPath ? t("settings.exeSaved") : t("settings.exeCleared"));
    });

  const detect = () =>
    run(async () => {
      const s = await api.detectKeepassxc();
      setExe(s.keepassxcPath ?? "");
      setMsg(t("settings.detected"));
    });

  const browse = async () => {
    const sel = await open({ multiple: false, directory: false });
    if (typeof sel === "string") setExe(sel);
  };

  const browseKeyfile = async () => {
    const sel = await open({ multiple: false, directory: false });
    if (typeof sel === "string") setKeyfile(sel);
  };

  const saveKeyfile = (value: string) =>
    run(async () => {
      const s = await api.setDefaultKeyfile(value || null);
      setKeyfile(s.defaultKeyfile ?? "");
      setMsg(s.defaultKeyfile ? t("settings.keyfileSaved") : t("settings.keyfileCleared"));
    });

  const changePrefs = (patch: Partial<PrefsUpdate>) =>
    run(async () => {
      if (!prefs) return;
      const { shortcut: _s, ...current } = prefs;
      const next = await api.setPrefs({ ...current, ...patch });
      setPrefs(next);
      onPrefs(next);
    });

  const saveShortcut = (value: string | null) =>
    run(async () => {
      const p = await api.setShortcut(value);
      setPrefs(p);
      setCombo(p.shortcut ?? "");
      setShortcutErr(""); // si hubo error, set_shortcut habría fallado antes de llegar aquí
      setMsg(p.shortcut ? t("settings.shortcutSet", { key: p.shortcut }) : t("settings.shortcutOff"));
    });

  const captureKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") return; // no atrapar la navegación con teclado
    e.preventDefault();
    const c = comboFromEvent(e);
    if (c) setCombo(c);
  };

  const enableHello = () =>
    run(async () => {
      await api.helloEnable(helloPw);
      setHelloPw("");
      setHello(await api.helloStatus());
      setMsg(t("settings.helloEnabled"));
    });

  const disableHello = () =>
    run(async () => {
      await api.helloDisable();
      setHello(await api.helloStatus());
      setMsg(t("settings.helloDisabled"));
    });

  const exportConfig = () =>
    run(async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await saveDialog({
        defaultPath: `kp-manager-${stamp}.kpm`,
        filters: [{ name: "KP Manager", extensions: ["kpm"] }],
      });
      if (!path) return; // canceló el selector
      await api.exportConfig(path);
      setMsg(t("settings.exported"));
    });

  const pickImport = async () => {
    const sel = await open({ multiple: false, directory: false, filters: [{ name: "KP Manager", extensions: ["kpm"] }] });
    if (typeof sel !== "string") return;
    setMsg("");
    setError("");
    setImportPw("");
    setImportMode("merge");
    setImportFile(sel);
  };

  const cancelImport = () => {
    setImportFile(null);
    setImportPw("");
  };

  const doImport = async () => {
    if (!importFile) return;
    setMsg("");
    setError("");
    try {
      const r = await api.importConfig(importFile, importPw, importMode);
      cancelImport();
      setMsg(t(r.replaced ? "settings.importedReplace" : "settings.imported", { vaults: r.vaults, folders: r.folders }));
      onImported();
    } catch (e) {
      // «Contraseña incorrecta» aquí es la del fichero, no la maestra de esta instalación.
      const wrong = typeof e === "object" && e !== null && (e as { code?: string }).code === "wrongPassword";
      setError(wrong ? t("settings.importWrongPw") : errMsg(e));
    }
  };

  const erase = () =>
    run(async () => {
      await api.resetData();
      onReset();
    });

  const changePw = () =>
    run(async () => {
      await api.changeMasterPassword(newPw);
      setNewPw("");
      setMsg(hello?.enabled ? t("settings.masterChangedHello") : t("settings.masterChanged"));
      setHello(await api.helloStatus());
    });

  return (
    <Modal
      title={t("settings.title")}
      icon={<IconSettings className="s16" />}
      onClose={onClose}
      footer={<><span className="grow" /><button className="btn btn-primary" onClick={onClose}>{t("common.done")}</button></>}
    >
      <div className="section">
        <span className="section-title">{t("settings.appearance")}</span>
        <div className="field">
          <span className="label">{t("settings.theme")}</span>
          <Segmented
            label={t("settings.theme")}
            value={prefs?.theme ?? "system"}
            onChange={(theme) => changePrefs({ theme })}
            options={[
              { value: "system", label: t("settings.themeSystem") },
              { value: "light", label: t("settings.themeLight") },
              { value: "dark", label: t("settings.themeDark") },
            ]}
          />
        </div>
        <div className="field">
          <span className="label">{t("settings.language")}</span>
          <Segmented
            label={t("settings.language")}
            value={prefs?.language ?? "auto"}
            onChange={(language) => changePrefs({ language })}
            options={[
              { value: "auto", label: t("settings.langAuto") },
              { value: "es", label: t("settings.langEs") },
              { value: "en", label: t("settings.langEn") },
            ]}
          />
        </div>
      </div>

      <div className="section">
        <span className="section-title">{t("settings.keepass")}</span>
        <div className="field">
          <label className="label" htmlFor="s-exe">{t("settings.exe")}</label>
          <div className="input-row">
            <div className="input"><input id="s-exe" className="input-el mono" value={exe} onChange={(e) => setExe(e.target.value)} placeholder={t("settings.autodetect")} /></div>
            <button className="btn btn-secondary" onClick={browse}>{t("common.browse")}</button>
          </div>
        </div>
        <div className="btns">
          <button className="btn btn-secondary btn-sm" onClick={detect}>{t("settings.detect")}</button>
          <button className="btn btn-ghost btn-sm" onClick={save}>{t("settings.saveExe")}</button>
        </div>
      </div>

      <div className="section">
        <span className="section-title">{t("settings.quick")}</span>
        <div className="field">
          <label className="label" htmlFor="s-sc">{t("settings.shortcut")}</label>
          <div className="input capture">
            <input
              id="s-sc"
              className="input-el mono"
              readOnly
              value={combo}
              placeholder={t("settings.shortcutPh")}
              onKeyDown={captureKey}
            />
          </div>
          <div className="help">{t("settings.shortcutHelp")}</div>
          {shortcutErr && <Alert kind="err">{t("settings.shortcutFailed", { err: shortcutErr })}</Alert>}
        </div>
        <div className="btns">
          <button className="btn btn-secondary btn-sm" onClick={() => saveShortcut(combo || null)} disabled={combo === (prefs?.shortcut ?? "")}>{t("settings.saveShortcut")}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => saveShortcut(DEFAULT_SHORTCUT)}>{t("settings.reset")}</button>
          {prefs?.shortcut && <button className="btn btn-ghost btn-sm" onClick={() => saveShortcut(null)}>{t("common.remove")}</button>}
        </div>
      </div>

      <div className="section">
        <span className="section-title">{t("settings.window")}</span>
        <Check checked={!!prefs?.minimizeToTray} onChange={(v) => changePrefs({ minimizeToTray: v })}>
          {t("settings.minTray")}
        </Check>
        <Check checked={!!prefs?.closeToTray} onChange={(v) => changePrefs({ closeToTray: v })}>
          {t("settings.closeTray")}
        </Check>
        <Check checked={!!prefs?.lockOnHide} onChange={(v) => changePrefs({ lockOnHide: v })}>
          {t("settings.lockHide")}
        </Check>
        {prefs?.closeToTray && <div className="help">{t("settings.trayHelp")}</div>}
        <Check checked={!prefs?.sortByName} onChange={(v) => changePrefs({ sortByName: !v })}>
          {t("settings.sortRecent")}
        </Check>
      </div>

      <div className="section">
        <span className="section-title">{t("settings.keyfile")}</span>
        <div className="help">{t("settings.keyfileHelp")}</div>
        <div className="input-row">
          <div className="input"><input className="input-el mono" value={keyfile} onChange={(e) => setKeyfile(e.target.value)} placeholder={t("settings.keyfileNone")} /></div>
          <button className="btn btn-secondary" onClick={browseKeyfile}>{t("common.browse")}</button>
        </div>
        <div className="btns">
          <button className="btn btn-secondary btn-sm" onClick={() => saveKeyfile(keyfile)}>{t("common.save")}</button>
          {keyfile && <button className="btn btn-ghost btn-sm" onClick={() => saveKeyfile("")}>{t("common.remove")}</button>}
        </div>
      </div>

      {hello?.supported && (
        <div className="section">
          <span className="section-title">{t("settings.hello")}</span>
          {hello.enabled ? (
            <div className="hello-row">
              <span className="badge badge-ok"><span className="dot" /> {t("settings.helloOn")}</span>
              <span className="help">{t("settings.helloOnHelp")}</span>
              <button className="btn btn-ghost btn-sm" onClick={disableHello}>{t("settings.disable")}</button>
            </div>
          ) : (
            <>
              <div className="help">{t("settings.helloHelp")}</div>
              <div className="input-row">
                <div className="input">
                  <IconKey className="s16" />
                  <input className="input-el" type="password" autoComplete="off" value={helloPw} onChange={(e) => setHelloPw(e.target.value)} placeholder={t("settings.master")} />
                </div>
                <button className="btn btn-secondary" onClick={enableHello} disabled={!helloPw}><IconFingerprint className="s16" /> {t("settings.enable")}</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="section">
        <span className="section-title">{t("settings.master")}</span>
        <div className="input-row">
          <div className="input">
            <IconKey className="s16" />
            <input className="input-el" type="password" autoComplete="off" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder={t("settings.newMaster")} />
          </div>
          <button className="btn btn-secondary" onClick={changePw} disabled={!newPw}>{t("settings.change")}</button>
        </div>
      </div>

      <div className="section">
        <span className="section-title">{t("settings.backup")}</span>
        {importFile ? (
          <>
            <div className="field">
              <label className="label" htmlFor="i-file">{t("settings.importFile")}</label>
              <div className="input"><input id="i-file" className="input-el mono" readOnly value={importFile} /></div>
            </div>
            <div className="field">
              <label className="label" htmlFor="i-pw">{t("settings.importPw")}</label>
              <div className="input">
                <IconKey className="s16" />
                <input id="i-pw" className="input-el" type="password" autoComplete="off" autoFocus value={importPw} onChange={(e) => setImportPw(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <span className="label">{t("settings.importMode")}</span>
              <Segmented
                label={t("settings.importMode")}
                value={importMode}
                onChange={setImportMode}
                options={[
                  { value: "merge", label: t("settings.modeMerge") },
                  { value: "replace", label: t("settings.modeReplace") },
                ]}
              />
              <div className="help">{t(importMode === "merge" ? "settings.modeMergeHelp" : "settings.modeReplaceHelp")}</div>
            </div>
            <div className="btns">
              <button className={`btn btn-sm ${importMode === "replace" ? "btn-danger-solid" : "btn-primary"}`} onClick={doImport} disabled={!importPw}>
                {t(importMode === "replace" ? "settings.importReplaceDo" : "settings.importDo")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={cancelImport}>{t("common.cancel")}</button>
            </div>
          </>
        ) : (
          <>
            <div className="help">{t("settings.backupHelp")}</div>
            <div className="btns">
              <button className="btn btn-secondary btn-sm" onClick={exportConfig}>{t("settings.export")}</button>
              <button className="btn btn-secondary btn-sm" onClick={pickImport}>{t("settings.import")}</button>
            </div>
          </>
        )}
      </div>

      <div className="section">
        <span className="section-title">{t("settings.data")}</span>
        {confirmErase ? (
          <div className="confirm">
            <div className="confirm-row">
              <span className="confirm-q"><IconTrash className="s16" /> {t("settings.eraseQ")}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmErase(false)}>{t("common.cancel")}</button>
              <button className="btn btn-danger-solid btn-sm" onClick={erase}>{t("settings.eraseYes")}</button>
            </div>
            <div className="note">{t("settings.eraseNote")}</div>
          </div>
        ) : (
          <>
            <div className="help">{t("settings.eraseHelp")}</div>
            <div className="btns">
              <button className="btn btn-danger btn-sm" onClick={() => setConfirmErase(true)}>
                <IconTrash className="s16" /> {t("settings.erase")}
              </button>
            </div>
          </>
        )}
      </div>

      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert kind="err">{error}</Alert>}
    </Modal>
  );
}
