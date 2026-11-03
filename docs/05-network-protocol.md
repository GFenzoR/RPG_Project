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

Detalles (T1.4, `server/internal/net/gateway`):
- **`session_token`** es de un solo uso: el servidor lo borra al canjearlo en el `Hello`
  (tabla `sessions`, `kind = 'play'`). Reconectar exige otro `POST /api/play`.
- **Hello:** debe ser el primer frame y llegar en 10 s; si no, el servidor cierra.
  Primer frame que no es `Hello`, token inválido, vencido o ya usado, o personaje que
  ya no existe → `Disconnect{INVALID_SESSION}` y cierre. Un error de la base durante
  el handshake → `Disconnect{UNSPECIFIED}` (el token ya se gastó: pedir otro).
- **Versión:** `client_version` es `MAJOR.MINOR.PATCH` (se ignora un sufijo `-dev` o
  `+build`). Se acepta si tiene la misma versión mayor que la mínima del servidor
  (`-min-client-version`, por defecto `0.1.0`) y no es más vieja. La versión se revisa
  antes del token, así un cliente viejo no gasta su token.
- **Welcome** va en el primer `ServerBatch` seguido de `FullMapView`, `PlayerStats`,
  `Inventory` (equipo guardado, T1.8) y `PlayerSkills` (todas las skills de
  `balance.yaml → skills.base`, con el nivel guardado del personaje).
- **Posición inicial:** la guardada; si el personaje nunca jugó (o su casilla dejó de
  ser caminable) el templo de su isla (`town`, o la primera isla del mundo). Si está
  ocupada, la casilla libre más cercana (hasta 3 de distancia).
- **Entrar dos veces:** si el personaje ya está en el mundo, la conexión vieja recibe
  `Disconnect{LOGGED_IN_ELSEWHERE}` y la nueva sigue con el estado en memoria.
- **Logout:** `Disconnect{LOGGED_OUT}` y cierre; se guarda el personaje. Cerrar el
  socket sin `Logout` también saca al personaje y lo guarda (las zonas sin logout y el
  bloqueo por combate llegan con T1.6/T1.11).
- **Apagado:** el servidor guarda a todos y manda `Disconnect{SERVER_SHUTDOWN}`.

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
| `POST /api/play` | token | `{character_id}` | `200 {session_token, expires_at}` (vive 60 s, un uso) |
| `GET /healthz` | — | — | `200 {status: "ok"}` / `503` si Postgres no responde |

- **Token de cuenta:** opaco (32 bytes aleatorios, base64url), dura 30 días. En la base
  se guarda solo su SHA-256 (tabla `sessions`, `kind = 'account'`). Se envía como
  `Authorization: Bearer <token>` (Tauri, herramientas, bots) o en la cookie
  `rpg_session` (`HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/api`) que pone el login
  para el cliente web. Si hay un `Authorization: Bearer` (el esquema no distingue
  mayúsculas), manda ese token; cualquier otro esquema (p. ej. `Basic` de un staging con
  contraseña) se ignora y se usa la cookie. El token solo
  viene en el cuerpo del login si se pide `token_in_body: true` (Tauri, bots): el cliente
  web no lo pide, así un XSS no puede leerlo de la respuesta. En la app de escritorio lo
  pide el lado Rust, que lo guarda en el llavero del SO y lo quita de la respuesta antes
  de pasarla al webview (`apps/desktop`, docs/12).
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
| `character_not_found` | 404 | `POST /api/play` con un personaje que no es de la cuenta |
| `rate_limited` | 429 | Demasiados intentos de login/registro (por IP o por email) |
| `busy` | 503 | Servidor saturado de logins; reintentar más tarde |
| `not_found` | 404 | Ruta `/api/...` inexistente |
| `internal` | 500 | Error del servidor (queda en el log) |

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
| `NpcTalk` | `creature_id` del NPC (T1.10) |
| `DialogChoose` | `dialog_id`, `option_id` (0 = cerrar) |
| `ShopBuy` / `ShopSell` | `dialog_id`, `item_id`, `count` (1..100) (T1.10) |
| `TradeRequest` | `creature_id`, `item`, `item_id`, `stack_index` |
| `TradeOffer` | `item`, `item_id`, `stack_index` |
| `TradeAccept` / `TradeCancel` | — |
| `CloseContainer` | `container_id` (T1.8) |
| `Ping` | `client_time` |
| `Logout` | — |

