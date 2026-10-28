import type { KeyboardEvent } from "react";

export const DEFAULT_SHORTCUT = "Ctrl+Alt+K";

/**
 * Convierte la pulsación en el formato que acepta el plugin global-shortcut («Ctrl+Alt+K»).
 * Devuelve null si solo hay modificadores o falta alguno (un atajo global sin modificador
 * capturaría una tecla normal en todo el sistema).
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  const c = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(c)) key = c;
  else if (c === "Space") key = "Space";

  return key && mods.length ? [...mods, key].join("+") : null;
}
