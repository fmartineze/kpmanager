import { KeyboardEvent, useId, useState } from "react";
import { useT } from "../i18n";
import { IconX } from "./Icons";

// Mismos límites que el backend (`normalize_tags`): él es quien manda, esto solo evita sorpresas al guardar.
export const MAX_TAGS = 8;
export const MAX_TAG_LEN = 32;

/** Limpia una etiqueta escrita a mano: recorta, quita `#` inicial y colapsa espacios. */
export const cleanTag = (raw: string) =>
  raw.trim().replace(/^#+/, "").split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_TAG_LEN).trim();

interface Props {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Etiquetas que ya existen en otros clientes, para autocompletar. */
  suggestions: string[];
  placeholder?: string;
  /** Texto escrito y aún sin convertir en etiqueta, para que el formulario pueda recogerlo al guardar. */
  onDraft?: (draft: string) => void;
}

export function TagInput({ value, onChange, suggestions, placeholder, onDraft }: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const listId = useId();

  const add = (raw: string) => {
    const tag = cleanTag(raw);
    setDraft("");
    onDraft?.("");
    if (!tag || value.length >= MAX_TAGS) return;
    if (value.some((v) => v.toLowerCase() === tag.toLowerCase())) return;
    onChange([...value, tag]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      // Con texto escrito, Enter añade la etiqueta; vacío, deja que el formulario se envíe como siempre.
      if (draft.trim() || e.key === ",") {
        e.preventDefault();
        add(draft);
      }
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const free = suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()));

  return (
    <div className="input tag-input">
      {value.map((tag) => (
        <span key={tag} className="tag-chip">
          {tag}
          <button type="button" onClick={() => onChange(value.filter((v) => v !== tag))} aria-label={t("form.tagRemove", { tag })}>
            <IconX className="s14" />
          </button>
        </span>
      ))}
      {value.length < MAX_TAGS && (
        <>
          <input
            className="input-el"
            list={listId}
            value={draft}
            maxLength={MAX_TAG_LEN}
            placeholder={value.length ? "" : placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
              onDraft?.(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => draft.trim() && add(draft)}
          />
          <datalist id={listId}>{free.map((s) => <option key={s} value={s} />)}</datalist>
        </>
      )}
    </div>
  );
}
