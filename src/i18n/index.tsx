import { Fragment, ReactNode, useSyncExternalStore } from "react";
import { es, Key } from "./es";
import { en } from "./en";

export type Lang = "es" | "en";
export type LangPref = "auto" | Lang;
export type { Key };

const dicts: Record<Lang, Record<Key, string>> = { es, en };
const LS_KEY = "kp.language";

/** El idioma del sistema: español si lo es, inglés en cualquier otro caso. */
const systemLang = (): Lang => ((navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase().startsWith("es") ? "es" : "en");
const resolve = (p: LangPref): Lang => (p === "auto" ? systemLang() : p);

// localStorage solo es una caché para pintar bien la primera pantalla antes de leer las preferencias reales.
const readCache = (): LangPref => {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v === "es" || v === "en" || v === "auto" ? v : "auto";
  } catch {
    return "auto";
  }
};

let pref: LangPref = readCache();
let lang: Lang = resolve(pref);
const listeners = new Set<() => void>();
document.documentElement.lang = lang;

export function setLanguagePref(next: LangPref) {
  pref = next;
  lang = resolve(next);
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(LS_KEY, next);
  } catch {
    /* sin caché: no pasa nada */
  }
  listeners.forEach((l) => l());
}

export const getLang = () => lang;

/** Traduce `key` en el idioma actual; si faltara en inglés, cae al español. */
export function translate(key: Key, vars?: Record<string, string | number>): string {
  const text = dicts[lang][key] ?? es[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Idioma activo; el componente se vuelve a pintar cuando cambia. */
export const useLang = () => useSyncExternalStore(subscribe, getLang);

/** `t` para usar en componentes: se actualiza al cambiar de idioma. */
export function useT() {
  useLang();
  return translate;
}

/** Convierte `<b>…</b>` de un texto traducido en negrita. */
export function rich(text: string): ReactNode {
  return text.split(/(<b>.*?<\/b>)/g).map((part, i) =>
    part.startsWith("<b>") ? <strong key={i}>{part.slice(3, -4)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

/** Texto de un error del backend (`{code, arg, message}`) o de cualquier otra excepción. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) {
    const { code, arg, message } = e as { code: string; arg?: string; message?: string };
    const key = `err.${code}` as Key;
    if (key in es) return translate(key, { arg: arg ?? "" });
    return message ?? String(code);
  }
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
