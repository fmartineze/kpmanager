import { ComponentType } from "react";
import type { IconView } from "../api";
import {
  IconAlert, IconCard, IconClock, IconDatabase, IconEdit, IconFolder, IconGlobe, IconHome, IconInfo, IconKey, IconLock,
  IconMail, IconNote, IconServer, IconSettings, IconStar, IconTerminal, IconTrash, IconUser, IconCheck, IconWrench,
} from "./Icons";

type Ic = ComponentType<{ className?: string }>;

// Los iconos estándar de KeePass son un índice (0–68) y cada programa pone su dibujo. Aquí se agrupan
// por significado en nuestro propio juego; el resto cae en el genérico de grupo o de entrada.
const STD: Record<number, Ic> = {};
const set = (ic: Ic, ids: number[]) => ids.forEach((i) => (STD[i] = ic));
set(IconKey, [0, 13, 58, 67]);
set(IconGlobe, [1, 8, 16, 35, 65]);
set(IconAlert, [2, 24, 45]);
set(IconServer, [3, 18, 23, 42]);
set(IconFolder, [4, 36, 47, 48, 49, 50]);
set(IconUser, [5, 9]);
set(IconMail, [19, 25, 40]);
set(IconNote, [7, 10, 21, 22, 28, 41, 44, 56, 57]);
set(IconTerminal, [29, 30, 33]);
set(IconSettings, [20, 32, 34]);
set(IconWrench, [59]);
set(IconLock, [51, 52]);
set(IconCard, [37, 66]);
set(IconStar, [61]);
set(IconHome, [60]);
set(IconClock, [39]);
set(IconCheck, [53]);
set(IconTrash, [43]);
set(IconInfo, [46]);
set(IconEdit, [54]);
set(IconDatabase, [26, 27, 38]);

interface Props {
  icon: IconView | null;
  /** Qué dibujar si el vault no define icono (o no se puede mostrar). */
  kind: "group" | "entry";
  custom: Record<string, string>;
}

/** Icono de un grupo o entrada: el personalizado del fichero (PNG validado) o el equivalente nuestro. */
export function VaultIcon({ icon, kind, custom }: Props) {
  if (icon?.kind === "custom") {
    const src = custom[icon.id];
    if (src) return <img className="vicon-img" src={src} alt="" draggable={false} />;
  }
  const Std = (icon?.kind === "std" && STD[icon.id]) || (kind === "group" ? IconFolder : IconKey);
  return <Std className="s16" />;
}
