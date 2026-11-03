# 00 — Visión y decisiones cerradas

## Qué es
Un MMORPG 2D de vista cenital con el espíritu de Tibia: mundo abierto, movimiento por
casillas, combate pausado por turnos de servidor, skills que mejoran con el uso y un
grinding que da sentido a llegar al nivel de cada quest. Se juega en el navegador o
instalado en PC, y la comunidad puede crear mapas con un editor web que también puede
usar una IA.

Nombre provisional: **RPG Project**.

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
| Plataforma | PC primero (navegador + instalable con Tauri). Móvil secundario, más adelante |
| Trampas | Sin anticheat en el cliente, que siempre se considera manipulable. Todo se valida en el servidor y los bots se detectan ahí (`01-architecture.md`, "Trampas y anti-bot") |
| Cliente | TypeScript + PixiJS v8, UI DOM con Preact |
| Servidor | Go, servidor autoritativo, tick fijo de 50 ms |
| Base de datos | PostgreSQL 16 |
| Protocolo | WebSocket binario + Protobuf |
| Escala inicial | Hasta 100 jugadores simultáneos en un solo servidor |
| Hosting | Una instancia AWS con Docker Compose (~USD 10–20/mes) |
| Arte | Packs libres CC0/CC-BY + placeholders; se reemplaza después |
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
- PvP y sistema de skulls → campos `pvp_flags`, `skull`, zonas `pvp` ya existen.
- Mercado global → la tabla de items tiene `tradeable` y el inventario es transaccional.
- Tienda cosmética → tablas `cosmetics` y `account_cosmetics`; sin pasarela de pago aún.
- Casas de jugadores, gremios, mazmorras instanciadas, cliente móvil nativo.

## Lo que NO vamos a hacer
- Usar sprites, mapas, nombres o textos de Tibia.
- Vender poder (experiencia, items, stats, bendiciones con dinero real).
- Arquitectura distribuida antes de necesitarla.
