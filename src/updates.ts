/**
 * Detección de versiones nuevas: consulta la última release pública del repositorio en GitHub.
 * No envía nada propio (es una petición GET anónima) y lo hace la propia ventana, así que usa el proxy y los
 * certificados de Windows.
 */

export const REPO = "fmartineze/kpmanager";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Solo se abren enlaces de este repositorio, nunca una URL cualquiera que venga en la respuesta. */
export const REPO_URL_PREFIX = `https://github.com/${REPO}/`;
export const FALLBACK_URL = `${REPO_URL_PREFIX}releases/latest`;

export interface Release {
  /** Sin la «v» inicial: `0.2.0`. */
  version: string;
  url: string;
}

interface Parsed {
  nums: [number, number, number];
  /** Sufijo de preversión (`beta.1`), vacío en una versión estable. */
  pre: string;
}

export function parseVersion(raw: string): Parsed | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(raw.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? "" };
}

/** <0 si a < b, 0 si iguales, >0 si a > b. Una preversión es anterior a su versión estable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0; // lo que no entendemos no se trata como «más nuevo»
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export const isNewer = (latest: string, current: string) => compareVersions(latest, current) > 0;

export const safeReleaseUrl = (url: unknown): string | null =>
  typeof url === "string" && url.startsWith(REPO_URL_PREFIX) ? url : null;

/** Última release publicada. Lanza si no hay red, GitHub falla o la respuesta no es una versión. */
export async function fetchLatest(timeoutMs = 10_000): Promise<Release> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    if (!parseVersion(tag)) throw new Error("etiqueta de versión no válida");
    return { version: tag.replace(/^v/, ""), url: safeReleaseUrl(body.html_url) ?? FALLBACK_URL };
  } finally {
    clearTimeout(timer);
  }
}
