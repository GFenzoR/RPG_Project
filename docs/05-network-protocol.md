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
- `ItemLocation`: `oneof` de `pos` (tile), `slot` (`EquipmentSlot`), `container`
  (`ContainerSlot {container_id, index}`; `container_id` lo asigna el servidor en
  `ContainerOpen` y vale solo durante la sesión) o `pocket` (campo 4, el lote 13: un
  bolsillo del personaje, su índice en `Inventory.pockets`; docs/02 "Bolsillos"). Como
  `oneof`, `pocket = 0` se distingue de no tenerlo.
- `ActionTarget`: `oneof` de `pos` o `creature_id`.
- `ItemStack {item_id, count, mods}`: `item_id` es el ID estable de `data/ids.lock.yaml`;
  `mods` (`ItemMods`) son los datos propios de la instancia, sin poner en un item común.
- `ItemMods {attribute, value, refine}` (docs/02 "Atributos de items"): el único atributo
  que tiró un equipable (`attribute` = id de `data/attributes.yaml`, `value` su cantidad;
  el cliente muestra el `text` del atributo con `{value}`) y su nivel de refinado de la
  forja (`refine`, 0 = sin refinar). Viaja en todo `ItemStack` de una instancia: equipo
  (`Inventory`), contenedores (`ContainerOpen`/`ContainerUpdate`), el suelo (`Tile`, en
  `TileUpdate` y en la `palette` de un `MapArea`), el intercambio, el buzón del mercado y los cadáveres. Un item con `mods` nunca se apila. Un
  cliente que no conoce el atributo no muestra su línea. Es un campo aditivo: un cliente
  viejo lo ignora.
- **Restos** (2026-11-23, aditivo): `ItemMods.remains_of` (4) es el id de `data/monsters`
  del monstruo cuyos restos son, y `ItemMods.body_of` (5) el nombre del jugador cuyo
  cuerpo es. Los pone el servidor al crear los restos (`session/combat.go`, `death.go`) y
  viajan en todo `ItemStack` de ellos: el `TileUpdate` de su casilla, el parámetro `item`
  de `look.container` y la ventana del botín. `ContainerOpen.mods` (6, aditivo) son los
  `mods` del contenedor mismo, para el título de su ventana. El cliente nombra los restos
  `client.item.remains_of` con `monster.<id>.name` ("restos de lobo", "wolf remains") o
  `client.item.body_of` con el nombre ("cuerpo de Ana") y dibuja el cadáver propio del
  monstruo (`corpses/<id>`, docs/17 "Cadáveres"). El servidor no los toma del cliente:
  como el resto de `mods`, el cliente solo los devuelve como parte del item que nombra.
  Los restos nunca se guardan, así que tampoco estos campos. Un cliente viejo los ignora
  y sigue mostrando el nombre y el sprite de la familia.
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
5. Servidor → Welcome {creature_id, server_time, tick_ms, max_queued_steps, view_width, view_height, attack_events, options} + FullMapView + Stats + Inventory + Skills + QuestLog
```
Versión de cliente incompatible → `Disconnect{reason: OUTDATED_CLIENT}`.

Detalles (T1.4, `server/internal/net/gateway`):
- **`session_token`** es de un solo uso: el servidor lo borra al canjearlo en el `Hello`
  (tabla `sessions`, `kind = 'play'`). Reconectar exige otro `POST /api/play`.
- **Hello:** debe ser el primer frame y llegar en 5 s; si no, el servidor cierra.
  Primer frame que no es `Hello`, token inválido, vencido o ya usado, o personaje que
  ya no existe → `Disconnect{INVALID_SESSION}` y cierre. Un token que no tiene la forma
  de uno real (exactamente 43 caracteres base64url, 32 bytes sin relleno) se rechaza igual
  sin llegar a la base. Un error de la base durante el handshake →
  `Disconnect{UNSPECIFIED}` (el token ya se gastó: pedir otro).
- **Servidor lleno:** si ya hay `-max-players` conexiones con jugador (o logins con el
  token ya canjeado), o todos los turnos de la base del handshake siguen ocupados después
  de esperar el `Hello` (5 s), → `Disconnect{SERVER_FULL}` antes de canjear el token (no
  se gasta). También si otro login tomó el último lugar mientras se canjeaba este token, o
  si la cola de logins del loop está llena (en esos dos casos el token ya se gastó). Límites
  en "Límites".
- **Personajes por cuenta:** una cuenta tiene como mucho `-max-chars-per-account` (2)
  personajes en el mundo a la vez, contando los link-dead; uno más →
  `Disconnect{TOO_MANY_CHARACTERS}`. Entrar con uno que ya está en el mundo no cuenta como
  otro: lo retoma ("Entrar dos veces").
- **Versión:** `client_version` es `MAJOR.MINOR.PATCH` (se ignora un sufijo `-dev` o
  `+build`). Se acepta si tiene la misma versión mayor que la mínima del servidor
  (`-min-client-version`, por defecto `0.1.0`) y no es más vieja. La versión se revisa
  antes del token, así un cliente viejo no gasta su token.
- **Welcome** va en el primer `ServerBatch` seguido de `FullMapView`, `PlayerStats`,
  `Inventory` (equipo guardado, T1.8), `PlayerSkills` (todas las skills de
  `balance.yaml → skills.base`, con el nivel guardado del personaje) y `QuestLog` (el
  diario de misiones, "Diario de misiones").
  `view_width`/`view_height` (31 y 21) son la ventana de casillas que el servidor le
  mantiene al día, sin el margen (ver "Formato de mapa"): el cliente dibuja como mucho
  eso. Un servidor anterior a la vista ancha no los manda (0): el cliente toma 15x11.
  `attack_events` (A9) dice que el servidor manda `CreatureAttack` y el motivo de cada
  `CreatureDisappear` ("Quién ataca y por qué sale una criatura"); un servidor anterior
  no lo manda (`false`) y el cliente lo deduce de efectos, proyectiles y barras de vida.
- **Posición inicial:** la guardada; si el personaje nunca jugó (o su casilla dejó de
  ser caminable) el templo de su isla (`town`, o la primera isla del mundo). Si está
  ocupada, la casilla libre más cercana (hasta 3 de distancia).
- **Entrar dos veces:** si el personaje ya está en el mundo, la conexión vieja recibe
  `Disconnect{LOGGED_IN_ELSEWHERE}` y la nueva sigue con el estado en memoria.
- **Logout:** `Disconnect{LOGGED_OUT}` y cierre; se guarda el personaje. En combate
  (`travel.combat_block_ms` desde la última vez que un monstruo lo atacó, que recibió daño
  o que le pegó a un monstruo o a un jugador, o el bloqueo PvP; docs/02 "Bloqueo de logout
  en combate") se rechaza con un mensaje de sistema, `combat.logout_locked` (o
  `pvp.logout_locked` con el bloqueo PvP) con el parámetro numérico `seconds` (lo que falta
  del bloqueo, redondeado hacia arriba, al menos 1; desde el 2026-11-24, aditivo), y la
  conexión sigue. El cliente no espera al rechazo para mostrar el bloqueo: lo lee del
  estado `in_combat` ("Estados", abajo), que ya trae su fin en `remaining_ms`; no hace falta
  un campo nuevo. Cerrar el socket sin
  `Logout` también saca al personaje y lo guarda, salvo en combate: queda en el mundo
  link-dead hasta que la pelea termina ("Desconexión en combate", abajo). Una casilla sin
  logout todavía no rechaza el `Logout` (solo la miran la inactividad y los chequeos de
  presencia).
- **Desconexión en combate:** si la conexión se cierra en combate (la cierra el cliente,
  se cae la red o la corta el servidor: cliente lento, flood, reseteo o cambio de
  contraseña, "Cerrar sesión en todos lados"), el
  personaje no sale del mundo: queda sin conexión (no recibe nada; lo que esa conexión
  haya mandado después no se ejecuta) y atacable hasta que la pelea termina; ahí se guarda
  y sale (quien lo veía recibe `CreatureDisappear{LOGOUT}`). Si muere así, sale en ese
  momento, ya en el templo. Un login de ese personaje en ese tiempo lo retoma como un
  relogueo normal (`Welcome` y vista completa, mismo estado y misma pelea); no hay mensaje
  nuevo ni rechazo. Reglas en `02-game-design.md`, "Bloqueo de logout en combate".
- **Apagado:** el servidor guarda a todos y manda `Disconnect{SERVER_SHUTDOWN}`.
- **Moderación (T2.6):** un GM expulsa con `Disconnect{KICKED}` y banea con
  `Disconnect{BANNED}`. El token de juego de una cuenta baneada no se canjea
  (`INVALID_SESSION`), y si el ban llega mientras un login leía la base, el `Join` se
  rechaza con `BANNED`.
- **Inactividad (T4.1):** sin acciones reales durante `balance.yaml` `idle.kick_after_ms`
  → `Message` de sistema `idle.warning` (`seconds`) `idle.warn_before_ms` antes y después
  `Disconnect{IDLE}`, con el personaje guardado. Cuenta lo que el servidor acepta y hace:
  un paso dado, un objetivo elegido, un hechizo o runa lanzado, un item movido o usado, un
  chat dicho, un diálogo abierto o una opción elegida, una compra o venta, un intento de
  recolección o de oficio. `Ping`, `Turn`, `LookAt`, `SetFightMode`, `StopWalk`,
  `CloseContainer`, `ReportPlayer`, `TutorialSkip` y cualquier intención rechazada no. Nunca en combate
  (`travel.combat_block_ms`) ni sobre una casilla sin logout: se reintenta cada segundo.

## API HTTP (cuentas, personajes y sitio público)
Implementada en `server/internal/httpapi` (T1.3). JSON en ambos sentidos; los `POST` con
cuerpo exigen `Content-Type: application/json` (también frena formularios cross-site),
cuerpo máximo 4 KiB, campos desconocidos rechazados. Respuestas con `Cache-Control: no-store`.

| Método y ruta | Auth | Cuerpo | Respuesta OK |
|---|---|---|---|
| `POST /api/auth/register` | — | `{email, password}` | `201 {account_id}` |
| `POST /api/auth/login` | — | `{email, password, token_in_body?}` | `200 {expires_at, token?}` + cookie |
| `POST /api/auth/logout` | token | — | `204`, revoca el token y borra la cookie |
| `POST /api/auth/logout-all` | token | — | `204` (lote 17): revoca **todas** las sesiones de la cuenta (navegadores, app de escritorio y tokens de juego sin canjear), borra la cookie y saca del juego a sus personajes conectados (`Disconnect{SIGNED_OUT_EVERYWHERE}`) |
| `POST /api/auth/keepalive` | token | — | `204` (lote 17): latido del cliente mientras juega, para que la sesión no venza por inactividad |
| `POST /api/account/password` | token | `{current_password, new_password}` | `204` (lote 17): cambia la contraseña; revoca las **demás** sesiones (la de este pedido sigue), los enlaces de reset pendientes y saca del juego a los personajes conectados (`PASSWORD_CHANGED`), también los de la propia sesión: a propósito, la contraseña cambió para toda la cuenta y el jugador vuelve a entrar desde la lista de personajes. `401 invalid_credentials` (contraseña actual mal, cuenta como login fallido), `403 reauth_required`, `400 invalid_password`, `429` |
| `GET /api/characters` | token | — | `200 {characters: [{id, name, vocation, level, look?}], max_characters}` (2026-11-23: `look` es el aspecto guardado, `{sex, body, skin, hair, hair_color, beard}`, ausente mientras el juego no le eligió uno; `max_characters` es el tope por cuenta, con el que la pantalla de personajes deshabilita "Crear personaje nuevo") |
| `POST /api/characters` | token | `{name, vocation, look?}` | `201 {character: {id, name, vocation, level}}` |
| `POST /api/play` | token | `{character_id}` | `200 {session_token, expires_at}` (vive 60 s, un uso) |
| `GET /api/account/options` | token | — | `200 {options}`: las opciones de interfaz de la cuenta ("Opciones de la cuenta", abajo); `{"v":1}` si nunca guardó |
| `POST /api/account/options` | token | el documento | `204`; `400 bad_request` (no pasa el esquema), `413 too_large` (más de 16 KiB), `415`, `429` |
| `GET /healthz` | — | — | `200 {status: "ok"}` / `503` si Postgres no responde (el ping se guarda 1 s contado desde que termina, y los pedidos que llegan durante un ping esperan ese mismo resultado: muchos pedidos cuestan un ping por segundo aunque la base esté lenta) |
| `GET /api/status` | — | — | `200 {online, players, version}` (T4.3, público) |
| `GET /api/highscores?category=&vocation=&page=` | — | — | `200 {category, vocation, page, page_size, has_more, entries: [{rank, name, vocation, value}]}` (T4.3, público) |
| `POST /api/maps/submissions` y demás `/api/maps/...` | token | ver "Envío de mapas" | T4.5 |
| `GET /api/auth/config` | — | — | `200 {email}`: si el servidor manda emails (T2.1) |
| `GET /api/account` | token | — | `200 {email, email_verified, email_enabled}` |
| `POST /api/auth/verify` | — | `{token}` | `204`; `400 invalid_token` |
| `POST /api/auth/verify/resend` | token | `{lang?}` | `202`; `409 already_verified`, `404 email_disabled`, `429` |
| `POST /api/auth/password/forgot` | — | `{email, lang?}` | `202` siempre (exista o no la cuenta); `404 email_disabled`. A una dirección nunca verificada le llega un enlace que la verifica y cambia la contraseña (abajo) |
| `POST /api/auth/password/reset` | — | `{token, password}` | `204`, revoca todas las sesiones y borra la cookie; `400 invalid_token` / `invalid_password` |

`POST /api/characters` acepta `look` (docs/02 "Apariencia", lote 13): `{sex, body, skin, hair,
hair_color, beard}` (`sex`, `male` o `female`, desde el 2026-11-20; sin él el look no es válido), ids de `data/looks.yaml` que un jugador puede elegir (nunca una piel
`creatures_only`); uno que no lo es responde `400 invalid_look`. Sin `look` (bots,
clientes viejos, los E2E que crean por la API) el personaje queda sin aspecto guardado y
el juego le da el que sale de su id al entrar ("Apariencia y equipo visible").
Un servidor sin `data/looks.yaml` ignora el `look` (crea el personaje sin aspecto
guardado). Si el contenido del cliente sí trae `lookOptions`, la pantalla de creación
muestra los selectores pero lo elegido se pierde: es una configuración inconsistente
(servidor y cliente deben usar el mismo `data/`), no un caso que el juego cubra.

### Opciones de la cuenta (`httpapi/options.go`, `server/internal/accountopts`)
Pedido del dueño del 2026-11-26: "todas las opciones que selecciona el jugador se deben
guardar". Las opciones de **interfaz** viven en un documento JSON por cuenta (tabla
`account_options`, migración 00029), así siguen al jugador a otro navegador o dispositivo.
Las opciones de **juego** de cada personaje van por el protocolo del juego ("Opciones
guardadas", más abajo). La tabla de qué se guarda dónde está en
`14-continuar-en-tu-pc.md` ("Opciones guardadas").

- `GET` devuelve el documento de la cuenta de la sesión; `POST` lo reemplaza entero. No hay
  id de cuenta en el pedido: sale de la sesión (`authed`), nunca del cliente. Es `POST` y no
  `PUT` porque el puente de la app de escritorio solo deja pasar `GET` y `POST`.
- **Esquema cerrado, versión 1** (`accountopts.Doc`): una clave desconocida en cualquier
  nivel, un tipo equivocado, un valor fuera de su enum o rango, datos después del
  documento o más de 16 KiB (`accountopts.MaxBytes`) lo rechazan entero. No hay texto
  libre: cada cadena es un enum, un id (`[a-z0-9_.-]`, hasta 64) o un nombre de personaje
  (letras, espacios, `'` y `-`, hasta 32).

  | Campo | Valor |
  |---|---|
  | `v` | `1` (obligatorio) |
  | `lang` | código de idioma (`es`, `en`) |
  | `audio` | `{volume: {master, music, sfx, ui, ambient}, muted: {…}}`, volúmenes 0..1 |
  | `controls` | `menu` \| `classic` |
  | `reduced_motion`, `camera_shake`, `chat_bubbles` | booleanos |
  | `ui_scale`, `text_scale` | 0,5..2 |
  | `name_size` | `normal` \| `large` |
  | `chat_opacity` | entero 0..100 |
  | `hotkeys` | `{<vocación>: [hasta 12 ids de hechizo o null]}`, hasta 16 vocaciones |
  | `track` | `{<personaje>: <id de quest>}`, hasta 32 |
  | `devices` | `{desktop?, touch?}`, cada uno `{touch_pad, zoom (1..32), minimap {open, scale}, windows}` |

  `windows` es el formato v3 de `client/src/ui/windows.ts` (`{v: 3, z, win, others}`, hasta
  64 ventanas por mapa, cada lugar `{open?, collapsed?, x?, y?, w?, h?}` con enteros de
  ±100000).
- **Por clase de dispositivo** (decisión de este lote): lo que solo tiene sentido en un tipo
  de pantalla (lugares y tamaños de ventanas en píxeles, zoom del mapa, minimapa, pad
  táctil) se guarda una vez para `desktop` (puntero fino) y otra para `touch` (teléfono o
  tablet, puntero grueso). Lo demás es de la cuenta.
- **Lo guardado nunca son los bytes del cliente:** el servidor decodifica, valida y vuelve a
  codificar en forma canónica (`Doc.Canonical`); la tabla además limita el tamaño. Un
  documento guardado que el servidor ya no acepta se lee como vacío.
- **Límites:** sesión obligatoria; `Content-Type: application/json` (frena formularios
  cross-site, como el resto de la API); 20 guardados de ráfaga y uno cada 3 s por cuenta
  (`DefaultOptionsRateLimit`, `429` con `Retry-After`), aparte del límite por cuenta de
  `authed`.
- **Cliente** (`client/src/state/saved-options.ts`, `option-storage.ts`): `localStorage`
  sigue siendo el caché que lee cada pantalla, y lo único que hay antes del login. Al
  entrar a la lista de personajes: **el servidor gana y lo local rellena lo que al servidor
  le falta** (los mapas se mezclan clave por clave; un layout de ventanas es un solo valor),
  y si el resultado difiere de lo guardado, se manda. Una excepción: lo que el jugador
  eligió en esa misma página antes de entrar (el idioma o el volumen en la pantalla de
  login) es su elección más nueva y gana. Después, cada cambio se manda 2 s después del
  último (`SAVE_DELAY_MS`), conservando las secciones de las otras clases de dispositivo.
  Al salir de la cuenta deja de mandar. Dos dispositivos abiertos a la vez: gana el último
  que guarda (documento entero), aceptado así.

`POST /api/auth/register` acepta además `lang` (idioma del email de verificación). El
cliente solo lo manda si `GET /api/auth/config` dice `email: true`: los servidores
anteriores a T2.1 rechazan campos desconocidos (la app de escritorio puede hablar con uno).

### Verificación de email y reset de contraseña (T2.1, `httpapi/email.go`)
- Solo funcionan con emails activados (SMTP, o `-mail log` en desarrollo;
  `GET /api/auth/config` → `{"email": true}`); si no, las rutas de envío responden
  `404 email_disabled` y el cliente no las ofrece. `-require-verified-email` exige SMTP real.
