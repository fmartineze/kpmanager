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
}

export function Modal({ title, subtitle, icon, onClose, children, footer }: Props) {
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
      <div className="modal" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
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
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
