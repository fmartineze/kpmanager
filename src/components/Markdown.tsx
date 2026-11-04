import { useMemo } from "react";
import DOMPurify from "dompurify";
import { Marked } from "marked";

// Las notas vienen de un fichero ajeno: se tratan como hostiles. El HTML crudo se escapa en el propio
// Markdown y, además, todo el resultado pasa por DOMPurify con una lista blanca estricta. No se admiten
// imágenes, estilos, scripts, formularios ni atributos de eventos.
const md = new Marked({ gfm: true, breaks: true, async: false });
md.use({
  renderer: {
    html: ({ text }) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    image: ({ text }) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    // Casillas de tareas como símbolo, sin controles de formulario.
    // Tabla dentro de un contenedor con desplazamiento: así conserva el diseño de tabla real.
    table(token) {
      const head = this.parser.renderer.tablerow({
        text: token.header.map((c) => this.parser.renderer.tablecell(c)).join(""),
      });
      const body = token.rows
        .map((r) =>
          this.parser.renderer.tablerow({ text: r.map((c) => this.parser.renderer.tablecell(c)).join("") }),
        )
        .join("");
      return `<div class="md-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
`;
    },
    checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
  },
});

const TAGS = [
  "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "a",
  "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td",
  "div",
];

const purify = DOMPurify(window);
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer");
    node.setAttribute("target", "_blank");
  }
});

export function renderMarkdown(text: string): string {
  return purify.sanitize(md.parse(text) as string, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ["href", "rel", "target", "start", "align", "class"],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

interface Props {
  text: string;
  /** Se llama con la dirección real del enlace pulsado; nunca se navega dentro de la app. */
  onLink: (href: string) => void;
}

export function Markdown({ text, onLink }: Props) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="md"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href");
        if (href) onLink(href);
      }}
      // Seguro: `html` acaba de pasar por DOMPurify con lista blanca.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
