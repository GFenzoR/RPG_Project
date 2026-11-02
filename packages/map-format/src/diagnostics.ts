// Validation findings shared by map-format, mapcli, the editor and the MCP server.
import type { Position } from "./types.ts";

export type PathSegment = string | number;

export interface Diagnostic {
  severity: "error" | "warning";
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  /** 1-based line in the file, when known. */
  line?: number;
  /** Location inside the document, e.g. ["monsters", 0, "monster"]. */
  path: PathSegment[];
  /** World position the finding is about, so tools can jump to the tile. */
  pos?: Position;
  message: string;
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
  const where = d.line === undefined ? d.file : `${d.file}:${d.line}`;
  const path = d.path.length > 0 ? ` ${formatPath(d.path)}:` : "";
  const pos = d.pos ? ` (${d.pos.x},${d.pos.y},${d.pos.z})` : "";
  return `${d.severity} ${where}${path}${pos} ${d.message}`;
}

/** Collects diagnostics for one file. */
export class Reporter {
  readonly diags: Diagnostic[];
  constructor(diags: Diagnostic[] = []) {
    this.diags = diags;
  }
  error(file: string, path: PathSegment[], message: string, pos?: Position, line?: number): void {
    this.push("error", file, path, message, pos, line);
  }
  warn(file: string, path: PathSegment[], message: string, pos?: Position, line?: number): void {
    this.push("warning", file, path, message, pos, line);
  }
  private push(
    severity: Diagnostic["severity"],
    file: string,
    path: PathSegment[],
    message: string,
    pos: Position | undefined,
    line: number | undefined,
  ): void {
    const d: Diagnostic = { severity, file, path, message };
    if (pos) d.pos = pos;
    if (line !== undefined) d.line = line;
    this.diags.push(d);
  }
}