- "Revoca todas las sesiones" incluye las conexiones abiertas: el reset borra los tokens
  guardados (cuenta y juego) y después el `app` encola `World.KickAccount`, que desconecta
  a **todos** los personajes conectados de la cuenta con `Disconnect{PASSWORD_CHANGED}`
  (se guardan como en un logout). Un personaje en combate (el bloqueo PvP o
  `travel.combat_block_ms` desde su última pelea) pierde la conexión igual, pero queda en
  el mundo link-dead hasta que la pelea termina (02-game-design.md, "Bloqueo de logout en
  combate"). Vale igual para un enlace de `gameserver admin reset-link`.
- Un login que ya canjeó su token de juego cuando la revocación se confirma (todavía va
  de camino al `Join`, así que la expulsión no lo encuentra) se rechaza en el `Join` con
  el mismo motivo (`PASSWORD_CHANGED` o `SIGNED_OUT_EVERYWHERE`): el gateway anota cuándo
  empezó el canje (`Character.RedeemedAt`) y el loop recuerda por cuenta la última
  revocación durante `session.RevocationMemory` (5 min).
  Ventana residual: un token de juego canjeado justo antes del reset cuyo `Hello` llegue al
  loop después del kick (milisegundos) entra igual; no puede volver a entrar después.
- Canjear un reset exige que la cuenta siga habilitada y con el email al que se mandó.
- **Dirección nunca verificada (lote 16):** cualquiera puede registrar una cuenta con un
  email ajeno sin verificarlo. Para que el dueño del buzón la recupere aunque el enlace de
  verificación de 24 h haya vencido, `forgot` también le manda el email de reset a una
  dirección nunca verificada: el enlace (misma página `/reset-password`, vence en 1 h) es un
  token `claim_email` (propósito propio: pedirlo no invalida el enlace de verificación del
  registro, y reenviar la verificación no invalida este; y no sirve en `/verify`).
  Canjearlo en `POST /api/auth/password/reset` prueba el buzón:
  verifica la dirección (con su fila `email_verified` en `audit_log`) y hace el reset de
  siempre en la misma transacción (cambia la contraseña, revoca todas las sesiones y borra
  las identidades vinculadas que no probaron ese email). Así el dueño del buzón se queda
  con la cuenta sin la contraseña de quien la registró. El enlace de verificación del
  registro no sirve en esa página: solo verifica.
  Mismo `202` uniforme y mismos límites por dirección y por IP.
- La cola de emails no se traba con una dirección que falla: cada reintento espera fuera
  de la goroutine de envío (30 s, 2 min, 10 min) y después se descarta.
- Al registrarse se manda el email de verificación (si falla la cola, el registro igual
  vale: se puede reenviar). Los enlaces son `PUBLIC_URL/verify?lang=xx#token=…` y
  `PUBLIC_URL/reset-password?lang=xx#token=…`; `PUBLIC_URL` es configuración, nunca el
  header `Host`. El token (43 caracteres base64url) viaja en el fragmento y la página lo
  manda en el cuerpo del `POST`; un token en la query se ignora.
- El idioma del email es el de la cuenta (`accounts.locale`, se guarda el del primer pedido
  con un idioma válido); si no hay, el del pedido; si no, `es`.
- `forgot` responde `202` sin cuerpo exista o no la cuenta, esté verificada o no, y aunque
  la dirección haya pasado su límite. La búsqueda y el email corren en segundo plano (como
  mucho 8 a la vez; el resto se descarta), así que ni el tiempo de respuesta depende de la
  cuenta. Un email mal formado sí da `400 invalid_email` (no dice nada de cuentas).
- Rate limits: `forgot`, `reset` y `verify` gastan el límite por IP de registro y login
  (10 de ráfaga, 1 cada 6 s). Emails de reset por dirección: 3, luego 1 cada 20 min (en
  silencio). Emails de verificación por cuenta: 3, luego 1 cada 10 min (`429`); el del
  registro cuenta.
- Errores: `invalid_token` (desconocido, usado, vencido o reemplazado), `email_unverified`
  (portal de mapas o, con `-require-verified-email`, `POST /api/play`), `already_verified`,
  `email_disabled`.

### OAuth con Google y Discord (T2.1, `httpapi/oauth.go`)
| Método y ruta | Auth | Cuerpo | Respuesta OK |
|---|---|---|---|
| `GET /api/auth/config` | — | — | `{email, providers: ["discord","google"], public_url, shop?}` (solo los que tienen claves; nunca secretos). En otra dirección que `public_url` el cliente esconde los botones. `shop: true` (T5.7) solo si la tienda tiene proveedor de pagos: el sitio enlaza `/shop` |
| `POST /api/auth/oauth/{provider}/start` | — | `{return?}` | `200 {url}` + cookie `rpg_oauth`; el navegador va a `url` |
| `POST /api/auth/oauth/{provider}/link` | token | `{password?}` | igual que `start`, para vincular a la cuenta |
| `GET /api/auth/oauth/{provider}/callback` | cookie `rpg_oauth` | — | `303` a una página fija del sitio (abajo) |
| `GET /api/auth/oauth/pending` | cookie `rpg_oauth_pending` | — | `200 {provider, email}`; `410 pending_expired` |
| `POST /api/auth/oauth/pending/confirm` | cookie pendiente | `{password}` | `200 {return}` + cookie de sesión |
| `POST /api/auth/oauth/pending/create` | cookie pendiente | `{email}` | `200 {return}` + cookie de sesión |
| `POST /api/account/unlink` | token | `{provider, password?}` | `204`; `403 reauth_required`, `401 invalid_credentials`, `409 last_login_method`, `404 not_linked` |

`GET /api/account` suma `has_password` e `identities: [{provider, email, linked_at}]`. La
página muestra el aviso de `?linked=` solo si es un proveedor conocido que la cuenta tiene
vinculado, y después lo saca de la URL.

- **Inicio:** un `POST` con JSON (ningún formulario de otro sitio puede iniciar un login en
  el navegador de otro). El servidor guarda en `oauth_states` el SHA-256 del `state`, el
  verificador PKCE, el `nonce` (Google), el modo (`login`/`link`), la ruta de vuelta y el
  SHA-256 de un valor aleatorio que va en la cookie `rpg_oauth` (`HttpOnly`, `Secure` con
  HTTPS, `SameSite=Lax` para volver en la redirección del proveedor, `Path=/api/auth/oauth`,
  10 min). `redirect_uri` = `PUBLIC_URL/api/auth/oauth/{provider}/callback`, siempre de la
  configuración, nunca del header `Host`.
- **Callback:** consume el `state` primero (un solo uso aunque falle después), exige la
  cookie del mismo navegador (comparación en tiempo constante) y el mismo proveedor, y
  canjea el `code` con el verificador. Google: el `id_token` se verifica con las JWKS
  (cache de 1 h, se vuelve a pedir ante un `kid` desconocido como mucho una vez por
  minuto), `iss`, `aud` = client id, `exp`/`iat` (±2 min) y `nonce`. Discord:
  `GET /users/@me` (`id`, `email`, `verified`).
- **Destinos:** login → la ruta de vuelta si está en la lista cerrada (`/`, `/play/`,
  `/account`, `/maps/submit`, `/maps/mine`; cualquier otra → `/play/`); vínculo →
  `/account?linked=<proveedor>`; email de una cuenta existente → `/oauth/confirm` (cookie
  `rpg_oauth_pending`, `SameSite=Strict`, 15 min); error → `/oauth/error?code=` con
  `state`, `denied`, `provider`, `no_email`, `identity_taken`, `provider_linked`,
  `unknown_provider`, `account_disabled`, `account_banned`, `email_taken`, `busy` o
  `internal`.
- **Confirmar con contraseña:** mismos límites de login fallido por (email, IP) y por email
  que `/api/auth/login`, y el mismo error `invalid_credentials`. El pendiente se consume en
  la misma transacción que crea el vínculo: dos confirmaciones del mismo token no vinculan
  dos veces (la segunda recibe `pending_expired`), y un vínculo fallido no lo consume.
- Un vínculo en curso queda atado a la sesión que pasó la re-autenticación
  (`oauth_states.session_hash`): si esa sesión ya no está activa al volver (logout, reset
  de contraseña, ban, cambio de rol), el callback termina en `code=state` y no vincula
  nada. El reset, el ban y el cambio de rol borran además los vínculos en curso.
- Una cuenta nueva cuyo email el proveedor no verificó (o el que se escribió en
  `/oauth/confirm`) recibe el email de verificación, igual que un registro con contraseña.
- **Vincular** exige re-autenticarse: `password` si la cuenta tiene (`403 reauth_required`
  si falta, `401 invalid_credentials` si no coincide, bajo los mismos límites de login
  fallido por email), o una sesión creada hace menos de 10 min si no tiene.
- **Desvincular** (lote 16) exige la misma re-autenticación que vincular, con los mismos
  errores: si no, con una sesión robada de una cuenta sin contraseña se podía vincular el
  proveedor del ladrón y después desvincular el del dueño. "Mi cuenta" muestra el campo
  de la contraseña cuando hay algo que vincular o desvincular.
- `GET /api/auth/oauth/pending` dice también `has_password`: sin contraseña la página no la
  pide (se vincula desde "Mi cuenta" entrando con el otro proveedor).
- Todas estas rutas gastan el límite por IP y por red de registro y login, salvo `pending`
  (gasta el de búsquedas de token por cliente). `link`, `pending/confirm` y `unlink`
  calculan contraseñas: como mucho dos a la vez por red ("Límites de la API").
- Los secretos de cliente salen solo de variables de entorno y no se registran nunca; los
  errores del proveedor se registran por su tipo (estado HTTP, chequeo fallido), nunca con
  un `code` o un token.

### Endpoints públicos del sitio (T4.3, `httpapi/public.go`)
Los usa la landing (`/`, `/highscores`). No piden cuenta, y comparten un rate limit por IP
propio (`DefaultPublicRateLimit`: ráfaga de 30, uno cada 500 ms; `/64` en IPv6, como el de
auth). Pasado el límite responden `429 rate_limited`.

- **`GET /api/status`:** `online` es si el game loop está corriendo, `players` los jugadores
  en el mundo y `version` la del build del servidor (`buildinfo.Version`). No toca Postgres
  ni el mundo: lee un `atomic` que el game loop actualiza cuando alguien entra o sale
  (`session.World.PublishedOnline`).
- **`GET /api/highscores`:** `category` = `level` (por defecto) o un id de skill de
  `data/balance.yaml` (`skills.base`); `vocation` = un id de `data/vocations.yaml` o vacío
  (todas); `page` = 1…50, de 20 filas (top 1000). Un valor inválido responde `400`
  `invalid_category`, `invalid_vocation` o `invalid_page`. Solo devuelve nombre, vocación,
  valor (nivel o nivel de la skill) y posición. Excluye cuentas de staff (`gm`, `admin`),
  deshabilitadas o con un ban activo (permanente o temporal); un ban levantado o vencido
  vuelve a contar. No hay borrado de personajes todavía: cuando exista, la query debe
  filtrarlos. Empates: más experiencia (nivel) o más tries (skill), y luego el personaje más
  antiguo. Un personaje sin fila de esa skill está en su nivel base.
- **Cache:** cada combinación `category × vocation × page` se sirve 60 s desde memoria
  (`DefaultHighscoreCacheTTL`, reloj inyectable). Si varias peticiones llegan con la cache
  vacía, solo la primera consulta Postgres y las demás esperan su resultado. Los errores no
  se guardan. La respuesta lleva `Cache-Control: public, max-age=30`. La cache guarda como
  mucho una entrada por clave válida, y el TTL cuenta desde que termina la consulta.
- **Presupuesto de Postgres:** el pool es el mismo que usan los guardados del juego, así que
  el ranking corre como mucho 2 consultas a la vez (claves distintas). Cada una tiene 5 s
  en total para conseguir su turno y terminar; si no consigue turno, o la consulta pasa el
  plazo, responde `503 busy` (y queda un warning en el log, no un error). Las consultas
  leen índices y no ordenan todos los personajes (costos en docs/07). En un ranking de
  skill, los personajes con fila de la skill van antes que los que siguen en el nivel base
  sin fila; uno con fila en el nivel base y 0 tries empata con ellos y va primero. Quien
  espera la consulta de otra petición deja de esperar si su cliente se va.

- **`GET /api/guilds`** (T5.1, `httpapi/guilds.go`): `{guilds: [{id, name, leader,
  members, created_at}]}`, hasta 500 por nombre. **`GET /api/guilds/{id}`**: `{id, name,
  created_at, members: [{name, vocation, level, rank}]}` (`rank` = `leader`, `vice` o
  `member`, de mayor a menor); un id que no existe → `404 not_found`, uno inválido →
  `400 invalid_id`. Solo datos públicos: ni el mensaje del día, ni quién está en línea, ni
  nada de las cuentas. Excluye, como el ranking, a los personajes de staff y de cuentas
  deshabilitadas o con un ban activo (no aparecen ni cuentan en `members`; un líder así
  sale como `""`). Comparten el rate limit público, las 2 consultas a la vez y el plazo
  del ranking. Caches de 60 s: la lista tiene una propia (ninguna otra clave la saca), y
  al leerla se guarda el id más alto emitido alguna vez (`guild_id_high`). Un id mayor
  responde 404 sin consultar Postgres; las páginas de gremios que existen van a otra
  cache, y los 404 de gremios disueltos a una tercera, chica. Así ids al azar no llenan
  la cache ni llegan a Postgres. Un cambio del juego, o un gremio nuevo, se ve como mucho
  60 s después.

- **Token de cuenta:** opaco (32 bytes aleatorios, base64url). En la base se guarda solo
  su SHA-256 (tabla `sessions`, `kind = 'account'`). **El juego nunca guarda el login
  (lote 17, decisión del dueño 2026-11-23):** la sesión dura como mucho **12 h**
  (`expires_at`, absoluto) y vence antes tras **30 min sin actividad autenticada**
  (`last_seen_at`; cada pedido con sesión lo refresca, como mucho una vez por minuto para
  no escribir en la base por pedido). Una sesión inactiva se rechaza (`401
  unauthorized`) y se borra en el acto; el job de limpieza borra las vencidas y las
  inactivas. La cookie es **de sesión del navegador** (sin `Expires` ni `Max-Age`):
  recargar la página dentro del mismo navegador conserva el login y, normalmente, cerrar
  el navegador lo olvida. No siempre: Chrome/Edge con "continuar donde lo dejaste" y las
  PWA instaladas restauran las cookies de sesión al reabrir; en ese caso solo lo acotan
  los 30 min de inactividad y el tope de 12 h. La migración 00026 borró las sesiones de 30 días anteriores (todos entran de
  nuevo una vez). Se envía como
  `Authorization: Bearer <token>` (Tauri, herramientas, bots) o en la cookie
  `rpg_session` (`HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/api`) que pone el login
  para el cliente web. Si hay un `Authorization: Bearer` (el esquema no distingue
  mayúsculas), manda ese token; cualquier otro esquema (p. ej. `Basic` de un staging con
  contraseña) se ignora y se usa la cookie. El token solo
  viene en el cuerpo del login si se pide `token_in_body: true` (Tauri, bots): el cliente
  web no lo pide, así un XSS no puede leerlo de la respuesta. En la app de escritorio lo
  pide el lado Rust, que lo guarda **solo en memoria** mientras la app está abierta y lo
  quita de la respuesta antes de pasarla al webview (`apps/desktop`, docs/12). Al arrancar,
  la app borra el token que una versión anterior hubiera dejado en el llavero del SO.
  El cliente (web y escritorio) recuerda solo el **email** del último login **con
  contraseña** (`localStorage` `rpg.lastEmail`) para rellenar el formulario; nunca el
  token. Un login con Google o Discord no lo cambia (a propósito: ese email lo decide el
  proveedor y el formulario no lo usa).
- **Sesión y juego (lote 17):** una vez canjeado el token de juego (`POST /api/play`, 60 s,
  un uso), la conexión WebSocket es independiente de la sesión HTTP: la inactividad de la
  sesión no corta una partida en curso. Para que la sesión siga viva al volver a la lista
  de personajes, el cliente manda `POST /api/auth/keepalive` cada 5 min mientras juega.
  Tras más de 12 h, o si el cliente no pudo mandar el latido, al salir del juego se pide
  la contraseña de nuevo. El portal de mapas y la página `/account` del sitio **no**
  mandan latido: más de 30 min en ellos sin ningún pedido termina en `401` al enviar
  (hay que entrar de nuevo). "Cerrar sesión en todos lados", un cambio o reset de
  contraseña y un ban sí cortan las conexiones abiertas (`World.KickAccount` /
  `SignOutAccount`, por el loop, guardando a los personajes como en un logout).
- **Cambiar la contraseña desde el juego (lote 17):** la contraseña actual se comprueba
  bajo los mismos límites de login fallido que `/api/auth/login` (por par email+red y por
  email), así una cookie robada no adivina más rápido que un login. La nueva sigue las
  reglas del registro. Una cuenta que solo entra con Google/Discord (sin contraseña) puede
  **crear** su primera contraseña sin `current_password` si su sesión tiene menos de 10
  min (`auth.ReauthWindow`, igual que vincular un proveedor); si no, `403
  reauth_required` y el cliente le pide volver a entrar con su proveedor. Si el servidor
  manda emails, todo cambio o creación de contraseña hecho así le avisa a la cuenta
  (`email.password_changed`, con un enlace a `/forgot-password`); si el aviso no se puede
  encolar se registra y el cambio sigue hecho. En la app de escritorio, un "cerrar sesión
  en todos lados" que falla (red o error del servidor) conserva la sesión de este equipo,
  como la cookie en la web: se ve el error y se puede reintentar.
- **Reglas:** email ASCII normalizado a minúsculas; contraseña de 8 a 128 caracteres (argon2id,
  19 MiB, t=2, p=1). Nombre de personaje de 3 a 16 caracteres, 1–3 palabras de letras
  ASCII con mayúscula inicial y el resto minúsculas (`Mira`, `Old Tom`), único sin
  distinguir mayúsculas y sin suplantar al staff: se rechaza si, en minúsculas y sin
  espacios, contiene `admin`, `gamemaster`, `moderat`/`moderad`, `soporte`/`support`,
  `staff`, `tutor`, `sistema`/`system` u `oficial`/`official`, o si alguna palabra es
  `Gm`, `Cm`, `God`, `Mod` o `Dev` (como palabra completa: `Gmork` vale). Tampoco puede
  copiar a un NPC (lote 16, `reserved_name`): al arrancar, el servidor junta los nombres de
  `i18n/<idioma>/npcs.yaml` (`npc.<id>.name`) en todos los idiomas, sin lo que va después de
  la coma ("Gisla, la curtidora" → "Gisla"), y reserva el nombre entero y cada palabra con
  mayúscula de 3 letras o más ("Maren Holt", "Maren", "Holt"; "Hermana Liora" reserva
  "Liora", pero no el título "Hermana": tampoco Sister, Brother, Mother, Father, Hermano,
  Madre, Padre, Master, Maestro ni Maestra); se comparan sin mayúsculas, espacios ni
  tildes ("maren holt" también; "Tobias" choca con "Tobías").
  `Gislar` vale. **Límites conocidos (aceptados):** se compara el nombre completo del
  personaje, así que "Gisla Tanner", "Sir Maren" u "Holt Maren" pasan (no impide parecerse
  a un NPC con algo pegado); los apellidos que son palabras comunes quedan reservados solos
  ("Moss", "Musgo", "Vado", "Ensayo", "Muestra", "Roe", "Pike"); y los personajes creados
  antes de la reserva con nombre de NPC no se tocan. La vocación debe
  existir en `data/vocations.yaml`. Máximo 10 personajes por cuenta. El personaje nace en
  nivel 1 con la vida y el maná iniciales de su vocación y sin posición: el servidor lo
  ubica en el templo de su ciudad al primer login (T1.4).
- **Rate limit** → `429 rate_limited` con `Retry-After`:
  - Por IP del cliente (IPv6: por /64): register y login comparten 10 pedidos, luego 1
    cada 6 s. Cuenta todo pedido, también los basura.
  - Login fallido por par (email, red: la IPv4 o la /48 de IPv6, porque un abonado puede
    tener una /48 entera): 5, luego 1 cada 4 min (15/h). Estricto, y un atacante desde
    otras redes no puede gastarlo por la víctima. Se recarga más lento que el límite por
    email (30/h): una sola IPv4 o una sola /48 nunca puede agotar el límite por email de
    una cuenta.
  - Login fallido por email desde cualquier IP: 30, luego 1 cada 2 min (~30/h). Laxo:
    solo frena la adivinación repartida en muchas IPs.
  - Un login con email inválido o una contraseña que el registro nunca aceptaría (fuera
    de 8–128 caracteres) responde `invalid_credentials` al instante, sin calcular hash y
    sin gastar los límites de login: así no sirve para llenar las tablas.
  - Los dos límites de login reservan una ficha **antes** de verificar la contraseña
    (así N pedidos simultáneos no pasan con una sola ficha) y la devuelven si el
    resultado no es `invalid_credentials`: solo los intentos **fallidos** cuentan y
    entrar bien nunca gasta.
  - **Dispositivo conocido (lote 16):** un login (o una confirmación de OAuth o un vínculo)
    con la contraseña correcta deja la cookie `rpg_device` (`HttpOnly`, `SameSite=Strict`,
    `Secure` con HTTPS, `Path=/api/auth`, 90 días; `unlink` no la pone, porque vive fuera
    de ese path): un HMAC del email, de una huella de la cuenta y su contraseña actual
    (`LoginStamp`: cambia con cada reset) y del vencimiento, con la clave de
    `RPG_DEVICE_KEY` (al menos 32 caracteres, p. ej. `openssl rand -hex 32`; sin ella, una
    clave al azar por proceso y un aviso en el log al arrancar), sin el email a la vista. Un navegador con la cookie
    de ese email no gasta el límite por email (sí el del par) mientras le dure su propio
    límite de fallos: 10, luego 1 cada 6 min por cookie; agotado, gasta el límite por
    email como cualquiera. Así una cookie copiada no sirve para adivinar sin tope desde
    muchas IPs, y un cambio de contraseña anula todas las cookies anteriores.
  - **Trade-off que queda:** quien conoce el email de alguien puede, sosteniendo más de
    ~30 fallos por hora desde **varias** redes (con 15/h por par hacen falta al menos 3
    IPv4 o 3 /48 de IPv6 distintas),
    agotar el límite por email; mientras siga agotado, la víctima recibe `429` desde
    cualquier navegador sin la cookie de dispositivo (uno nuevo, la app de escritorio, los
    bots). Su navegador de siempre sigue entrando. Un reinicio del servidor olvida los
    dispositivos salvo con `RPG_DEVICE_KEY` fija (docs/09, docs/13).
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
- **Límites de la API (lote 16, `httpapi/abuse.go`)**, todos `429 rate_limited` con
  `Retry-After`:
  - **Búsquedas de token por cliente** (IP o /64): las rutas con sesión, `logout` y
    `GET /api/auth/oauth/pending` gastan 60, luego 1 cada 500 ms, **antes** de buscar el
    token en Postgres. Además un token que no tiene el formato emitido (43 caracteres
    base64url) se rechaza (`401 unauthorized`, o `204` en el logout) sin consultar nada:
    tokens inventados no gastan conexiones del pool.
  - **Búsquedas de token por red** (IPv6 /48, IPv4 /24, falla cerrado): las mismas rutas
    gastan además 300, luego 1 cada 100 ms por red: una /48 tiene 65 536 /64, tantas como
    para llenar la tabla por cliente y pasar sin contar.
  - **Por cuenta**, después de autenticar: cualquier ruta con sesión, 60 y luego 1 cada
    500 ms; `POST /api/play` y `POST /api/characters` juntos, 20 y luego 1 cada 3 s (cada
    token de juego es una fila de `sessions` hasta la purga de cada hora).
  - **Por red** (IPv6 /48, IPv4 /24): register, login y las demás rutas que gastan el límite
    por IP también gastan 40, luego 1 cada 1,5 s (falla cerrado: llenar su tabla pide más
    redes de las que tiene un atacante).
  - **Cálculos de contraseña en curso por red** (IPv6 /48, IPv4 por dirección): login,
    register, `password/reset`, `oauth/.../link`, `oauth/pending/confirm` y `unlink`, como
    mucho 2 a la vez (dos personas detrás de un mismo NAT o CGNAT entran juntas); los
    demás reciben `429` en el acto (`Retry-After: 1`). Así una red no puede ocupar los 4
    cálculos del servidor.
  - **Plazos:** la búsqueda del token, la lista de personajes, crear personaje, `play`,
    `GET /api/account`, `logout`, `pending` y la búsqueda de sesión y perfil antes de
    comprobar la contraseña en `link` y `unlink` cortan su trabajo en Postgres a los 3 s.
  - **Devoluciones:** un `429` del tope de cálculos por red devuelve lo que el pedido ya
    gastó de los límites por IP y por red (quien reintenta detrás de un NAT no quema su
    ráfaga). Una creación de personaje rechazada sin escribir nada (JSON mal formado,
    `invalid_name`, `reserved_name`, `name_taken`, `invalid_vocation`, `invalid_look`,
    `character_limit`) devuelve su ficha del límite de escritura por cuenta; el límite de
    pedidos por cuenta sigue acotando a quien prueba nombres.
  - **Riesgo aceptado (CGNAT y móviles):** las operadoras reparten las /64 de muchos
    abonados dentro de una misma /48 (y muchos clientes IPv4 comparten una /24), así que
    el tope de 2 cálculos a la vez y la ráfaga de 40 por red pueden dar `429` a usuarios
    legítimos de la misma operadora en horas pico. A la escala actual el riesgo es bajo;
    en producción hay que vigilar la tasa de `429` de login y registro y subir los límites
    (`Config.AuthNetRateLimit`, `Config.NetHashing`) si aparece.
  - **Arneses en una sola IP** (`-auth-rate-burst N`, E2E, bots, `make play`): una ráfaga
    por IP mayor que la de fábrica sube también a N las ráfagas por cliente de las
    búsquedas de token y por red (la de búsquedas de token por red, a N o 300, la mayor),
    y apaga el tope de cálculos por red. Los límites por cuenta no cambian.
  - **Logs muestreados:** un error que un cliente puede repetir (un `500` de una ruta, un
    webhook de pago con la firma mal) se registra la primera vez y después como mucho una
    línea por minuto con `suppressed`, cuántos se callaron. Ese resumen se escribe cuando
    el mismo error vuelve a ocurrir pasado el minuto: si la ráfaga termina antes, el
    conteo de su último minuto no llega al log (no hay vaciado periódico; basta para ver
    que el error existe y su orden de magnitud). Se guardan hasta 256 claves (ruta y
    texto del error); con la tabla llena se borran las inactivas y las nuevas que no
    entran comparten una sola clave, así errores con textos siempre distintos no anulan el
    muestreo.
  - **Pool de Postgres:** sin `pool_max_conns` en `DATABASE_URL`, 16 conexiones
    (`store.DefaultMaxConns`; el de pgxpool era max(4, CPUs)).
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
| `account_banned` | 403 | Cuenta suspendida por el staff (T2.6); solo con la contraseña correcta |
| `unauthorized` | 401 | Token ausente, vencido o revocado |
| `invalid_name` / `invalid_vocation` / `invalid_look` | 400 | Creación de personaje inválida |
| `reserved_name` | 400 | El nombre tiene una palabra reservada (se hace pasar por staff o por el juego: "GM", "Admin", "Soporte"...) o es el de un NPC (nombre completo, ver abajo) |
| `name_taken` | 409 | Nombre en uso |
| `character_limit` | 409 | La cuenta ya tiene el máximo de personajes |
| `character_not_found` | 404 | `POST /api/play` con un personaje que no es de la cuenta |
| `rate_limited` | 429 | Demasiados pedidos: login/registro (por IP, red o email), búsquedas de token, pedidos de la cuenta, u otro cálculo de contraseña de la misma red en curso |
| `busy` | 503 | Servidor saturado de logins, o el ranking no consiguió turno en Postgres; reintentar más tarde |
| `invalid_category` / `invalid_vocation` / `invalid_page` | 400 | Filtros de `GET /api/highscores` |
| `not_found` | 404 | Ruta `/api/...` inexistente |
| `internal` | 500 | Error del servidor (queda en el log) |

OAuth, verificación de email y reset de contraseña llegan con T2.1.

### Envío de mapas (T4.5, `httpapi/mapsubmit.go`)
El portal del sitio (`/maps/submit`, `/maps/mine`, `/maps/review`; flujo y reglas en
docs/04, "Portal de envío de mapas"). Todas las rutas piden sesión (cookie o Bearer). Las
de moderación miran el rol de la cuenta **en cada pedido** (`accounts.role`, gm o admin):
un rol quitado deja de servir al instante. Sin `MapSubmissions` en la config (stores de
test sin Postgres) las rutas no existen (404).

Aviso en el juego: cada envío guardado encola un comando al loop (`World.MapSubmitted`; el
handler no toca el mundo) y los gm y admin conectados reciben el `Message` de sistema
`gm.map_submission` (`id`, `title`: el título ya saneado, como texto). Nada del autor va en
él. Después de un aviso, durante un minuto los envíos solo se cuentan, y al final llega uno
solo `gm.map_submissions` (`count`, `id` del último). Con la cola del loop llena el aviso se
pierde (el envío sigue en la cola de moderación).

| Método y ruta | Quién | Cuerpo | Respuesta OK |
|---|---|---|---|
| `POST /api/maps/submissions` | cualquier cuenta | `{title, description, character_id, license, patch}` | `201 {submission}` |
| `GET /api/maps/submissions/mine` | cualquier cuenta | — | `200 {submissions, can_review, email, license, max_bytes, per_day, pr_worker}` (las 100 más nuevas; `email` es el de la propia cuenta, para "Sesión: …"; `pr_worker`: corre el worker que abre los PR, flag `-map-pr-worker` o `RPG_MAP_PR_WORKER=on`) |
| `GET /api/maps/submissions?status=&cursor=` | gm, admin | — | `200 {status, submissions, next?}`: páginas de 50. `pending` (default) del más viejo al más nuevo por creación; los demás estados del cambio más reciente al más viejo (`updated_at`). `next` es el `cursor` de la página siguiente (`<µs unix>-<id>`, keyset) |
| `GET /api/maps/submissions/{id}` | autor, gm, admin | — | `200 {submission}` |
| `GET /api/maps/submissions/{id}/patch` | autor, gm, admin | — | `200` el patch tal cual se subió, como adjunto; `410 patch_gone` si ya se purgó |
| `POST /api/maps/submissions/{id}/review` | gm, admin | `{decision: "approve"\|"reject", reason}` | `200 {submission}` |

- `submission`: `{id, title, description, author, license, status, sha256, size, base_ref,
  files: [{path, action: create|modify|delete}], created_at, updated_at, reviewed_at?,
  reason?, failure?, pr_url?, pr_number?, has_patch}`. `failure` es un código del worker
  (`conflict`, `outside_plot`, `invalid_patch`, `no_changes`, `github`; docs/04). `has_patch` es `false` cuando la
  retención ya borró los bytes (docs/04). `author` es el nombre del personaje elegido
  (`character_id`, tiene que ser de la cuenta); el email nunca sale. Quien no es autor ni
  staff recibe el mismo `404` que con un id inexistente.
- `patch` es el **texto** del `.rpgpatch.json` como string JSON. El cuerpo puede medir hasta
  `2 × max_bytes + 16 KiB` (el escape de JSON); el texto, hasta `max_bytes`. Un envío no
  pasa por el límite general de 4 KiB. **Presupuesto de memoria:** antes de leer un byte
  del cuerpo, el envío toma uno de `DefaultMapUploadSlots` (4) lugares, que suelta al
  responder; si no hay, `503 busy` sin leer el cuerpo. Un `Content-Length` sobre el tope es
  `413` de entrada. El cuerpo se lee en un solo buffer del tamaño de `Content-Length` (no
  con el decoder de JSON, que dobla su buffer) y tiene 30 s para llegar (≈ 140 KB/s con el
  tope de 4 MiB). Cada envío en curso retiene a lo sumo ≈ 5 × `max_bytes` (cuerpo, texto
  decodificado, copia guardada): con 2 MiB, el portal entero no pasa de ≈ 40 MiB. Caddy
  corta en 5 MB los cuerpos de `/api/maps/*` antes de que lleguen al servidor.
- `license` tiene que ser exactamente `cc-by-4.0` (`httpapi.MapLicense`): es el checkbox.
- Textos: `title` 1–80 caracteres, `description` ≤ 2000 y `reason` ≤ 500 (obligatorio para
  rechazar). Se recortan y `\r\n` pasa a `\n`. Se rechazan controles (salvo salto y tab en
  los multilínea), los mismos caracteres prohibidos que en los mapas, los controles
  bidireccionales (U+202A–U+202E, U+2066–U+2069…) y U+2028/U+2029.
- La descarga sale con `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`
  y `Content-Security-Policy: default-src 'none'; sandbox`: el navegador nunca la muestra.
  La de un moderador queda en `audit_log` (`map_download`).
- Antes de leer el cuerpo, `POST /api/maps/submissions` mira la cuenta sin locks
  (`CheckSubmitter`: deshabilitada o baneada, antigüedad, cupo del día) y corta con su
  código, incluso antes de tomar un lugar del presupuesto; una cuenta que sería rechazada no ocupa los MB de lectura. La transacción del
  alta lo vuelve a mirar con la cuenta bloqueada.
- La descarga del patch es un `<a download>`: usa la cookie, así que la cola de moderación
  es del sitio web (la app de escritorio, con token Bearer, no la ofrece).
- Límites (flags de `gameserver`): `-map-submit-max-bytes` (2 MiB), `-map-submit-per-day`
  (3 envíos guardados por cuenta en 24 h móviles) y `-map-submit-min-account-age` (24 h).
  Además, 5 intentos por minuto por cuenta (`DefaultMapSubmitRateLimit`, válidos o no).
- Descargas del patch: 10 por cuenta con una más cada 6 s (`DefaultMapDownloadRateLimit`)
  y 2 a la vez en todo el servidor (`busy` si no hay lugar): cada una lee hasta 2 MiB del
  pool de Postgres que comparten los guardados del juego.
- `-map-patch-retention` (30 días; 0 = nunca): los bytes del patch de un envío
  `rejected`, `pr_opened` o `failed` se borran ese tiempo después de su último cambio
  (job horario, como la purga de sesiones). Quedan el sha256 y los metadatos.

| Código | HTTP | Cuándo |
|---|---|---|
| `invalid_patch` | 400 | El chequeo del patch falló. Trae `detail` (código de `server/internal/mappatch`: `not_json`, `path`, `forbidden_char`…) y, si aplica, `file` (índice). Nunca repite texto del patch |
| `patch_too_large` | 413 | El texto pasa `max_bytes` o el cuerpo pasa su tope |
| `license_required` | 400 | `license` no es la vigente |
| `invalid_title` / `invalid_description` / `invalid_reason` | 400 | Texto vacío, largo o con caracteres prohibidos |
| `character_not_found` | 404 | `character_id` no es de la cuenta |
| `account_too_new` | 403 | La cuenta es más nueva que el mínimo |
| `submit_limit` | 429 | Ya hizo `per_day` envíos en 24 h |
| `duplicate_submission` | 409 | El mismo patch (sha256) de la cuenta sigue pendiente |
| `account_blocked` | 403 | Enviar con la cuenta deshabilitada o baneada |
| `forbidden` | 403 | Una ruta de moderación sin ser gm/admin |
| `patch_gone` | 410 | Descargar un patch que la retención ya borró |
| `busy` | 503 | Además de lo habitual: no hay lugar para otra subida o descarga del portal |
| `not_pending` | 409 | Revisar un envío que ya se decidió |
| `own_submission` | 403 | Un moderador revisando su propio envío (lo decide otro) |
| `unauthorized` | 401 | Además de lo habitual: la sesión sobrevivió a su cuenta |

### Tienda cosmética (T5.7, `httpapi/shop.go`)
Diseño en `01-architecture.md` ("Pagos y tienda cosmética"); reglas en `02-game-design.md`.
Todas con la sesión de la cuenta (cookie o `Bearer`), menos el webhook. Los `POST` piden `Content-Type: application/json` (como el resto: bloquea los
formularios de otro sitio). Sin `data/cosmetics.yaml` o sin Postgres, las rutas no existen
(404). Sin `PAYMENTS_PROVIDER`, `GET` contesta con `enabled: false` (sin paquetes) y todo
`POST` con `503 shop_disabled`; el webhook, 404.

| Ruta | Respuesta |
|---|---|
| `GET /api/shop` | `{enabled, balance, blocked, daily_limit, bought_today, packs: [{id, amount, price, currency}], cosmetics: [{id, kind, price, owned}], history: [{at, kind, amount, cosmetic_id?, pack_id?, shortfall?}]}` |
| `POST /api/shop/checkout` `{pack_id, lang?}` | `{url}`: la página de pago del proveedor, que nombra el paquete con `cosmetic_pack.<id>.name` en `lang` (o `Accept-Language`; español si no hay). El navegador va ahí con `location.assign`. Con el proveedor falso es `/api/shop/fake-checkout/<sesión>` (relativa al sitio): el sitio la postea y va a `/shop?checkout=success` |
| `POST /api/shop/buy` `{cosmetic_id}` | `{balance, owned}` (gasta moneda premium; ids ordenados) |
| `POST /api/payments/webhook/<proveedor>` | Lo llama el proveedor. `200 {status}` con `credited`, `debited`, `duplicate`, `ignored`, `flagged` (disputa), `pending_reversal` (reembolso antes del pago) o `unmatched` (pago aprobado que no se puede acreditar: queda para el staff); `401 invalid_signature`; `502`/`503` para que reintente |
| `POST /api/shop/fake-checkout/<sesión>` | Solo con `PAYMENTS_PROVIDER=fake` (nunca en producción ni en un servidor que alcance otra gente) y solo con la sesión de la cuenta que inició ese checkout (otra cuenta o una sesión inválida: `404 unknown_session`; un `GET` no paga). Paga en el acto mandando al webhook una notificación firmada y contesta `{status}`. `?status=refunded` o `chargeback` la revierte (tests) |

- `price` de un paquete es un entero en la unidad menor de su moneda (ISO 4217): en CLP no
  hay decimales, así que `1990` = $1.990. `amount` es la moneda premium que acredita.
- `history` trae los 50 movimientos más nuevos (`kind`: `pack`, `purchase`, `refund`,
  `chargeback` o `grant`; `amount` con signo). `blocked` = la cuenta no puede comprar
  (deshabilitada, baneada o marcada tras un reembolso que no alcanzó a descontarse).
- Errores: `unknown_pack` (404), `unknown_cosmetic` (404), `insufficient_balance` (409),
  `already_owned` (409), `daily_limit` (409: el paquete pasaría `limits.daily_premium`
  de `data/cosmetics.yaml` en 24 h), `shop_blocked` (403), `provider_error` (502),
  `rate_limited` (429: 10 checkouts o compras por cuenta, luego 1 cada 6 s).
- Tras una compra, un pago, un reembolso o un `/premium`, los personajes en línea de la
  cuenta reciben `CosmeticsState` (unos milisegundos después: lo empuja el `app`).
- E2E con el proveedor falso: el servidor con `RPG_ENV=development` y
  `PAYMENTS_PROVIDER=fake`; `POST /api/shop/checkout` y luego `POST` a la `url` con la
  misma sesión.

## Mensajes cliente → servidor (intenciones)
| Mensaje | Campos |
|---|---|
| `Walk` | `dir` (N, NE, E, SE, S, SW, W, NW), `walk_epoch`, `seq` |
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
| `Say` | `channel` (decir, gritar, susurrar, global, grupo), `text` (máx. 255) |
| `NpcTalk` | `creature_id` del NPC (T1.10) |
| `DialogChoose` | `dialog_id`, `option_id` (0 = cerrar) |
| `ShopBuy` / `ShopSell` | `dialog_id`, `item_id`, `count` (1..100) (T1.10) |
| `TradeRequest` | `creature_id`, `item?`, `item_id`, `stack_index` (T5.3: invitar o aceptar la invitación) |
| `TradeOffer` | `item`, `item_id`, `stack_index`, o `remove` + `index` (T5.3) |
| `TradeAccept` / `TradeCancel` | — (T5.3) |
| `MarketCommand` | `browse`, `create`, `cancel`, `accept`, `withdraw` o `close` (T5.3) |
| `CloseContainer` | `container_id` (T1.8) |
| `PartyCommand` | `action` (invitar, invitar por nombre, aceptar, rechazar, salir, expulsar, pasar liderazgo, compartir sí/no), `creature_id`, `name` (T3.3) |
| `Craft` | `recipe_id`, `station` (posición de la estación, T3.4) |
| `Refine` | `station` (el yunque), `item` (slot o contenedor), `item_id`, `level` (el nivel de refinado que ve el cliente), `protect` (gastar un ámbar) (la forja) |
| `ReportPlayer` | `creature_id` (un jugador a la vista), `reason` (1..200 caracteres) (T4.1) |
| `PresenceAnswer` | `check_id`, `option_id` (respuesta a un `PresenceCheck`, T4.1) |
| `TutorialSkip` | — (termina el tutorial sin premio, T4.2) |
| `Ping` | `client_time` |
| `Logout` | — |

`item_id` y `stack_index` en las acciones sobre items permiten al servidor rechazar
una acción hecha sobre una vista desactualizada del tile o contenedor.

### Caminar (T1.4, `server/internal/session`)
- El servidor marca el ritmo: un paso empieza cuando terminó el anterior. Duración de un
  paso recto = `base_step_ms × terreno% / velocidad`, con terreno el `ground.speed` de la
  casilla **de destino** (100 por defecto), redondeada hacia arriba a ticks de 50 ms (al
  menos uno). Un paso en diagonal dura esos ticks × `diagonal_cost` (√2, leído en
  milésimas: 1.414), redondeado al tick más cercano y nunca menos que el recto: así un
  paso recto de 10 ticks es uno diagonal de 14, no de 15, y la velocidad por casilla de
  distancia es la misma en las 8 direcciones. Una excepción: si el paso recto dura un solo
  tick, el diagonal dura dos (√2 redondearía a uno y la diagonal rendiría √2 veces más
  distancia por tick; solo pasa a velocidades que hoy nadie alcanza: 2000 en suelo normal,
  1000 en camino). `diagonal_cost` va de 1 a 2 (`world.MaxDiagonalCost`: con más, el costo
  de una ruta no cabría en el A*). `CreatureMove.duration_ms` es esa duración
  ya redondeada; el cliente predice la misma con aritmética entera
  (`client/src/state/step-time.ts`, igual que `StepTicks`). La posición cambia al
  **empezar** el paso.
- **`Walk` encola un paso de teclado** detrás de los pasos de teclado que ya esperan, como
  mucho `movement.max_queued_steps` (`balance.yaml`, 4; el `Welcome` se lo dice al
  cliente, así un cambio del YAML no necesita recompilar el cliente); si en la cola hay un
  `WalkPath` o un paso de persecución (`chase`), lo descarta. Si el personaje está a mitad de un paso,
  el siguiente sale el tick en que termina. Así el cliente predice unos pasos adelante y
  manda cada uno un poco antes de que termine el que dibuja (`client/CLAUDE.md`
  "Movimiento fluido"): el servidor camina sin huecos entre casillas aunque la red los
  junte o los atrase. Uno más que el tope no es un cliente honesto (el cliente nunca tiene
  más de `max_queued_steps` sin confirmar): **reinicia la caminata** (`WalkRejected` con
  `dir` = `UNSPECIFIED`: no se rechazó un paso, y el cliente no debe evitar esa casilla).
  Mandar `Walk` cada tick no acelera nada: el ritmo es del servidor, la cola se llena y
  el siguiente la vacía.
- **Número del `Walk` (`seq`).** El cliente numera sus `Walk` (uno más cada vez, desde 1;
  0 = sin número, bots y clientes viejos). El `CreatureMove` del paso que ejecuta ese
  `Walk` lo devuelve en `walk_seq`, **solo en la copia del propio jugador** (los demás
  reciben 0); un paso de un `WalkPath` o de persecución lleva 0. Así el cliente empareja
  cada respuesta con su predicción aunque el servidor haya dado antes un paso que el
  cliente no esperaba (el siguiente de un camino por click, uno de persecución) o un
  `Walk` se haya perdido (el gateway descarta lo que pasa del rate limit, o la cola del
  loop llena): un `walk_seq` k responde también a los `Walk` anteriores a k que no
  volvieron. El servidor no decide nada con `seq`: solo lo copia.
- **Época de la caminata (`walk_epoch`, desde 1).** Toda vez que el servidor vacía la cola
  y se lo dice al cliente, empieza una época nueva: cada `WalkRejected` (lleva
  `walk_epoch`) y cada teletransporte (el `FullMapView` lleva `walk_epoch`; el del login
  trae la 1). El cliente manda en cada `Walk` la época del último de esos mensajes. Un
  `Walk` de otra época salió antes de que el cliente supiera del reinicio, y el cliente ya
  lo olvidó: el servidor lo descarta **sin contestar** (no lo ejecuta desde una casilla que
  el cliente no esperaba). `walk_epoch` 0 no se revisa (clientes y bots anteriores a la
  cola). Garantía: todo `Walk` aceptado termina en un `CreatureMove` (con su `seq`), un
  `WalkRejected` o un `FullMapView` (teletransporte, muerte); el servidor no vacía la cola
  en silencio por su cuenta. Solo lo hacen, sin contestar, lo que pide el propio cliente
  (`StopWalk` y `WalkPath`, que la reemplaza) y la desconexión. El cliente del juego no
  manda ninguno de los dos (docs/17 A6): sus `Walk` siempre esperan respuesta. Un `Walk`
  que el gateway descarta no llega nunca: lo responde el `walk_seq` de uno posterior, y
  si no hay otro, el cliente lo da por perdido a los 3 s (`PREDICT_TIMEOUT_MS`).
- **Click para caminar y mouse mantenido (docs/17 MOV-3 y MOV-4): `Walk`, no `WalkPath`.**
  El cliente arma el camino con A* y manda cada paso como un `Walk` de teclado, con su
  época y su `seq`, el mismo margen antes de que termine el paso dibujado y el mismo tope
  `max_queued_steps`; el mouse mantenido elige cada paso hacia el cursor. Para el
  servidor no hay diferencia con una tecla: valida y da cada paso a su ritmo. Si rechaza
  uno (un `Walk` bloqueado por una criatura no se recalcula), el cliente rearma el camino
  esquivando esa casilla y sigue con la época nueva. `WalkPath` (con el rodeo del
  servidor) queda para los bots (`tools/bots`) y clientes que no predicen.
- `WalkPath` reemplaza la cola. Vacío = `StopWalk`. Más de `max_path_tiles` pasos
  (`balance.yaml`, 100) o una dirección inválida → `WalkRejected` con `dir` =
  `UNSPECIFIED` y nada se encola. En los demás rechazos `dir` es el paso rechazado.
- Cada paso se valida al ejecutarse: casilla sin suelo, que bloquea o fuera del mundo →
  `WalkRejected{pos, dir, walk_epoch}`, se vacía la cola (los pasos de teclado de atrás
  también) y empieza otra época. Si la bloquea **una criatura** durante un
  `WalkPath`, el servidor recalcula con A* hasta el final del camino esquivando
  criaturas (y escaleras, agujeros y teletransportes salvo el final); si no hay camino (o
  el destino está ocupado) → `WalkRejected`. Un `Walk` de teclado bloqueado por una
  criatura se rechaza sin recalcular. Un paso sobre una escalera sigue en "Portales".
- **Cuota de pathfinding por tick:** los recálculos comparten 12 000 nodos expandidos
  por tick y cada búsqueda expande como máximo 2 × 1 500; una búsqueda solo arranca si
  cabe el peor caso. Sin cuota, el jugador espera al tick siguiente (no se rechaza).
- `StopWalk` vacía la cola (el paso en curso termina). `Turn` cambia la dirección y
  manda `CreatureTurn` a quien lo ve (nada si ya miraba hacia ahí). **Anti-flood (lote
  16):** a los observadores les llega una ráfaga de 6 giros y después uno cada 100 ms
  (GCRA por jugador, `turnFlood` en `session/move.go`); la dirección cambia siempre al
  instante y quien gira recibe cada `CreatureTurn` suyo. El último giro retenido sale
  cuando el cupo se recarga, así que los observadores terminan viendo la dirección real.
- `Ping` → `Pong` en el batch de ese tick.

### Combate cuerpo a cuerpo (T1.6, `server/internal/session/combat.go`)
- `SetTarget{creature_id}` elige un monstruo que el cliente conoce, en su mismo piso, con
  ninguno de los dos en zona de protección, o (T5.2, con PvP) un jugador que las reglas
  dejan atacar ("PvP" abajo). Si no vale (NPCs, jugadores con PvP apagado), el servidor
  lo descarta y manda `Message` de sistema `combat.cannot_attack` (o la clave `pvp.*` del
  motivo); el cliente suelta el objetivo al recibirlo. `0` deja de atacar. El objetivo se pierde
  solo cuando sale de la vista o muere: el cliente lo suelta con su `CreatureDisappear`.
- `SetFightMode{stance, chase}`: `stance` ofensivo/equilibrado/defensivo multiplica el
  golpe máximo y la defensa del escudo (`combat.modes` de `balance.yaml`); `UNSPECIFIED`
  se ignora. Por defecto equilibrado y sin perseguir. Con `chase` el jugador da un paso
  hacia su objetivo cuando no está pegado a él y no tiene pasos en cola. El servidor los
  guarda por personaje ("Opciones guardadas").
- **Opciones guardadas** (`session/options.go`, migración 00029, pedido del dueño del
  2026-11-26): la postura, perseguir y el modo seguro (`SetSafeMode`) son del personaje y
  el servidor es su dueño. El loop los cambia con esos dos mensajes (un `stance` fuera del
  enum no cambia nada), van en cada snapshot (`characters.opt_stance`, `opt_chase`,
  `opt_safe`, por el camino de guardado de siempre: nada de base de datos en el loop) y
  vuelven en el siguiente login, en un relogueo rápido (del snapshot sin confirmar) y en un
  login que reemplaza a otro (del jugador en memoria). Morir no los toca.
  `Welcome.options` (`GameOptions{stance, chase, safe_mode}`) le dice al cliente los
  vigentes: el cliente los muestra y **no los vuelve a mandar** al entrar. Un personaje de
  antes de la migración tiene los de siempre (equilibrado, sin perseguir, modo seguro
  activado); una fila con una postura inválida pelea equilibrada.
- Ronda: con el objetivo a una casilla (también en diagonal) el jugador golpea cada
  `combat.attack_interval_ms` (2000 ms). Fórmulas en `server/internal/combat` (doc 02).
  Sin arma golpea con los puños (`combat.fist_attack`, con su skill `fist`); con arma,
  con la de la mano derecha (T1.8).
- Cada golpe (de jugador o de monstruo) manda antes `CreatureAttack{MELEE}` a quien
  conoce al atacante (A9, "Quién ataca y por qué sale una criatura") y después, a quien ve
  la casilla: `Effect` (`effect_id` 1 = golpe con daño, 2 = bloqueado o fallado) y, si
  hubo daño, `FloatingText{DAMAGE}` y `CreatureHealth`. El jugador golpeado recibe además
  `PlayerStats`. Los `effect_id` son constantes del protocolo hasta que exista
  `data/effects.yaml`.
- Muerte de un monstruo: `CreatureDisappear{reason: DEATH}` (después de su
  `CreatureHealth` 0), `TileUpdate` con sus restos encima de la pila (el item de su
  `corpse` en `data/monsters`, o `creature_remains`, con `mods.remains_of` = el id del
  monstruo: ver "Restos" arriba; dura `combat.monster_corpse_ms`; es un contenedor con el
  botín, T1.8),
  `FloatingText{EXPERIENCE}` y `PlayerStats` a cada jugador que hizo daño (la experiencia
  se reparte según el daño de los que siguen conectados; con un grupo que comparte, a cada
  miembro que comparte, ver "Grupos": `FloatingText.bonus` es la parte del bonus de grupo)
  y, al que más daño hizo,
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
  `FullMapView`, `CreatureDisappear{reason: DEATH}` a quienes lo veían morir y
  `CreatureAppear` a quienes ven el templo) y recibe
  `Inventory`, `PlayerStats`, `PlayerSkills` y el `Message` de sistema `death.died` con
  `experience` (perdida) y `blessings` (las que tenía y se consumieron), ambos `number`.
  El cliente muestra la pantalla de muerte con ese mensaje. Un personaje que muere
  link-dead no tiene a quién decírselo: el servidor guarda ese mismo `death.died` en memoria
  y se lo manda al **próximo login** del personaje (también al que retoma al link-dead),
  después de su `Welcome`, `FullMapView`, `PlayerStats`, `Inventory`, `PlayerSkills` y
  cosméticos; una sola vez. Un reinicio del servidor en el medio lo pierde. Sacar, usar o
  meter algo en el cuerpo ajeno dentro de `corpse_owner_only_ms` responde
  `death.corpse_not_owner`.

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
  `into_itself`, `too_deep`, `tile_full`, `cannot_use`, `not_ready`, `saving`,
  `not_yours` y `floor_first` (la espera de la falla segura del comercio, ver "Falla
  segura" en T5.3), y `portal.no_room` (un item tirado sobre una escalera, un agujero o un
  teletransporte no tiene dónde caer del otro lado).
