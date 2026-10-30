# 05 — Protocolo de red

## Transporte
- WebSocket seguro (`wss://<host>/ws`), mensajes **binarios**.
- Cada frame del cliente contiene exactamente un `ClientMessage`. Cada frame del
  servidor contiene exactamente un `ServerBatch` (ver "Agregación por tick"), que lleva
  uno o más `ServerMessage`.
- Esquemas en `proto/game/v1/*.proto` (`common.proto`, `client.proto`, `server.proto`).
  Código generado con `make gen` (buf con plugins locales, sin red a buf.build):
  Go en `server/internal/net/pb/game/v1` (paquete `gamev1`), TS en
  `packages/protocol/src/gen`. El código generado se commitea para compilar sin buf;
  regenéralo y commitéalo junto con cada cambio de `.proto`. `make proto-lint` corre
  `buf lint` y `buf format`.
- `@rpg/protocol` reexporta los tipos y esquemas generados y expone
  `encodeClientMessage` / `decodeServerBatch`.
- Cambios compatibles hacia atrás dentro de `v1` (agregar campos, nunca reutilizar
  números). Un cambio incompatible crea `v2`.

## Tipos comunes (`common.proto`)
- `Position {x, y, z}`: coordenadas globales (ver `03-world-and-maps.md`).
- `Direction`: N, NE, E, SE, S, SW, W, NW (`DIRECTION_NORTH`…). `0` = sin especificar.
- `ItemLocation`: `oneof` de `pos` (tile), `slot` (`EquipmentSlot`) o `container`
  (`ContainerSlot {container_id, index}`; `container_id` lo asigna el servidor en
  `ContainerOpen` y vale solo durante la sesión).
- `ActionTarget`: `oneof` de `pos` o `creature_id`.
- `ItemStack {item_id, count}`: `item_id` es el ID estable de `data/ids.lock.yaml`.
- `LocalizedText {key, params[]}`: texto visible como clave i18n + parámetros
  `{name, value}`. Es una lista y no un `map` para que la codificación sea determinista.

## Handshake
```
1. Cliente → HTTP POST /api/auth/login (o flujo OAuth) → recibe account_token
2. Cliente → HTTP GET /api/characters                  → lista de personajes
3. Cliente → HTTP POST /api/play {character_id}        → session_token (vive 60 s)
4. Cliente abre WS y envía Hello {session_token, client_version, locale}
5. Servidor → Welcome {player_id, server_time, tick_ms} + FullMapView + Stats + Inventory + Skills
```
Versión de cliente incompatible → `Disconnect{reason: OUTDATED_CLIENT}`.

## Mensajes cliente → servidor (intenciones)
| Mensaje | Campos |
|---|---|
| `Walk` | `dir` (N, NE, E, SE, S, SW, W, NW) |
| `WalkPath` | `steps[]` (máx. 100) |
| `StopWalk` | — |
| `Turn` | `dir` |
| `SetTarget` | `creature_id` (0 = ninguno) |
| `SetFightMode` | `stance`, `chase` |
| `CastSpell` | `spell_id` o `words`, `target?` |
| `UseItem` | `from` (pos, slot o contenedor), `item_id`, `stack_index` |
| `UseItemOn` | `from`, `item_id`, `stack_index`, `to` (pos o criatura) |
| `MoveItem` | `from`, `item_id`, `stack_index`, `to`, `count` |
| `LookAt` | `pos`, `stack_index` |
| `Say` | `channel` (decir, gritar, susurrar, global), `text` (máx. 255) |
| `DialogChoose` | `dialog_id`, `option_id` |
| `TradeRequest` | `player_id`, `item`, `item_id`, `stack_index` |
| `TradeOffer` | `item`, `item_id`, `stack_index` |
| `TradeAccept` / `TradeCancel` | — |
| `Ping` | `client_time` |
| `Logout` | — |

`item_id` y `stack_index` en las acciones sobre items permiten al servidor rechazar
una acción hecha sobre una vista desactualizada del tile o contenedor.