`item_id` y `stack_index` en las acciones sobre items permiten al servidor rechazar
una acción hecha sobre una vista desactualizada del tile o contenedor.

### Caminar (T1.4, `server/internal/session`)
- El servidor marca el ritmo: un paso empieza cuando terminó el anterior. Duración =
  `base_step_ms × terreno% / velocidad` (× `diagonal_cost` en diagonal), con terreno el
  `ground.speed` de la casilla **de destino** (100 por defecto), redondeada hacia arriba
  a ticks de 50 ms. `CreatureMove.duration_ms` es esa duración ya redondeada. La
  posición cambia al **empezar** el paso.
- `Walk` reemplaza lo que hubiera en cola (también un `WalkPath`) por un paso; si el
  personaje está a mitad de un paso, sale al terminarlo. Mandar `Walk` cada tick no
  acelera nada.
- `WalkPath` reemplaza la cola. Vacío = `StopWalk`. Más de `max_path_tiles` pasos
  (`balance.yaml`, 100) o una dirección inválida → `WalkRejected` con `dir` =
  `UNSPECIFIED` y nada se encola. En los demás rechazos `dir` es el paso rechazado.
- Cada paso se valida al ejecutarse: casilla sin suelo, que bloquea o fuera del mundo →
  `WalkRejected{pos, dir}` y se vacía la cola. Si la bloquea **una criatura** durante un
  `WalkPath`, el servidor recalcula con A* hasta el final del camino esquivando
  criaturas; si no hay camino (o el destino está ocupado) → `WalkRejected`. Un `Walk`
  de teclado bloqueado por una criatura se rechaza sin recalcular.
- **Cuota de pathfinding por tick:** los recálculos comparten 12 000 nodos expandidos
  por tick y cada búsqueda expande como máximo 2 × 1 500; una búsqueda solo arranca si
  cabe el peor caso. Sin cuota, el jugador espera al tick siguiente (no se rechaza).
- `StopWalk` vacía la cola (el paso en curso termina). `Turn` cambia la dirección y
  manda `CreatureTurn` a quien lo ve (nada si ya miraba hacia ahí).
- `Ping` → `Pong` en el batch de ese tick.

### Combate cuerpo a cuerpo (T1.6, `server/internal/session/combat.go`)
- `SetTarget{creature_id}` elige un monstruo que el cliente conoce, en su mismo piso, con
  ninguno de los dos en zona de protección. Si no vale (también jugadores y NPCs, hasta
  PvP), el servidor lo descarta y manda `Message` de sistema `combat.cannot_attack`; el
  cliente suelta el objetivo al recibirlo. `0` deja de atacar. El objetivo se pierde
  solo cuando sale de la vista o muere: el cliente lo suelta con su `CreatureDisappear`.
- `SetFightMode{stance, chase}`: `stance` ofensivo/equilibrado/defensivo multiplica el
  golpe máximo y la defensa del escudo (`combat.modes` de `balance.yaml`); `UNSPECIFIED`
  se ignora. Por defecto equilibrado y sin perseguir. Con `chase` el jugador da un paso
  hacia su objetivo cuando no está pegado a él y no tiene pasos en cola.
- Ronda: con el objetivo a una casilla (también en diagonal) el jugador golpea cada
  `combat.attack_interval_ms` (2000 ms). Fórmulas en `server/internal/combat` (doc 02).
  Sin arma golpea con los puños (`combat.fist_attack`, con su skill `fist`); con arma,
  con la de la mano derecha (T1.8).
- Cada golpe (de jugador o de monstruo) manda a quien ve la casilla: `Effect`
  (`effect_id` 1 = golpe con daño, 2 = bloqueado o fallado) y, si hubo daño,
  `FloatingText{DAMAGE}` y `CreatureHealth`. El jugador golpeado recibe además
  `PlayerStats`. Los `effect_id` son constantes del protocolo hasta que exista
  `data/effects.yaml`.
