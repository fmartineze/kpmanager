import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errMsg, HelloStatus, Prefs } from "../api";
import { Modal } from "./Modal";
import { IconFingerprint, IconKey, IconSettings } from "./Icons";
import { Alert, Check } from "./ui";
import { comboFromEvent, DEFAULT_SHORTCUT } from "../shortcut";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
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
      setMsg(s.keepassxcPath ? "Ruta guardada" : "Ruta manual eliminada: se usará la autodetección");
    });

  const detect = () =>
    run(async () => {
      const s = await api.detectKeepassxc();
      setExe(s.keepassxcPath ?? "");
      setMsg("KeePassXC detectado");
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
      setMsg(s.defaultKeyfile ? "Keyfile predeterminada guardada" : "Keyfile predeterminada eliminada");
    });

  const changePrefs = (patch: Partial<Pick<Prefs, "minimizeToTray" | "closeToTray" | "lockOnHide" | "sortByName">>) =>
    run(async () => {
      if (!prefs) return;
      const next = { ...prefs, ...patch };
      setPrefs(await api.setPrefs(next.minimizeToTray, next.closeToTray, next.lockOnHide, next.sortByName));
    });

  const saveShortcut = (value: string | null) =>
    run(async () => {
      const p = await api.setShortcut(value);
      setPrefs(p);
      setCombo(p.shortcut ?? "");
      setMsg(p.shortcut ? `Atajo global: ${p.shortcut}` : "Atajo global desactivado");
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
      setMsg("Windows Hello activado");
    });

  const disableHello = () =>
    run(async () => {
      await api.helloDisable();
      setHello(await api.helloStatus());
      setMsg("Windows Hello desactivado");
    });

  const changePw = () =>
    run(async () => {
      await api.changeMasterPassword(newPw);
      setNewPw("");
      setMsg(hello?.enabled ? "Contraseña maestra cambiada. Windows Hello se ha desactivado: vuelve a activarlo" : "Contraseña maestra cambiada");
      setHello(await api.helloStatus());
    });

  return (
    <Modal
      title="Ajustes"
      icon={<IconSettings className="s16" />}
      onClose={onClose}
      footer={<><span className="grow" /><button className="btn btn-primary" onClick={onClose}>Listo</button></>}
    >
      <div className="section">
        <span className="section-title">KeePassXC</span>
        <div className="field">
          <label className="label" htmlFor="s-exe">Ejecutable</label>
          <div className="input-row">
            <div className="input"><input id="s-exe" className="input-el mono" value={exe} onChange={(e) => setExe(e.target.value)} placeholder="Autodetección" /></div>
            <button className="btn btn-secondary" onClick={browse}>Examinar</button>
          </div>
        </div>
        <div className="btns">
          <button className="btn btn-secondary btn-sm" onClick={detect}>Detectar automáticamente</button>
          <button className="btn btn-ghost btn-sm" onClick={save}>Guardar ruta</button>
        </div>
      </div>

      <div className="section">
        <span className="section-title">Acceso rápido</span>
        <div className="field">
          <label className="label" htmlFor="s-sc">Atajo global para abrir la app</label>
          <div className="input capture">
            <input
              id="s-sc"
              className="input-el mono"
              readOnly
              value={combo}
              placeholder="Pulsa la combinación…"
              onKeyDown={captureKey}
            />
          </div>
          <div className="help">Haz clic en el campo y pulsa la combinación (con Ctrl, Alt, Mayús o Win). Funciona desde cualquier aplicación.</div>
        </div>
        <div className="btns">
          <button className="btn btn-secondary btn-sm" onClick={() => saveShortcut(combo || null)} disabled={combo === (prefs?.shortcut ?? "")}>Guardar atajo</button>
          <button className="btn btn-ghost btn-sm" onClick={() => saveShortcut(DEFAULT_SHORTCUT)}>Restablecer</button>
          {prefs?.shortcut && <button className="btn btn-ghost btn-sm" onClick={() => saveShortcut(null)}>Quitar</button>}
        </div>
      </div>

      <div className="section">
        <span className="section-title">Ventana y lista</span>
        <Check checked={!!prefs?.minimizeToTray} onChange={(v) => changePrefs({ minimizeToTray: v })}>
          Minimizar a la bandeja del sistema
        </Check>
        <Check checked={!!prefs?.closeToTray} onChange={(v) => changePrefs({ closeToTray: v })}>
          Cerrar a la bandeja (la app sigue disponible con el atajo)
        </Check>
        <Check checked={!!prefs?.lockOnHide} onChange={(v) => changePrefs({ lockOnHide: v })}>
          Bloquear al ocultar la ventana en la bandeja
        </Check>
        {prefs?.closeToTray && (
          <div className="help">Para cerrarla del todo: clic derecho en el icono de la bandeja → «Cerrar KP Manager».</div>
        )}
        <Check checked={!prefs?.sortByName} onChange={(v) => changePrefs({ sortByName: !v })}>
          Ordenar por último uso (si no, alfabético). Los favoritos van siempre arriba.
        </Check>
      </div>

      <div className="section">
        <span className="section-title">Keyfile predeterminada</span>
        <div className="help">Se rellena al crear un vault y se ofrece al editar los que no la usan.</div>
        <div className="input-row">
          <div className="input"><input className="input-el mono" value={keyfile} onChange={(e) => setKeyfile(e.target.value)} placeholder="Ninguna" /></div>
          <button className="btn btn-secondary" onClick={browseKeyfile}>Examinar</button>
        </div>
        <div className="btns">
          <button className="btn btn-secondary btn-sm" onClick={() => saveKeyfile(keyfile)}>Guardar</button>
          {keyfile && <button className="btn btn-ghost btn-sm" onClick={() => saveKeyfile("")}>Quitar</button>}
        </div>
      </div>

      {hello?.supported && (
        <div className="section">
          <span className="section-title">Windows Hello</span>
          {hello.enabled ? (
            <div className="hello-row">
              <span className="badge badge-ok"><span className="dot" /> Activado</span>
              <span className="help">Se usa al iniciar; si falla, se pide la contraseña.</span>
              <button className="btn btn-ghost btn-sm" onClick={disableHello}>Desactivar</button>
            </div>
          ) : (
            <>
              <div className="help">Desbloquea con tu huella, rostro o PIN. Confirma tu contraseña maestra para activarlo.</div>
              <div className="input-row">
                <div className="input">
                  <IconKey className="s16" />
                  <input className="input-el" type="password" autoComplete="off" value={helloPw} onChange={(e) => setHelloPw(e.target.value)} placeholder="Contraseña maestra" />
                </div>
                <button className="btn btn-secondary" onClick={enableHello} disabled={!helloPw}><IconFingerprint className="s16" /> Activar</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="section">
        <span className="section-title">Contraseña maestra</span>
        <div className="input-row">
          <div className="input">
            <IconKey className="s16" />
            <input className="input-el" type="password" autoComplete="off" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="Nueva contraseña maestra" />
          </div>
          <button className="btn btn-secondary" onClick={changePw} disabled={!newPw}>Cambiar</button>
        </div>
      </div>

      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert kind="err">{error}</Alert>}
    </Modal>
  );
}