- **`MoveItem`:** `count` de 1 al tamaño de la pila para apilables (se ignora en los demás).
  Destino `pos`: un tile caminable al alcance. Destino `slot` o `container` con un
  contenedor en ese lugar: adentro de ese contenedor. Mover dentro del mismo contenedor
  no reordena (ignorado). Un destino `pos` que es la entrada de una escalera, un agujero
  o un teletransporte: el item **cae** al otro extremo (`02-game-design.md`, "Cambiar de
  piso"): queda en el destino del portal o en la casilla con lugar más cercana a
  `travel.arrival_radius` (nunca en una casa ni en la sala de una puerta con llave). El
  `TileUpdate` es de esa casilla y le llega a quien la ve (no al que lo tiró si no la
  ve: otro piso u otra isla); la casilla del portal no cambia. Sin lugar,
  `portal.no_room` y nada cambia. Sobre una escalera de mano o un punto de soga el item
  queda en la casilla.
- **Respuestas:** cada lugar que cambió manda su estado completo: `TileUpdate` a quien ve
  el tile, `Inventory` (todos los slots ocupados y los bolsillos) al dueño y
  `ContainerUpdate` a cada jugador que tiene el contenedor abierto. Si cambió el peso
  cargado, `PlayerStats` (`capacity` = capacidad libre en gramos, `max_capacity` = la
  total).
- **Bolsillos** (lote 13, docs/02 "Bolsillos"): `Inventory.pockets` (campo 2) es lo que
  llevan los bolsillos del personaje, el 0 primero y sin huecos (como
  `ContainerUpdate.items`), y `Inventory.pocket_slots` (campo 3) cuántos tiene
  (`inventory.pocket_slots`, 4). Llegan en cada `Inventory`; un cambio en los bolsillos
  manda el `Inventory` entero (nunca un `ContainerUpdate`: los bolsillos no son una ventana
  y no tienen `container_id`). Un cambio que toca el equipo o los bolsillos más de una vez
  (un `MoveItem` entre un bolsillo y un slot, lo que se recibe en varias pilas) manda un
  solo `Inventory`, con el estado final. Se los nombra con `ItemLocation.pocket` en
  `MoveItem`, `UseItem`, `UseItemOn`, `LookAt`, `TradeOffer`/`TradeRequest` y `Refine`:
  el índice es el de `ItemLocation.pocket` y el servidor ignora `stack_index` (el cliente
  repite ahí el índice); un índice sin item, o con otro item, es `inventory.not_possible`.
  Un `MoveItem` a un bolsillo con un contenedor lo mete adentro. Un `MoveItem` al slot de
  mochila o a la ventana de la mochila equipada (su primer nivel) que no tiene lugar, o al
  slot de mochila vacío de algo que no es una mochila, lo deja en los bolsillos; sin lugar
  ahí tampoco, `inventory.container_full`. Los bolsillos mismos no tienen ningún
  `ItemLocation`: nada los mueve. Un cliente viejo ignora los campos y
  no ve lo que llevan.
- **Contenedores:** `UseItem` sobre un contenedor lo abre (`ContainerOpen` con un
  `container_id` nuevo de la sesión, `capacity` = lugares, `has_parent` si está dentro de
  otro contenedor) o lo cierra si ya estaba abierto (`ContainerClose`). Como máximo
  `inventory.max_open_containers` (16) a la vez: abrir otro cierra el más viejo.
  `CloseContainer` cierra una ventana. El servidor manda `ContainerClose` cuando el
  jugador se aleja de un contenedor del suelo, cuando el contenedor se mueve fuera de su
  alcance o cuando los restos desaparecen.
- **Consumibles:** `UseItem` cura (`FloatingText{HEAL}` a quien ve, `CreatureHealth` si
  cambió el %, `PlayerStats` al jugador) o, si solo es comida, `inventory.ate` con el
  item. Gasta una unidad. La comida (`food_ms`, auditoría de contenido m2) además suma
  tiempo a la condición `well_fed` (`PlayerConditions` al jugador); si es solo comida y
  pasaría del tope, el servidor contesta `inventory.full_stomach` y no gasta nada.
- **Cofres de recompensa** (docs/02 "Libros y cofres", sin mensajes nuevos): `UseItem` sobre
  un cofre del mapa (item con bloque `chest`) a `inventory.reach` da sus recompensas una vez
  por personaje, todas juntas: las de siempre de un item que llega a la mochila
  (`ContainerUpdate`, `PlayerStats`) y `chest.found` con un parámetro `item` por recompensa
  (`{items}`, como el botín). Si ya lo abrió, `chest.empty`; si no le entra todo,
  `chest.no_room` y no recibe nada; lejos, `inventory.too_far`.
- **Libros y pergaminos:** no hay mensaje. El cliente abre su ventana de lectura con los
  textos de `books.yaml` que ya tiene (docs/02 "Libros y cofres"); `LookAt` sobre uno
  contesta como sobre cualquier item fijo del mapa (`look.ground` más su descripción).
- **`LookAt`:** `Message` de sistema `look.weapon` (`attack`, `defense`), `look.armor`
  (`armor`), `look.shield` (`defense`), `look.container` (`slots`), `look.item` o
  `look.ground`, con el parámetro `item` y, salvo el suelo, `weight` (gramos de la pila con
  su contenido) y `level` si el item lo exige. Un item fijo del mapa (`pickupable: false`,
  que no es contenedor: un cartel, un yunque, un árbol) contesta como el suelo,
  `look.ground` sin peso (T5.5). El cliente agrega la descripción que nombra el
  `description` del item en `data/items` (`item.<id>.desc`, o el `text.*` de un cartel) si
  existe y muestra el peso en g o kg (`formatMass`, docs/02 "Unidades").
- **Login:** `Inventory` lleva el equipo guardado y los bolsillos; un personaje que nunca
  jugó recibe `inventory.start_container` en el slot de mochila y el `start_kit` de su
  vocación (docs/02 "Equipo inicial"): su primer `Inventory` ya trae el arma, la ropa y,
  según la vocación, el escudo o la munición en sus slots, y el resto dentro de la mochila
  (los bolsillos, vacíos salvo que la mochila no alcance). No hay mensaje aparte para el kit.

### Magia (T1.9, `server/internal/session/magic.go`)
Reglas de juego en `02-game-design.md` ("Magia (T1.9)").
- **`CastSpell`**: `spell_id` (hotkey) o `words`; `target` opcional (criatura o tile; sin él,
  el objetivo actual). Una curación a otro (`heal.range`, T3.1) exige `target` con un
  jugador (su id o su casilla), nunca el que lanza: no usa el objetivo actual. Un `Say` en el canal `SAY` cuyo texto, en minúsculas y con los
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
  quien ve cualquiera de las dos puntas. Quien ve solo una punta recibe la otra como la punta
  que ve, movida en un eje hasta el borde de su ventana del lado por donde cruza el disparo
  (T4.1): no viaja la casilla de un tirador ni la de un blanco fuera de la ventana, solo el
  lado.
- **Quién ataca** (A9): un hechizo o una runa sobre una criatura y un hechizo de área
  mandan antes `CreatureAttack{SPELL}` (el de área sin objetivo, con su centro y su radio);
  una varita o un arma a distancia, `CreatureAttack{RANGED}`; los ataques a distancia y
  los hechizos de los monstruos, `RANGED` y `SPELL` ("Quién ataca y por qué sale una
  criatura").
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
  herramienta), `inventory.not_possible` (otro piso o fuera de la vista; ver "Puertas"),
  `inventory.too_far` (más lejos que `resource.reach`),
  `magic.no_sight`, `gather.not_ready` (antes de `gathering.use_interval_ms`),
  `gather.depleted` (casilla agotada: no entrena), `gather.failed` y
  `gather.got{item}`. Lo obtenido va a la mochila como una compra (lo que no entra cae al
  suelo con `inventory.item_on_floor`).
- **Efectos**: 5 = cosecha lograda, 6 = intento sin resultado, en la casilla del recurso,
  para todos los que la ven. 8 y 9 son de la forja ("Forja", abajo).
- El cliente entra en modo "usar con" al usar una herramienta (click derecho) y el
  siguiente click en el mapa manda el `UseItemOn`; Escape o click derecho lo cancelan.

### Forja (`server/internal/session/refine.go`)
Reglas y números en `02-game-design.md` ("Forja") y `balance.yaml` `forge` (docs/06).
- **`Refine{station, item, item_id, mods, protect}`**: un intento sobre la pieza de `item`
  (un slot de equipo o un contenedor abierto que el jugador lleva; nunca una posición del
  suelo) en el yunque de `station`. `item_id` y `mods` (todos: atributo, valor y nivel de
  refinado; sin `mods`, una pieza común) son la pieza que el cliente ve: otra pieza, otra
  tirada u otro nivel (una vista vieja, o el mismo click mandado de nuevo después de un
  éxito) se rechaza con `inventory.not_possible` sin gastar nada. Así, con lag, un segundo
  click mandado antes del resultado de una rotura (las piezas de ese contenedor ya subieron
  un lugar) nunca refina la que ocupó su índice, salvo que sea igual en todo (entonces da lo
  mismo cuál). Los `mods` son solo una clave: la instancia conserva los suyos. Además la
  ventana no manda otro intento hasta que llega la respuesta del anterior (abajo). `protect`
  gasta un ámbar de resguardo, solo si el intento puede fallar (por encima de
  `forge.safe_level`; abajo se ignora); el cliente no lo pide sin uno.
- **Rechazos** (`Message` de sistema; nada se gasta): `refine.unavailable` (forja apagada),
  `inventory.not_possible` (otro piso o fuera de la vista, item que no está ahí o de otro
  nivel, una posición del suelo), `refine.not_carried` (en un contenedor abierto que no
  lleva: un cadáver, un cofre del suelo), `craft.no_station{item}` (no hay yunque en esa
  casilla),
  `inventory.too_far` (a más de 1 casilla), `refine.not_refinable` (no tira atributos:
  munición, contenedores, materiales...), `refine.top_level{level}` (ya está en el tope),
  `refine.in_trade` (ofrecida en el intercambio), `refine.no_stones{item}` (las que faltan
  de la piedra de su banda), `refine.no_protection{item}`, `refine.no_money{price}`,
  `refine.no_change_room` (el vuelto de una moneda partida no entra) y `refine.not_ready`
  (antes de `forge.time_ms` desde el último intento de un oficio).
- **Respuesta:** `RefineResult` con `outcome`, la instancia después (`item` con sus `mods`; al
  romperse, solo `item_id`), su `level` (0 rota) y `text`: `refine.success{item, level}`,
  `refine.broken{item}` o `refine.protected{item, level}`, donde `item` es la pieza como era
  (con sus `mods`: el cliente la nombra "+6 …") y `level` el nivel de ahora (también va
  `from`, el de antes). El mismo texto llega como `Message` de sistema (el log). En el mismo
  lote, **antes** del `RefineResult`, llegan el `Inventory` o `ContainerUpdate` de las monedas,
  las piedras, el ámbar y la pieza (sus `mods` nuevos, o sin ella; con la pieza puesta,
  también lo que cambia su equipo); **después**, `PlayerStats` y el `StationOpen` del yunque
  con lo que queda (y la `MarketUpdate` de una ventana del mercado abierta). Toda respuesta a
  un `Refine` es un `RefineResult` o un `Message` de sistema: el cliente espera una de las dos
  (o 10 s) antes de dejar mandar otro intento.
- **Efectos** en la casilla del yunque, para todos los que la ven: **8** chispas (éxito),
  **9** una pieza que se parte (rota, o el ámbar que se quiebra en su lugar).
- La pieza refinada lleva su nivel en `ItemMods.refine` en todo mensaje que la nombra
  (inventario, contenedores, suelo, intercambio, mercado, parámetros `item`, también el de
  `look.*`, cuyo `attack`, `armor` o `defense` incluye lo que suma el nivel).

### Chat (T1.13, `server/internal/session/chat.go`)
Reglas y números en `02-game-design.md` ("Chat") y `balance.yaml` `chat`.
- **`Say`** `channel` `SAY`/`YELL`/`WHISPER` → `Message{kind: SAY|YELL|WHISPER,
  speaker_id, speaker_name, pos, text}` a todo jugador dentro del rectángulo del modo en el
  mismo piso (incluido quien habla). `GLOBAL` → `Message{kind: GLOBAL, speaker_id,
  speaker_name, text}` sin `pos` a todos los conectados. `UNSPECIFIED` se ignora.
  Solo quien ve a quien habla recibe `pos`: un grito llega más lejos que la ventana, y quien
  no lo ve (o no ve a un invisible) lo oye por nombre, sin `pos` (T4.1).
- El servidor limpia el texto (controles y caracteres de formato → espacio, espacios
  colapsados) y lo reenvía **tal cual**: no escapa HTML. El cliente lo dibuja siempre como
  texto (nodos DOM de Preact o `Text` de Pixi), nunca como HTML ni como plantilla i18n.
- Rechazos (`Message` de sistema): `chat.too_long` (`max`), `chat.flood` (`seconds`),
  `chat.muted` (`seconds`), `chat.global_wait` (`seconds`).
- El rate limit por conexión del gateway (comandos/s, desconexión) sigue aplicando a
  todo, chat incluido; el anti-flood es una capa más fina dentro del juego.

### Comandos de staff (T2.6, `server/internal/session/admin.go`)
Reglas y lista en `02-game-design.md` ("Moderación"); diseño en `01-architecture.md`.
- No hay mensaje propio: un `Say` cuyo texto limpio empieza con `/` es un comando, en
  cualquier canal, y nunca se reenvía como chat. Se revisa antes el largo (`chat.too_long`).
- Comando desconocido, o que el rol de la cuenta no permite → `Message` de sistema
  `command.unknown`, después del mismo anti-flood del chat (`chat.flood`, `chat.muted`).
- Staff: límite propio (ráfaga de 10, luego 1/s) → `command.too_fast`. Respuestas:
  `gm.usage` (`usage`: la sintaxis, texto sin traducir), `gm.player_offline` (`name`),
  `gm.player_not_found` (`name`), `gm.bad_position` (`x`, `y`, `z`), `gm.teleported`
  (`name`, `x`, `y`, `z`), `gm.item_unknown` (`id`), `gm.item_count` (`max`),
  `gm.item_created` (`item`), `gm.protected` (`name`), `gm.kicked` (`name`),
  `gm.ban_duration` (`days`), `gm.ban_reason` (`max`), `gm.banned` (`name`),
  `gm.unbanned` (`name`), `gm.not_banned` (`name`) y `gm.failed` (sin parámetros). Los de ban y unban llegan cuando responde la
  base, unos ticks después.
- `/announce` → `Message{kind: BROADCAST, speaker_id, speaker_name, text}` sin `pos` a
  todos los conectados. El texto va tal cual; el cliente pone la etiqueta traducida
  (`client.chat.line.broadcast`).
- Expulsado → `Disconnect{KICKED}`. Baneado → `Disconnect{BANNED}`; sus tokens quedan
  revocados, así que el cliente vuelve al login y muestra el motivo ahí.

- Tienda (T5.7, `session/cosmetics.go`): `/premium Nombre +100 nota` o `-100 nota` (solo
  admin; de −100000 a 100000; la nota es obligatoria; `+0 clear nota` limpia la marca de
  la cuenta) y `/purchases Nombre` (gm: saldo y los 10 movimientos más nuevos). Funcionan
  con el personaje desconectado; los escribe la base en una transacción con su fila en
  `premium_ledger` y en `audit_log`. Respuestas: `gm.premium_amount` (`max`),
  `gm.premium_insufficient` (`name`, `balance`), `gm.premium_done` (`name`, `balance`),
  `gm.purchases` (`name`, `balance`, `count`) seguido de un `gm.purchase_line` (`at`,
  `reason`, `amount`, `ref`; texto sin traducir) por movimiento, `gm.player_not_found` y
  `gm.failed`.

### Cosméticos (T5.7, `server/internal/session/cosmetics.go`)
Lo comprado es de la cuenta y se equipa por personaje. Solo cambia lo que se dibuja:
ninguna regla del juego lee los cosméticos.
- `EquipCosmetic{cosmetic_id}`: un id de `data/cosmetics.yaml` que la cuenta tiene; su
  `kind` dice qué ranura ocupa (`outfit`, `outfit_color` o `name_effect`). Uno que no tiene
  o desconocido → `Message` de sistema `shop.not_owned` y un `CosmeticsState` sin cambios.
- `UnequipCosmetic{kind}`: esa ranura vuelve al aspecto por defecto. Otro `kind` se ignora.
- Sin catálogo en el servidor → `shop.unavailable`. Anti-flood: ráfaga de 5 cambios, luego
  1 cada 500 ms; lo que pasa se descarta sin aviso.
- Un cambio llega a quienes ven al jugador (él incluido) como
  `CreatureCosmetics{id, cosmetics}`, y al jugador además `CosmeticsState`.
- `Creature.cosmetics` (campo 12) trae lo equipado en cada `Creature` (`FullMapView`,
  `MapSlice`, `CreatureAppear`); vacío = aspecto por defecto.
- `CosmeticsState{owned, balance, equipped}`: al entrar (después de `PlayerSkills`), tras
  cada `EquipCosmetic`/`UnequipCosmetic` y cuando cambia el saldo o lo comprado fuera del
  juego. Comprar se hace por HTTP (sitio), nunca por el socket.
- Lo equipado se guarda con el personaje (`characters.outfit`, `outfit_color`,
  `name_effect`) en el siguiente guardado, como todo lo demás; al entrar, lo que la cuenta
  ya no tiene o que salió del catálogo se descarta.

### Apariencia y equipo visible (lote 13, `server/internal/session/look.go`)
Todo humanoide del motor (jugadores, NPCs que son personas, monstruos humanoides; docs/17
"Humanoides del motor") se dibuja con un cuerpo (`BodyLook`) y lo que lleva encima. Solo
cambia lo que se dibuja: ninguna regla del juego lee el aspecto.
- **`BodyLook{body, skin, hair, hair_color, beard, sex}`** (`common.proto`): ids de
  `data/looks.yaml` (`builds`, `skins`, `hair_styles`, `hair_colors`, `beards`, `sexes`).
  `sex` (campo 6, agregado el 2026-11-20) es `male` o `female`: el cliente dibuja el cuerpo
  y la ropa de torso de ese sexo; vacío (un servidor anterior) dibuja el del hombre.
  `SetLook` y la creación lo exigen (`PlayerLook`). Se guarda en `characters.look_sex`
  (migración 00022); un personaje guardado antes lo recibe al entrar sin cambiar el resto
  de su aspecto: hombre si tiene barba, si no el que sale del id.
- **`Creature.look`** (campo 13): el cuerpo de un jugador (el suyo), de un NPC o de un
  monstruo humanoide (el de su `look` de `data/`). Vacío para una bestia o con un servidor
  sin `data/looks.yaml`.
- **`Creature.equipment`** (campo 14, `VisibleEquipment{head, torso, legs, feet,
  left_hand, right_hand}`): solo jugadores; el id numérico (`data/ids.lock.yaml`) del item
  de cada slot que se ve en la figura, 0 = vacío. Nunca el amuleto, el anillo, la mochila
  ni la munición, ni nada de adentro de un contenedor. El cliente dibuja el `worn` de cada
  item (`data/items`); uno sin `worn` no se ve.
- **`Creature.worn`** (campo 15, `Worn{head, torso, legs, feet, shield, weapon}` de
  `WornPiece{shape, tint}`): solo NPCs y monstruos, las piezas de su `look.worn` (no son
  items). Un mensaje por definición, compartido por cada `Creature` de ella.
- **`CreatureLook{id, look, equipment}`** (`ServerMessage` 46): cambió el cuerpo o lo que
  muestra un jugador; los dos campos son el estado entero. Va a quienes lo conocen (él
  incluido; `eachWatcher`, las reglas de AOI de los demás mensajes de criaturas: un
  invisible solo a sí mismo) cuando cambia el cuerpo (`SetLook`) o el item de un slot
  visible: equiparse, sacarse algo, una pieza que se gasta o se rompe en la forja, lo que
  cae al morir, lo que se vende o se intercambia. Todo pasa por `equipmentChanged`, que
  compara los ids de los slots visibles con los últimos mandados: mover algo dentro de la
  mochila o cambiar el anillo no manda nada. Va **uno por jugador y tick como mucho**, al
  final del tick (`flushLooks`, antes de armar los batches) con el estado de ese momento:
  un arma que va y vuelve entre la mano y la mochila varias veces en un tick, o un
  `SetLook` y un cambio de equipo del mismo tick, son un solo `CreatureLook`. Un jugador
  que en ese tick salió de la vista de otro (una muerte que lo lleva al templo) ya no se
  lo manda a ese otro. Quien entra en la vista después recibe el estado en el `Creature`
  de su `CreatureAppear`, `FullMapView` o `MapSlice`.
- **`SetLook{look}`** (`ClientMessage` 37): cambia el cuerpo propio, gratis y en cualquier
  momento (la ventana Apariencia → Personalizar). Cada id tiene que ser una elección de
  jugador; si no → `Message` de sistema `appearance.invalid` y un `CreatureLook` solo al
  jugador con el aspecto que conserva. El mismo aspecto no manda nada. Anti-flood:
  `limits` de `data/looks.yaml` (ráfaga de 6, después 1 cada 1,5 s); lo que pasa se
  descarta sin aviso. Sin `data/looks.yaml` en el servidor → `appearance.unavailable`,
  una sola vez por sesión (los `SetLook` siguientes se ignoran sin respuesta).
- **Guardado:** `characters.look_*` (migración 00021), con el siguiente guardado, como
  todo lo demás. Al entrar, un aspecto vacío (los personajes de antes de la migración) o
  que ya no es una elección de `data/looks.yaml` se reemplaza por el que sale del id del
  personaje (`content.DefaultLook`: siempre el mismo para el mismo id y las mismas listas)
  y se guarda así: un cambio posterior de las listas no lo cambia.

### Reportes de jugadores (T4.1, `server/internal/session/report.go`)
Reglas en `02-game-design.md` ("Moderación"); diseño en `01-architecture.md`.
- **`ReportPlayer{creature_id, reason}`** (el botón "!" de la lista de batalla) o el comando
  de chat `/report Nombre motivo` (cualquier jugador en línea; el nombre es la tira más
  larga de palabras iniciales que nombra a alguien conectado). El cliente solo manda el
  motivo: el servidor adjunta las dos posiciones, el nivel y los últimos
  `reports.events` eventos del reportado (chat, objetivo elegido, muertes de monstruos,
  su muerte y movimientos de economía).
- Respuestas (`Message` de sistema): `report.sent` (`name`), `report.usage`,
  `report.self`, `report.offline` (`name`), `report.not_visible` (botón sobre alguien
  que no ve), `report.reason` (`max`), `report.too_fast` (`minutes`),
  `report.same_target` (`name`) y `report.unavailable`. Los GM en línea reciben
  `gm.report_new` (`name`, `reporter`, `reason`).
- GM: `/reports` → `gm.reports` (`count`) y un `gm.report_entry` (`id`, `name`,
  `reporter`, `reason`, `minutes`) por reporte, o `gm.reports_none`. `/closereport id
  resolución` → `gm.report_closed`, `gm.report_not_found` o `gm.report_not_open` (`id`).
  Llegan cuando responde la base, unos ticks después.

### Chequeo de presencia (T4.1, `server/internal/session/antibot.go`)
Diseño en `01-architecture.md` ("Detección de bots").
- **`PresenceCheck{check_id, question, options[], timeout_ms}`**: `question` y cada
  `DialogOption.text` son claves i18n. La pregunta es siempre `presence.question`
  ("elige el color de esta muestra") con un parámetro numérico `swatch`: un color
  `0xRRGGBB` que el servidor sortea en cada chequeo dentro de la franja del color pedido
  (`server/internal/presence`); el cliente lo dibuja como una muestra. Las opciones son
  `presence.option.<color>` (`blue`, `yellow`, `white`, `black`): ningún par depende solo
  del tono (blanco y negro se leen por la luminosidad; azul y amarillo están en el eje
  que conserva quien tiene protanopía o deuteranopía), así que un jugador daltónico
  contesta igual que cualquiera. Hasta la revisión del lote 16 eran rojo, azul, verde y
  amarillo. **Desde el
  lote 16 ningún texto de la pregunta coincide con una opción**: antes la clave era
  `presence.question.<color>` y un script contestaba comparando sufijos sin mirar nada.
  Clasificar el tono sigue siendo posible para un script (nada que el cliente dibuja es
  secreto), por eso un acierto nunca limpia la sospecha. Los ids de las opciones van del
  1 al 9 en orden al azar.
  `timeout_ms` es lo que queda: el plazo corre solo mientras el personaje está en línea y
  activo. Con un chequeo pendiente se manda otra vez, con el mismo `check_id` y el tiempo
  que queda, al volver a entrar y al volver a jugar después de estar inactivo. El servidor
  no vence antes de que se juegue todo `timeout_ms` desde que lo manda, así que
  `ahora + timeout_ms` en el cliente es más tarde que el plazo real solo por la latencia
  (y mientras el jugador está ausente, más temprano: el reloj del servidor se para). Al
  vencer, el servidor no manda nada: el cliente lo cierra solo, 3 s antes de esa hora (con
  un timer, sin esperar mensajes). Una respuesta se manda siempre, aunque la ventana ya
  estuviera vencida en el cliente: si el chequeo sigue pendiente vale, si no, se ignora.
  Si llega otra vez un `check_id` que el cliente ya contestó (el reenvío se cruzó con la
  respuesta), lo ignora. Los chequeos al azar y los
  de GM son idénticos a los de la detección.
- **`PresenceAnswer{check_id, option_id}`**: con un `check_id` que no está pendiente no
  pasa nada. Con el pendiente, correcto o no, la respuesta es siempre el `Message` de
  sistema `presence.thanks`.
- GM: `/presence Nombre` → `gm.presence_sent` (`name`) o `gm.player_offline` (también un
  invisible que el GM no ve) / `gm.protected`. A los GM en línea les llegan
  `gm.bot_suspect` (`name`, `score`), `gm.presence_failed` (`name`) y
  `gm.presence_deferred` (`name`).

### Tutorial (T4.2, `server/internal/session/tutorial.go`)
Pasos en `data/tutorial.yaml` (`06-content-data.md`, "Tutorial"); diseño en
`02-game-design.md`, "Tutorial".
- **`TutorialStep{state, step_id, index, total, text, highlight, progress, count}`**
  (servidor → cliente). `state` = `ACTIVE` (hay paso), `DONE` o `SKIPPED` (terminó, para
  siempre). Con `ACTIVE`: `step_id` del YAML, `index` (desde 0) y `total` contando solo los
  pasos de la vocación del personaje, `text` = clave i18n con el parámetro `count`,
  `highlight` = valor del atributo `data-tutorial` del elemento de UI a resaltar (vacío =
  ninguno) y `progress`/`count` = eventos contados y necesarios. Llega al entrar (si está
  activo), cada vez que cambia el paso o su progreso, y una vez con `DONE`/`SKIPPED` al
  terminar. Al terminar llega además el `Message` de sistema `tutorial.completed` (y el
  premio: `dialog.received_gold`) o `tutorial.skipped`. Un paso de un solo evento que ya
  se cumple al volverse el actual se da por hecho en el acto: la quest ya empezada, el
  contenedor ya abierto, el objetivo ya elegido o la muerte que causó, en ese mismo tick,
  la acción que cerró el paso anterior (un hechizo que mata a su objetivo).
- **`TutorialSkip{}`** (cliente → servidor): termina el tutorial sin premio. Sin tutorial
  activo no pasa nada. **No hay mensaje para completar un paso:** los pasos avanzan con
  eventos del servidor ya validados (un `NpcTalk` fuera de rango, un `SetTarget` inválido o
  un `Walk` rechazado no cuentan).

### NPCs, diálogos y tiendas (T1.10, `server/internal/session/npc.go`)
- `NpcTalk{creature_id}` abre el diálogo de un NPC que el cliente conoce, en el mismo piso
  y a ≤ `TalkRange` (3) casillas (Chebyshev). Fuera de rango → `Message` de sistema
  `dialog.too_far`; un NPC desconocido → `inventory.not_possible`. Un diálogo nuevo cierra
  el anterior. El servidor responde `DialogOpen` con el nodo inicial.
- `DialogOpen` lleva solo las opciones cuyo `if` se cumple ahora; `option_id` es la
  posición de la opción en el nodo (1..9), así que no cambia mientras el nodo está
  abierto. El `text` de una opción puede traer parámetros: una que vende una bendición
  lleva `{price}` (número), lo que le cuesta a este jugador, que crece con su nivel
  (auditoría de contenido M6); el cliente los formatea como los de cualquier mensaje. Las rutas de barco de un nodo `boat_routes: true` (T3.5) van primero, con
  `option_id` 100 + su posición entre las rutas del capitán (101, 102…); elegir una no
  reenvía el nodo: si se rechaza llega solo el `Message` (`travel.*`, `dialog.no_money`)
  y la ventana sigue abierta; si zarpa llegan `DialogClose`, la vista nueva y
  `travel.sailed` (parámetro `island` = id de la isla). El cliente las elige con click o con las teclas 1–9 (la n-ésima mostrada).
- `DialogChoose`: un `dialog_id` viejo se ignora; `option_id` 0 cierra. El servidor vuelve
  a evaluar el `if` (una ventana vieja no sirve para elegir una opción oculta: reenvía el
  nodo) y revisa los costos antes de ejecutar nada (`docs/06-content-data.md`). Si algo
  falla manda el `Message` de rechazo (`dialog.no_money`, `dialog.no_item`...) y reenvía el
  nodo. Si no, ejecuta las acciones, entra al nodo de `goto` (o se queda en el mismo si no
  hay) y manda el `DialogOpen` nuevo; `close` y `teleport` cierran con `DialogClose` (los
  viajes en barco son rutas, `option_id` 101+, ver arriba).
- Alejarse a más de `TalkRange`, cambiar de piso o teletransportarse cierra el diálogo
  (`DialogClose`).
- **Tienda:** la acción `open_shop` manda `ShopOpen{dialog_id, npc_creature_id, money,
  offers}` y el diálogo sigue abierto; la tienda se cierra con el `DialogClose` de ese
  diálogo. Cada `ShopOffer` trae `buy_price` (lo que paga el jugador; 0 = no lo vende),
  `sell_price` (lo que recibe; 0 = no lo compra) y `owned` (unidades en sus contenedores).
- `ShopBuy` es todo o nada: dinero suficiente, capacidad y lugar en la mochila (se
  apila con lo que ya hay, y queda un lugar libre por cada moneda menor para el vuelto)
  o `shop.no_money` / `shop.no_room`. `ShopSell` toma de los
  contenedores, nunca lo equipado (`shop.not_enough`); sus monedas nunca caen al suelo por
  peso: entran aunque el vendedor esté sobrecargado si pesan menos que lo vendido, y si
  pesan más y no caben en su capacidad la venta se rechaza con `shop.no_room` (docs/02
  "Cargas realistas"). Tras cada compra o venta: `Message`
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

### Minimapa (`server/internal/session/minimap.go`, pedido del dueño del 2026-11-23)
Lo explorado vive en el servidor, por personaje (docs/02 "Minimapa"): un bit por casilla,
en sectores de 32x32 de un piso. Un sector se nombra en el protocolo, dentro de su piso, con
`sx << 16 | sy` (`sx = x / 32`, `sy = y / 32`). El bitset de un sector son 128 bytes, fila
por fila: el bit `x % 8` del byte `(y * 32 + x) / 8` (x, y dentro del sector).
- `MinimapIndex{floors}` (campo 50 de `ServerMessage`): una vez al entrar, en el lote del
  `Welcome`, después de `PlayerSkills` y antes del `QuestLog`. Cada `MinimapFloorIndex`
  trae `z` y los sectores de ese piso con algo explorado (también la vista de este login).
  Un sector que no está es negro entero: el cliente no lo pide.
- `MinimapRequest{z, sectors}` (campo 40 de `ClientMessage`): hasta 16 sectores del piso
  **propio** (otro piso se ignora; más de 16, también). El servidor contesta un
  `MinimapSectors` con `answer = true` y un `MinimapSector` por sector pedido (un repetido,
  una vez):
  `explored` (vacío si no tiene nada explorado), `palette` (ids numéricos de items) y
  `tiles` (1024 bytes, uno por casilla en el mismo orden: 0 = sin explorar o sin nada; si
  no, 1 + índice de `palette`). El item de una casilla es el de más arriba que bloquea el
  paso (muro, árbol, roca), o si no su suelo; **nunca** sale una casilla sin explorar.
  Presupuesto por jugador: 32 sectores de golpe, recarga de 32 por segundo exactos (1,6
  por tick; la fracción se arrastra, también para quien pide en cada tick); un pedido que
  no entra se descarta entero, sin respuesta, igual que uno de otro piso (el jugador puede
  haber cambiado de piso mientras viajaba). El cliente da un sector por pedido recién
  cuando le llega su respuesta (`answer`): uno sin respuesta a los 2 s (`REQUEST_RETRY_MS`)
  lo pide otra vez la próxima vez que lo tenga a la vista, aunque nada más haya cambiado.
  El color sale del mapa del servidor **como está ahora** (`world.Map`): una puerta lejana
  ya explorada se ve abierta o cerrada según su estado actual. Es una pista aceptada (solo
  casillas que el personaje ya vio, y cuesta presupuesto).
- **Deltas:** como mucho uno por segundo, `MinimapSectors` con `answer = false` y los
  sectores que ganaron bits desde el anterior, solo con `explored` (sin `palette` ni
  `tiles`): esas casillas están en la vista del cliente, que las colorea con el mapa que
  le mandaron. Un delta **no** da un sector por pedido: si el sector tenía algo explorado
  de logins anteriores y el cliente nunca lo pidió (minimapa plegado, o el delta llegó
  antes que la respuesta), lo pide igual. Nada mientras el jugador camina por lo ya
  explorado. El cliente explora además su propia vista con la misma regla (31x21 del piso
  propio), así la niebla se abre con el paso.
- **Color en el cliente:** `MinimapState` recuerda el item de color de cada casilla que el
  cliente recibe (`FullMapView`, `MapSlice`, `TileUpdate`: `noteTile`), porque `WorldState`
  olvida el mapa a más de 2 chunks del jugador y entero en cada `FullMapView` (escalera,
  teletransporte, muerte): lo explorado en esta sesión sigue coloreado hasta el próximo
  login, que lo trae del servidor. Una casilla que vino en una respuesta se pinta con el
  item de la respuesta (el servidor conoce las marcas del mapa que el cliente no tiene);
  la del mapa recibido, solo si no vino.
- `TrackQuest{quest_id}` (campo 41): sigue una quest **en curso** en el minimapa; vacío, o
  una quest que no está en curso, deja de seguir. El servidor contesta siempre un
  `ObjectiveHint` (campo 52 de `ServerMessage`), también al dejar de seguir y aunque otra
  quest cambie en el mismo tick, y lo manda otra vez en el flush de cada tick en que
  cambia el paso de esa quest (terminada: `quest_id` vacío) o en que una reubicación
  (escalera, teletransporte, barco, despertar en el templo) cambia el lugar más cercano.
  No se guarda: el
  cliente lo manda de nuevo después de cada `Welcome` (lo recuerda por personaje en
  `localStorage` `rpg.track`).
- `ObjectiveHint{quest_id, step_id, center, radius}`: un círculo (radio euclídeo en
  casillas) alrededor de un punto **cercano** al lugar del paso, que puede estar en otro
  piso (`center.z`). Nunca es la casilla exacta: el centro se corre entre un cuarto y la
  mitad del radio (cuando el lugar del paso es grande y no deja ese margen, se corre 1
  casilla y el círculo crece para contenerlo), siempre igual para el mismo personaje, paso
  y lugar (`quest.FuzzHint` con una semilla de personaje, quest, paso y centro del lugar:
  pedirlo muchas veces no lo promedia, y conocer un spawn de un `kill` no da el corrimiento
  de los otros), y el lugar del paso entra entero en el círculo. Un centro que caería
  fuera del mapa se refleja al otro lado del lugar (nunca se recorta encima de él). Con `quest_id` y sin `center`: se sigue la quest
  pero su paso no tiene lugar (un `has_item` o un `flag_equals` sin `hint_area`, docs/06).
  El lugar sale del YAML (`hint_area`) o del paso: el NPC de un `dialog_action` (los NPCs
  no se mueven), el spawn más cercano del monstruo de un `kill` (su piso primero; el más
  cercano a donde el jugador empezó a seguir, avanzó la quest o se reubicó por última vez:
  caminar por el mismo piso no lo recalcula), el lugar de un `reach` (una zona: su
  rectángulo envolvente), las placas de un `sigils`. La pista no revela mapa: el
  cliente dibuja solo el círculo o la flecha, nunca casillas sin explorar.
- Todo agregado sin romper nada: un cliente viejo ignora los campos nuevos y un servidor
  viejo nunca los manda.

### Diario de misiones (`server/internal/session/questlog.go`)
- `QuestLog{entries}` es el diario completo del personaje: una `QuestLogEntry` por quest
  que empezó o terminó, en el orden de su id. Llega **entero** al entrar (en el lote del
  `Welcome`, después de `PlayerSkills`, vacío también: así el cliente sabe que el servidor
  lo tiene) y en el lote de cada tick en que cambió alguna quest del personaje (empezó,
  cumplió un paso, contó una muerte, terminó). Siempre uno solo por tick aunque cambie
  varias veces, también en el del login: si al entrar se cumple un paso `reach` (el
  jugador entra parado en su lugar), ese único `QuestLog` ya lo trae cumplido (el servidor
  lo arma al final del tick, `flushQuestLog`). Solo lo recibe el propio jugador.
- Cada entrada: `quest_id`, `name` (clave i18n del nombre), `chapter` (0 para una
  secundaria o una tarea), `state` (`ACTIVE`, `DONE` o `COOLING`), `repeatable`; en curso,
  `step_id` y `step_text` (clave i18n del texto del paso actual) y, en un paso `kill`,
  `kills` y `kills_needed` (`kills_needed` 0: no es un paso de muertes); una tarea
  terminada trae `available_at`, cuándo se puede tomar otra vez (ms Unix del reloj del
  servidor): `COOLING` si eso todavía no pasó al mandarla, `DONE` si ya pasó. El
  servidor no avisa cuando vence una espera: el cliente compara `available_at` con su
  reloj corregido por `Welcome.server_time`.
- **Quests de hito** (docs/02 "Quests de hito"): después de las entradas de siempre llega
  una por cada hito que el personaje no empezó, con `state` `OPEN` (4). La entrada de un
  hito (en cualquier estado) trae `milestone` (`MilestoneInfo`): `title` (clave i18n del
  título), `level` y `level_met`, el equipo (`gear_item`, id numérico, con
  `gear_equipped`, o `gear_weapon`, un tipo de arma; vacíos si no pide) y `gear_met`,
  `players`, `vocations` (una por placa, o vacía) y `vocation_met`. Las marcas `*_met` son
  del propio personaje al mandarlo; el diario sale otra vez cuando cambian (al subir o
  bajar de nivel, o al cambiar lo que lleva: `questRecheck` compara una huella). Un
  cliente viejo descarta el estado desconocido.
- Mensajes de sistema de las placas: `milestone.waiting` (`quest`, `count`, `total`),
  `milestone.not_ready` (`quest`, `names`), `milestone.fail_step`, `fail_vocation`,
  `fail_level`, `fail_gear` (`quest`), `milestone.blocked` (`quest`), `milestone.staff`,
  `milestone.achieved` (`quest`, `names`: los participantes, a cada uno). Mirar una placa
  agrega `milestone.plates` (`quest`, `count`, `total`) o `milestone.plates_vocation`
  (con `vocation`). Sin mensajes nuevos de cliente: se camina sobre las placas.
- Es solo para mostrar: el servidor decide todo con lo guardado (`quest_state`).
  Agregado sin romper nada (campo 45 de `ServerMessage`): un cliente viejo lo ignora.

### Grupos (T3.3, `server/internal/session/party.go`)
Reglas y números en `02-game-design.md` ("Grupos") y `balance.yaml` `party`.
- **`PartyCommand{action, creature_id, name}`**:
  - `INVITE` (`creature_id` = un jugador que el cliente ve): solo el líder o alguien sin
    grupo. Cuenta para el anti-flood del chat y para `party.invites_per_minute` (por cuenta:
    un relogueo o el otro personaje no lo reinician). Al invitado
    le llega `PartyInvitation{inviter_id, inviter_name, expires_ms}`; al que invita,
    `party.invited` (`name`). Uno que el cliente no ve → `party.player_not_seen`.
  - `INVITE_NAME` (9, agregado sin romper nada; `name` = campo 3, el nombre escrito;
    `creature_id` se ignora): el botón "Invitar" de la ventana de grupo. Las mismas reglas
    que `INVITE`, pero el servidor busca el nombre (exacto, sin importar mayúsculas, sin
    espacios a los lados) entre los jugadores **en línea**, en el loop y sin la base: el
    invitado puede estar en cualquier lado. Desconectado, inexistente o invisible sin ser
    visto → `party.player_not_found` (`name`, tal como se escribió), siempre igual. Un
    `name` vacío o de más de 80 bytes (4 × el nombre más largo) se ignora sin contestar; se
    limpia como el chat (sin caracteres de control) antes de buscarlo y de devolverlo. `/invite Nombre` en la línea de chat hace lo mismo.
  - Respuestas de una invitación, en orden: muteado por flood (`chat.muted`/`chat.flood`),
    límite de invitaciones (`party.invite_rate`, `seconds`: cuánto esperar; el intento
    rechazado no alarga la espera), a sí mismo (`party.invite_self`), no encontrado, no es
    el líder (`party.not_leader`), ya está en un grupo (`party.already_in_party`), grupo
    completo (`party.full`), ya invitado (`party.already_invited`) o `party.invited`.
  - `ACCEPT` / `DECLINE` (`creature_id` = quien invitó). Aceptar una invitación vencida, de
    alguien que ya no lidera o que se fue → `party.invite_gone`. Rechazar le avisa al que
    invitó (`party.declined`, `name`).
  - `LEAVE`; `KICK` y `PASS_LEADER` (`creature_id` = otro miembro, solo el líder);
    `SHARE_ON` / `SHARE_OFF` (solo el líder). `PASS_LEADER` y un `SHARE_*` que cambia algo
    cuentan para el anti-flood del chat (`chat.flood`, `chat.muted`).
- **`PartyUpdate{leader_id, shared, members[], bonus_percent}`**: el grupo completo, en
  orden de llegada, el propio jugador incluido. Llega cuando cambia el grupo (miembros,
  líder, experiencia compartida, indicador) y, como mucho cada `update_ms`, cuando cambia
  lo que el jugador ve de otro miembro. Sin `members` = ya no está en un grupo. `shared`:
  `OFF`, `ACTIVE` (dos o más de los miembros que el jugador ve, él incluido, califican) o
  `INACTIVE`; un grupo nuevo empieza con la experiencia compartida prendida
  (`party.shared_by_default`), así que su primer `PartyUpdate` dice `INACTIVE`.
  `bonus_percent` (campo 4, agregado sin romper nada): el bonus de grupo de los que
  comparten ahora (`bonus_pct_by_sharers` según cuántos miembros tienen `sharing`; dos
  personajes de una cuenta cuentan como uno), 0 salvo con `ACTIVE`. El cliente lo muestra
  en la ventana de grupo y como el estado `party_bonus` de la bandeja (lo arma el cliente:
  no viaja en `PlayerConditions`).
- **`FloatingText.bonus`** (campo 4, agregado sin romper nada; solo `EXPERIENCE`): la parte
  de `amount` que es el bonus de grupo de una muerte compartida (`amount` ya la incluye).
  Lo reciben el que la cobra y los miembros de su grupo; cualquier otro que mira recibe 0.
  El cliente escribe `client.party.xp_bonus` ("126 (+6 grupo)").
- **`PartyMember{creature_id, name, vocation, level, in_view, health_percent,
  mana_percent, island, sharing}`**. Auditoría de información: `health_percent`,
  `mana_percent` y `sharing` valen 0/falso si `in_view` es falso (el que mira no conoce a esa criatura: fuera
  de la ventana o invisible). Fuera de vista solo viaja la isla (`""` en el mar). El mensaje
  no tiene posición ni piso.
- **Chat:** `Say{channel: PARTY}` → `Message{kind: PARTY, speaker_id, speaker_name, text}`
  sin `pos` a todos los miembros. Sin grupo → `party.none`.
- Mensajes de sistema: `party.invited`, `party.player_not_found` (`name`),
  `party.player_not_seen`, `party.already_in_party` (`name`), `party.already_invited`
  (`name`), `party.leave_first`, `party.full`, `party.not_leader`, `party.none`,
  `party.not_a_member`, `party.invite_gone`, `party.invite_usage`, `party.invite_self`,
  `party.invite_rate` (`seconds`), `party.declined`,
  `party.joined`, `party.left`, `party.kicked`, `party.new_leader` (todos con `name`),
  `party.you_were_kicked`, `party.disbanded`, `party.shared_on`, `party.shared_off`,
  `party.shared_default` (al formarse un grupo con la experiencia compartida prendida: lo
  oyen los dos primeros miembros).

### PvP (T5.2, `server/internal/session/pvp.go` y `guildwar.go`)
Reglas y números en `02-game-design.md` ("PvP") y `balance.yaml` `pvp`.
- **`SetSafeMode{enabled}`** (cliente → servidor): el modo seguro. Activado por defecto;
  desde el 2026-11-26 el servidor lo guarda por personaje y el `Welcome` dice el vigente
  ("Opciones guardadas", en "Combate cuerpo a cuerpo"), así que el cliente lo manda solo cada vez
  que cambia el interruptor. Responde `pvp.safe_on` / `pvp.safe_off`.
- **Atacar a un jugador:** el mismo `SetTarget`. El servidor valida en cada ronda (zonas,
  niveles, staff, modo seguro); si deja de valer, suelta el objetivo y manda el motivo.
  `CastSpell` con objetivo (`creature_id`, casilla o el objetivo actual) también alcanza a
  un jugador; las runas igual, y los hechizos de condición a distancia (`entangle`: el
  `Projectile` del elemento, `Effect` 7 en la casilla del jugador y su `PlayerConditions`).
  Motivos de rechazo: `pvp.off`, `pvp.staff`,
  `pvp.protected_staff`, `pvp.your_level` / `pvp.their_level` (`level`), `pvp.zone`,
  `pvp.safe_mode`. El cliente suelta su objetivo al recibir cualquiera de ellos.
- **`Creature.skull`** y **`CreatureSkull{id, skull}`** a quienes ven al jugador (él
  incluido) cuando cambia. `Skull`: `UNSPECIFIED` (sin marca), `AGGRESSOR`, `MURDERER`,
  `OUTLAW`.
- **Mensajes de sistema:** `pvp.kill` / `pvp.kill_unjust` (`name` = la víctima) a cada
  jugador que se llevó la muerte, `pvp.killed_by` (`name`) a la víctima (o
  `pvp.killed_unseen` si no veía a quien la mató),
  `pvp.arena_defeat`, `pvp.skull_gained` (`skull` content_id: `aggressor`, `murderer`,
  `outlaw`, que el cliente traduce como `client.skull.<id>`), `pvp.logout_locked` (un
  `Logout` rechazado: la conexión sigue), `pvp.protection_locked` (con su
  `WalkRejected`), `pvp.skull_removed_staff`, y para el staff `gm.skull_removed` (`name`).
- **Desconexión con bloqueo PvP:** si la conexión se cierra mientras dura el bloqueo, el
  personaje no sale del mundo: queda sin conexión (no recibe nada) y atacable hasta que el
  bloqueo vence; ahí se guarda y sale. Un login de ese personaje en ese tiempo lo retoma
  como un relogueo normal (`Welcome` y vista completa, mismo estado y mismo bloqueo); no hay
  mensaje nuevo ni rechazo. Es el caso PvP de la "Desconexión en combate" de cualquier
  pelea (sección "Handshake").
- **Guerras de gremios** dentro de `GuildCommand` (campo nuevo `war_id`):
  `WAR_DECLARE` (`name` = el gremio enemigo), `WAR_ACCEPT` / `WAR_DECLINE` / `WAR_SURRENDER`
  (`war_id`). Solo el líder. Por chat: `/guild war declare|accept|decline|surrender Gremio`.
  `GuildUpdate.wars` = `GuildWar{war_id, enemy_name, state (PENDING|ACTIVE),
  declared_by_us, our_kills, their_kills, kill_limit, ends_ms}`: las declaradas y las
  activas; las terminadas no se listan. Mensajes (`guild` = el otro gremio): `guild.war_off`,
  `guild.war_no_guild`, `guild.war_self`, `guild.war_exists`, `guild.war_too_many`
  (`count`), `guild.war_enemy_busy`, `guild.war_declared`, `guild.war_declared_on_us`,
  `guild.war_started` (`kills`), `guild.war_declined`, `guild.war_expired`,
  `guild.war_won` / `guild.war_lost` / `guild.war_draw` (`our_kills`, `their_kills`),
  `guild.war_surrendered`, `guild.war_disbanded`, `guild.war_not_found`.

### Intercambio y mercado (T5.3, `server/internal/session/trade.go` y `market.go`)
Reglas y números en `02-game-design.md` ("Economía") y `balance.yaml` `trade` y `market`.
- **Intercambio.** `TradeRequest{creature_id}` invita a un jugador adyacente; el invitado
  acepta mandando `TradeRequest` con el `creature_id` de quien lo invitó (o rechaza con
  `TradeCancel`). Ambos opcionalmente ofrecen ya un item (`item`, `item_id`,
  `stack_index`). `TradeOffer` agrega un item de un contenedor abierto (la pila entera, o
  un contenedor vacío) o, con `remove`, saca el ofrecido en `index`. `TradeAccept`
  confirma; con las dos confirmaciones el servidor intercambia en el mismo tick.
  `TradeUpdate{state, partner_creature_id, partner_name, own_offer[], partner_offer[],
  own_accepted, partner_accepted, invited, reason, max_items}` llega a los dos tras cada
  cambio. `REQUESTED` = invitación pendiente (`invited` en quien la recibió);
  `NEGOTIATING`; `COMPLETED` y `CANCELLED` cierran la ventana. `reason` es la clave i18n
  del motivo (`trade.cancel.too_far`, `died`, `combat`, `left`, `expired`, `no_room`,
  `staff`, `read_only`; vacío si un jugador la cerró), que el cliente muestra en el log.
  Mensajes: `trade.unavailable`, `trade.busy`, `trade.too_far`, `trade.bad_item`,
  `trade.offer_full` (`max`), `trade.staff`, `trade.combat`, `trade.completed`,
  `trade.empty` (confirmar sin nada ofrecido), `trade.too_fast` (anti-flood),
  `trade.read_only`.
- **Mercado.** Se abre con `UseItem` sobre un tablero del mapa (item con
  `market_board: true`); el servidor contesta `MarketUpdate{open: true, ...}`. Cada
  `MarketCommand` exige seguir junto al tablero y responde otra `MarketUpdate` completa:
  `browse{item_id}`, `create{side, item_id, amount, price, duration_index, mods}`,
  `cancel{offer_id}`, `accept{offer_id, amount, mods}`, `withdraw{}` y `close{}` (sin
  respuesta). **Equipables** (docs/02 "Atributos de items"): vender uno, en `create` con
  `side` SELL o en `accept` de una oferta de compra, es una instancia: `amount` 1 y `mods`
  = los de la instancia elegida (sin `mods`: una sin atributo); otra cantidad responde
  `market.bad_amount` (`max` 1) y unos `mods` que el jugador no tiene en la mochila
  `market.not_enough_items`. `mods` es solo una clave para encontrarla: la instancia
  conserva los suyos. `MarketUpdate`: `money`, el item buscado con sus mejores `sells` / `buys`
  (`MarketOffer{offer_id, side, item_id, amount, price, expires_at, owner_name, own, mods}`;
  `mods`, en una oferta de venta de un equipable, los de su instancia: cada una es una fila),
  hasta `list_size` por lado, en orden de precio; en las ventas de un equipable, después
  de esas, la más barata de cada clase de pieza que quede, un par atributo y nivel de
  refinado, para que una pieza refinada o un atributo raro más caros se vean: docs/02
  "Atributos de items", Mercado) y `reference_price`, las ofertas propias (`own`), el buzón
  (`mailbox_gold`, `mailbox_items` hasta `mailbox_shown` y `mailbox_more`), el
  `history` propio (más nuevo primero), las reglas del formulario (`fee_permille`,
  `fee_min`, `fee_max`, `max_offers`, `max_amount`, `max_price`, `durations_hours`) y
  `owned` (unidades del item buscado en la mochila; si es un equipable, `owned_mods` trae
  los `mods` de cada una para elegir cuál vender: primero el refinado más bajo y después la
  tirada más floja, como `spareFirst`, así la opción de entrada nunca es la pieza más
  refinada; el cliente nombra cada opción con su nivel, "+7 espada · +3 ataque") y
  `read_only` (solo se puede buscar hasta que el servidor reinicie; las demás acciones
  responden `market.read_only`).
  `open: false` cierra la ventana (el jugador se alejó). `withdraw` entrega primero los
  items en orden mientras entren y después todo el oro que entre.
  **Refresco en vivo:** el servidor también manda, por su cuenta, una `MarketUpdate`
  completa con `refresh: true` cuando la acción de otro cambia lo que la ventana abierta
  muestra (ofertas del item buscado, ofertas propias, buzón, una suspensión, o el dinero e
  items propios tras un intercambio; también al pasar a solo lectura). Sale al final del
  tick, una por ventana y como mucho cada `market.push_every_ms` de `balance.yaml`
  (500 ms; lo que cambie entre medio sale al terminar ese plazo); quien actúa recibe solo
  la respuesta a su comando (`refresh: false`). El cliente aplica un `refresh` solo si la
  ventana sigue abierta: uno que se cruzó con el `close{}` no la vuelve a abrir. Mientras
  la ventana muestra el mismo `item_id`, el cliente no cambia el precio que propone el
  formulario de crear aunque cambie `reference_price`.
  **Clientes viejos:** `refresh` es un campo nuevo y aditivo, así que no se subió
  `-min-client-version` (el proyecto nunca lo subió por un campo aditivo: el cliente web se
  sirve con el servidor y siempre es el actual). Una app de escritorio o móvil anterior lo
  ignora y trata el refresco como una respuesta: actualiza la ventana abierta igual, y en
  el caso raro de que el refresco se cruce con su `close{}`, la vuelve a abrir (cosmético;
  se cierra con el botón o al alejarse). Si hace falta dejarlas fuera, se sube
  `-min-client-version` junto con `client/package.json` (docs/09). Precios en la moneda más chica, fechas en ms Unix. Mensajes:
  `market.closed`, `staff`, `too_fast`, `not_at_board`, `bad_item`, `bad_amount` (`max`),
  `bad_price` (`max`), `too_many_offers` (`max`), `not_enough_items`, `not_enough_money`
  (`price`), `no_room`, `offer_gone`, `own_offer`, `created` (`item`, `fee`), `cancelled`
  (`item`), `bought` / `sold` (`item`, `price`), `offer_filled` y `offer_expired` (al
  dueño), `withdrawn` (`price`), `mailbox_empty`, `mailbox_room`; staff:
  `gm.market_offer_sell` / `gm.market_offer_buy` (`id`, `name`, `item`, `price`),
  `gm.market_none`, `gm.market_cancelled`, `gm.market_unknown`.
