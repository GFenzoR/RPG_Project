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
  `TextParam {name, value}`. Es una lista y no un `map` para que la codificación sea
  determinista. `value` tiene tipo (`text` sin traducir, `number`, `content_id` o
  `item`), así el cliente formatea números y plurales y traduce nombres: el servidor
  nunca pone texto armado o traducido en un parámetro.
- Ids de criatura: todo id de jugador, monstruo o NPC en el protocolo es el id de
  criatura de la sesión (`creature_id`, `npc_creature_id`…), nunca el id de base de datos.

## Handshake
```
1. Cliente → HTTP POST /api/auth/login (o flujo OAuth) → recibe account_token
2. Cliente → HTTP GET /api/characters                  → lista de personajes
3. Cliente → HTTP POST /api/play {character_id}        → session_token (vive 60 s)
4. Cliente abre WS y envía Hello {session_token, client_version, locale}
5. Servidor → Welcome {creature_id, server_time, tick_ms} + FullMapView + Stats + Inventory + Skills
```
Versión de cliente incompatible → `Disconnect{reason: OUTDATED_CLIENT}`.

## API HTTP (cuentas y personajes)
Implementada en `server/internal/httpapi` (T1.3). JSON en ambos sentidos; los `POST` con
cuerpo exigen `Content-Type: application/json` (también frena formularios cross-site),
cuerpo máximo 4 KiB, campos desconocidos rechazados. Respuestas con `Cache-Control: no-store`.

| Método y ruta | Auth | Cuerpo | Respuesta OK |
|---|---|---|---|
| `POST /api/auth/register` | — | `{email, password}` | `201 {account_id}` |
| `POST /api/auth/login` | — | `{email, password, token_in_body?}` | `200 {expires_at, token?}` + cookie |
| `POST /api/auth/logout` | token | — | `204`, revoca el token y borra la cookie |
| `GET /api/characters` | token | — | `200 {characters: [{id, name, vocation, level}]}` |
| `POST /api/characters` | token | `{name, vocation}` | `201 {character: {id, name, vocation, level}}` |
| `GET /healthz` | — | — | `200 {status: "ok"}` / `503` si Postgres no responde |

- **Token de cuenta:** opaco (32 bytes aleatorios, base64url), dura 30 días. En la base
  se guarda solo su SHA-256 (tabla `sessions`, `kind = 'account'`). Se envía como
  `Authorization: Bearer <token>` (Tauri, herramientas, bots) o en la cookie
  `rpg_session` (`HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/api`) que pone el login
  para el cliente web. Si hay un `Authorization: Bearer` (el esquema no distingue
  mayúsculas), manda ese token; cualquier otro esquema (p. ej. `Basic` de un staging con
  contraseña) se ignora y se usa la cookie. El token solo
  viene en el cuerpo del login si se pide `token_in_body: true` (Tauri, bots): el cliente
  web no lo pide, así un XSS no puede leerlo de la respuesta.
- **Reglas:** email ASCII normalizado a minúsculas; contraseña de 8 a 128 caracteres (argon2id,
  19 MiB, t=2, p=1). Nombre de personaje de 3 a 20 caracteres, 1–3 palabras de letras
  ASCII con mayúscula inicial y el resto minúsculas (`Mira`, `Old Tom`), único sin
  distinguir mayúsculas y sin suplantar al staff: se rechaza si, en minúsculas y sin
  espacios, contiene `admin`, `gamemaster`, `moderat`/`moderad`, `soporte`/`support`,
  `staff`, `tutor`, `sistema`/`system` u `oficial`/`official`, o si alguna palabra es
  `Gm`, `Cm`, `God`, `Mod` o `Dev` (como palabra completa: `Gmork` vale). La vocación debe
  existir en `data/vocations.yaml`. Máximo 10 personajes por cuenta. El personaje nace en
  nivel 1 con la vida y el maná iniciales de su vocación y sin posición: el servidor lo
  ubica en el templo de su ciudad al primer login (T1.4).
