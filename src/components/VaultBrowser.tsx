import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api, EntryDetail, EntryRow, errMsg, GroupNode, Prefs, Totp, Vault, VaultTree } from "../api";
import { useT } from "../i18n";
import {
  IconAlert, IconBack, IconClock, IconCopy, IconDownload, IconExpand, IconExternal, IconEye, IconEyeOff, IconFolder, IconHome, IconPaperclip, IconReport, IconSearch, IconTerminal, IconX,
} from "./Icons";
import { Markdown } from "./Markdown";
import { Modal } from "./Modal";
import { KeyHints, Note } from "./ui";
import { ReportDialog } from "./ReportDialog";
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
  const [ssh, setSsh] = useState<{ kind: "ssh" | "rdp"; target: string; options: PassOption[]; stage: "ask" | "pick" } | null>(null); // SSH o Escritorio remoto en curso
  const [showEmpty, setShowEmpty] = useState(false);
  // Informe para compartir: entradas candidatas (una sola = desde su ficha) y carpeta de la que salen.
  const [report, setReport] = useState<{ rows: EntryRow[]; where: string } | null>(null);
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
      // La búsqueda cubre carpetas (por nombre) y entradas; las carpetas vacías solo si se muestran.
      const groups = tree.groups
        .filter((g) => g.id !== tree.root && norm(g.name).includes(q) && (showEmpty || filled.has(g.id)))
        .sort((a, b) => cmp(a.name, b.name))
        .map((g): Item => ({ kind: "group", g }));
      const found = tree.entries
        .filter((e) => norm(e.title).includes(q) || norm(e.username).includes(q) || norm(e.url).includes(q) || e.tags.some((x) => norm(x).includes(q)))
        .sort((a, b) => cmp(a.title, b.title))
        .map((e): Item => ({ kind: "entry", e }));
      return [...groups, ...found];
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
      // Ruta completa desde la raíz: al venir de una búsqueda la carpeta puede estar en cualquier sitio.
      const chain: string[] = [];
      for (let g: GroupNode | undefined = it.g; g; g = g.parent ? byId.get(g.parent) : undefined) chain.unshift(g.id);
      setPath(chain[0] === tree.root ? chain : [tree.root, ...chain]);
      setQuery("");
    } else setEntry(it.e);
  };

  // Retroceso sube un nivel y Enter abre la fila resaltada, estén o no en el cuadro de búsqueda
  // (con el foco en un botón, Enter ya lo pulsa él). Con un diálogo encima no se toca nada.
  useEffect(() => {
    if (entry || report || link) return;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Dentro de un campo de texto con contenido, Retroceso sigue borrando.
        if ((tag === "INPUT" || tag === "TEXTAREA") && (el as HTMLInputElement).value) return;
        e.preventDefault();
        up();
      } else if (e.key === "Escape" && tag !== "INPUT") {
        escape();
      } else if (e.key === "Enter" && tag !== "INPUT" && tag !== "BUTTON" && tag !== "A" && items[cur]) {
        e.preventDefault();
        if (e.shiftKey) onOpenKeepass();
        else pick(items[cur]);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // Esc: siempre vuelve a la lista de clientes (Inicio); Retroceso sube un nivel.
  const escape = () => onBack();

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setCursor((c) => (Math.min(c, items.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Enter") {
      // Sin esto, al abrir una entrada el foco salta a su botón «Atrás» y el propio Enter lo activa.
      e.preventDefault();
      if (e.shiftKey) onOpenKeepass();
      else if (items[cur]) pick(items[cur]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!report) escape();
    }
  }

  const groupPath = (id: string) => {
    const names: string[] = [];
    for (let g = byId.get(id); g && g.id !== tree.root; g = g.parent ? byId.get(g.parent) : undefined) names.unshift(g.name);
    return names.join(" › ");
  };

  // Antes de abrir cualquier enlace se muestra la dirección real: el texto de un enlace puede engañar.
  const confirmLink = link && (
    <LinkConfirm
      url={link}
      onCancel={() => setLink(null)}
      onOpen={() => {
        const url = link;
        setLink(null);
        api.openLink(url).catch((e) => notify(errMsg(e), "error"));
      }}
    />
  );

  // SSH / Escritorio remoto en dos pasos: primero «¿abrir o cancelar?» y, si se acepta, qué campo se usa como contraseña.
  const openRemote = (field: string | null) => {
    if (!entry || !ssh) return;
    const kind = ssh.kind;
    setSsh(null);
    (kind === "rdp" ? api.openRdp(vault.id, entry.id, field) : api.openSsh(vault.id, entry.id, field))
      .then(() => field && notify(t(kind === "rdp" ? "vault.rdpCopied" : "vault.sshCopied", { s: prefs.clipboardClearSecs || 0 })))
      .catch((e) => notify(errMsg(e), "error"));
  };
  const confirmSsh =
    ssh &&
    (ssh.stage === "ask" ? (
      <LinkConfirm
        url={`${ssh.kind === "rdp" ? "RDP" : "ssh"} ${ssh.target}`}
        ask={t(ssh.kind === "rdp" ? "vault.rdpAsk" : "vault.sshAsk")}
        openLabel={t(ssh.kind === "rdp" ? "vault.rdpOpen" : "vault.sshOpen")}
        onCancel={() => setSsh(null)}
        onOpen={() => setSsh({ ...ssh, stage: "pick" })}
      />
    ) : (
      <SshPasswordDialog kind={ssh.kind} target={ssh.target} options={ssh.options} onCancel={() => setSsh(null)} onDone={openRemote} />
    ));

  const emptyNote = (
    <div className="empty-note">
      <span>{t(hiddenEmpty === 1 ? "vault.hiddenEmpty1" : "vault.hiddenEmptyN", { n: hiddenEmpty })}</span>
      <button className="link-btn" onClick={() => setShowEmpty(true)}>{t("vault.showEmpty")}</button>
    </div>
  );

  const reportDialog = report && (
    <ReportDialog vault={vault} rows={report.rows} where={report.where} prefs={prefs} onClose={() => setReport(null)} notify={notify} />
  );
  // Entradas visibles ahora mismo (carpeta actual o resultados de la búsqueda): candidatas al informe.
  const visibleEntries = items.flatMap((it) => (it.kind === "entry" ? [it.e] : []));

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
          onHome={onBack}
          onLink={setLink}
          notify={notify}
          paused={!!report || !!link || !!ssh}
          onOpenKeepass={onOpenKeepass}
          onSsh={(kind, target, options) => setSsh({ kind, target, options, stage: "ask" })}
          onReport={() => setReport({ rows: [entry], where: groupPath(entry.group) })}
        />
        {confirmLink}
        {confirmSsh}
        {reportDialog}
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
          <button className="btn btn-icon" onClick={onBack} aria-label={t("vault.home")}>
            <IconHome /><span className="tip">{t("vault.home")}</span>
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
          {visibleEntries.length > 0 && (
            <button className="btn btn-icon" onClick={() => setReport({ rows: visibleEntries, where: query ? "" : groupPath(here) })} aria-label={t("report.tip")}>
              <IconReport /><span className="tip end">{t("report.tip")}</span>
            </button>
          )}
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
            const sub = isGroup ? (query && it.g.parent ? groupPath(it.g.parent) : "") : query ? [groupPath(it.e.group), it.e.username].filter(Boolean).join(" · ") : it.e.username;
            const icon = prefs.showVaultIcons ? (isGroup ? it.g.icon : it.e.icon) : null;
            return (
              <div key={isGroup ? it.g.id : it.e.id} data-idx={i} className={`row ${i === cur ? "is-focus" : ""}`}>
                <button className="row-main" onClick={(e) => (e.shiftKey ? onOpenKeepass() : pick(it))} title={[title, sub, !isGroup && it.e.tags.length ? `#${it.e.tags.join(" #")}` : ""].filter(Boolean).join("\n")}>
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
      {items.length > 0 && !link && !report && (
        <KeyHints
          items={[
            ...(path.length > 1 ? ([["Backspace", t("hint.up")]] as [string, string][]) : []),
            ["Shift+Enter", t("hint.keepass")],
          ]}
        />
      )}
      {confirmLink}
      {reportDialog}
    </>
  );
}

/** Segundo paso de SSH: qué campo se copia al portapapeles para usarlo como contraseña. */
function SshPasswordDialog({
  kind, target, options, onCancel, onDone,
}: {
  kind: "ssh" | "rdp";
  target: string;
  options: PassOption[];
  onCancel: () => void;
  onDone: (field: string | null) => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<string | null>(options[0].value);
  return (
    <Modal
      title={t(kind === "rdp" ? "vault.rdpPass" : "vault.sshPass")}
      subtitle={`${kind === "rdp" ? "RDP" : "ssh"} ${target}`}
      icon={<IconTerminal className="s16" />}
      onClose={onCancel}
      footer={
        <>
          <span className="grow" />
          <button className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button className="btn btn-primary" onClick={() => onDone(picked)}>{t(kind === "rdp" ? "vault.rdpGo" : "vault.sshGo")}</button>
        </>
      }
    >
      <fieldset
        className="choice"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onDone(picked);
          }
        }}
      >
        <legend>{t("vault.sshPassQ")}</legend>
        <div className="choice-list">
        {options.map((o, i) => (
          <label key={o.value ?? "none"} className={`choice-card compact ${picked === o.value ? "on" : ""}`} title={`${o.label} · ${o.hint}`}>
            <input type="radio" className="sr" name="sshpass" autoFocus={picked === o.value || (i === 0 && !options.some((x) => x.value === picked))} checked={picked === o.value} onChange={() => setPicked(o.value)} />
            <span className="radio" />
            <span className="txt">
              <strong>{o.label}</strong>
              <small>{o.hint}</small>
            </span>
          </label>
        ))}
        </div>
      </fieldset>
      <Note>{t(kind === "rdp" ? "vault.rdpPassNote" : "vault.sshPassNote")}</Note>
    </Modal>
  );
}

