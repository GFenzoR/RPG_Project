/// <reference types="vite/client" />

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
