import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, HelloStatus, Prefs, SyncReport, Vault } from "./api";
import { listen } from "@tauri-apps/api/event";
import { rich, setLanguagePref, translate, useLang, useT } from "./i18n";
import { setThemePref } from "./theme";
import type { HelloMode } from "./helloPolicy";
import { getVersion } from "@tauri-apps/api/app";
import { fetchLatest, isNewer, Release } from "./updates";
import { UpdateDialog } from "./components/UpdateDialog";
import { SyncDialog } from "./components/SyncDialog";
import { WatchDialog } from "./components/WatchDialog";
import { UnlockScreen } from "./components/UnlockScreen";
import { OpenState, VaultList } from "./components/VaultList";
import { VaultForm } from "./components/VaultForm";
import { ScanDialog } from "./components/ScanDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconAlert, IconCheck, IconFolder, IconLock, IconMinus, IconPlus, IconSearch, IconSettings, IconShield, IconX } from "./components/Icons";

const AUTO_LOCK_MS = 5 * 60 * 1000;
const MIN_OPENING_MS = 900; // que el aviso "Abriendo…" se vea aunque el lanzamiento sea instantáneo
const DONE_MS = 1100;

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

type Dialog = null | { kind: "form"; vault: Vault | null } | { kind: "scan"; rescan?: string } | { kind: "settings" } | { kind: "sync"; report: SyncReport } | { kind: "watch" } | { kind: "update"; release: Release };
type Toast = { msg: string; kind: "ok" | "error"; key: number } | null;

function Titlebar() {
  const t = useT();
  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="tb-mark"><IconShield className="s14" /></span>
      <span>KP Manager</span>
      <span className="grow" />
      <button className="tb-btn" onClick={() => win.minimize()} aria-label={t("app.minimize")}><IconMinus className="s14" /></button>
      <button className="tb-btn close" onClick={() => win.close()} aria-label={t("app.close")}><IconX className="s14" /></button>
    </div>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="win app-win">
    <Titlebar />
    {children}
  </div>
);