- **Falla segura** (docs/01 "Transacciones"): si un cambio del comercio no se pudo
  guardar, sus personajes reciben `Disconnect{SAVE_FAILED}` y sus logins
  `Disconnect{CHARACTER_LOCKED}` hasta que el servidor reinicie. Mientras la base no
  confirma un cambio de comercio o de casa de un personaje, un `MoveItem` suyo hacia el
  suelo fuera de una casa (desde lo que lleva, desde su propio cadáver o desde lo que el
  servidor dejó a sus pies) se rechaza con `inventory.saving`, y su cadáver sigue
  reservado para él (`death.corpse_not_owner`). Lo que el servidor le deja a sus pies
  fuera de una casa en ese tiempo (no le entraba) también: el `MoveItem`, `UseItem` o
  `UseItemOn` de otro sobre eso responde `inventory.not_yours`. Lo mismo vale para lo
  que alguien saca del suelo de una casa al suelo público (directo, a una pila o a un
  contenedor apoyado ahí): queda reservado para quien lo sacó hasta que la base confirma
  esa escritura de la casa, y meter algo en un contenedor del suelo reservado a otro
  también responde `inventory.not_yours`. Lo que sale de una casa se suma solo a una pila
  ya reservada a quien lo saca (si no, cae como pila aparte) y entra solo en un
  contenedor del suelo ya reservado a él: llevarlo directo a otro contenedor de la calle
  (una mochila ajena, un cadáver) responde `inventory.floor_first`. El cadáver que el
  personaje deja mientras espera también queda reservado para él hasta la confirmación;
  uno de antes de la espera no.

