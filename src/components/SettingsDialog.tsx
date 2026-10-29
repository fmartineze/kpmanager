import { useEffect, useState } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, errMsg, HelloStatus, ImportMode, Prefs, PrefsUpdate } from "../api";
import { useT } from "../i18n";
import { Modal } from "./Modal";
import { IconFingerprint, IconKey, IconSettings, IconTrash } from "./Icons";
import { Alert, Check, Segmented } from "./ui";
import { comboFromEvent, DEFAULT_SHORTCUT } from "../shortcut";
import { getVersion } from "@tauri-apps/api/app";
import { fetchLatest, isNewer, REPO_URL_PREFIX, Release } from "../updates";
import { openRelease } from "./UpdateDialog";

type Tab = "general" | "keepass" | "security" | "data" | "about";
const RELEASES_URL = `${REPO_URL_PREFIX}releases`;

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
  const [tab, setTab] = useState<Tab>("general");
  const [exe, setExe] = useState("");
  const [keyfile, setKeyfile] = useState("");
  const [newPw, setNewPw] = useState("");
  const [helloPw, setHelloPw] = useState("");
  const [hello, setHello] = useState<HelloStatus | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [combo, setCombo] = useState("");
  const [shortcutErr, setShortcutErr] = useState("");
  const [confirmErase, setConfirmErase] = useState(false);
  // Comprobación manual de versión nueva
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<{ kind: "latest" | "fail" } | { kind: "new"; release: Release } | null>(null);
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
    getVersion().then(setVersion).catch(() => {});
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
      const { shortcut: _s, ignoredUpdate: _i, ...current } = prefs;
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

  // A mano se avisa de la última versión aunque la hubieras ignorado: lo has pedido expresamente.
  const checkNow = async () => {
    setChecking(true);
    setFound(null);
    try {
      const latest = await fetchLatest();
      setFound(isNewer(latest.version, version) ? { kind: "new", release: latest } : { kind: "latest" });
    } catch {
      setFound({ kind: "fail" });
    } finally {
      setChecking(false);
    }
  };

  const askAgain = () =>
    run(async () => {
      onPrefs(await api.ignoreUpdate(null));
      setPrefs(await api.getPrefs());
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

  const tabList: { id: Tab; label: string }[] = [
    { id: "general", label: t("settings.tabGeneral") },
    { id: "keepass", label: t("settings.tabKeepass") },
    { id: "security", label: t("settings.tabSecurity") },
    { id: "data", label: t("settings.tabData") },
    { id: "about", label: t("settings.tabAbout") },
  ];

  const switchTab = (next: Tab) => {
    setTab(next);
    setMsg("");
    setError("");
  };

  // Flechas izquierda/derecha, Inicio y Fin cambian de pestaña, como en cualquier barra de pestañas.
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = tabList.findIndex((x) => x.id === tab);
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabList.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = tabList[(to + tabList.length) % tabList.length].id;
    switchTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  const tabs = (
    <div className="tabs" role="tablist" aria-label={t("settings.tabs")} onKeyDown={onTabKey}>
      {tabList.map((x) => (
        <button
          key={x.id}
          id={`tab-${x.id}`}
          role="tab"
          aria-selected={tab === x.id}
          aria-controls="settings-panel"
          tabIndex={tab === x.id ? 0 : -1}
          className="tab"
          onClick={() => switchTab(x.id)}
        >
          {x.label}
        </button>
      ))}
    </div>
  );

  const notices = (
    <div className="modal-notices">
      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert kind="err">{error}</Alert>}
    </div>
  );

  return (
    <Modal
      title={t("settings.title")}
      icon={<IconSettings className="s16" />}
      onClose={onClose}
      tabs={tabs}
      notices={notices}
      fixedHeight
      footer={<><span className="grow" /><button className="btn btn-primary" onClick={onClose}>{t("common.done")}</button></>}
    >
      {/* El panel no añade caja propia: sus secciones siguen siendo hijas directas del cuerpo con scroll. */}
      <div id="settings-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} style={{ display: "contents" }}>
        {tab === "general" && (
          <>
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
              {prefs?.closeToTray && <div className="help">{t("settings.trayHelp")}</div>}
              <Check checked={!prefs?.sortByName} onChange={(v) => changePrefs({ sortByName: !v })}>
                {t("settings.sortRecent")}
              </Check>
            </div>
          </>
        )}

        {tab === "keepass" && (
          <>
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
          </>
        )}

        {tab === "security" && (
          <>
            <div className="section">
              <span className="section-title">{t("settings.lock")}</span>
              <Check checked={!!prefs?.lockOnHide} onChange={(v) => changePrefs({ lockOnHide: v })}>
                {t("settings.lockHide")}
              </Check>
              <div className="help">{t("settings.autoLockHelp")}</div>
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
          </>
        )}

        {tab === "data" && (
          <>
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
          </>
        )}

        {tab === "about" && (
          <>
            <div className="section">
              <div className="about">
                <b>KP Manager</b>
                <span className="help">{version && t("settings.version", { v: version })}</span>
                <span className="help">{t("settings.aboutText")}</span>
              </div>
            </div>

            <div className="section">
              <span className="section-title">{t("settings.updates")}</span>
              <Check checked={!!prefs?.checkUpdates} onChange={(v) => changePrefs({ checkUpdates: v })}>
                {t("settings.autoUpdates")}
              </Check>
              <div className="btns">
                <button className="btn btn-secondary btn-sm" onClick={checkNow} disabled={checking || !version}>
                  {checking ? t("settings.checking") : t("settings.checkNow")}
                </button>
              </div>
              {found?.kind === "latest" && <Alert kind="ok">{t("settings.upToDate", { v: version })}</Alert>}
              {found?.kind === "fail" && <Alert kind="err">{t("settings.checkFail")}</Alert>}
              {found?.kind === "new" && (
                <Alert kind="info">
                  {t("settings.newVersion", { v: found.release.version })}{" "}
                  <button className="btn btn-link" onClick={() => openRelease(found.release.url)}>{t("update.download")}</button>
                </Alert>
              )}
              {prefs?.ignoredUpdate && (
                <div className="hello-row">
                  <span className="help">{t("settings.ignoredVersion", { v: prefs.ignoredUpdate })}</span>
                  <button className="btn btn-link" onClick={askAgain}>{t("settings.askAgain")}</button>
                </div>
              )}
            </div>

            <div className="section">
              <span className="section-title">{t("settings.project")}</span>
              <div className="btns">
                <button className="btn btn-secondary btn-sm" onClick={() => openRelease(RELEASES_URL)}>{t("settings.releasesLink")}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
