/// <reference types="vite/client" />

/**
 * Whether the read-only E2E hooks (window.__rpgClient, window.__rpgAudio) are published:
 * true in the dev server and unit tests, false in a production build unless built with
 * RPG_E2E_HOOKS=1 (vite.config.ts). A literal, so the build drops the guarded code.
 */
declare const __RPG_E2E_HOOKS__: boolean;

declare module "virtual:rpg-content" {
  import type { ClientContent } from "./content-types.ts";
  const content: ClientContent;
  export default content;
}

declare module "virtual:rpg-site" {
  import type { SiteContent } from "./content-types.ts";
  const site: SiteContent;
  export default site;
}

declare module "virtual:rpg-credits" {
  import type { Credits } from "./content-types.ts";
  const credits: Credits;
  export default credits;
}
