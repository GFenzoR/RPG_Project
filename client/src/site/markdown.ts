// Minimal Markdown subset of news posts (T4.3, docs/06-content-data.md "Noticias"):
//   - paragraphs separated by a blank line (single line breaks join with a space);
//   - consecutive lines starting with "- " form a list;
//   - **bold** and *italics* inside a line (not nested; no space just inside the markers).
// Everything else is text. The result is data, rendered by Preact as text nodes: no HTML
// is ever parsed, so a post cannot inject markup.

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type Block = { kind: "p"; spans: Span[] } | { kind: "ul"; items: Span[][] };

/** Splits one line of text into plain, bold and italic spans. */
export function parseInline(text: string): Span[] {
  const out: Span[] = [];
  // The text between markers cannot start or end with a space ("2 * 3 * 4" stays text).
  const re = /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Parses a post body into blocks. */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: "p", spans: parseInline(para.join(" ")) });
    if (list.length > 0) blocks.push({ kind: "ul", items: list.map(parseInline) });
    para = [];
    list = [];
  };
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
    } else if (line.startsWith("- ")) {
      if (para.length > 0) {
        blocks.push({ kind: "p", spans: parseInline(para.join(" ")) });
        para = [];
      }
      list.push(line.slice(2).trim());
    } else {
      if (list.length > 0) {
        blocks.push({ kind: "ul", items: list.map(parseInline) });
        list = [];
      }
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** The first paragraph as plain text (news list excerpts). */
export function excerpt(src: string): string {
  const first = parseMarkdown(src).find((b) => b.kind === "p");
  return first?.kind === "p" ? first.spans.map((s) => s.text).join("") : "";
}
