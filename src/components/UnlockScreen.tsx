import { FormEvent, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMsg } from "../api";
import { IconFingerprint, IconKey, IconLock, IconShield } from "./Icons";
import { Alert } from "./ui";

interface Props {
  isNew: boolean;
  /** Windows Hello está activado: se ofrece como método principal. */
  hello: boolean;
  /** Lanzar Windows Hello nada más mostrar la pantalla. */
  autoHello: boolean;
  onUnlocked: () => void;
}

/** 0–4 según longitud y variedad de caracteres. */
function strength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return pw ? Math.max(s, 1) : 0;
}

export function UnlockScreen({ isNew, hello, autoHello, onUnlocked }: Props) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const helloTried = useRef(false);

  const fail = (msg: string) => {
    setError(msg);
    setShake(true);
  };

  const inFlight = useRef(false);

  async function useHello() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api.helloUnlock();
      onUnlocked();
    } catch (err) {
      fail(`${errMsg(err)}. Introduce la contraseña maestra.`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (hello && autoHello && !isNew && !helloTried.current) {
      helloTried.current = true; // evita un segundo aviso por el doble montaje de StrictMode
      useHello();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Si la app se bloqueó al ocultarse, Hello se lanza al volver a mostrarla (atajo, bandeja…).
  useEffect(() => {
    if (!hello || isNew) return;
    const unlisten = listen("focus-search", () => useHello());
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hello, isNew]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (isNew && pw !== pw2) return fail("Las contraseñas no coinciden");
    setBusy(true);
    setError("");
    try {
      await api.unlock(pw);
      setPw("");
      setPw2("");
      onUnlocked();
    } catch (err) {
      fail(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const score = strength(pw);
  const mismatch = isNew && pw2 !== "" && pw !== pw2;

  return (
    <div className="auth">
      <div className="shield-wrap">
        <div className="shield"><IconShield /></div>
      </div>
      <span className="chip-lock"><IconLock className="s14" /> {isNew ? "Primer uso" : "Bloqueado"}</span>
      <h1>{isNew ? "Crea tu contraseña maestra" : "Tus vaults, a un clic"}</h1>
      <p className="lede">
        {isNew ? (
          <>Cifra la configuración y las credenciales guardadas. <strong>No se puede recuperar</strong> si la pierdes.</>
        ) : (
          <>Introduce la contraseña maestra para desbloquear <strong>KP Manager</strong>.</>
        )}
      </p>

      <form className={`form ${shake ? "shake" : ""}`} onSubmit={submit} onAnimationEnd={() => setShake(false)}>
        <div className="field">
          <label className="label" htmlFor="pw">Contraseña maestra</label>
          <div className={`input ${error && !mismatch ? "is-error" : ""}`}>
            <IconKey className="s16" />
            <input
              id="pw"
              className="input-el"
              type="password"
              autoFocus={!hello}
              autoComplete="off"
              placeholder="Contraseña maestra"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </div>
          {isNew && (
            <div className="meter" aria-label={`Fortaleza ${score} de 4`}>
              {[0, 1, 2, 3].map((i) => <b key={i} className={i < score ? "on" : ""} />)}
            </div>
          )}
        </div>
        {isNew && (
          <div className="field">
            <label className="label" htmlFor="pw2">Repite la contraseña</label>
            <div className={`input ${mismatch ? "is-error" : ""}`}>
              <IconKey className="s16" />
              <input id="pw2" className="input-el" type="password" autoComplete="off" placeholder="Repite la contraseña" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </div>
          </div>
        )}
        {error && <Alert kind="err">{error}</Alert>}
        <button className="btn btn-primary btn-block" disabled={busy || !pw}>
          {busy && <span className="spin" />}
          {busy ? "Procesando…" : isNew ? "Crear y entrar" : "Desbloquear"}
        </button>
        {hello && !isNew && (
          <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={useHello}>
            <IconFingerprint /> Usar Windows Hello
          </button>
        )}
      </form>
    </div>
  );
}
