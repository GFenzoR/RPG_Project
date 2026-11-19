---
name: add-item
description: Agrega un item nuevo (arma, armadura, material, consumible, suelo o decoración) con su YAML, textos es/en, ID estable y sprite. Úsala cuando se pida crear o modificar items.
---

# Agregar un item

1. Elige el archivo por categoría en `data/items/` (ground, walls, decoration, weapons,
   equipment para escudos, armaduras y joyas, ammo, tools, misc, runes, doors).
2. ID de texto en `snake_case` inglés, único. Revisa con `grep` que no exista.
3. Completa los campos del esquema (`docs/06-content-data.md`). Para armas y armaduras,
   compara stats con items del mismo nivel para no romper el balance. Los números son
   propios: nunca copies peso, ataque, defensa ni armadura de un item de Tibia, aunque
   le cambies el nombre (regla legal de CLAUDE.md).
4. Textos en `i18n/es/items.yaml` e `i18n/en/items.yaml` (nombre y descripción).
5. Corre `make gen` para asignar el ID numérico en `data/ids.lock.yaml`.
   Nunca edites ni reutilices números existentes a mano.
6. Sprite en `assets/sprites/<categoría>/<id>.png` (32x32 o múltiplo) con licencia
   registrada en `assets/CREDITS.md`; si no hay, placeholder + `assets/MISSING.md`.
   **Equipo** (arma, escudo, armadura, joya, munición): su propio `sprite`
   (`weapons/<id>`, `shields/<id>`, `armor/<id>`, `jewelry/<id>`, `ammo/<id>`) dibujado
   por el motor de sprites: una llamada más al constructor de su línea en
   `tools/spritegen/src/engine/specs/items/` con el material y el acento de su banda
   (docs/17 "Íconos de items"), en su fila de `ICON_ROWS`; `make spritegen ONLY=<ruta>`,
   `spritegen sheet` y revisar `build/spritegen/icons.slots.png` con Read. Nunca un tile
   de un pack ni un placeholder: `engine/items.test.ts` lo exige.
7. Si un NPC lo vende o compra, agrégalo a su `shop`.
8. `make validate test`.
