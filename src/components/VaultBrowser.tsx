import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api, EntryDetail, EntryRow, errMsg, GroupNode, Prefs, Totp, Vault, VaultTree } from "../api";
import { useT } from "../i18n";
import {
  IconAlert, IconBack, IconClock, IconCopy, IconDownload, IconExternal, IconEye, IconEyeOff, IconFolder, IconPaperclip, IconSearch, IconX,
} from "./Icons";
import { Markdown } from "./Markdown";
import { VaultIcon } from "./VaultIcon";

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const REVEAL_MS = 10_000; // una contraseña mostrada se vuelve a ocultar sola
const TOUCH_MS = 30_000; // cada cuánto se avisa a Rust de que el usuario sigue ahí (cierre por inactividad)

type Notify = (msg: string, kind?: "ok" | "error") => void;

interface Props {
  vault: Vault;
  tree: VaultTree;
  prefs: Prefs;
  onBack: () => void;
  onOpenKeepass: () => void;
  notify: Notify;
}

type Item = { kind: "group"; g: GroupNode } | { kind: "entry"; e: EntryRow };

export function VaultBrowser({ vault, tree, prefs, onBack, onOpenKeepass, notify }: Props) {
  const t = useT();
  const [path, setPath] = useState<string[]>([tree.root]);
  const [entry, setEntry] = useState<EntryRow | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [link, setLink] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const deferred = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(tree.groups.map((g) => [g.id, g])), [tree]);
  const here = path[path.length - 1];

  // Grupos con alguna entrada en ellos o en sus subgrupos; el resto se consideran vacíos.
  const filled = useMemo(() => {
    const set = new Set<string>();
    for (const e of tree.entries) {
      for (let g = byId.get(e.group); g && !set.has(g.id); g = g.parent ? byId.get(g.parent) : undefined) set.add(g.id);
    }
    return set;
  }, [tree, byId]);

  // Mientras se usa el navegador, Rust sabe que hay actividad y no cierra el vault por inactividad.
  useEffect(() => {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < TOUCH_MS) return;
      last = now;
      api.touchVault(vault.id).catch(() => {});
    };
    const events = ["mousemove", "keydown", "mousedown", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, touch));
    return () => events.forEach((e) => window.removeEventListener(e, touch));
  }, [vault.id]);

  const items = useMemo<Item[]>(() => {
    const q = norm(deferred.trim());
    const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
    if (q) {
      return tree.entries
        .filter((e) => norm(e.title).includes(q) || norm(e.username).includes(q) || norm(e.url).includes(q) || e.tags.some((x) => norm(x).includes(q)))
        .sort((a, b) => cmp(a.title, b.title))
        .map((e): Item => ({ kind: "entry", e }));
    }
    const groups = tree.groups.filter((g) => g.parent === here && (showEmpty || filled.has(g.id))).sort((a, b) => cmp(a.name, b.name));
    const entries = tree.entries.filter((e) => e.group === here).sort((a, b) => cmp(a.title, b.title));
    return [...groups.map((g): Item => ({ kind: "group", g })), ...entries.map((e): Item => ({ kind: "entry", e }))];
  }, [tree, here, deferred, showEmpty, filled]);

  // Subgrupos vacíos de este grupo que no se muestran (solo al explorar, no al buscar).
  const hiddenEmpty = deferred.trim() || showEmpty ? 0 : tree.groups.filter((g) => g.parent === here && !filled.has(g.id)).length;

  useEffect(() => setCursor(0), [here, deferred]);
  const cur = Math.min(cursor, items.length - 1);

  useEffect(() => {
    if (cur >= 0) document.querySelector(`[data-idx="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  useEffect(() => {
    if (!entry) searchRef.current?.focus();
  }, [entry]);

  const up = useCallback(() => {
    if (query) setQuery("");
    else if (path.length > 1) setPath((p) => p.slice(0, -1));
    else onBack();
  }, [query, path.length, onBack]);

  const pick = (it: Item) => {
    if (it.kind === "group") {
      setPath((p) => [...p, it.g.id]);
      setQuery("");
    } else setEntry(it.e);
  };

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setCursor((c) => (Math.min(c, items.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Enter") {
      if (items[cur]) pick(items[cur]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      up();
    }
  }

  const groupPath = (id: string) => {
    const names: string[] = [];
    for (let g = byId.get(id); g && g.id !== tree.root; g = g.parent ? byId.get(g.parent) : undefined) names.unshift(g.name);
    return names.join(" › ");
  };

  // Antes de abrir cualquier enlace se muestra la dirección real: el texto de un enlace puede engañar.
  const confirmLink = link && (
    <div className="link-confirm" role="alertdialog" aria-label={t("vault.linkAsk")}>
      <div className="alert alert-info">
        <IconExternal className="s16" />
        <div>
          <div>{t("vault.linkAsk")}</div>
          <div className="link-url">{link}</div>
          <div className="btns">
            <button
              className="btn btn-primary btn-sm"
              autoFocus
              onClick={() => {
                const url = link;
                setLink(null);
                api.openLink(url).catch((e) => notify(errMsg(e), "error"));
              }}
            >
              {t("vault.linkOpen")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setLink(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );

  const emptyNote = (
    <div className="empty-note">
      <span>{t(hiddenEmpty === 1 ? "vault.hiddenEmpty1" : "vault.hiddenEmptyN", { n: hiddenEmpty })}</span>
      <button className="link-btn" onClick={() => setShowEmpty(true)}>{t("vault.showEmpty")}</button>
    </div>
  );

  if (entry) {
    return (
      <>
        <EntryView
          key={entry.id}
          vault={vault}
          row={entry}
          prefs={prefs}
          groupName={groupPath(entry.group)}
          custom={tree.icons}
          onBack={() => setEntry(null)}
          onLink={setLink}
          notify={notify}
        />
        {confirmLink}
      </>
    );
  }

  return (
    <>
      <div className="head">
        <div className="vb-top">
          <button className="btn btn-icon" onClick={up} aria-label={t("vault.back")}>
            <IconBack /><span className="tip">{t("vault.back")}</span>
          </button>
          <div className="vb-title">
            <span className="vb-name">{vault.client}</span>
            <nav className="crumbs" aria-label={t("vault.path")}>
              {path.map((id, i) => (
                <span key={id} className="crumb-wrap">
                  {i > 0 && <span className="sep">›</span>}
                  <button className={`crumb ${i === path.length - 1 ? "on" : ""}`} onClick={() => setPath(path.slice(0, i + 1))} disabled={i === path.length - 1}>
                    {i === 0 ? t("vault.rootName") : byId.get(id)?.name}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <button className="btn btn-icon" onClick={onOpenKeepass} aria-label={t("vault.openKeepass")}>
            <IconExternal /><span className="tip end">{t("vault.openKeepass")}</span>
          </button>
        </div>
        <div className="search">
          <IconSearch />
          <input ref={searchRef} className="input-el" type="text" autoFocus placeholder={t("vault.search")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          {query && <button className="clear" onClick={() => setQuery("")} aria-label={t("search.clear")}><IconX className="s14" /></button>}
        </div>
      </div>

      {items.length === 0 && !hiddenEmpty ? (
        <div className="empty">
          <div className="empty-art neutral">{query ? <IconSearch /> : <IconFolder />}</div>
          <h2>{query ? t("list.noResults") : t("vault.emptyGroup")}</h2>
          {query && <p>{t("list.noResultsText", { q: query.trim() })}</p>}
        </div>
      ) : (
        <div className="list">
          {items.map((it, i) => {
            const isGroup = it.kind === "group";
            const title = (isGroup ? it.g.name : it.e.title) || t("vault.untitled");
            const sub = isGroup ? "" : query ? [groupPath(it.e.group), it.e.username].filter(Boolean).join(" · ") : it.e.username;
            const icon = prefs.showVaultIcons ? (isGroup ? it.g.icon : it.e.icon) : null;
            return (
              <div key={isGroup ? it.g.id : it.e.id} data-idx={i} className={`row ${i === cur ? "is-focus" : ""}`}>
                <button className="row-main" onClick={() => pick(it)} title={[title, sub, !isGroup && it.e.tags.length ? `#${it.e.tags.join(" #")}` : ""].filter(Boolean).join("\n")}>
                  <span className={`vicon ${isGroup ? "group" : ""}`}><VaultIcon icon={icon} kind={isGroup ? "group" : "entry"} custom={tree.icons} /></span>
                  <span className="row-text">
                    <span className="row-name">{title}</span>
                    {sub && <span className="row-sub">{sub}</span>}
                  </span>
                  {!isGroup && it.e.tags.length > 0 && (
                    <span className="row-tags">
                      {/* Como en la lista de clientes: la primera etiqueta y un «+N» si hay más */}
                      <span className="tag-badge">{it.e.tags[0]}</span>
                      {it.e.tags.length > 1 && <span className="tag-badge more">+{it.e.tags.length - 1}</span>}
                    </span>
                  )}
                  {!isGroup && it.e.hasTotp && <IconClock className="s14 totp-ic" aria-label={t("vault.totp")} role="img" />}
                  {!isGroup && it.e.hasAttachments && <IconPaperclip className="s14 muted" />}
                </button>
              </div>
            );
          })}
          {hiddenEmpty > 0 && emptyNote}
        </div>
      )}
      {confirmLink}
    </>
  );
}