- **Rate limit** → `429 rate_limited` con `Retry-After`:
  - Por IP del cliente (IPv6: por /64): register y login comparten 10 pedidos, luego 1
    cada 6 s. Cuenta todo pedido, también los basura.
  - Login fallido por par (email, IP): 5, luego 1 por minuto. Estricto, y un atacante
    desde otras IPs no puede gastarlo por la víctima.
  - Login fallido por email desde cualquier IP: 30, luego 1 cada 2 min (~30/h). Laxo:
    solo frena la adivinación repartida en muchas IPs.
  - Un login con email inválido o una contraseña que el registro nunca aceptaría (fuera
    de 8–128 caracteres) responde `invalid_credentials` al instante, sin calcular hash y
    sin gastar los límites de login: así no sirve para llenar las tablas.
  - Los dos límites de login reservan una ficha **antes** de verificar la contraseña
    (así N pedidos simultáneos no pasan con una sola ficha) y la devuelven si el
    resultado no es `invalid_credentials`: solo los intentos **fallidos** cuentan y
    entrar bien nunca gasta.
  - **Trade-off:** quien conoce el email de alguien puede, sosteniendo ~30 fallos por
    hora desde IPs distintas, agotar el límite por email; mientras siga agotado, la
    víctima recibe `429` desde **cualquier** IP, también la de siempre. Lo aceptamos
    frente a dejar sin tope la adivinación distribuida. Mejora pendiente: eximir del
    límite por email a dispositivos o IPs donde la cuenta ya entró.
  - Las tablas de límites tienen tamaño fijo (65 536 casillas en 16 384 grupos de 4;
    cada clave cae en un grupo y lleva una etiqueta, ambos derivados de un HMAC con
    secreto aleatorio por proceso): la memoria está acotada y no se pueden elegir claves
    que caigan en el grupo de otro. Una clave cuya etiqueta está en su grupo usa siempre
    esa casilla, y una casilla solo cambia de dueño cuando está vacía o llena: rociar
    claves nuevas nunca resetea un límite gastado.
  - El tiempo se mide desde el arranque del limitador (monotónico con el reloj real), y
    si el reloj retrocede los buckets siguen recargando desde ahí: un salto del reloj
    de pared ni congela los límites ni los rellena todos de golpe.
  - Si las 4 casillas del grupo de una clave están ocupadas por otros buckets en uso: el
    límite por IP **deja pasar** el pedido sin contarlo, y los límites de login
    **comparten** la casilla más llena (fallan cerrados).
  - **Residuo en los límites de login:** solo los gastan cálculos reales de contraseña
    (máx. 4 a la vez), así que un atacante solo puede mantener gastada una fracción *f*
    pequeña de las casillas. Una cuenta que nunca falló recibe `429` solo si las 4
    casillas de su grupo están gastadas por otros. Como los buckets gastados caen en los
    grupos con conteos tipo Poisson, eso pasa con probabilidad P(Poisson(4*f*) ≥ 4) ≈
    (4*f*)⁴/24 ≈ 10·*f*⁴ por cada una de las dos tablas de login: ≈ 0,08 % de las cuentas
    con *f* = 10 %, ≈ 0,3 % con *f* = 15 %, mientras dure el ataque. Con 2 casillas por
    clave era ≈ 2·*f*² (≈ 1,8 % con *f* = 10 %).
  - El límite por IP es **best effort**: quien sostenga ~11 000 pedidos/s desde decenas
    de miles de /64 (p. ej. un /48 IPv6) satura la tabla y, mientras dure, las IPs sin
    casilla quedan sin ese límite. Preferimos eso a un `429` para todos. Lo que sigue
    protegiendo: los límites de login por par y por email, y el tope de 4 cálculos de
    contraseña, que también acota el ritmo de registros (spam de cuentas). Cuando la
    tabla vuelve a llenarse de fichas, las claves nuevas recuperan casilla.
- **Detrás de Caddy**, `-trust-proxy` toma la IP del último salto de `X-Forwarded-For`
  (el puerto del servidor no debe quedar expuesto fuera de Caddy).
- **Cálculos de contraseña** (argon2id, máx. 4 a la vez): si están saturados más de 2 s
  → `503 busy`.
- **Errores:** `{"error": {"code": "<código>"}}`. El cliente traduce el código con la
  clave i18n `error.<código>`; el servidor nunca manda texto visible.

| Código | HTTP | Cuándo |
|---|---|---|
| `bad_request` | 400 | JSON mal formado, campos desconocidos o cuerpo > 4 KiB |
| `unsupported_media_type` | 415 | Falta `Content-Type: application/json` |
| `invalid_email` / `invalid_password` | 400 | Registro con email o contraseña inválidos |
| `email_taken` | 409 | Email ya registrado |
| `invalid_credentials` | 401 | Email o contraseña incorrectos (no distingue cuál) |
| `account_disabled` | 403 | Cuenta deshabilitada |
| `unauthorized` | 401 | Token ausente, vencido o revocado |
| `invalid_name` / `invalid_vocation` | 400 | Creación de personaje inválida |
| `name_taken` | 409 | Nombre en uso |
| `character_limit` | 409 | La cuenta ya tiene el máximo de personajes |
| `rate_limited` | 429 | Demasiados intentos de login/registro (por IP o por email) |
| `busy` | 503 | Servidor saturado de logins; reintentar más tarde |
| `not_found` | 404 | Ruta `/api/...` inexistente |
| `internal` | 500 | Error del servidor (queda en el log) |

`POST /api/play` (paso 3 del handshake, token `kind = 'play'` de 60 s) llega con T1.4.
OAuth, verificación de email y reset de contraseña llegan con T2.1.

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
| `LookAt` | `from` (pos, slot o contenedor), `item_id`, `stack_index` |
| `Say` | `channel` (decir, gritar, susurrar, global), `text` (máx. 255) |
| `DialogChoose` | `dialog_id`, `option_id` |
| `TradeRequest` | `creature_id`, `item`, `item_id`, `stack_index` |
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
nombre; solo los jugadores llevan `name` (en `Message`: `speaker_name` solo para
jugadores, `speaker_content_id` para NPCs y monstruos).

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
declaración). Al agregar o cambiar un fixture (en modo update cada lenguaje tolera que
falte el binario del otro):
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
