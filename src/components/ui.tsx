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

export const Note = ({ children }: { children: ReactNode }) => (
  <div className="note">
    <IconInfo className="s16" />
    <div>{children}</div>
  </div>
);
