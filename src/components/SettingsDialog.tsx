import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errMsg, HelloStatus, Prefs, PrefsUpdate } from "../api";
import { useT } from "../i18n";
import { Modal } from "./Modal";
import { IconFingerprint, IconKey, IconSettings } from "./Icons";
import { Alert, Check, Segmented } from "./ui";
import { comboFromEvent, DEFAULT_SHORTCUT } from "../shortcut";

interface Props {
  onClose: () => void;
  /** El tema y el idioma se aplican en cuanto cambian, sin esperar a cerrar. */
  onPrefs: (p: Prefs) => void;
}

export function SettingsDialog({ onClose, onPrefs }: Props) {
  const t = useT();
  const [exe, setExe] = useState("");
  const [keyfile, setKeyfile] = useState("");
  const [newPw, setNewPw] = useState("");
  const [helloPw, setHelloPw] = useState("");
  const [hello, setHello] = useState<HelloStatus | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [combo, setCombo] = useState("");
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

      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert kind="err">{error}</Alert>}
    </Modal>
  );
}
