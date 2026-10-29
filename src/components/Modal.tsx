import { ReactNode, useCallback, useEffect, useState } from "react";
import { IconX } from "./Icons";
import { useT } from "../i18n";

interface Props {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Barra de pestañas fija bajo la cabecera (no se desplaza con el contenido). */
  tabs?: ReactNode;
  /** Avisos de resultado fijos sobre el contenido, para que no queden fuera de la vista al desplazarse. */
  notices?: ReactNode;
  /** Ocupa siempre toda la altura disponible: el diálogo no cambia de tamaño al cambiar de pestaña. */
  fixedHeight?: boolean;
}

export function Modal({ title, subtitle, icon, onClose, children, footer, tabs, notices, fixedHeight }: Props) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);

  // Animación de salida antes de desmontar.
  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(onClose, 140);
  }, [onClose]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);

  return (
    <div className={`scrim ${leaving ? "leaving" : ""}`} onMouseDown={close}>
      <div className={`modal ${fixedHeight ? "fixed" : ""}`} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {icon && <span className="modal-ic">{icon}</span>}
          <div className="grow">
            <h2 className="modal-title">{title}</h2>
            {subtitle && <p className="modal-sub">{subtitle}</p>}
          </div>
          <button className="btn btn-icon plain" onClick={close} aria-label={t("common.close")}>
            <IconX className="s16" />
          </button>
        </div>
        {tabs}
        {notices}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
