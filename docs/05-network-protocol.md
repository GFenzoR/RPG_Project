# 05 — Protocolo de red

## Transporte
- WebSocket seguro (`wss://<host>/ws`), mensajes **binarios**.
- Cada frame contiene exactamente un `ClientMessage` o `ServerMessage` de Protobuf.
- Esquemas en `proto/game/v1/*.proto`. Código generado con `buf generate`:
  Go en `server/internal/net/pb`, TS en `packages/protocol`.
- Cambios compatibles hacia atrás dentro de `v1` (agregar campos, nunca reutilizar
  números). Un cambio incompatible crea `v2`.

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
| `UseItem` | `from` (pos o slot), `item_id`, `stack_index` |
| `UseItemOn` | `from`, `to` (pos o criatura) |
| `MoveItem` | `from`, `to`, `count` |
| `LookAt` | `pos`, `stack_index` |
| `Say` | `channel`, `text` (máx. 255) |
| `DialogChoose` | `dialog_id`, `option_id` |
| `TradeRequest` / `TradeOffer` / `TradeAccept` / `TradeCancel` | |
| `Ping` | `client_time` |
| `Logout` | — |

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

Los textos del servidor viajan como **clave i18n + parámetros**, no como texto final.
El cliente traduce según su idioma.

## Agregación por tick
El servidor agrupa todos los eventos de una sesión en un tick dentro de un
`ServerBatch {tick, events[]}`: un frame por tick por jugador como máximo. Si no hay
eventos, no envía nada.

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