- Muerte de un monstruo: `CreatureDisappear`, `TileUpdate` con `creature_remains` encima
  de la pila (dura `combat.monster_corpse_ms`; es un contenedor con el botín, T1.8),
  `FloatingText{EXPERIENCE}` y `PlayerStats` a cada jugador que hizo daño (la experiencia
  se reparte según el daño de los que siguen conectados) y, al que más daño hizo,
  `Message` de sistema `combat.loot` con un parámetro `monster` (`content_id`) y un
  parámetro `item` por pila del botín (el cliente los junta en `{items}`), o
  `combat.loot_none` si no hubo botín.
- Progreso (T1.7): cuando cambia el nivel o el % de una skill el jugador recibe
  `PlayerSkills` completo; si subió de nivel, además el `Message` de sistema
  `progress.skill_up` con `skill` (`content_id`, el cliente muestra `skill.<id>.name`) y
  `level` (`number`). Al subir de nivel por experiencia recibe `progress.level_up` con
  `from` y `level`, `PlayerStats` con los nuevos máximos, y quien lo ve recibe
  `CreatureSpeed` (si cambió) y `CreatureHealth` (si cambió el %).
- La regeneración manda `PlayerStats` al jugador (y `CreatureHealth` a quien lo ve si
  cambió el %) solo cuando le faltaba vida o maná.
- Muerte de un jugador (T1.11, reglas en `02-game-design.md`): `TileUpdate` con el cuerpo
  (`creature_remains`) donde murió, el jugador reaparece en su templo (como un teleport:
  `FullMapView`, `CreatureDisappear`/`CreatureAppear` a los observadores) y recibe
  `Inventory`, `PlayerStats`, `PlayerSkills` y el `Message` de sistema `death.died` con
  `experience` (perdida) y `blessings` (las que tenía y se consumieron), ambos `number`.
  El cliente muestra la pantalla de muerte con ese mensaje. Sacar o usar algo del cuerpo
  ajeno dentro de `corpse_owner_only_ms` responde `death.corpse_not_owner`.

### Items e inventario (T1.8, `server/internal/session/inventory.go`)
Reglas de juego en `02-game-design.md` ("Items, equipo e inventario").
- **Pila de un tile:** suelo (índice 0), items fijos de `world.bin` y encima los items del
  servidor (restos, items soltados) con su `count` si son apilables. `stack_index` de una
  acción sobre `pos` es el índice en esa pila; solo los items del servidor se mueven o usan.
  En `slot` vale 0; en `container` es el `index`.
- **Validación:** si `item_id` no coincide con lo que hay en esa posición (vista vieja),
  el índice no existe o el contenedor no está abierto → `Message` de sistema
  `inventory.not_possible` y nada cambia. Otros rechazos: `inventory.too_far`,
  `cannot_move` (`pickupable: false`), `wrong_slot`, `level_required` (`level`),
  `vocation_cannot`, `hands_full`, `slot_occupied`, `container_full`, `too_heavy`,
  `into_itself`, `too_deep`, `tile_full`, `cannot_use`, `not_ready`.
- **`MoveItem`:** `count` de 1 al tamaño de la pila para apilables (se ignora en los demás).
  Destino `pos`: un tile caminable al alcance. Destino `slot` o `container` con un
  contenedor en ese lugar: adentro de ese contenedor. Mover dentro del mismo contenedor
  no reordena (ignorado).
- **Respuestas:** cada lugar que cambió manda su estado completo: `TileUpdate` a quien ve
  el tile, `Inventory` (todos los slots ocupados) al dueño y `ContainerUpdate` a cada
  jugador que tiene el contenedor abierto. Si cambió el peso cargado, `PlayerStats`
  (`capacity` = capacidad libre en gramos, `max_capacity` = la total).
- **Contenedores:** `UseItem` sobre un contenedor lo abre (`ContainerOpen` con un
  `container_id` nuevo de la sesión, `capacity` = lugares, `has_parent` si está dentro de
  otro contenedor) o lo cierra si ya estaba abierto (`ContainerClose`). Como máximo
  `inventory.max_open_containers` (16) a la vez: abrir otro cierra el más viejo.
  `CloseContainer` cierra una ventana. El servidor manda `ContainerClose` cuando el
  jugador se aleja de un contenedor del suelo, cuando el contenedor se mueve fuera de su
  alcance o cuando los restos desaparecen.
