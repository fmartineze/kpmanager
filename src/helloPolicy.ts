/**
 * Cuándo se lanza Windows Hello sin que el usuario pulse el botón.
 *
 * Regla de fondo: **nunca con la ventana fuera de vista** (minimizada, en la bandeja o detrás de otras).
 * Windows muestra el aviso de Hello como una ventana propia; sin una app visible a la que asociarse aparece
 * de la nada, que es justo lo que no queremos tras un bloqueo por inactividad.
 */

/** Por qué se bloqueó la app, que decide cuándo se pide Hello solo. */
export type HelloMode =
  /** Arranque: nada más mostrarse la pantalla, si ya está en primer plano. */
  | "mount"
  /** Bloqueo por inactividad: en cuanto el usuario vuelva a tocar la app. */
  | "interaction"
  /** Bloqueo a mano, desde la bandeja o al ocultar: solo al volver a traer la ventana al frente. */
  | "return";

/** Qué acaba de pasar. */
export type HelloTrigger = "mount" | "interaction" | "return";

const ALLOWED: Record<HelloMode, readonly HelloTrigger[]> = {
  mount: ["mount", "return"],
  interaction: ["interaction", "return"],
  return: ["return"],
};

/** La ventana se ve y tiene el foco. */
export const isForeground = () => document.visibilityState === "visible" && document.hasFocus();

export function shouldPromptHello(mode: HelloMode, trigger: HelloTrigger, foreground: boolean = isForeground()): boolean {
  return foreground && ALLOWED[mode].includes(trigger);
}
