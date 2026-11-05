import { ReactNode } from "react";
import { IconAlert, IconCheck, IconInfo } from "./Icons";

/** Casilla del sistema de diseño. */
export function Check({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <Box on={checked} disabled={disabled} />
      {children}
    </label>
  );
}

export const Box = ({ on, disabled, danger }: { on: boolean; disabled?: boolean; danger?: boolean }) => (
  <span className={`box ${on ? "on" : ""} ${disabled ? "is-disabled" : ""} ${danger ? "danger" : ""}`}>
    <IconCheck />
  </span>
);

export function Alert({ kind, children }: { kind: "ok" | "err" | "info"; children: ReactNode }) {
  const Icon = kind === "ok" ? IconCheck : kind === "err" ? IconAlert : IconInfo;
  return (
    <div className={`alert alert-${kind}`} role={kind === "err" ? "alert" : "status"}>
      <Icon className="s16" />
      <div>{children}</div>
    </div>
  );
}

/** Línea de acciones de teclado disponibles, al pie de la ventana. Cada par es [tecla(s), acción]. */
export function KeyHints({ items }: { items: [string, string][] }) {
  if (!items.length) return null;
  return (
    <div className="kbd-hint" aria-live="polite">
      {items.map(([keys, what]) => (
        <span key={keys + what}>
          {keys.split("+").map((k) => <kbd key={k}>{k}</kbd>)} {what}
        </span>
      ))}
    </div>
  );
}

export const Note = ({ children }: { children: ReactNode }) => (
  <div className="note">
    <IconInfo className="s16" />
    <div>{children}</div>
  </div>
);

/** Selector de una opción entre pocas (tema, idioma). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`seg-btn ${o.value === value ? "on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