- **Consumibles:** `UseItem` cura (`FloatingText{HEAL}` a quien ve, `CreatureHealth` si
  cambió el %, `PlayerStats` al jugador) o, si solo es comida, `inventory.ate` con el
  item. Gasta una unidad.
- **`LookAt`:** `Message` de sistema `look.weapon` (`attack`, `defense`), `look.armor`
  (`armor`), `look.shield` (`defense`), `look.container` (`slots`), `look.item` o
  `look.ground`, con el parámetro `item` y, salvo el suelo, `weight` (gramos de la pila con
  su contenido) y `level` si el item lo exige. El cliente agrega la descripción
  `item.<id>.desc` si existe y muestra el peso en oz.
- **Login:** `Inventory` lleva el equipo guardado; un personaje que nunca jugó recibe
  `inventory.start_container` en el slot de mochila.

### Magia (T1.9, `server/internal/session/magic.go`)
Reglas de juego en `02-game-design.md` ("Magia (T1.9)").
- **`CastSpell`**: `spell_id` (hotkey) o `words`; `target` opcional (criatura o tile; sin él,
  el objetivo actual). Un `Say` en el canal `SAY` cuyo texto, en minúsculas y con los
  espacios colapsados, coincide con las palabras de un hechizo lo lanza igual (y no se muestra como chat;
  los demás textos son chat, ver "Chat"). Ids o palabras desconocidas se
  ignoran.
- **Rechazos** (`Message` de sistema, no se gasta nada ni empieza ningún cooldown):
  `magic.vocation`, `magic.level_required` (`level`), `magic.magic_level_required`
  (`level`), `magic.not_ready`, `magic.no_mana`, `magic.no_target`, `magic.out_of_range`,
  `magic.no_sight`, `magic.protection_zone`, `magic.no_room` e `inventory.too_heavy` (al
  conjurar).
- **Lanzado**: el jugador recibe `SpellCooldown{spell_id, cooldown_ms, group,
  group_cooldown_ms}` (ya redondeados a ticks) y `PlayerStats` con el maná gastado; si
  cambió el nivel mágico, `PlayerSkills` (y `progress.skill_up`).
- **Efectos** (`effect_id`, constantes del protocolo hasta `data/effects.yaml`): 3 =
  curación, 4 = conjurar, `10 + elemento` = golpe elemental o casilla de un hechizo de
  área, con elemento en el orden `physical, fire, ice, energy, earth, holy, death`
  (0..6). Un golpe mágico con daño usa el efecto de su elemento en vez del 1; con 0 de daño,
  el 2.
- **`Projectile{from, to, projectile_id}`** con `projectile_id = 1 + elemento`: hechizos de
  un objetivo, disparos de varita y ataques a distancia o hechizos de monstruos. Lo recibe
  quien ve cualquiera de las dos puntas.
- **Curación**: `Effect` 3, `FloatingText{HEAL}` si curó algo y `CreatureHealth` si cambió
  el %.
- **Conjurar**: la runa aparece en la mochila equipada (`ContainerUpdate` a quien la tiene
  abierta), `Effect` 4 y `magic.conjured` con el parámetro `item`.
- **Runas**: `UseItemOn{from, item_id, stack_index, to}` (criatura o tile) o `UseItem`
  (sobre el objetivo actual) lanza el hechizo de la runa sin maná; en `ItemStack.count` una
  runa lleva sus cargas. Cada uso gasta una carga (la última la quita) y manda
  `SpellCooldown` solo con el cooldown del grupo.
- **Varitas**: con una varita en la mano derecha el ataque automático es un `Projectile` del
  elemento de la varita cada ronda, a `weapon.range` casillas y con línea de visión; con
  `chase` el jugador se acerca hasta tenerlo a tiro.

### Pesca y minería (T1.12, `server/internal/session/gathering.go`)
- `UseItemOn{from, item_id, stack_index, to: pos}` con una herramienta que el jugador lleva
  (equipada o en un contenedor suyo) sobre una casilla cuyo item de arriba con `resource`
  (pila de arriba hacia abajo, luego el suelo) tiene `resource.tool == tool.use`.