### Baúl de la cuenta (`server/internal/session/stash.go`)
Reglas en `02-game-design.md` ("Baúl de la cuenta") y `balance.yaml stash`.
- **Abrir:** `UseItem` sobre un item del mapa con `stash: true` (`stash_chest`) a 1 casilla;
  el servidor contesta `StashUpdate{open: true, capacity, items, chest, result: OK}`. Sin
  baúl (apagado, sin transfers, mundo en solo lectura, staff) `result: UNAVAILABLE`; lejos,
  `TOO_FAR` (con `open: false`).
- `StashCommand` (oneof):
  - `deposit{from, item_id, count}`: `from` es un slot de equipo, un contenedor abierto que
    el jugador lleva o un bolsillo (nunca el suelo); `count` solo para pilas (1..la pila).
    Una pila con `mods` o contenido es una sola instancia: entra entera (un `count` menor es
    `NOT_POSSIBLE`), igual que sale.
  - `withdraw{index, item_id, mods, count}`: `index` es la celda; `item_id` y `mods` son lo
    que el cliente vio ahí (clave de comparación, como en `Refine`): si otro personaje de la
    cuenta lo movió, `CHANGED`. `count` solo para pilas: 0 es `NOT_POSSIBLE` y más que las
    unidades que quedan es `CHANGED` (otro personaje sacó parte). Solo una pila sin `mods`
    ni contenido se divide; una pila con `mods` sale entera (el `count` solo tiene que caber
    en ella). Va a la mochila y después a los bolsillos.
  - `close{}`: cierra (contesta `StashUpdate{open: false}`).
