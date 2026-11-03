// The client version has one source: client/package.json. The web build and the desktop
// app (apps/desktop: tauri.conf.json "version" points at the same file) send it in Hello,
// and the server rejects versions older than its -min-client-version (docs/05).
import { version } from "../package.json";

export const CLIENT_VERSION: string = version;