// ───────────────────────── Detalle de una entrada ─────────────────────────

interface EntryProps {
  vault: Vault;
  row: EntryRow;
  prefs: Prefs;
  groupName: string;
  custom: Record<string, string>;
  onBack: () => void;
  onLink: (url: string) => void;
  notify: Notify;
}

const NOTES_KEY = "kp.notesMode";
const readMode = (): "md" | "text" => {
  try {
    return localStorage.getItem(NOTES_KEY) === "text" ? "text" : "md";
  } catch {
    return "md";
  }
};

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function EntryView({ vault, row, prefs, groupName, custom, onBack, onLink, notify }: EntryProps) {
  const t = useT();
  const [d, setD] = useState<EntryDetail | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [totp, setTotp] = useState<Totp | null>(null);
  const [left, setLeft] = useState(0);
  const [mode, setMode] = useState<"md" | "text">(readMode);
  const timers = useRef<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    api.entryDetail(vault.id, row.id).then((x) => alive && setD(x)).catch((e) => alive && setError(errMsg(e)));
    const pending = timers.current;
    return () => {
      alive = false;
      // Al salir de la entrada no queda ningún secreto en el estado de la interfaz.
      Object.values(pending).forEach((id) => window.clearTimeout(id));
    };
  }, [vault.id, row.id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onBack]);

  // Código TOTP: se pide a Rust (la semilla no sale de allí) y se renueva al caducar.
  const loadTotp = useCallback(() => {
    api.entryTotp(vault.id, row.id).then((x) => { setTotp(x); setLeft(x.validFor); }).catch(() => setTotp(null));
  }, [vault.id, row.id]);
  useEffect(() => {
    if (d?.hasTotp) loadTotp();
  }, [d?.hasTotp, loadTotp]);
  useEffect(() => {
    if (!totp) return;
    const id = window.setInterval(() => setLeft((l) => (l <= 1 ? (loadTotp(), l) : l - 1)), 1000);
    return () => window.clearInterval(id);
  }, [totp, loadTotp]);

  const copy = (field: string) =>
    api
      .copySecret(vault.id, row.id, field)
      .then(() => notify(prefs.clipboardClearSecs > 0 ? t("vault.copiedClear", { s: prefs.clipboardClearSecs }) : t("vault.copied")))
      .catch((e) => notify(errMsg(e), "error"));

  const hide = (field: string) => {
    window.clearTimeout(timers.current[field]);
    setShown((s) => {
      const { [field]: _gone, ...rest } = s;
      return rest;
    });
  };

  const toggle = async (field: string) => {
    if (field in shown) return hide(field);
    try {
      const v = await api.revealSecret(vault.id, row.id, field);
      setShown((s) => ({ ...s, [field]: v }));
      timers.current[field] = window.setTimeout(() => hide(field), REVEAL_MS);
    } catch (e) {
      notify(errMsg(e), "error");
    }
  };

  const save = async (name: string) => {
    try {
      if (await api.saveAttachment(vault.id, row.id, name)) notify(t("vault.saved", { name }));
    } catch (e) {
      notify(errMsg(e), "error");
    }
  };

  const setNotesMode = (m: "md" | "text") => {
    setMode(m);
    try {
      localStorage.setItem(NOTES_KEY, m);
    } catch {
      /* sin caché: no pasa nada */
    }
  };

  const copyBtn = (field: string) => (
    <button className="btn btn-icon plain" onClick={() => copy(field)} aria-label={t("vault.copy")} title={t("vault.copy")}><IconCopy className="s16" /></button>
  );

  const secret = (label: string, field: string) => {
    const v = shown[field];
    return (
      <div className="fld">
        <span className="fld-label">{label}</span>
        <div className="fld-row">
          <span className={`fld-val mono ${v === undefined ? "dots" : ""}`}>{v ?? "••••••••••"}</span>
          <button className="btn btn-icon plain" onClick={() => toggle(field)} aria-label={v === undefined ? t("vault.show") : t("vault.hide")} title={v === undefined ? t("vault.show") : t("vault.hide")}>
            {v === undefined ? <IconEye className="s16" /> : <IconEyeOff className="s16" />}
          </button>
          {copyBtn(field)}
        </div>
      </div>
    );
  };

  const text = (label: string, value: string, field: string, extra?: React.ReactNode, onClick?: () => void) => (
    <div className="fld">
      <span className="fld-label">{label}</span>
      <div className="fld-row">
        {onClick ? (
          <button className="fld-val link-btn" onClick={onClick} title={t("vault.linkOpen")}>{value}</button>
        ) : (
          <span className="fld-val">{value}</span>
        )}
        {extra}
        {copyBtn(field)}
      </div>
    </div>
  );

  const half = totp ? Math.ceil(totp.code.length / 2) : 0;

  return (
    <>
      <div className="head">
        <div className="vb-top">
          <button className="btn btn-icon" onClick={onBack} aria-label={t("vault.back")} autoFocus>
            <IconBack /><span className="tip">{t("vault.back")}</span>
          </button>
          <div className="vb-title">
            <span className="vb-name">{row.title || t("vault.untitled")}</span>
            <span className="crumbs"><span className="crumb on">{[vault.client, groupName].filter(Boolean).join(" › ")}</span></span>
          </div>
          {prefs.showVaultIcons && row.icon && <span className="vicon big"><VaultIcon icon={row.icon} kind="entry" custom={custom} /></span>}
        </div>
      </div>

      <div className="detail">
        {error && <div className="alert alert-err"><IconAlert className="s16" /><div>{error}</div></div>}
        {!d && !error && <div className="detail-loading"><span className="spin lg" /></div>}
        {d && (
          <>
            {d.username && text(t("vault.username"), d.username, "username")}
            {d.hasPassword && secret(t("vault.password"), "password")}
            {d.hasTotp && totp && (
              <div className="fld">
                <span className="fld-label">{t("vault.totp")}</span>
                <div className="fld-row">
                  <span className="fld-val mono totp">{`${totp.code.slice(0, half)} ${totp.code.slice(half)}`}</span>
                  <span className={`totp-left ${left <= 5 ? "low" : ""}`} title={t("vault.totpLeft", { s: left })}>{left}s</span>
                  {copyBtn("totp")}
                </div>
              </div>
            )}
            {d.url &&
              text(
                t("vault.url"),
                d.url,
                "url",
                <button className="btn btn-icon plain" onClick={() => onLink(d.url)} aria-label={t("vault.linkOpen")} title={t("vault.linkOpen")}><IconExternal className="s16" /></button>,
                () => onLink(d.url),
              )}
            {d.fields.map((f) =>
              f.protected ? <div key={f.name}>{secret(f.name, `custom:${f.name}`)}</div> : f.value ? <div key={f.name}>{text(f.name, f.value, `custom:${f.name}`)}</div> : null,
            )}
            {d.tags.length > 0 && (
              <div className="fld">
                <span className="fld-label">{t("vault.tags")}</span>
                <div className="row-tags">{d.tags.map((x) => <span key={x} className="tag-badge">{x}</span>)}</div>
              </div>
            )}
            {d.notes && (
              <div className="fld">
                <div className="fld-head">
                  <span className="fld-label">{t("vault.notes")}</span>
                  <span className="grow" />
                  <div className="seg seg-sm" role="radiogroup" aria-label={t("vault.notes")}>
                    <button type="button" role="radio" aria-checked={mode === "md"} className={`seg-btn ${mode === "md" ? "on" : ""}`} onClick={() => setNotesMode("md")}>Markdown</button>
                    <button type="button" role="radio" aria-checked={mode === "text"} className={`seg-btn ${mode === "text" ? "on" : ""}`} onClick={() => setNotesMode("text")}>{t("vault.plain")}</button>
                  </div>
                  {copyBtn("notes")}
                </div>
                {mode === "md" ? <Markdown text={d.notes} onLink={onLink} /> : <pre className="notes-plain">{d.notes}</pre>}
              </div>
            )}
            {d.attachments.length > 0 && (
              <div className="fld">
                <span className="fld-label">{t("vault.attachments")}</span>
                {d.attachments.map((a) => (
                  <div key={a.name} className="fld-row att">
                    <IconPaperclip className="s16 muted" />
                    <span className="fld-val">{a.name}</span>
                    <span className="att-size">{fmtSize(a.size)}</span>
                    <button className="btn btn-icon plain" onClick={() => save(a.name)} aria-label={t("vault.saveAs", { name: a.name })} title={t("vault.saveAs", { name: a.name })}><IconDownload className="s16" /></button>
                  </div>
                ))}
              </div>
            )}
            {!d.username && !d.hasPassword && !d.url && !d.notes && d.fields.length === 0 && d.attachments.length === 0 && <div className="help">{t("vault.emptyEntry")}</div>}
          </>
        )}
      </div>
    </>
  );
}
