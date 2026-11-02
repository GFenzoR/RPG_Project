/// <reference types="vite/client" />

declare module "virtual:rpg-content" {
  import type { ClientContent } from "./content-types.ts";
  const content: ClientContent;
  export default content;
}