/** Notas a pantalla completa, con el mismo renderizado (Markdown saneado o texto) que en la ficha. Esc la cierra. */
function NotesFull({
  text, mode, setMode, paused, onLink, onCopy, onClose,
}: {
  text: string;
  mode: "md" | "text";
  setMode: (m: "md" | "text") => void;
  /** Con la confirmación de un enlace encima, Esc es de ella y no cierra esta vista. */
  paused: boolean;
  onLink: (href: string) => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.focus(); // con el foco aquí, ↑ ↓ RePág AvPág desplazan el texto
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.key !== "Escape" && e.key !== "Backspace") || paused) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [paused, onClose]);

  return (
    <div className="notes-full" role="dialog" aria-label={t("vault.notes")}>
      <div className="notes-full-head">
        <span className="fld-label">{t("vault.notes")}</span>
        <span className="grow" />
        <div className="seg seg-sm" role="radiogroup" aria-label={t("vault.notes")}>
          <button type="button" role="radio" aria-checked={mode === "md"} className={`seg-btn ${mode === "md" ? "on" : ""}`} onClick={() => setMode("md")}>Markdown</button>
          <button type="button" role="radio" aria-checked={mode === "text"} className={`seg-btn ${mode === "text" ? "on" : ""}`} onClick={() => setMode("text")}>{t("vault.plain")}</button>
        </div>
        <button className="btn btn-icon plain" onClick={onCopy} aria-label={t("vault.copy")} title={t("vault.copy")}><IconCopy className="s16" /></button>
        <button className="btn btn-icon plain" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}><IconX className="s16" /></button>
      </div>
      <div className="notes-full-body" ref={bodyRef} tabIndex={0}>
        {mode === "md" ? <Markdown text={text} onLink={onLink} /> : <pre className="notes-plain">{text}</pre>}
      </div>
      <div className="kbd-hint"><span><kbd>Esc</kbd> / <kbd>Backspace</kbd> {t("vault.hintClose")}</span></div>
    </div>
  );
}

