// YAML loading with source positions, so every error can point at file:line:col.
import { readFileSync } from "node:fs";
import { LineCounter, isCollection, isMap, isScalar, parseDocument } from "yaml";
import type { Document, Node } from "yaml";

export type PathSegment = string | number;

export interface Diagnostic {
  severity: "error" | "warning";
  /** Path relative to the content root, with forward slashes. */
  file: string;
  line?: number;
  col?: number;
  /** Location inside the document, e.g. ["loot", 0, "item"]. */
  path: PathSegment[];
  message: string;
}

export interface SourceFile {
  file: string;
  data: unknown;
  /** Finds the 1-based line/column of a path, falling back to the closest parent. */
  locate(path: PathSegment[]): { line: number; col: number } | undefined;
}

export function loadYaml(
  absPath: string,
  file: string,
  diags: Diagnostic[],
): SourceFile | undefined {
  return parseYaml(readFileSync(absPath, "utf8"), file, diags);
}

export function parseYaml(text: string, file: string, diags: Diagnostic[]): SourceFile | undefined {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    for (const err of doc.errors) {
      const pos = lineCounter.linePos(err.pos[0]);
      diags.push({
        severity: "error",
        file,
        line: pos.line,
        col: pos.col,
        path: [],
        message: `invalid YAML: ${err.message.split("\n")[0] ?? err.code}`,
      });
    }
    return undefined;
  }
  return {
    file,
    data: doc.toJS() as unknown,
    locate(path) {
      for (let n = path.length; n >= 0; n--) {
        const node = nodeAt(doc, path.slice(0, n));
        if (node?.range) {
          const pos = lineCounter.linePos(node.range[0]);
          return { line: pos.line, col: pos.col };
        }
      }
      return undefined;
    },
  };
}

/** The node at path; for a map entry, its key, so positions point at "field:". */
function nodeAt(doc: Document, path: PathSegment[]): Node | undefined {
  if (path.length === 0) return doc.contents ?? undefined;
  const parent: unknown = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  const last = path[path.length - 1];
  if (isMap(parent)) {
    const pair = parent.items.find((p) => isScalar(p.key) && String(p.key.value) === String(last));
    return isScalar(pair?.key) ? pair.key : undefined;
  }
  const node: unknown = doc.getIn(path, true);
  return isScalar(node) || isCollection(node) ? node : undefined;
}

export function formatPath(path: PathSegment[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? seg : `.${seg}`;
  }
  return out;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.line === undefined ? d.file : `${d.file}:${d.line}:${d.col ?? 1}`;
  const path = d.path.length > 0 ? ` ${formatPath(d.path)}:` : "";
  return `${d.severity} ${where}${path} ${d.message}`;
}

/** Closest candidate by edit distance, for "did you mean" hints. */
export function suggest(value: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDist = Math.max(2, Math.floor(value.length / 3)) + 1;
  for (const c of candidates) {
    const d = levenshtein(value, c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}