## Mensajes servidor → cliente (eventos)
| Mensaje | Uso |
|---|---|
| `FullMapView` | Área completa visible (al entrar o teletransportarse) |
| `MapSlice` | Fila o columna nueva al moverse |
| `TileUpdate` | Cambió la pila de un tile |
| `CreatureAppear` / `CreatureDisappear` | Entra o sale de la vista |
| `CreatureMove` | `id`, `from`, `to`, `duration_ms` |
| `CreatureTurn`, `CreatureHealth`, `CreatureOutfit`, `CreatureSpeed` | |
| `Effect` | Efecto visual en posición (`effect_id`) |
| `Projectile` | De A a B (`projectile_id`) |
| `FloatingText` | Daño, curación, XP |
| `PlayerStats` | HP, MP, nivel, XP, capacidad, velocidad, alma |
| `PlayerSkills` | Nivel y % de cada skill |
| `Inventory` / `ContainerOpen` / `ContainerUpdate` / `ContainerClose` | |
| `Message` | Chat y mensajes del sistema (clave i18n + parámetros) |
| `DialogOpen` / `DialogClose` | Diálogo de NPC con texto y opciones |
| `ShopOpen` | Lista de compra/venta |
| `TradeUpdate` | Estado del trade |
| `WalkRejected` | El cliente corrige su predicción |
| `Pong`, `Disconnect` | |

Los textos del servidor viajan como **clave i18n + parámetros** (`LocalizedText`), no
como texto final. El cliente traduce según su idioma. El chat escrito por jugadores
viaja tal cual (`Message.text`); lo que escribe el servidor va en `Message.localized`.
Monstruos y NPCs se identifican con su `content_id` de `data/` y el cliente traduce su
nombre; solo los jugadores llevan `name`.

### Formato de mapa en `FullMapView` / `MapSlice`
Ambos llevan un `MapArea {x, y, width, height, palette[], floors[], creatures[]}`:
- `palette`: pilas de tile (`Tile {items[]}`, suelo primero) distintas del área.
- `floors[]`: `MapFloor {z, tiles[]}` con `width × height` índices a `palette`, fila
  por fila (y, luego x). `-1` = sin tile.
- `creatures`: criaturas paradas dentro del área.
`MapSlice` usa el mismo formato con la fila o columna nueva (`width` o `height` = 1).

### Identificadores de sesión
`dialog_id` y `container_id` son locales a la sesión y los asigna el servidor; las
skills y oficios se mandan por `skill_id` de `data/` para no cambiar el protocolo al
agregar uno nuevo.

## Agregación por tick
El servidor agrupa todos los eventos de una sesión en un tick dentro de un
`ServerBatch {tick, events[]}`: un frame por tick por jugador como máximo. Si no hay
eventos, no envía nada.

## Compatibilidad Go ↔ TS (golden files)
`proto/testdata/golden/` tiene fixtures compartidos: `<nombre>.json` es el JSON
canónico proto3 de un mensaje (`client_*` = `ClientMessage`, `server_*` =
`ServerBatch`), `<nombre>.go.bin` su codificación en Go y `<nombre>.ts.bin` la de TS.
Cada lenguaje verifica que su codificación no cambió y que decodifica **ambos** binarios
al mismo JSON (`server/internal/net/golden_test.go`, `packages/protocol/src/golden.test.ts`).
No se exige igualdad de bytes entre lenguajes: protobuf no define una codificación
canónica (protobuf-go escribe los campos `oneof` al final, protobuf-es en orden de
declaración). Al agregar o cambiar un fixture:
```
cd server && go test ./internal/net -update
UPDATE_GOLDEN=1 pnpm --filter @rpg/protocol test
```

## Límites
- Tamaño máximo de mensaje entrante: 4 KB. Saliente: sin límite fijo, pero
  `FullMapView` se comprime con la paleta y suele quedar < 20 KB.
- Rate limit: 30 comandos/s por conexión (ráfaga 60). Excederlo de forma sostenida
  desconecta.
- Cola de salida por sesión acotada: si un cliente lento la llena, se desconecta en
  vez de consumir memoria del servidor.

## Presupuesto de ancho de banda
Objetivo: < 4 KB/s promedio por jugador en zona concurrida. Con 100 jugadores ≈ 400 KB/s
de salida, cómodo para una instancia chica.