/** Confirmación para abrir un enlace, manejable con el teclado: ← → ↑ ↓ alternan, Enter acepta, Esc cancela. */
interface PassOption {
  value: string | null; // `password`, `custom:<nombre>` o null (ninguna)
  label: string;
  hint: string;
}

function LinkConfirm({
  url, ask, openLabel, onOpen, onCancel,
}: {
  url: string;
  ask?: string;
  openLabel?: string;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const openRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        (document.activeElement === openRef.current ? cancelRef : openRef).current?.focus();
      }
    };
    // En captura: se atiende antes que los atajos de la pantalla que hay debajo.
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onCancel]);

  return (
    <div className="link-confirm" role="alertdialog" aria-label={ask ?? t("vault.linkAsk")}>
      <div className="alert alert-info">
        <IconExternal className="s16" />
        <div>
          <div>{ask ?? t("vault.linkAsk")}</div>
          <div className="link-url">{url}</div>
          <div className="btns">
            <button ref={openRef} className="btn btn-primary btn-sm" autoFocus onClick={onOpen}>{openLabel ?? t("vault.linkOpen")}</button>
            <button ref={cancelRef} className="btn btn-ghost btn-sm" onClick={onCancel}>{t("common.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
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
  onHome: () => void;
  onLink: (url: string) => void;
  notify: Notify;
  /** Con un diálogo encima, Esc cierra el diálogo y no debe volver atrás. */
  paused: boolean;
  onReport: () => void;
  /** Pide confirmar una conexión SSH a este destino (`usuario@host`). */
  onSsh: (kind: "ssh" | "rdp", target: string, options: PassOption[]) => void;
  /** Shift+Enter: abre el vault en KeePassXC. */
  onOpenKeepass: () => void;
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

function EntryView({ vault, row, prefs, groupName, custom, onBack, onHome, onLink, notify, paused, onReport, onSsh, onOpenKeepass }: EntryProps) {
  const t = useT();
  const [d, setD] = useState<EntryDetail | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [totp, setTotp] = useState<Totp | null>(null);
  const [left, setLeft] = useState(0);
  const [mode, setMode] = useState<"md" | "text">(readMode);
  const [fi, setFi] = useState<string | null>(null); // campo resaltado con el teclado
  const [expanded, setExpanded] = useState(false); // notas a pantalla completa
  const halt = paused || expanded; // con algo encima, los atajos de la ficha no actúan
  const [sshTarget, setSshTarget] = useState<string | null>(null); // destino SSH posible con usuario + URL
  const [rdpTarget, setRdpTarget] = useState<string | null>(null); // destino de Escritorio remoto posible
  const timers = useRef<Record<string, number>>({});
  const actions = useRef<{ copy: (f: string) => unknown; toggle: (f: string) => unknown }>({ copy: () => {}, toggle: () => {} });

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
    const h = (e: KeyboardEvent) => {
      if (halt) return;
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === "Escape") onHome();
      else if (e.key === "Backspace" && tag !== "INPUT" && tag !== "TEXTAREA") onBack();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onBack, onHome, halt]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (halt || e.defaultPrevented || e.key !== "Enter" || !e.shiftKey) return;
      e.preventDefault();
      onOpenKeepass();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [halt, onOpenKeepass]);

  // Campos navegables con ↑ ↓, en el orden en que se ven.
  const order = useMemo(() => {
    if (!d) return [] as string[];
    const ids: string[] = [];
    if (d.username) ids.push("username");
    if (d.hasPassword) ids.push("password");
    if (d.hasTotp && totp) ids.push("totp");
    if (d.url) ids.push("url");
    for (const f of d.fields) if (f.protected || f.value) ids.push(`custom:${f.name}`);
    if (d.notes) ids.push("notes");
    for (const a of d.attachments) ids.push(`att:${a.name}`);
    return ids;
  }, [d, totp]);

  // Campos que se pueden mostrar u ocultar: la contraseña y los campos personalizados protegidos.
  const isSecretField = useCallback(
    (id: string) => id === "password" || (id.startsWith("custom:") && !!d?.fields.some((f) => f.protected && `custom:${f.name}` === id)),
    [d],
  );

  // Campos que se pueden usar como contraseña: la de la entrada y cualquier campo personalizado.
  const passOptions = useCallback(
    (): PassOption[] => [
      ...(d?.hasPassword ? [{ value: "password", label: t("vault.sshPassPassword"), hint: t("vault.sshPassPasswordHint") }] : []),
      ...(d?.fields ?? []).filter((f) => f.protected || f.value).map((f) => ({ value: `custom:${f.name}`, label: f.name, hint: t("vault.sshPassCustomHint") })),
      { value: null, label: t("vault.sshPassNone"), hint: t("vault.sshPassNoneHint") },
    ],
    [d, t],
  );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // Un Enter ya atendido por un diálogo (que acaba de cerrarse) no debe actuar también sobre el campo.
      if (halt || e.defaultPrevented || (e.key === "Enter" && e.shiftKey) || !order.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // El foco estaba en el botón «Atrás»: sin soltarlo, Enter lo pulsaría y cerraría la entrada.
        (document.activeElement as HTMLElement | null)?.blur();
        const i = fi ? order.indexOf(fi) : -1;
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = i < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, i + step));
        setFi(order[next]);
        document.querySelector(`[data-fid="${CSS.escape(order[next])}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && fi === "notes" && d?.notes) {
        // preventDefault: el foco pasa a la vista ampliada y este Enter no debe pulsar nada allí.
        e.preventDefault();
        setExpanded(true);
      } else if (e.key === "Enter" && fi === "url" && d?.url) {
        // preventDefault: el foco salta al botón de la confirmación y este mismo Enter no debe aceptarla.
        e.preventDefault();
        onLink(d.url);
      } else if ((e.key === "s" || e.key === "S") && fi === "url" && sshTarget && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        onSsh("ssh", sshTarget, passOptions());
      } else if ((e.key === "t" || e.key === "T") && fi === "url" && rdpTarget && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        onSsh("rdp", rdpTarget, passOptions());
      } else if ((e.key === "c" || e.key === "C") && fi && !fi.startsWith("att:") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        actions.current.copy(fi);
      } else if ((e.key === "v" || e.key === "V") && fi && isSecretField(fi) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        actions.current.toggle(fi);
      } else if (e.key === "Tab") {
        setFi(null); // pasa al teclado «normal»: Enter vuelve a pulsar el botón con el foco
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [order, fi, halt, d, onLink, onSsh, sshTarget, rdpTarget, passOptions, isSecretField]);

  // Con la URL resaltada se consulta (en Rust) si usuario + URL dan un destino SSH válido.
  useEffect(() => {
    let alive = true;
    setSshTarget(null);
    setRdpTarget(null);
    if (fi === "url") {
      api.sshTarget(vault.id, row.id).then((x) => alive && setSshTarget(x)).catch(() => {});
      api.rdpTarget(vault.id, row.id).then((x) => alive && setRdpTarget(x)).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [fi, vault.id, row.id]);

  const fcls = (id: string) => `fld ${fi === id ? "is-focus" : ""}`;

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
  actions.current = { copy, toggle };

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
      <div className={fcls(field)} data-fid={field}>
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
    <div className={fcls(field)} data-fid={field}>
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
          <button className="btn btn-icon" onClick={onHome} aria-label={t("vault.home")}>
            <IconHome /><span className="tip">{t("vault.home")}</span>
          </button>
          <div className="vb-title">
            <span className="vb-name">{row.title || t("vault.untitled")}</span>
            <span className="crumbs"><span className="crumb on">{[vault.client, groupName].filter(Boolean).join(" › ")}</span></span>
          </div>
          <button className="btn btn-icon" onClick={onReport} aria-label={t("report.tip")}>
            <IconReport /><span className="tip end">{t("report.tip")}</span>
          </button>
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
              <div className={fcls("totp")} data-fid="totp">
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
              <div className={fcls("notes")} data-fid="notes">
                <div className="fld-head">
                  <span className="fld-label">{t("vault.notes")}</span>
                  <span className="grow" />
                  <div className="seg seg-sm" role="radiogroup" aria-label={t("vault.notes")}>
                    <button type="button" role="radio" aria-checked={mode === "md"} className={`seg-btn ${mode === "md" ? "on" : ""}`} onClick={() => setNotesMode("md")}>Markdown</button>
                    <button type="button" role="radio" aria-checked={mode === "text"} className={`seg-btn ${mode === "text" ? "on" : ""}`} onClick={() => setNotesMode("text")}>{t("vault.plain")}</button>
                  </div>
                  <button className="btn btn-icon plain" onClick={() => setExpanded(true)} aria-label={t("vault.notesExpand")} title={t("vault.notesExpand")}><IconExpand className="s16" /></button>
                  {copyBtn("notes")}
                </div>
                {mode === "md" ? <Markdown text={d.notes} onLink={onLink} /> : <pre className="notes-plain">{d.notes}</pre>}
              </div>
            )}
            {d.attachments.length > 0 && (
              <div className="fld">
                <span className="fld-label">{t("vault.attachments")}</span>
                {d.attachments.map((a) => (
                  <div key={a.name} className={`fld-row att ${fi === `att:${a.name}` ? "is-focus" : ""}`} data-fid={`att:${a.name}`}>
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
      {fi === "notes" && !halt && (
        <div className="kbd-hint" aria-live="polite">
          <span><kbd>Enter</kbd> {t("vault.hintExpand")}</span>
          <span><kbd>C</kbd> {t("hint.copy")}</span>
        </div>
      )}
      {expanded && d?.notes && (
        <NotesFull
          text={d.notes}
          mode={mode}
          setMode={setNotesMode}
          paused={paused}
          onLink={onLink}
          onCopy={() => copy("notes")}
          onClose={() => setExpanded(false)}
        />
      )}
      {!halt && fi !== "url" && fi !== "notes" && (
        <KeyHints
          items={
            fi && !fi.startsWith("att:")
              ? [["C", t("hint.copy")], ...(isSecretField(fi) ? ([["V", t(fi in shown ? "hint.hide" : "hint.reveal")]] as [string, string][]) : [])]
              : [["Backspace", t("hint.back")], ["Esc", t("hint.home")], ["Shift+Enter", t("hint.keepass")]]
          }
        />
      )}
      {fi === "url" && !halt && (
        <div className="kbd-hint" aria-live="polite">
          <span><kbd>Enter</kbd> {t("vault.hintOpenUrl")}</span>
          {sshTarget && <span><kbd>S</kbd> {t("vault.hintOpenSsh")}</span>}
          {rdpTarget && <span><kbd>T</kbd> {t("vault.hintOpenRdp")}</span>}
        </div>
      )}
    </>
  );
}