- Toda acción contesta un `StashUpdate` entero con su `result` (`StashResult`): `OK`,
  `FULL`, `NO_ROOM`, `TOO_HEAVY`, `TOO_FAR` (y cierra), `CHANGED`, `NOT_ALLOWED` (no
  comerciable, ofrecido en un intercambio), `TOO_FAST` (anti-flood), `UNAVAILABLE`,
  `NOT_POSSIBLE` (también un `deposit` o `withdraw` sin la ventana abierta: sin `chest`, y
  bajo el mismo anti-flood, que pasada la ráfaga los descarta sin contestar), `IN_COMBAT`
  (bloqueo PvP). El cliente muestra la clave
  `client.stash.result.<código>` en el log. Un cambio hecho por otro personaje de la cuenta
  con la ventana abierta le llega como `StashUpdate` con `OK`. Moverse lejos del cofre manda
  `StashUpdate{open: false}`; un mundo que pasa a solo lectura (`Tainted`) cierra todas.
- **Persistencia:** cada movimiento que se hizo sale como un `Transfer` con el snapshot del
  personaje y un `StashOp` (todas las celdas de la cuenta, `account_stash_items`, migración
  00025), en una transacción. El login lee el baúl con el personaje
  (`PlayCharacter.Stash`); el loop lo usa solo si no tiene ya el de esa cuenta en memoria.
  Si al cargarlo un equipable guardado sin atributo tira uno, el baúl se escribe en el acto
  (un `Transfer` con el snapshot del que entró): salir y entrar no vuelve a tirarlo. El baúl
  en memoria no se suelta mientras un login de la cuenta no lo tomó (`join` resta el login
  de la cuenta recién después de darle el baúl), así que reentrar con el mismo personaje no
  lo rearma con una lectura vieja.
  `LoginStarted` y `LoginAborted` llevan la cuenta además del personaje (docs/01).