- Respuestas por `Message` de sistema: `gather.nothing` (no hay recurso para esa
  herramienta), `inventory.too_far` (otro piso o más lejos que `resource.reach`),
  `magic.no_sight`, `gather.not_ready` (antes de `gathering.use_interval_ms`),
  `gather.depleted` (casilla agotada: no entrena), `gather.failed` y
  `gather.got{item}`. Lo obtenido va a la mochila como una compra (lo que no entra cae al
  suelo con `inventory.item_on_floor`).
- **Efectos**: 5 = cosecha lograda, 6 = intento sin resultado, en la casilla del recurso,
  para todos los que la ven.
- El cliente entra en modo "usar con" al usar una herramienta (click derecho) y el
  siguiente click en el mapa manda el `UseItemOn`; Escape o click derecho lo cancelan.

### Chat (T1.13, `server/internal/session/chat.go`)
Reglas y números en `02-game-design.md` ("Chat") y `balance.yaml` `chat`.
- **`Say`** `channel` `SAY`/`YELL`/`WHISPER` → `Message{kind: SAY|YELL|WHISPER,
  speaker_id, speaker_name, pos, text}` a todo jugador dentro del rectángulo del modo en el
  mismo piso (incluido quien habla). `GLOBAL` → `Message{kind: GLOBAL, speaker_id,
  speaker_name, text}` sin `pos` a todos los conectados. `UNSPECIFIED` se ignora.
- El servidor limpia el texto (controles y caracteres de formato → espacio, espacios
  colapsados) y lo reenvía **tal cual**: no escapa HTML. El cliente lo dibuja siempre como
  texto (nodos DOM de Preact o `Text` de Pixi), nunca como HTML ni como plantilla i18n.
- Rechazos (`Message` de sistema): `chat.too_long` (`max`), `chat.flood` (`seconds`),
  `chat.muted` (`seconds`), `chat.global_wait` (`seconds`).
- El rate limit por conexión del gateway (comandos/s, desconexión) sigue aplicando a
  todo, chat incluido; el anti-flood es una capa más fina dentro del juego.

### NPCs, diálogos y tiendas (T1.10, `server/internal/session/npc.go`)
- `NpcTalk{creature_id}` abre el diálogo de un NPC que el cliente conoce, en el mismo piso
  y a ≤ `TalkRange` (3) casillas (Chebyshev). Fuera de rango → `Message` de sistema
  `dialog.too_far`; un NPC desconocido → `inventory.not_possible`. Un diálogo nuevo cierra
  el anterior. El servidor responde `DialogOpen` con el nodo inicial.
- `DialogOpen` lleva solo las opciones cuyo `if` se cumple ahora; `option_id` es la
  posición de la opción en el nodo (1..9), así que no cambia mientras el nodo está
  abierto. El cliente las elige con click o con las teclas 1–9 (la n-ésima mostrada).
- `DialogChoose`: un `dialog_id` viejo se ignora; `option_id` 0 cierra. El servidor vuelve
  a evaluar el `if` (una ventana vieja no sirve para elegir una opción oculta: reenvía el
  nodo) y revisa los costos antes de ejecutar nada (`docs/06-content-data.md`). Si algo
  falla manda el `Message` de rechazo (`dialog.no_money`, `dialog.no_item`...) y reenvía el
  nodo. Si no, ejecuta las acciones, entra al nodo de `goto` (o se queda en el mismo si no
  hay) y manda el `DialogOpen` nuevo; `close`, `travel` y `teleport` cierran con
  `DialogClose`.
- Alejarse a más de `TalkRange`, cambiar de piso o teletransportarse cierra el diálogo
  (`DialogClose`).
- **Tienda:** la acción `open_shop` manda `ShopOpen{dialog_id, npc_creature_id, money,
  offers}` y el diálogo sigue abierto; la tienda se cierra con el `DialogClose` de ese
  diálogo. Cada `ShopOffer` trae `buy_price` (lo que paga el jugador; 0 = no lo vende),
  `sell_price` (lo que recibe; 0 = no lo compra) y `owned` (unidades en sus contenedores).
