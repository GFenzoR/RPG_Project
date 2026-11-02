---
name: add-monster
description: Agrega un monstruo nuevo al juego (YAML, textos es/en, sprite o placeholder, loot, test de balance). Úsala cuando se pida crear, diseñar o balancear un monstruo o criatura.
---

# Agregar un monstruo

1. Busca en `data/monsters/` uno de nivel parecido para usar como referencia de números.
2. Crea `data/monsters/<id>.yaml` siguiendo el esquema de `docs/06-content-data.md`.
   - Nombre e identidad propios: nunca copies monstruos, nombres ni stats de Tibia (vida,
     experiencia, daño, loot), tampoco para un animal genérico como un lobo.
   - Define `tags` con la isla donde vive.
3. Agrega `monster.<id>.name` en `i18n/es/monsters.yaml` e `i18n/en/monsters.yaml`.
4. Items nuevos de loot: créalos con la skill `add-item` antes de referenciarlos.
5. Sprite: si existe en `assets/`, enlázalo; si no, deja que `spritepack` genere el
   placeholder y anótalo en `assets/MISSING.md`.
6. Balance con simulación: agrega un caso en `server/internal/sim/balance_test.go` que
   mida, para un personaje del nivel objetivo de la isla, el tiempo para matarlo y el
   daño recibido. Objetivos orientativos:
   - Monstruo común: 5–15 s de combate, el jugador pierde 10–40 % de vida.
   - Experiencia por hora razonable para la curva de `balance.yaml`.
7. `make validate test`.
8. Si se va a colocar en el mapa, usa la skill `build-map-area` o `mapcli spawn add`.
