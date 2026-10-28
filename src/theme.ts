export type ThemePref = "system" | "light" | "dark";

const LS_KEY = "kp.theme";
const mq = window.matchMedia("(prefers-color-scheme: dark)");
let pref: ThemePref = "system";

const isPref = (v: unknown): v is ThemePref => v === "system" || v === "light" || v === "dark";

function paint() {
  const dark = pref === "dark" || (pref === "system" && mq.matches);
  document.documentElement.classList.toggle("kp-dark", dark);
  document.documentElement.classList.toggle("kp-light", !dark);
}

// «Sistema» sigue los cambios del sistema en vivo.
mq.addEventListener("change", paint);

export function setThemePref(next: ThemePref) {
  pref = isPref(next) ? next : "system";
  try {
    localStorage.setItem(LS_KEY, pref);
  } catch {
    /* sin caché: no pasa nada */
  }
  paint();
}

/** Aplica el último tema conocido antes de pintar nada, para evitar el parpadeo del arranque. */
export function initTheme() {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (isPref(v)) pref = v;
  } catch {
    /* ignorar */
  }
  paint();
}