- `ShopBuy` es todo o nada: dinero suficiente, capacidad y lugar en la mochila (se
  apila con lo que ya hay, y queda un lugar libre por cada moneda menor para el vuelto)
  o `shop.no_money` / `shop.no_room`. `ShopSell` toma de los
  contenedores, nunca lo equipado (`shop.not_enough`). Tras cada compra o venta: `Message`
  `shop.bought`/`shop.sold`, `PlayerStats` y un `ShopOpen` actualizado.
- **Dinero:** la suma de `worth × count` de los items `currency` que lleva (equipo y
  contenedores anidados). Pagar saca primero las monedas de menor valor y devuelve el
  vuelto; cobrar entrega la menor cantidad de monedas. Lo que no cabe en la mochila
  (`give_item`, recompensas, vuelto) cae al suelo bajo el jugador con
  `dialog.item_on_floor`.
- Las quests avisan con `Message` de sistema: `dialog.quest_started`,
  `dialog.quest_updated`, `dialog.quest_kills` (`{monster} {count}/{total}`) y
  `dialog.quest_completed`, con el parámetro `content_id` `quest` (el cliente muestra
  `quest.<id>.name`).

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
| `SpellCooldown` | Cooldown propio y de grupo de un hechizo lanzado (T1.9) |
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

Reglas del área de interés (T1.4):
- El área es de 17x13 casillas centrada en el jugador: las 15x11 visibles más 1 de
  margen por lado. `MapArea.x/y` es la esquina superior izquierda; cerca del borde del
  mundo (coordenada 0) el área se recorta y `width`/`height` lo dicen.
- **Pisos:** en la superficie o arriba (z ≤ 7) se mandan los pisos 0–7; bajo tierra solo
  el piso actual. Un piso sin ninguna casilla en el área no se manda. Las criaturas se
  ven con la misma regla, así que "A ve a B" es simétrico.
- Tile = suelo y luego la pila de items de `world.bin`, de abajo arriba, y encima los
  items del servidor (T1.8) con su `count` si son apilables (0 en los demás).
- **Paso ortogonal:** un `MapSlice` con la columna (13 de alto) o la fila (17 de ancho) nueva. **Paso
  diagonal:** dos `MapSlice`, primero la columna completa (13) y después la fila sin la
  esquina (16).
- `MapArea.creatures` de un `MapSlice` trae las criaturas que entran a la vista por ese
  movimiento propio; las que salen llegan como `CreatureDisappear`. Cuando otra
  criatura se mueve: si el cliente la conocía y la sigue viendo → `CreatureMove`; si
  deja de verla → `CreatureDisappear`; si entra a la vista → `CreatureAppear`.
- `FullMapView` (al entrar o teletransportarse) reemplaza todo lo que el cliente
  conocía: antes van `CreatureDisappear` de lo que ya no está.

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
- Tamaño máximo de mensaje entrante: 4 KB (más grande → cierre WebSocket 1009). Saliente:
  sin límite fijo, pero `FullMapView` se comprime con la paleta y suele quedar < 20 KB.
- Frames de texto o protobuf inválido después del `Hello` → `Disconnect{KICKED}`.
- Rate limit: 30 comandos/s por conexión (ráfaga 60). Un mensaje sin ficha se descarta
  y suma deuda; la deuda se paga con la misma recarga. Con más de 30 de deuda →
  `Disconnect{RATE_LIMITED}`. Así solo desconecta el exceso **sostenido**: a 40/s, tras
  ~9 s; a 30/s, nunca.
- Cola de salida por sesión acotada (128 batches ≈ 6,4 s de ticks): si un cliente lento
  la llena, el servidor lo saca del mundo, lo guarda y cierra con
  `Disconnect{SLOW_CLIENT}` (sin mandarle los batches pendientes) en vez de consumir
  memoria.
- Orígenes del navegador: por defecto solo el mismo host; otros (servidor de Vite,
  Tauri) con `-ws-origins` o `RPG_WS_ORIGINS` (lista separada por comas). Un patrón con
  `://` se compara con `esquema://host`: el cliente de escritorio usa
  `tauri://localhost,http://tauri.localhost` (default del compose de producción).

## Presupuesto de ancho de banda
Objetivo: < 4 KB/s promedio por jugador en zona concurrida. Con 100 jugadores ≈ 400 KB/s
de salida, cómodo para una instancia chica.
