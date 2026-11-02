// Only the editor page itself may call the local API. A page from another site open in
// the same browser could otherwise POST to localhost and write or delete map files.
//   - every call must carry the API_HEADER custom header: a cross-site page can only send
//     it after a CORS preflight, which this server never approves;
//   - when the browser says where the request comes from (Origin, Sec-Fetch-Site), it must
//     be this same origin;
//   - POST bodies must be application/json.
import type { IncomingHttpHeaders } from "node:http";
import { API_HEADER } from "../src/io/wire.ts";

/** Why the request is refused, or undefined when it may proceed. */
export function refuseRequest(method: string, headers: IncomingHttpHeaders): string | undefined {
  if (headers[API_HEADER] !== "1") return `missing ${API_HEADER} header`;
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return `cross-site request (sec-fetch-site: ${String(site)})`;
  const origin = headers["origin"];
  if (origin !== undefined) {
    const host = headers["host"];
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      return `invalid origin ${origin}`;
    }
    if (!host || originHost !== host) return `cross-origin request from ${origin}`;
  }
  if (method === "POST" && !String(headers["content-type"] ?? "").startsWith("application/json"))
    return "POST bodies must be application/json";
  return undefined;
}
