# 00 — Visión y decisiones cerradas

## Qué es
Un MMORPG 2D de vista cenital con el espíritu de Tibia: mundo abierto, movimiento por
casillas, combate pausado por turnos de servidor, skills que mejoran con el uso y un
grinding que da sentido a llegar al nivel de cada quest. Se juega en el navegador o
instalado en PC, y la comunidad puede crear mapas con un editor web que también puede
usar una IA.

Nombre: **Neque's Realm** (hasta noviembre de 2026 se llamó "RPG Project", nombre provisional). Los identificadores internos (`rpg-*`, cookie `rpg_session`, base `rpg`) no cambian.

## Pilares
1. **Sensación Tibia.** Ritmo, lectura del mapa y progresión deben sentirse familiares
   para un jugador de Tibia, con identidad propia (arte, lore, nombres).
2. **Mundo de islas.** Un archipiélago de islas conectadas por barcos. Cada isla tiene
   su tono, su nivel recomendado y sus secretos.
3. **Progreso que se gana.** Nivel por experiencia, skills por uso, quests que exigen
   nivel. Sin atajos pagados.
4. **Mundo construido con la comunidad.** Cualquiera puede diseñar zonas; las aprobadas
   se integran al mapa oficial.
5. **Barato de operar.** Un servidor chico en AWS debe aguantar el primer público.

## Decisiones cerradas
| Tema | Decisión |
|---|---|
| Vista y gráficos | Cenital, 2D, tiles de 32x32, estilo pixel art tipo Tibia |
| Área visible | Mínimo 15x11 casillas y hasta 31x21 según la ventana (decisión del dueño, 2026-11-17): el servidor manda lo que el cliente puede ver. Hasta su tarea (A7 de `17-direccion-de-arte-y-ui.md`) se ven 15x11 |
| Estilo de interfaz | Oscura y gótica (referencia Diablo 2) con las funciones de Tibia: botonera que abre ventanas separadas. Detalle en `17-direccion-de-arte-y-ui.md` (pedido del dueño, 2026-11-17) |
| Plataforma | PC primero (navegador + instalable con Tauri). Móvil secundario, más adelante |
| Trampas | Sin anticheat en el cliente, que siempre se considera manipulable. Todo se valida en el servidor y los bots se detectan ahí (`01-architecture.md`, "Trampas y anti-bot") |
| Cliente | TypeScript + PixiJS v8, UI DOM con Preact |
| Servidor | Go, servidor autoritativo, tick fijo de 50 ms |
| Base de datos | PostgreSQL 16 |
| Protocolo | WebSocket binario + Protobuf |
| Escala inicial | Hasta 100 jugadores simultáneos en un solo servidor |
| Hosting | Una instancia AWS con Docker Compose (~USD 10–20/mes) |
| Arte | Arte propio más packs libres: CC0, CC-BY, OGA-BY y, desde el 2026-11-17 (decisión del dueño), CC-BY-SA (p. ej. Liberated Pixel Cup); fuentes OFL. Licencias y obligaciones en `assets/CREDITS.md`; dirección de arte en `17-direccion-de-arte-y-ui.md` |
| Combate | Como Tibia: movimiento por casillas, auto-ataque al objetivo, hechizos y runas con hotkeys |
| Vocaciones | 4 fijas, con nombres propios (equivalentes a knight, paladin, sorcerer, druid) |
| Skills | Como Tibia (puños, espada, hacha, maza, distancia, escudo, nivel mágico, pesca) **más oficios** (minería, herrería, cocina, etc.) |
| PvP | MVP solo PvE. El modelo de datos queda listo para PvP con skulls más adelante |
| Muerte | Como Tibia: pérdida de % de experiencia y skills, chance de soltar items, bendiciones que lo reducen |
| Mundo | Islas o continentes conectados por barco, cada uno con pisos subterráneos y superiores |
| Mapas de la comunidad | Se integran al mapa principal tras revisión (flujo tipo pull request) |
| Map editor | Web, abierto a todos, y usable por IA vía CLI y MCP |
| Historia | Línea principal en capítulos con nivel mínimo, más lore y quests sueltas |
| NPCs | Ventanas de diálogo con opciones |
| Economía | NPCs + trade directo entre jugadores. Mercado global en fase posterior |
| Monetización | Solo cosméticos (outfits, monturas, colores). Nunca ventajas de juego |
| Cuentas | Email + contraseña, Google y Discord (OAuth) |
| Idiomas | Español e inglés desde el día uno |
| Primer hito | Rebanada vertical (ver `10-roadmap.md`) |

## Fuera de alcance por ahora (pero contemplado en el modelo de datos)
Estas piezas ya no están fuera del plan: forman el Hito 5 (`10-roadmap.md`). Hasta que
llegue su tarea, siguen como estaban:
- Gremios → T5.1.
- PvP y sistema de skulls → T5.2 (hecha: `02-game-design.md`, "PvP"); `pvp_flags` sigue sin uso.
- Mercado global → T5.3; la tabla de items tiene `tradeable` y el inventario es
  transaccional.
- Casas de jugadores → T5.4.
- Cliente móvil → T5.6 (controles táctiles y Tauri mobile; sigue siendo plataforma
  secundaria).
- Tienda cosmética → T5.7; tablas `cosmetics` y `account_cosmetics`, con pasarela de pago
  en modo prueba hasta que el dueño elija proveedor. Solo cosméticos.
- Sigue fuera de alcance, sin tarea: mazmorras instanciadas.

## Lo que NO vamos a hacer
- Usar sprites, mapas, nombres o textos de Tibia (ni sprites, fuentes o interfaces de Diablo
  u otros juegos de referencia: de ellos se aprende el estilo, no se calca).
- Vender poder (experiencia, items, stats, bendiciones con dinero real).
- Arquitectura distribuida antes de necesitarla.