export default function App() {
  const t = useT();
  const lang = useLang();
  const [phase, setPhase] = useState<"loading" | "locked" | "ready">("loading");
  const [isNew, setIsNew] = useState(false);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [opening, setOpening] = useState<OpenState>(null);
  const [hello, setHello] = useState<HelloStatus>({ supported: false, enabled: false });
  // Cuándo se pide Windows Hello solo: al arrancar sí; tras bloquear, solo al volver a la app (ver helloPolicy).
  const [helloMode, setHelloMode] = useState<HelloMode>("mount");
  const [prefs, setPrefs] = useState<Prefs>({ shortcut: null, minimizeToTray: false, closeToTray: true, lockOnHide: false, sortByName: false, theme: "system", language: "auto", checkUpdates: false, ignoredUpdate: null });
  // Fila resaltada para abrir con Enter; solo se muestra al buscar o tras usar las flechas.
  const [cursor, setCursor] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const deferred = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);

  // Las preferencias no son secretas y se leen aunque la app esté bloqueada: así la pantalla de
  // desbloqueo ya sale con el tema y el idioma elegidos.
  const applyPrefs = useCallback((p: Prefs) => {
    setPrefs(p);
    setThemePref(p.theme);
    setLanguagePref(p.language);
  }, []);

  useEffect(() => {
    api.getPrefs().then(applyPrefs).catch(() => {});
  }, [applyPrefs]);

  // El menú de la bandeja lo pinta el sistema: hay que decirle el idioma ya resuelto.
  useEffect(() => {
    api.setTrayLanguage(lang).catch(() => {});
  }, [lang]);

  // Aviso de versión nueva. Se comprueba al desbloquear y cada 24 h mientras la app siga abierta.
  // `checkUpdates` empieza en false hasta leer las preferencias, así que no se consulta nada antes de saber si está permitido.
  const ignoredRef = useRef<string | null>(null);
  ignoredRef.current = prefs.ignoredUpdate;
  const snoozedRef = useRef<string | null>(null); // «Más tarde»: no se repite en esta sesión
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => {
    if (phase !== "ready" || !prefs.checkUpdates || !appVersion) return;
    let stopped = false;
    const check = async () => {
      try {
        const latest = await fetchLatest();
        if (stopped || !isNewer(latest.version, appVersion)) return;
        if (latest.version === ignoredRef.current || latest.version === snoozedRef.current) return;
        // Si el usuario está en medio de algo (un diálogo abierto), no se le interrumpe.
        setDialog((d) => d ?? { kind: "update", release: latest });
      } catch {
        /* sin conexión o GitHub caído: se reintenta en la próxima comprobación */
      }
    };
    check();
    const timer = window.setInterval(check, 24 * 60 * 60 * 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [phase, prefs.checkUpdates, appVersion]);

  const showToast = useCallback((msg: string, kind: "ok" | "error" = "ok") => {
    const key = Date.now();
    setToast({ msg, kind, key });
    window.setTimeout(() => setToast((t) => (t?.key === key ? null : t)), kind === "error" ? 7000 : 4000);
  }, []);

  // Si el atajo global no se pudo registrar al arrancar (otra aplicación lo usa…), la app no tiene
  // consola donde avisar: se lo decimos al usuario una vez, nada más ver la pantalla principal.
  const shortcutWarned = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || shortcutWarned.current) return;
    shortcutWarned.current = true;
    api
      .shortcutStatus()
      .then((err) => err && showToast(translate("toast.shortcutFailed", { err: errMsg(err) }), "error"))
      .catch(() => {});
  }, [phase, showToast]);

  const refresh = useCallback(async () => setVaults(await api.listVaults()), []);
  const lastCheck = useRef(0);

  // Revisa las carpetas en seguimiento y, si hay cambios, pregunta qué hacer.
  const checkWatched = useCallback(
    async (silent = true) => {
      lastCheck.current = Date.now();
      try {
        const r = await api.checkWatched();
        if (r.new.length || r.missing.length) setDialog((d) => d ?? { kind: "sync", report: r });
        else if (!silent) showToast(translate("toast.noChanges"));
        if (r.unreachable.length && !silent) showToast(translate("toast.unreachable", { path: r.unreachable[0] }), "error");
      } catch {
        /* bloqueada u otro error transitorio: se reintenta en la siguiente revisión */
      }
    },
    [showToast],
  );

  useEffect(() => {
    api.status().then(async (s) => {
      setIsNew(!s.exists);
      if (!s.unlocked) setHello(await api.helloStatus().catch(() => ({ supported: false, enabled: false })));
      setPhase(s.unlocked ? "ready" : "locked");
      if (s.unlocked) refresh().then(() => checkWatched());
    });
  }, [refresh, checkWatched]);

  // Al volver a la ventana (máx. una vez cada 30 s) se revisan las carpetas en seguimiento.
  useEffect(() => {
    if (phase !== "ready") return;
    const h = () => Date.now() - lastCheck.current > 30_000 && checkWatched();
    window.addEventListener("focus", h);
    return () => window.removeEventListener("focus", h);
  }, [phase, checkWatched]);

  // `idle`: bloqueo por inactividad. `manual`: botón Bloquear, menú de la bandeja o al ocultar la ventana.
  const lock = useCallback(async (kind: "idle" | "manual" = "idle") => {
    await api.lock();
    setHello(await api.helloStatus().catch(() => ({ supported: false, enabled: false })));
    setHelloMode(kind === "idle" ? "interaction" : "return");
    setVaults([]);
    setQuery("");
    setNavigated(false);
    setDialog(null);
    setOpening(null);
    setIsNew(false);
    setPhase("locked");
  }, []);

  // Bloqueo automático por inactividad.
  useEffect(() => {
    if (phase !== "ready") return;
    let t = window.setTimeout(lock, AUTO_LOCK_MS);
    const reset = () => {
      window.clearTimeout(t);
      t = window.setTimeout(lock, AUTO_LOCK_MS);
    };
    const events = ["mousemove", "keydown", "mousedown"] as const;
    events.forEach((e) => window.addEventListener(e, reset));
    return () => {
      window.clearTimeout(t);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [phase, lock]);

  // Ctrl/Cmd+F enfoca el buscador.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Preferencias (orden, atajo…): se recargan al desbloquear y al cerrar un diálogo (p. ej. Ajustes).
  useEffect(() => {
    if (phase === "ready" && !dialog) api.getPrefs().then(applyPrefs).catch(() => {});
  }, [phase, dialog, applyPrefs]);

  // El foco vive en el buscador siempre que se ve la pantalla principal sin diálogos.
  useEffect(() => {
    if (phase === "ready" && !dialog) searchRef.current?.focus();
  }, [phase, dialog]);

  useEffect(() => {
    if (phase !== "ready") return;
    const focusSearch = () => !dialog && searchRef.current?.focus();
    window.addEventListener("focus", focusSearch);
    // El atajo global, la bandeja y una segunda ejecución piden enfocar el buscador desde Rust.
    const unlisten = listen("focus-search", focusSearch);
    return () => {
      window.removeEventListener("focus", focusSearch);
      unlisten.then((f) => f());
    };
  }, [phase, dialog]);

  // «Bloquear» desde el menú de la bandeja (Rust ya ha bloqueado el almacén).
  useEffect(() => {
    const unlisten = listen("lock-request", () => lock("manual"));
    return () => {
      unlisten.then((f) => f());
    };
  }, [lock]);

  const sorted = useMemo(
    () =>
      [...vaults].sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) ||
          (prefs.sortByName ? 0 : (b.lastOpened ?? 0) - (a.lastOpened ?? 0)) ||
          a.client.localeCompare(b.client, undefined, { sensitivity: "base" }),
      ),
    [vaults, prefs.sortByName],
  );

  const filtered = useMemo(() => {
    const q = norm(deferred.trim());
    if (!q) return sorted;
    return sorted.filter((v) => norm(v.client).includes(q) || norm(v.path).includes(q));
  }, [sorted, deferred]);

  // El cursor vuelve a la primera coincidencia al cambiar la búsqueda y nunca sale de la lista.
  useEffect(() => setCursor(0), [deferred]);
  const cursorIdx = Math.min(cursor, filtered.length - 1);

  async function open(v: Vault) {
    setOpening({ id: v.id, phase: "opening" });
    try {
      await Promise.all([api.openVault(v.id), sleep(MIN_OPENING_MS)]);
      setOpening({ id: v.id, phase: "done" });
      await sleep(DONE_MS);
    } catch (e) {
      showToast(errMsg(e), "error");
    } finally {
      setOpening(null);
      refresh(); // el orden por último uso cambia tras abrir
    }
  }

  async function toggleFavorite(v: Vault) {
    const favorite = !v.favorite;
    setVaults((vs) => vs.map((x) => (x.id === v.id ? { ...x, favorite } : x)));
    try {
      await api.setFavorite(v.id, favorite);
    } catch (e) {
      setVaults((vs) => vs.map((x) => (x.id === v.id ? { ...x, favorite: v.favorite } : x)));
      showToast(errMsg(e), "error");
    }
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!filtered.length) return;
      setNavigated(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (Math.min(c, filtered.length - 1) + step + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      const v = filtered[cursorIdx];
      if (v && !opening) open(v);
    } else if (e.key === "Escape" && query) {
      setQuery("");
      setNavigated(false);
    }
  }

  // Tras borrar todos los datos la app queda como en el primer arranque: crear contraseña maestra.
  const resetDone = useCallback(() => {
    setVaults([]);
    setQuery("");
    setNavigated(false);
    setDialog(null);
    setOpening(null);
    setHello((h) => ({ ...h, enabled: false }));
    setHelloMode("return");
    setIsNew(true);
    setPhase("locked");
  }, []);

  // Tras importar, la lista y las preferencias (tema, idioma…) pueden haber cambiado por completo.
  const importedDone = useCallback(async () => {
    await refresh();
    applyPrefs(await api.getPrefs());
  }, [refresh, applyPrefs]);

  const saved = async (msg: string) => {
    setDialog(null);
    await refresh();
    showToast(msg);
  };

  if (phase === "loading") return <Shell>{null}</Shell>;
  if (phase === "locked") {
    return (
      <Shell>
        <UnlockScreen
          key={helloMode + hello.enabled}
          isNew={isNew}
          hello={hello.enabled}
          helloMode={helloMode}
          onUnlocked={async () => {
            await refresh();
            setPhase("ready");
            checkWatched();
          }}
        />
      </Shell>
    );
  }

  const q = query.trim();

  return (
    <Shell>
      <div className="head">
        <div className="search">
          <IconSearch />
          <input
            ref={searchRef}
            className="input-el"
            type="text"
            autoFocus
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query ? (
            <button className="clear" onClick={() => setQuery("")} aria-label={t("search.clear")}><IconX className="s14" /></button>
          ) : (
            <span className="hint">Ctrl F</span>
          )}
        </div>
        <div className="meta">
          <span className="count">
            {q ? <>{rich(t("count.of", { n: `<b>${filtered.length}</b>`, total: vaults.length }))}</> : <>{rich(t(vaults.length === 1 ? "count.client" : "count.clients", { n: `<b>${vaults.length}</b>` }))}</>}
          </span>
          <div className="actions">
            <button className="btn btn-icon accent" aria-label={t("tip.add")} onClick={() => setDialog({ kind: "form", vault: null })}>
              <IconPlus /><span className="tip">{t("tip.add")}</span>
            </button>
            <button className="btn btn-icon" aria-label={t("tip.folders")} onClick={() => setDialog({ kind: "watch" })}>
              <IconFolder /><span className="tip">{t("tip.folders")}</span>
            </button>
            <button className="btn btn-icon" aria-label={t("tip.settings")} onClick={() => setDialog({ kind: "settings" })}>
              <IconSettings /><span className="tip end">{t("tip.settings")}</span>
            </button>
            <button className="btn btn-icon" aria-label={t("tip.lock")} onClick={() => lock("manual")}>
              <IconLock /><span className="tip end">{t("tip.lock")}</span>
            </button>
          </div>
        </div>
      </div>

      <VaultList
        vaults={filtered}
        total={vaults.length}
        query={query}
        opening={opening}
        cursor={navigated || q ? cursorIdx : -1}
        onToggleFavorite={toggleFavorite}
        onOpen={open}
        onEdit={(v) => setDialog({ kind: "form", vault: v })}
        onAdd={() => setDialog({ kind: "form", vault: null })}
        onFolders={() => setDialog({ kind: "watch" })}
      />

      {dialog?.kind === "form" && <VaultForm vault={dialog.vault} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === "scan" && (
        <ScanDialog
          rescan={dialog.rescan}
          onClose={() => setDialog(null)}
          onImported={async () => {
            await saved(t("toast.imported"));
          }}
        />
      )}
      {dialog?.kind === "watch" && (
        <WatchDialog
          onClose={() => setDialog(null)}
          onAdd={() => setDialog({ kind: "scan" })}
          onRescan={(path) => setDialog({ kind: "scan", rescan: path })}
          onCheck={() => {
            setDialog(null);
            checkWatched(false);
          }}
        />
      )}
      {dialog?.kind === "update" && (
        <UpdateDialog
          release={dialog.release}
          current={appVersion}
          onLater={() => {
            snoozedRef.current = dialog.release.version;
            setDialog(null);
          }}
          onIgnore={async () => {
            const v = dialog.release.version;
            setDialog(null);
            try {
              applyPrefs(await api.ignoreUpdate(v));
              showToast(t("update.ignored", { v }));
            } catch (e) {
              showToast(errMsg(e), "error");
            }
          }}
        />
      )}
      {dialog?.kind === "sync" && <SyncDialog report={dialog.report} onClose={() => setDialog(null)} onDone={saved} />}
      {dialog?.kind === "settings" && <SettingsDialog onClose={() => setDialog(null)} onPrefs={applyPrefs} onReset={resetDone} onImported={importedDone} />}

      {toast && (
        <div className="toasts">
          <div key={toast.key} className={`toast ${toast.kind === "error" ? "err" : "ok"}`} role="status">
            <span className="toast-ic">{toast.kind === "error" ? <IconAlert className="s16" /> : <IconCheck className="s16" />}</span>
            <div className="toast-txt">{toast.msg}</div>
            <button className="btn btn-icon plain" onClick={() => setToast(null)} aria-label={t("toast.close")}><IconX className="s14" /></button>
            <span className="toast-timer" />
          </div>
        </div>
      )}
    </Shell>
  );
}
