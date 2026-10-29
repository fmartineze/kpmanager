import { FormEvent, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMsg } from "../api";
import { IconFingerprint, IconKey, IconLock, IconShield } from "./Icons";
import { Alert } from "./ui";
import { rich, useT } from "../i18n";
import { HelloMode, HelloTrigger, shouldPromptHello } from "../helloPolicy";

interface Props {
  isNew: boolean;
  /** Windows Hello está activado: se ofrece como método principal. */
  hello: boolean;
  /** Cuándo lanzar Windows Hello sin que el usuario lo pida (solo con la ventana a la vista y en primer plano). */
  helloMode: HelloMode;
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

export function UnlockScreen({ isNew, hello, helloMode, onUnlocked }: Props) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

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
      fail(t("unlock.helloFail", { err: errMsg(err) }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // Hello solo se lanza solo una vez por pantalla de bloqueo («armado»): si el usuario lo cancela o falla,
  // ya no vuelve a saltar y queda el botón. Y nunca con la ventana fuera de vista (ver helloPolicy).
  const armed = useRef(hello && !isNew);

  useEffect(() => {
    if (!hello || isNew) return;
    const attempt = (trigger: HelloTrigger) => {
      if (!armed.current || inFlight.current || !shouldPromptHello(helloMode, trigger)) return;
      armed.current = false;
      useHello();
    };
    const onReturn = () => attempt("return");
    const onInteraction = () => attempt("interaction");

    attempt("mount");
    // La ventana recupera el foco (restaurarla de la barra de tareas, alt-tab…).
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    // Atajo global, bandeja o segunda ejecución: Rust trae la ventana al frente y avisa.
    const unlisten = listen("focus-search", onReturn);
    // Bloqueo por inactividad con la app a la vista: se pide al volver a tocarla, no de golpe.
    const interactive = helloMode === "interaction" ? (["pointerdown", "pointermove", "keydown"] as const) : [];
    interactive.forEach((e) => window.addEventListener(e, onInteraction));
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      interactive.forEach((e) => window.removeEventListener(e, onInteraction));
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hello, isNew, helloMode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (isNew && pw !== pw2) return fail(t("unlock.mismatch"));
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
      <span className="chip-lock"><IconLock className="s14" /> {isNew ? t("unlock.chipNew") : t("unlock.chipLocked")}</span>
      <h1>{isNew ? t("unlock.titleNew") : t("unlock.titleLocked")}</h1>
      <p className="lede">{rich(t(isNew ? "unlock.ledeNew" : "unlock.ledeLocked"))}</p>

      <form className={`form ${shake ? "shake" : ""}`} onSubmit={submit} onAnimationEnd={() => setShake(false)}>
        <div className="field">
          <label className="label" htmlFor="pw">{t("unlock.master")}</label>
          <div className={`input ${error && !mismatch ? "is-error" : ""}`}>
            <IconKey className="s16" />
            <input
              id="pw"
              className="input-el"
              type="password"
              autoFocus={!hello}
              autoComplete="off"
              placeholder={t("unlock.master")}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </div>
          {isNew && (
            <div className="meter" aria-label={t("unlock.strength", { n: score })}>
              {[0, 1, 2, 3].map((i) => <b key={i} className={i < score ? "on" : ""} />)}
            </div>
          )}
        </div>
        {isNew && (
          <div className="field">
            <label className="label" htmlFor="pw2">{t("unlock.repeat")}</label>
            <div className={`input ${mismatch ? "is-error" : ""}`}>
              <IconKey className="s16" />
              <input id="pw2" className="input-el" type="password" autoComplete="off" placeholder={t("unlock.repeat")} value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </div>
          </div>
        )}
        {error && <Alert kind="err">{error}</Alert>}
        <button className="btn btn-primary btn-block" disabled={busy || !pw}>
          {busy && <span className="spin" />}
          {busy ? t("unlock.busy") : isNew ? t("unlock.create") : t("unlock.unlock")}
        </button>
        {hello && !isNew && (
          <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={useHello}>
            <IconFingerprint /> {t("unlock.hello")}
          </button>
        )}
      </form>
    </div>
  );
}