### Casas (T5.4, `server/internal/session/house.go`)
Reglas y números en `02-game-design.md` ("Casas") y `balance.yaml houses`.
- **Abrir:** `UseItem` sobre una casilla de **puerta** de una casa (cualquier índice de la
  pila; si hay items sueltos en la puerta, sobre ellos se usan como siempre) a hasta 3
  casillas; el servidor contesta `HouseUpdate{open: true, ...}`. El cliente conoce las
  puertas por `houses.yaml` (plugin de Vite) para mandar el `UseItem` con el suelo
  (`stack_index` 0) cuando la casilla no tiene nada encima. `LookAt` sobre una puerta,
  además del mensaje de siempre, manda `house.look_free` (`house`, `price`, `days`,
  `size`) o `house.look_owned` (`house`, `name`).
- `HouseCommand` exige seguir junto a una puerta o dentro de la casa y responde otra
  `HouseUpdate` completa: `rent{}`, `extend{}`, `leave{}`, `guest_add{name}`,
  `guest_remove{name}`, `guild_access{enabled}`, `transfer_offer{name, price}` (a
  alguien conectado; un invisible que el dueño no ve o alguien del personal cuenta como
  desconectado, `house.transfer_bad`, igual que en las invitaciones de gremio y grupo:
  la oferta no revela quién está en línea, lote 16),
  `transfer_cancel{}`, `transfer_accept{house_id, price}` (lo que vio: si la oferta cambió,
  `house.transfer_changed`), `enter{}` (con acceso, a hasta 3 casillas de una puerta: a una
  casilla libre adentro junto a ella; `house.crowded` si no hay), `exit{}` (de adentro a la
  salida) y `close{}` (sin respuesta). La ventana se abre y se usa a hasta 3 casillas de
  una puerta o dentro de la casa. Fuera de `rent`, `transfer_accept`, `enter` y `exit`,
  solo el dueño.
- `HouseUpdate`: `house_id`, `name` (clave i18n), `island`, `rent` y `period_days`,
  `size`, `owner` (vacío: libre), `is_owner`, solo para el dueño `paid_until` (ms Unix),
  `guests` y `guild_access`; `max_guests`, `items` / `max_items`, `min_level`,
  `max_periods`, la transferencia pendiente (`transfer_to`, `transfer_price`; para el
  invitado `transfer_for_me`), `money`, `read_only`, `access` (puede entrar) e `inside`
  (está adentro). `open:
  false` cierra la ventana (se alejó de la puerta).
- Pasar a una casilla de casa sin acceso: `WalkRejected` y `house.no_access`. Mover items
  desde o hacia una casa: `house.no_access`, `house.owner_only` (un invitado saca algo),
  `house.full` (`max`), `house.too_fast`, `house.read_only`.
- Mensajes (`house` es un `content_id`: el cliente lo traduce como `house.<id>.name`):
  `house.closed`, `staff`, `not_at_door`, `too_fast`, `read_only`, `no_access`,
  `level_required` (`level`), `has_house`, `taken`, `not_enough_money` (`price`),
  `rented` (`house`, `days`, `price`), `extended`, `max_periods` (`max`), `left`,
  `not_owner`, `guest_bad_name`, `guests_full` (`max`), `guest_added` /
  `guest_removed` (`name`), `guild_on` / `guild_off`, `transfer_bad`,
  `transfer_offered` / `transfer_for_you` (`house`, `name`, `price`), `transfer_none`,
  `transfer_cancelled`, `transfer_done`, `transferred_away`, `full`, `owner_only`,
  `expelled`, `renewed` (`house`, `price`), `lost_unpaid`, `evicted`, `items_mailed`
  (`house`, `count`); staff: `gm.house_info` (`id`, `name`, `until`, `guests`, `items`),
  `gm.house_free`, `gm.house_unknown`, `gm.house_evicted`, `gm.house_moved`,
  `gm.house_no_target`.
- `GET /api/houses` (público, sin cuenta): `{houses: [{id, name, island, rent, size,
  taken, owner}]}`, todas las casas del mapa; `taken` dice si está alquilada y `owner` es
  el nombre del personaje, o `""` si está libre o el dueño no se muestra (personal,
  cuentas deshabilitadas o suspendidas, como el ranking). Cache de
  60 s, límite por IP y cupos de consulta compartidos con `/api/guilds`.

### Mundo vivo (`server/internal/session/livingworld.go`, `proto/game/v1/livingworld.proto`)
Reglas y contrato en `livingworld/README.md`. El objeto es **un item más de la casilla**:
`FullMapView`, `MapSlice` y `TileUpdate` lo mandan encima de los items del mapa y debajo de
los sueltos, así que su `stack_index` es `1 + len(items del mapa)`. Cuando se rompe, se mueve,
se abre o vuelve, llega el `TileUpdate` de la casilla (y el de la de destino en un empuje).
- **Golpear:** `UseItem{from: pos, item_id, stack_index}` sobre el objeto: un golpe con el
  arma de la mano derecha (o a mano limpia). `UseItemOn` de un hacha o un pico con `to: pos`:
  un golpe de herramienta. Un hechizo o runa de área de fuego golpea los que arden en su
  área. Respuestas: `living.wrong_way`, `living.already_broken`, `inventory.too_far`, la de
  sin línea de visión y `gather.not_ready` (el ritmo de los oficios). Usar un empujable dice
  `living.push_hint`; un rastrillo cerrado, `living.gate_closed`.
- **Empujar:** `PushObject{pos, dir}` (cliente → servidor): el jugador está en la casilla
  de al lado y empuja en línea recta (norte, este, sur u oeste). Lo manda el cliente cuando
  una tecla lo haría caminar contra un objeto con `living: pushable` en el contenido. A lo
  sumo uno cada `balance.living.push_cooldown_ms` (400 ms; uno antes se ignora); `living.push_blocked` si la casilla de atrás no
  está libre, `inventory.not_possible` si ya no hay nada (otro lo empujó en el mismo tick),
  `inventory.too_far` si no está al lado.
- **`LivingObjectEvent`** (servidor → cliente, a quien ve la casilla, en el mismo batch que
  su `TileUpdate`): `kind` (`HIT`, `BREAK`, `RESPAWN`, `PUSH`, `GATE_OPEN`, `GATE_CLOSE`,
  `FADE`, `RESET`), `pos`, `to` (empuje y vuelta), `item_id`, `effect` (material de las
  partículas), `sound` (id de `assets/sounds.yaml`) y `hp_permille` (lo que le queda tras
  un golpe).
- **`WorldClock`** (servidor → cliente, `ServerMessage.world_clock` = 53; día y noche,
  `server/internal/session/daynight.go`, `livingworld/README.md` "Día y noche"): `day`
  (ciclos desde la época del mundo: la luna del cielo es la de `day mod lunar_days`, salvo en
  el amanecer, que conserva la de la noche anterior, `(day - 1) mod lunar_days`: una noche
  pertenece al día en que cayó; el `/time` del staff informa esa misma fase), `cycle_ms`
  (cuánto va del ciclo: 0 empieza el amanecer, `day_minutes` empieza la noche) y `rate`
  (ms del mundo por ms real: 1 normal, 0 detenido por el staff). Llega justo después del
  `Welcome`, a todos cada `sync_seconds` (60) de `data/livingworld/daynight.yaml` mientras
  el reloj corre (detenido, `rate` 0, no hay nada nuevo que decir y no se repite) y en el
  acto después de un `/time` (docs/16). El cliente lo lleva adelante a `rate` entre dos y
  dibuja con él la luz, las lámparas y las sombras; ninguna regla depende de la hora. Sin
  `daynight.yaml` el servidor no lo manda y el cliente dibuja el mediodía (también un
  cliente viejo lo ignora). El mensaje no lleva el largo del ciclo: el cliente lo toma de su
  propia copia de `daynight.yaml`, empaquetada en el build junto con la del servidor; un
  cliente y un servidor desplegados con datos distintos interpretarían mal `cycle_ms`. Los
  servidores del E2E arrancan con `-world-time noon` (solo desarrollo y test): la hora
  queda detenida al mediodía del día 0, para que las capturas no dependan de la hora real.

### Puertas (`server/internal/session/door.go`)
Reglas en `02-game-design.md` ("Puertas con llave"); los items en `data/items/doors.yaml`.
- **Usar:** `UseItem{from: pos, item_id, stack_index}` sobre el item de la puerta (índice
  ≥ 1 de la pila), en el mismo piso, a la vista y a `inventory.reach` (si no, `too_far`).
  Un `item_id` que no es el de la casilla (una vista vieja), otro piso o una casilla fuera
  de la vista no son un uso de puerta: siguen como cualquier `UseItem`. Ni `UseItem`
  (puertas, puertas de casas, tableros del mercado, estaciones de crafteo, items del
  suelo), ni `UseItemOn` de una herramienta sobre una casilla (recolección), ni `Craft`
  miran una casilla de otro piso o fuera de la vista: la respuesta es
  `inventory.not_possible` para cualquier casilla y no dice qué hay ni si la puerta está
  abierta o cerrada. No hay mensajes nuevos en el protocolo.
- **Respuesta:** la puerta cambia por su par y quien ve la casilla recibe su
  `TileUpdate`; el cliente decide qué se camina por el item, así que no necesita más. Al
  que la usó, si tiene llave: `door.unlocked` / `door.relocked` (`item`: la llave); si la
  abre sin llave desde la sala de atrás: `door.unbarred`. Una puerta sin llave no manda
  mensaje.
- **Rechazos** (la puerta queda como estaba): `door.locked` (trabada y sin llave desde
  afuera), `door.no_key` (cerrarla con llave sin la llave), `door.blocked` (una criatura o
  un item en su casilla), `door.shut_in` (un jugador sin la llave en la sala) y
  `door.not_ready` (usó una puerta hace menos de `inventory.door_cooldown_ms`, 500 ms: la
  abrió, la cerró o se lo rechazaron; un rechazo también empieza la espera).

### Portales (`server/internal/session/portal.go`)
Reglas en `02-game-design.md` ("Cambiar de piso"); el mapa en `portals.yaml` (docs/03).
No hay mensajes nuevos en el protocolo: un portal es un teletransporte.
- **Escalera, agujero, teletransporte:** un paso (`Walk` o un paso de `WalkPath`) sobre su
  casilla. El paso se valida como cualquiera y además el otro extremo tiene que recibir al
  jugador. Si lo recibe, el batch de ese tick trae primero el `CreatureMove` del paso
  (también a quienes lo ven) y después, como un `/tp`: `CreatureDisappear` de lo que el
  cliente conocía y `FullMapView` del destino (con el piso nuevo); los observadores del
  origen reciben `CreatureDisappear` y los del destino `CreatureAppear`. Sin `MapSlice`
  del piso de origen: el `FullMapView` reemplaza la vista. El paso pendiente del cliente
  queda resuelto por el `FullMapView`, la cola de pasos se vacía y empieza otra época de
  caminata (`walk_epoch`). El cliente no predice pasos más allá de una escalera, un agujero
  o un teletransporte. Subir y bajar sin
  parar cuesta un `FullMapView` por paso: en la mina volcánica, 471 bytes arriba y 308
  abajo, unos 950 B/s al ritmo de un nivel 30 (docs/07; lo mide
  `TestVolcanicMineStairsOnTheMap`).
- **Escalera de mano:** `UseItem{from: pos, item_id, stack_index}` sobre la casilla con el
  suelo (índice 0) o un item fijo de su pila, en el mismo piso, a la vista y a
  `inventory.reach` (si no, `too_far`), con línea de visión (si no, `magic.no_sight`: solo
  importa con un alcance mayor que 1). Un `item_id` que no es el de la casilla →
  `inventory.not_possible`. El cliente manda siempre el suelo, aunque haya items encima
  (un cadáver, monedas): lo de encima no tapa la escalera. Un `UseItem` con el índice de
  un item tirado encima usa ese item, no trepa: es lo que manda Ctrl+click derecho (y
  "Abrir"/"Usar" del toque largo). Respuesta: `FullMapView` como arriba.
- **Punto de soga:** `UseItemOn{from: <la soga>, to: {pos}}` con un item cuyo `tool.use` es
  `rope`, llevado por el jugador, al mismo alcance y con línea de visión. Un `UseItem`
  sobre la casilla responde
  `portal.need_rope`; otra herramienta sigue como recolección (`gather.nothing`).
- **Rechazos** (nada cambia): `portal.blocked` (ninguna casilla libre en el destino ni a
  `travel.arrival_radius`; un paso rechazado así llega además con `WalkRejected`),
  `portal.not_ready` (escalera de mano o soga a mitad de un paso) y
  `pvp.protection_locked` (atacante con bloqueo hacia una zona protegida).
- Un portal `boat` no hace nada: se camina sobre él como sobre cualquier casilla.
- **Items:** un `MoveItem` a la entrada de una escalera, un agujero o un teletransporte
  deja el item del otro lado (ver `MoveItem` en "Items e inventario"): `TileUpdate` de la casilla
  donde cae a quien la ve, o `portal.no_room` si no hay dónde.

### Gremios (T5.1, `server/internal/session/guild.go`)
Reglas y números en `02-game-design.md` ("Gremios") y `balance.yaml` `guild`.
- **`GuildCommand{action, name, text, guild_id, war_id}`** (`war_id`: T5.2). Los miembros se nombran por nombre de
  personaje (pueden estar desconectados). Cada comando cuenta para el anti-flood del chat.
  - `CREATE` (`name` = el gremio), `INVITE` / `REVOKE` (`name` = un personaje conectado),
    `ACCEPT` / `DECLINE` (`guild_id` de la invitación), `LEAVE`, `KICK`, `PROMOTE`,
    `DEMOTE`, `TRANSFER` (`name` = un miembro), `MOTD` (`text`; vacío lo borra) y
    `DISBAND` (`name` repite el nombre del gremio, como confirmación).
  - El chat hace lo mismo: `/guild create|invite|revoke|accept|decline|leave|kick|promote|
    demote|motd|transfer|disband ...`; `accept`, `decline` y `disband` llevan el nombre del
    gremio. Sin argumentos o con una acción desconocida → `guild.usage`.
- **`GuildUpdate{guild_id, name, motd, rank, members[], pending[], invitations[], wars[]}`**: el
  estado completo, al entrar al mundo y cada vez que cambia (miembros, rangos, quién está
  en línea, mensaje del día, invitaciones), como mucho uno por tick. `guild_id` 0 = sin
  gremio. `members` = `GuildMember{name, rank, online}`, de mayor rango a menor y por
  antigüedad. `pending` = `GuildPendingInvite{name, expires_ms}`, solo para vicelíderes y
  el líder. `invitations` = `GuildInvitation{guild_id, guild_name, expires_ms}`: las
  invitaciones vigentes al propio jugador. Auditoría de información: de los otros miembros
  solo viajan nombre, rango y si están en línea; nunca posición, nivel ni vida.
- **`Creature.guild`** (nombre del gremio de un jugador, vacío si no tiene) y
  **`CreatureGuild{id, guild}`** a quienes ven a ese jugador cuando cambia (entra, sale,
  lo expulsan, se renombra o se disuelve).
- **`LookAt{creature_id}`** (T5.1): mirar una criatura que el cliente ve. Un jugador →
  `look.player` (`name`, `vocation` content_id, `level`) o `look.player_guild` (además
  `guild` y `rank` content_id: `leader`, `vice` o `member`). Un monstruo → `look.monster`
  (`monster`), un NPC → `look.npc` (`npc`). Una criatura que no ve → `inventory.not_possible`.
- **Chat:** `Say{channel: GUILD}` → `Message{kind: GUILD, speaker_id, speaker_name, text}`
  sin `pos` a los miembros conectados. Sin gremio → `guild.none`.
- Mensajes de sistema: `guild.unavailable`, `guild.usage`, `guild.none`,
  `guild.already_member`, `guild.level` (`level`), `guild.cost` (`amount`),
  `guild.name_length` / `guild.name_chars` / `guild.name_reserved` (`min`, `max`, `words`),
  `guild.name_taken` (`name`), `guild.created` (`guild`, `amount`), `guild.no_permission`,
  `guild.player_offline`, `guild.target_in_guild`, `guild.already_invited`,
  `guild.invite_sent`, `guild.invite_revoked`, `guild.invite_unknown`,
  `guild.not_a_member`, `guild.same_rank`, `guild.joined`, `guild.left`, `guild.promoted`,
  `guild.demoted`, `guild.motd_changed`, `guild.new_leader` (con `name`), `guild.self`,
  `guild.too_many_invites` / `guild.full` / `guild.too_many_vices` / `guild.motd_too_long`
  (`max`), `guild.invited_you` (`guild`, `name`), `guild.no_invite`, `guild.invite_gone`,
  `guild.leave_first`, `guild.declined` / `guild.you_left` / `guild.you_were_kicked` /
  `guild.disbanded` / `guild.disbanded_staff` / `guild.renamed_staff` /
  `guild.disband_confirm` (`guild`), `guild.kicked` (`name`, `by`),
  `guild.leader_cannot_leave`. Staff: `gm.guild_not_found` (`guild`), `gm.guild_renamed`
  (`guild`, `name`), `gm.guild_disbanded` (`guild`).

### Condiciones (T3.2, `server/internal/session/condition.go`)
Reglas en `02-game-design.md` ("Condiciones").
- **`PlayerConditions{conditions: [ActiveCondition{condition_id, remaining_ms, ticks}]}`**:
  la lista completa de las condiciones propias. Llega al entrar (si tiene alguna) y al
  final del tick en que alguna empezó, cambió (un golpe más, se apiló) o terminó; una lista
  vacía = ninguna. `remaining_ms` es lo que falta hasta el final, o en una de daño los
  golpes que quedan × su intervalo. Las condiciones de otras criaturas no se mandan.
- **Estados** (lote 13, `server/internal/session/status.go`; reglas en `02-game-design.md`,
  "Estados del personaje"): después de las condiciones, la misma lista lleva hasta tres
  entradas con ids que no son de `balance.yaml`: `in_combat` (el bloqueo de logout,
  `remaining_ms` hasta que se puede salir; llega al empezar la pelea, otra vez si su fin se
  movió 1 s o más, y la lista sin él cuando termina: con eso el cliente cuenta los segundos
  en la bandeja y bloquea el botón "Salir del juego"), `pvp_locked` (el bloqueo PvP del atacante,
  hasta que vence) y `protection_zone` (parado en una zona de protección; `remaining_ms` 0
  = sin fin, solo en ella: el cliente lo decide por el id, y cualquier otra entrada con 0
  está terminando). `ticks` es 0 en las tres. Es aditivo: un cliente viejo las mostraría como
  condiciones desconocidas. El servidor las lee del jugador al final de cada tick (una
  consulta al mapa y unas comparaciones por jugador) y manda la lista otra vez cuando una
  empieza o termina, o cuando su fin se movió 1 s o más de lo que el cliente sabe
  (`statusSlack`): una pelea mueve el fin del bloqueo con cada golpe y así cuesta a lo
  sumo una lista por segundo. El cliente cuenta para atrás lo último que supo: su ícono
  puede terminar hasta 1 s antes o después que el bloqueo, y la lista sin él llega en el
  tick en que el bloqueo termina de verdad. El botón "Salir del juego" bloqueado cuenta
  con ese mismo `remaining_ms`: puede verse libre hasta 1 s antes de tiempo, y un `Logout`
  en ese segundo se rechaza como siempre (`combat.logout_locked` o `pvp.logout_locked`,
  con su `seconds`).
- **Daño periódico**: cada golpe es un golpe más (`Effect 10 + elemento`, `FloatingText`,
  `CreatureHealth`, `PlayerStats` al afectado).
- **Velocidad**: el afectado recibe `PlayerStats.speed` y quien lo ve `CreatureSpeed`; los
  `CreatureMove.duration_ms` siguientes ya usan la velocidad nueva.
- **Efecto 7** (`EffectBuff`): un hechizo de condición sobre su objetivo o una cura.
- `magic.nothing_to_cure`: una cura sin nada que curar (no gasta maná).
- **Invisibilidad, filtrada en el servidor**: al volverse invisible, quien lo conocía recibe
  `CreatureDisappear{reason: TELEPORT}` (como si se hubiera ido: nada dice que sigue ahí). Mientras dure, nadie más lo recibe: ni en `FullMapView` /
  `MapSlice`, ni `CreatureAppear` o `CreatureMove`, ni sus golpes, curas o vida
  (`Effect`, `FloatingText`, `CreatureHealth`), ni un `Projectile` hacia él. Su chat local
  llega con su nombre pero sin `pos`. Al terminar le llega `CreatureAppear` a quien ve su
  casilla. Solo su propio cliente lo sigue recibiendo (y lo dibuja semitransparente).
  Un invisible sigue ocupando su casilla: quien intente pisarla recibe `WalkRejected` (un
  camino por click vuelve y lo rodea) y los monstruos lo esquivan. Es una pista aceptada.

