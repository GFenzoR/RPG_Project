// Renders a news body (markdown.ts) as Preact elements: text nodes only.
import type { JSX } from "preact";
import { parseMarkdown } from "./markdown.ts";
import type { Span } from "./markdown.ts";

function Spans(props: { spans: Span[] }): JSX.Element {
  return (
    <>
      {props.spans.map((s, i) =>
        s.bold ? <strong key={i}>{s.text}</strong> : s.italic ? <em key={i}>{s.text}</em> : s.text,
      )}
    </>
  );
}

export function Markdown(props: { source: string }): JSX.Element {
  return (
    <>
      {parseMarkdown(props.source).map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>
            <Spans spans={b.spans} />
          </p>
        ) : (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Spans spans={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}