### Quién ataca y por qué sale una criatura (A9, `server/internal/session/attack.go`)
Para que el cliente anime el golpe, el disparo o el conjuro del atacante y la caída de
quien muere (`17-direccion-de-arte-y-ui.md`, ANI-7) sin adivinarlos. `Welcome.attack_events`
dice que el servidor los manda.
- **`CreatureAttack{id, kind, target_id, to, radius}`**: la criatura `id` atacó. Sale
  solo cuando el ataque ocurre (la ronda tocó, pasó los chequeos de rango, línea de visión
  y PvP, y, en un monstruo, su `chance`), en el batch del ataque y **antes** de su
  `Projectile`, `Effect` y `FloatingText`.
  - `kind`: `MELEE` (un golpe a una casilla: arma, puños, el ataque `melee` de un
    monstruo), `RANGED` (un disparo: arma a distancia, varita, el ataque `distance` de un
    monstruo), `SPELL` (un hechizo o una runa sobre una criatura, un hechizo de área, el
    ataque `spell` de un monstruo).
  - `target_id`: la criatura atacada, si el cliente la conoce; 0 en un hechizo de área o
    si el objetivo está fuera de su ventana.
  - `to`: la casilla del objetivo; con el objetivo fuera de la ventana, el borde de la
    ventana de su lado, en línea con el atacante (como `Projectile`); en un área, su centro
    (la casilla de quien lo lanza). `radius`: el radio del área; 0 si es a un objetivo.
  - Un hechizo de área es **un** `CreatureAttack`, no uno por criatura alcanzada.
  - **El área de un monstruo** (`area` de un ataque, docs/02 "Monstruos", "Habilidades";
    sin cambios en el protocolo) también es uno, sin `target_id`, con el `kind` de su
    ataque (`MELEE`, `RANGED` o `SPELL`), seguido de un `Effect` de su elemento
    (`10 + elemento`) en cada casilla del área y del golpe de cada jugador alcanzado. Un
    círculo va con su centro (el monstruo o su objetivo) y su radio; un **rayo**, como el
    círculo de su largo alrededor del monstruo (`to` = la casilla del monstruo,
    `radius` = el largo: el cliente juega el conjuro hacia donde mira, y el monstruo se
    gira hacia su objetivo antes; las casillas del rayo son sus `Effect`). La punta de un
    rayo en diagonal queda fuera de ese círculo (a largo 4, la casilla a 4 y 4): el
    cliente busca quién causó un golpe en el círculo o en las 8 líneas de ese largo desde
    el centro (`areaCovers` en `client/src/render/creature-events.ts`). Un círculo
    alrededor del objetivo sale con su `Projectile` (si el ataque no es `melee`). Quien
    conoce al monstruo pero no ve el centro (un objetivo fuera de su ventana) recibe solo
    el lado, sin `radius`, como un ataque a alguien que no conoce. Un área apuntada a un
    invisible (el círculo en su casilla, el rayo hacia él) solo le llega, con sus
    `Effect`, a quien ve al invisible.
  - Curarse e invocar de un monstruo (`heal_self`, `summon`) no son ataques: `Effect` 3,
    `FloatingText{HEAL}` y `CreatureHealth` al curarse; `CreatureAppear` de cada invocado y
    `Effect` 4 (conjurar) en su casilla al invocar. Entrar en una fase muestra el `Effect`
    7 sobre el monstruo y, si cambia su velocidad, `CreatureSpeed`.
  - No son ataques (no lo mandan): curar, conjurar, un hechizo de condición sobre uno
    mismo (también la invisibilidad), el daño periódico de una condición.
- **Lo que no se filtra** (el mismo criterio que el resto del AOI):
  - Solo lo recibe quien conoce al atacante (`Knows`): un invisible no ataca sin dejar de
    serlo, y el ataque de un jugador termina su invisibilidad **antes** de mandarse, así
    los demás reciben su `CreatureAppear` primero y nunca un ataque de alguien que no
    conocen.
  - Un ataque a alguien que el cliente no conoce no le llega si el objetivo es un
    invisible o está en una casilla que ve (un golpe a una casilla vacía delataría al
    invisible: el de un monstruo que ve invisibles solo le llega al invisible). Si el
    objetivo está fuera de su ventana, le llega sin `target_id` y con `to` en el borde.
    Con el atacante parado en ese borde (el margen de la ventana) y su objetivo justo
    afuera, el borde es la casilla del propio atacante (`to` = su casilla): el ataque
    llega igual (a diferencia de un `Projectile`, que no volaría a ningún lado y no se
    manda) y el cliente lo juega hacia donde mira el atacante (un monstruo se gira hacia
    su objetivo antes de golpear).
  - Quien ve al objetivo pero no al atacante no recibe `CreatureAttack` (no tiene a quién
    animar): le llegan, como antes, el `Projectile` desde el borde y el golpe.
- **`CreatureDisappear{id, reason}`**: por qué salió de la vista, sin decir más de lo que
  quien mira ya ve.

  | `reason` | Cuándo |
  |---|---|
  | `OUT_OF_VIEW` | Caminó fuera de la ventana, o quien mira caminó o fue movido lejos (lo que se borra antes de un `FullMapView`) |
  | `DEATH` | Murió ahí: un monstruo (después de su `CreatureHealth` 0) o un jugador, también en una arena (reaparece en su templo con `CreatureAppear`) |
  | `DESPAWN` | El servidor sacó a un monstruo o NPC sin que muera: los invocados de un monstruo que murió, se rindió o se quedó sin objetivo (docs/02 "Habilidades"). Queda también para monstruos de eventos |
  | `TELEPORT` | Dejó su casilla sin caminar ni morir: un portal (escalera, agujero, teletransporte, escalera de mano, soga), un barco, `/tp`, el teleport de un NPC, la expulsión de una casa. **Volverse invisible también** manda `TELEPORT`: para quien mira se fue, y nada dice que sigue ahí |
  | `LOGOUT` | El jugador salió del juego: `Logout`, la conexión cerrada, una expulsión o un ban, la inactividad, un cliente lento, entrar desde otra conexión, el fin de la pelea de un link-dead (o su muerte: sale del templo) |
  | `UNSPECIFIED` | Un servidor anterior (`attack_events` en `false`) |
- **Cliente:** con `attack_events`, el atacante juega su clip de ataque (o la embestida
  procedural) hacia su objetivo y una criatura cae solo con `DEATH`; sin él, lo deduce
  (`client/src/render/creature-events.ts`, ANI-7).

## Mensajes servidor → cliente (eventos)
| Mensaje | Uso |
|---|---|
| `FullMapView` | Área completa visible (al entrar, teletransportarse o pasar por un portal) y la época de la caminata (`walk_epoch`) |
| `MapSlice` | Fila o columna nueva al moverse |
| `TileUpdate` | Cambió la pila de un tile |
| `TrailWear` | Desgaste de senderos (mundo vivo): las casillas en vista cuyo nivel cambió este tick ("Desgaste de senderos", abajo) |
| `CreatureAppear` / `CreatureDisappear` | Entra o sale de la vista; `CreatureDisappear.reason` dice por qué (A9) |
| `CreatureAttack` | Quién atacó, cómo (`MELEE`, `RANGED`, `SPELL`) y a quién o a qué área (A9) |
| `CreatureMove` | `id`, `from`, `to`, `duration_ms`, `walk_seq` (solo el propio: el `seq` del `Walk` que ejecuta) |
| `CreatureTurn`, `CreatureHealth`, `CreatureOutfit`, `CreatureSpeed` | |
| `Effect` | Efecto visual en posición (`effect_id`) |
| `Projectile` | De A a B (`projectile_id`) |
| `LivingObjectEvent` | Qué le pasó a un objeto del mundo vivo (golpe, rotura, empuje, restos que se desvanecen...) para efectos y sonido; su aspecto llega siempre en `TileUpdate` ("Mundo vivo") |
| `FloatingText` | Daño, curación, XP |
| `PlayerStats` | HP, MP, nivel, XP, capacidad, velocidad, alma |
| `PlayerSkills` | Nivel y % de cada skill |
| `SpellCooldown` | Cooldown propio y de grupo de un hechizo lanzado (T1.9) |
| `PlayerConditions` | Lista completa de las condiciones propias activas (T3.2) y de los estados `in_combat`, `pvp_locked` y `protection_zone` (lote 13) |
| `PartyUpdate` / `PartyInvitation` | Estado completo del grupo propio; invitación recibida (T3.3) |
| `TutorialStep` | Paso actual del tutorial y su progreso, o su fin (T4.2) |
| `QuestLog` | El diario de misiones entero: al entrar y en cada tick en que cambió una quest ("Diario de misiones") |
| `StationOpen` | Estación de oficio usada: `pos`, `item_id`, unidades llevadas de sus ingredientes (`owned`) y `tools` llevadas; llega de nuevo tras cada `Craft` (T3.4). En el yunque, `owned` también cuenta las piedras de temple y el ámbar, y `money` es el dinero que se lleva; llega también tras cada `Refine` |
| `RefineResult` | Cómo terminó un intento de la forja: `outcome` (`SUCCESS`, `BROKEN`, `PROTECTED`), `item` (la instancia después, sin `mods` si se rompió), `level` y `text` (el mismo `LocalizedText` del mensaje del log) |
| `Inventory` / `ContainerOpen` / `ContainerUpdate` / `ContainerClose` | |
| `Message` | Chat y mensajes del sistema (clave i18n + parámetros) |
| `DialogOpen` / `DialogClose` | Diálogo de NPC con texto y opciones |
| `ShopOpen` | Lista de compra/venta |
| `TradeUpdate` | Estado de la ventana de intercambio (T5.3) |
| `MarketUpdate` | La ventana del mercado, o su cierre (T5.3) |
| `HouseUpdate` | La ventana de una casa, o su cierre (T5.4) |
| `CreatureCosmetics` | Cambiaron los cosméticos equipados de un jugador visible (T5.7) |
| `CreatureLook` | Cambió el cuerpo o el equipo visible de un jugador que se conoce ("Apariencia y equipo visible") |
| `CosmeticsState` | Cosméticos de la cuenta, saldo premium y lo equipado (T5.7) |
| `WalkRejected` | El cliente corrige su predicción: posición, paso rechazado y época nueva de la caminata (`walk_epoch`) |
| `Pong`, `Disconnect` | |

Los textos del servidor viajan como **clave i18n + parámetros** (`LocalizedText`), no
como texto final. El cliente traduce según su idioma. El chat escrito por jugadores
viaja tal cual (`Message.text`); lo que escribe el servidor va en `Message.localized`.
Monstruos y NPCs se identifican con su `content_id` de `data/` y el cliente traduce su
nombre; solo los jugadores llevan `name` (en `Message`: `speaker_name` solo para
jugadores, `speaker_content_id` para NPCs y monstruos).

### Formato de mapa en `FullMapView` / `MapSlice`
Ambos llevan un `MapArea {x, y, width, height, palette[], floors[], creatures[]}`:
- `palette`: pilas de tile (`Tile {items[]}`, suelo primero) distintas del área (los
  `mods` cuentan: dos espadas con distinto atributo son dos pilas).
- `floors[]`: `MapFloor {z, tiles[]}` con `width × height` índices a `palette`, fila
  por fila (y, luego x). `-1` = sin tile.
- `creatures`: criaturas paradas dentro del área.
- `wear`: el desgaste de senderos del área en el piso del jugador (un `TrailWear`, si hay
  alguna casilla gastada; abajo). Los pisos que se ven desde arriba no lo traen: los
  cambios de nivel solo llegan a quien está en el piso de la casilla.
`MapSlice` usa el mismo formato con la fila o columna nueva (`width` o `height` = 1).

### Desgaste de senderos (`proto/game/v1/livingworld.proto`, lote 17)
El pasto gastado por los pasos de los jugadores (docs/02 "Senderos",
`livingworld/README.md`). `TrailWear {z, tiles[], levels}`: `tiles[i]` es `x << 16 | y` de
una casilla del piso `z` y `levels[i]` (un byte) su nivel, 0 nada, 1 pisoteado, 2 gastado,
3 tierra pelada. Viaja de dos formas:
- en `MapArea.wear` de un `FullMapView` o un `MapSlice`: todas las casillas del área en el
  piso del jugador con nivel mayor que 0. El cliente olvida antes lo que tenía dentro de esa área (lo que pasó
  mientras no la veía llega así);
- como `ServerMessage.trail_wear` (campo 49; el 48 es `LivingObjectEvent` de los
  rompibles): las casillas que el jugador ve cuyo nivel cambió en el tick (0: el pasto se
  recuperó). Solo cambios de nivel, nunca cada paso: una casilla cruza un umbral cada
  muchos pasos o cada varios minutos de recuperación.
El cliente no lo inventa ni lo predice: lo guarda (`client/src/state/trail-wear.ts`) y lo
dibuja el mundo vivo (`applyWear`).

Reglas del área de interés (T1.4; vista ancha desde 2026-11):
- El área es de 33x23 casillas centrada en el jugador: la ventana de 31x21
  (`Welcome.view_width`/`view_height`) más 1 de margen por lado. Antes de la vista ancha
  era de 17x13 (15x11 + 1): el formato no cambió, solo el tamaño, así que un cliente viejo
  la recibe igual y dibuja sus 15x11 del centro. `MapArea.x/y` es la esquina superior
  izquierda; cerca del borde del mundo (coordenada 0) el área se recorta y
  `width`/`height` lo dicen.
- La ventana es la misma para todos los jugadores, sea cual sea su pantalla o su zoom (que
  son solo de dibujo): así "A ve a B" es simétrico. Lo que nota un monstruo no es esta
  ventana, sino la clásica de 15x11 + 1 (`02-game-design.md`, "La vista").
- **Pisos:** en la superficie o arriba (z ≤ 7) se mandan los pisos 0–7; bajo tierra solo
  el piso actual. Un piso sin ninguna casilla en el área no se manda. Las criaturas se
  ven con la misma regla, así que "A ve a B" es simétrico.
- Tile = suelo y luego la pila de items de `world.bin`, de abajo arriba, y encima los
  items del servidor (T1.8) con su `count` si son apilables (0 en los demás).
- **Paso ortogonal:** un `MapSlice` con la columna (23 de alto) o la fila (33 de ancho) nueva. **Paso
  diagonal:** dos `MapSlice`, primero la columna completa (23) y después la fila sin la
  esquina (32).
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
  sin límite fijo, pero `FullMapView` se comprime con la paleta y suele quedar < 20 KB
  (~1 KB en el pueblo de Lanternby con la vista de 31x21).
- Frames de texto o protobuf inválido después del `Hello` → `Disconnect{KICKED}`.
- Rate limit: 30 comandos/s por conexión (ráfaga 60). Un mensaje sin ficha se descarta
  y suma deuda; la deuda se paga con la misma recarga. Con más de 30 de deuda →
  `Disconnect{RATE_LIMITED}`. Así solo desconecta el exceso **sostenido**: a 40/s, tras
  ~9 s; a 30/s, nunca.
- Cola de salida por sesión acotada (128 batches ≈ 6,4 s de ticks): si un cliente lento
  la llena, el servidor lo saca del mundo, lo guarda y cierra con
  `Disconnect{SLOW_CLIENT}` (sin mandarle los batches pendientes) en vez de consumir
  memoria. En combate cierra igual, pero el personaje queda en el mundo link-dead hasta
  que la pelea termina (lo que esa conexión mandó después no se ejecuta).
- **Conexiones a `/ws` (lote 16, `gateway/admit.go`).** El servidor cuenta por **cliente**:
  su IPv4, o su /64 en IPv6 (un abonado suele tener un /64 entero); detrás de Caddy, con
  `-trust-proxy`, la última entrada de `X-Forwarded-For`, la misma regla que el rate
  limit de la API HTTP (`net/clientip`). Antes de aceptar el WebSocket revisa, en orden:

  | Límite | Flag de `gameserver` | Por defecto | Rechazo |
  |---|---|---|---|
  | Conexiones de todos aún en el handshake | `-ws-max-unauthenticated` | 1000 | HTTP 503 |
  | Handshakes leyendo la base a la vez (canje del token y carga del personaje) | `-ws-max-handshakes` | 32 | HTTP 503 si están todos ocupados; el que ya mandó `Hello` espera hasta 5 s y si no, `SERVER_FULL` |
  | Conexiones abiertas de un cliente (con jugador o no) | `-ws-max-conns-per-ip` | 32 | HTTP 429 |
  | Conexiones de un cliente aún en el handshake | `-ws-max-pending-per-ip` | 4 | HTTP 429 |
  | Conexiones nuevas de un cliente (balde) | `-ws-handshake-burst`, `-ws-handshake-every` | 5 seguidas, después 1 cada 2 s | HTTP 429 |
  | Jugadores (conexiones con personaje o con el token ya canjeado) | `-max-players` | 500 | `Disconnect{SERVER_FULL}` después del `Hello` |
  | Personajes de una cuenta en el mundo | `-max-chars-per-account` | 2 | `Disconnect{TOO_MANY_CHARACTERS}` |
  | Comandos de una conexión esperando en la cola del loop | `-ws-max-queued-per-conn` | 64 (≥ la ráfaga de 60 del limitador) | se descartan (ver docs/01, "Equidad de la cola") |

  Un rechazo HTTP lleva `Retry-After` y nunca llega al `Hello` ni a la base: el navegador
  solo ve que la conexión falló (el cliente muestra el texto de conexión perdida). Cada
  rechazo suma en `ws_refused_total{reason}` de `/metrics`: `client_limit` (429),
  `server_busy` (503) y `server_full` (`SERVER_FULL`).
  **IP compartida (NAT).** Un "cliente" es una IPv4 pública: detrás de un CGNAT de
  telefonía móvil, un cibercafé o un colegio, muchos jugadores honestos comparten una. Por
  eso el tope de conexiones abiertas es holgado (32): cada jugador conectado usa una. Lo
  que protege la base son los handshakes pendientes (4) y el balde (5 seguidas, luego 1
  cada 2 s), que sí quedan ajustados: si todo un grupo detrás de la misma IP se reconecta
  a la vez (un corte de la red), los que pasan del balde reciben 429 y entran reintentando
  unos segundos después. Con más de 32 jugadores detrás de una IP, el 33.º recibe 429. Un
  valor de `-1` quita ese límite (solo para pruebas de carga). Con
  `-ws-loopback-exempt` (por defecto solo si `RPG_ENV` es `development` o `test`) los
  límites **por cliente** no se aplican a 127.0.0.0/8 ni a `::1`: los bots, el E2E y
  `make play` corren en la misma máquina; los globales sí. En producción (`RPG_ENV`
  vacío o `production`) no hay excepción, y detrás de Caddy el cliente es la IP real.
  Los bots (`tools/bots`) comparten cuenta de a 2, lo que cabe en
  `-max-chars-per-account` por defecto: corren también contra servidores con los límites
  de producción (los jobs `stack` y `home-stack` de CI). Contra un servidor con `URL=` en
  esta máquina hace falta `-ws-loopback-exempt` (y un `-auth-rate-burst` mayor si son
  muchos bots).
  Al recibir el `Hello` solo se mira si queda lugar de `-max-players` (así un servidor
  lleno no gasta tokens ni lee la base); el lugar se toma recién después de canjear el
  token con éxito. Un `Hello` con un token falso de forma válida no ocupa lugar mientras
  espera turno de la base ni durante el canje (revisión del lote 16).
- **Logs acotados:** los comandos descartados de una conexión, los canjes de token y las
  cargas de personaje que fallan por la base y los logins rechazados por la cola llena se
  registran una vez por intervalo (10 s) con la cuenta (`count`), no uno por evento.
- Orígenes del navegador: por defecto solo el mismo host; otros (servidor de Vite,
  Tauri) con `-ws-origins` o `RPG_WS_ORIGINS` (lista separada por comas). Un patrón con
  `://` se compara con `esquema://host`: el cliente de escritorio usa
  `tauri://localhost,http://tauri.localhost` (default del compose de producción).

## Presupuesto de ancho de banda
Objetivo: < 4 KB/s promedio por jugador en zona concurrida. Con 100 jugadores ≈ 400 KB/s
de salida, cómodo para una instancia chica.

Con la vista de 31x21 (`07-performance-budget.md`, "Vista ancha"), los escenarios de la
prueba de carga jugados en proceso dan 490 B/s por jugador (100 repartidos por Puerto) y
1676 B/s (300 en el pueblo, donde todos ven a todos); con 15x11 eran 309 y 785. Un
`FullMapView` en el pueblo de Lanternby pesa ~1 KB (antes ~350 B). Los eventos de ataque y
los motivos de A9 suben eso a 532 y 1684 B/s (`07-performance-budget.md`, "Eventos de
ataque"): un `CreatureAttack` pesa unos 23 B por cliente que lo recibe y un motivo, 2 B.
El aspecto (lote 13, `07-performance-budget.md` "Aspecto y equipo visible") suma a cada
`Creature` humanoide unos 35–45 B (`BodyLook`; un monstruo o un NPC, además sus piezas) y
a uno que lleva equipo unos 10–20 B (`VisibleEquipment`); solo al aparecer o al cambiar,
nunca por paso.
El desgaste de senderos (lote 17) suma unos 4–5 B por casilla gastada al `MapArea` (3–4 B
de `x << 16 | y` en varint y 1 B de nivel) y nada a un área sin desgaste: una columna nueva
con un sendero que la cruza, ~10 B. Un cambio de nivel es un `TrailWear` de ~10 B para
cada jugador que ve la casilla, y con los números de `wear.yaml` una casilla cambia de
nivel cada decenas de pasos o cada varios minutos: despreciable al lado de los pasos.
El `WorldClock` (día y noche) pesa unos 12 B, uno por jugador al entrar y uno por minuto:
0,2 B/s.
