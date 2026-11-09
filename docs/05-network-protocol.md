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
| `GET /api/characters` | token | — | `200 {characters: [{id, name, vocation, level}]}` |
| `POST /api/characters` | token | `{name, vocation}` | `201 {character: {id, name, vocation, level}}` |
| `POST /api/play` | token | `{character_id}` | `200 {session_token, expires_at}` (vive 60 s, un uso) |
| `GET /healthz` | — | — | `200 {status: "ok"}` / `503` si Postgres no responde |
| `GET /api/status` | — | — | `200 {online, players, version}` (T4.3, público) |
| `GET /api/highscores?category=&vocation=&page=` | — | — | `200 {category, vocation, page, page_size, has_more, entries: [{rank, name, vocation, value}]}` (T4.3, público) |
| `POST /api/maps/submissions` y demás `/api/maps/...` | token | ver "Envío de mapas" | T4.5 |
| `GET /api/auth/config` | — | — | `200 {email}`: si el servidor manda emails (T2.1) |
| `GET /api/account` | token | — | `200 {email, email_verified, email_enabled}` |
| `POST /api/auth/verify` | — | `{token}` | `204`; `400 invalid_token` |
| `POST /api/auth/verify/resend` | token | `{lang?}` | `202`; `409 already_verified`, `404 email_disabled`, `429` |
| `POST /api/auth/password/forgot` | — | `{email, lang?}` | `202` siempre (exista o no la cuenta); `404 email_disabled` |
| `POST /api/auth/password/reset` | — | `{token, password}` | `204`, revoca todas las sesiones y borra la cookie; `400 invalid_token` / `invalid_password` |

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
  (se guardan como en un logout). Vale igual para un enlace de `gameserver admin reset-link`.
  Ventana residual: un token de juego canjeado justo antes del reset cuyo `Hello` llegue al
  loop después del kick (milisegundos) entra igual; no puede volver a entrar después.
- Canjear un reset exige que la cuenta siga habilitada y con el email al que se mandó.
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
| `GET /api/auth/config` | — | — | `{email, providers: ["discord","google"], public_url}` (solo los que tienen claves; nunca secretos). En otra dirección que `public_url` el cliente esconde los botones |
| `POST /api/auth/oauth/{provider}/start` | — | `{return?}` | `200 {url}` + cookie `rpg_oauth`; el navegador va a `url` |
| `POST /api/auth/oauth/{provider}/link` | token | `{password?}` | igual que `start`, para vincular a la cuenta |
| `GET /api/auth/oauth/{provider}/callback` | cookie `rpg_oauth` | — | `303` a una página fija del sitio (abajo) |
| `GET /api/auth/oauth/pending` | cookie `rpg_oauth_pending` | — | `200 {provider, email}`; `410 pending_expired` |
| `POST /api/auth/oauth/pending/confirm` | cookie pendiente | `{password}` | `200 {return}` + cookie de sesión |
| `POST /api/auth/oauth/pending/create` | cookie pendiente | `{email}` | `200 {return}` + cookie de sesión |
| `POST /api/account/unlink` | token | `{provider}` | `204`; `409 last_login_method`, `404 not_linked` |

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
- `GET /api/auth/oauth/pending` dice también `has_password`: sin contraseña la página no la
  pide (se vincula desde "Mi cuenta" entrando con el otro proveedor).
- Todas estas rutas gastan el límite por IP de registro y login, salvo `pending` y `unlink`.
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
  del ranking, y una cache propia de 60 s (también para los 404: ids al azar no llegan a
  Postgres). Un cambio del juego se ve como mucho 60 s después.

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
| `account_banned` | 403 | Cuenta suspendida por el staff (T2.6); solo con la contraseña correcta |
| `unauthorized` | 401 | Token ausente, vencido o revocado |
| `invalid_name` / `invalid_vocation` | 400 | Creación de personaje inválida |
| `name_taken` | 409 | Nombre en uso |
| `character_limit` | 409 | La cuenta ya tiene el máximo de personajes |
| `character_not_found` | 404 | `POST /api/play` con un personaje que no es de la cuenta |
| `rate_limited` | 429 | Demasiados intentos de login/registro (por IP o por email) |
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
| `Say` | `channel` (decir, gritar, susurrar, global, grupo), `text` (máx. 255) |
| `NpcTalk` | `creature_id` del NPC (T1.10) |
| `DialogChoose` | `dialog_id`, `option_id` (0 = cerrar) |
| `ShopBuy` / `ShopSell` | `dialog_id`, `item_id`, `count` (1..100) (T1.10) |
| `TradeRequest` | `creature_id`, `item`, `item_id`, `stack_index` |
| `TradeOffer` | `item`, `item_id`, `stack_index` |
| `TradeAccept` / `TradeCancel` | — |
| `CloseContainer` | `container_id` (T1.8) |
| `PartyCommand` | `action` (invitar, aceptar, rechazar, salir, expulsar, pasar liderazgo, compartir sí/no), `creature_id` (T3.3) |
| `Craft` | `recipe_id`, `station` (posición de la estación, T3.4) |
| `ReportPlayer` | `creature_id` (un jugador a la vista), `reason` (1..200 caracteres) (T4.1) |
| `PresenceAnswer` | `check_id`, `option_id` (respuesta a un `PresenceCheck`, T4.1) |
| `TutorialSkip` | — (termina el tutorial sin premio, T4.2) |
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
  `DialogOption.text` son claves i18n (`presence.question.<color>`,
  `presence.option.<color>`). Los ids de las opciones van del 1 al 9 en orden al azar.
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
  abierto. Las rutas de barco de un nodo `boat_routes: true` (T3.5) van primero, con
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

### Grupos (T3.3, `server/internal/session/party.go`)
Reglas y números en `02-game-design.md` ("Grupos") y `balance.yaml` `party`.
- **`PartyCommand{action, creature_id}`**:
  - `INVITE` (`creature_id` = un jugador que el cliente ve): solo el líder o alguien sin
    grupo. Cuenta para el anti-flood del chat. Al invitado le llega
    `PartyInvitation{inviter_id, inviter_name, expires_ms}`; al que invita, `party.invited`
    (`name`). `/invite Nombre` en la línea de chat hace lo mismo por nombre.
  - `ACCEPT` / `DECLINE` (`creature_id` = quien invitó). Aceptar una invitación vencida, de
    alguien que ya no lidera o que se fue → `party.invite_gone`. Rechazar le avisa al que
    invitó (`party.declined`, `name`).
  - `LEAVE`; `KICK` y `PASS_LEADER` (`creature_id` = otro miembro, solo el líder);
    `SHARE_ON` / `SHARE_OFF` (solo el líder). `PASS_LEADER` y un `SHARE_*` que cambia algo
    cuentan para el anti-flood del chat (`chat.flood`, `chat.muted`).
- **`PartyUpdate{leader_id, shared, members[]}`**: el grupo completo, en orden de
  llegada, el propio jugador incluido. Llega cuando cambia el grupo (miembros, líder,
  experiencia compartida, indicador) y, como mucho cada `update_ms`, cuando cambia lo que
  el jugador ve de otro miembro. Sin `members` = ya no está en un grupo. `shared`:
  `OFF`, `ACTIVE` (dos o más de los miembros que el jugador ve, él incluido, califican) o
  `INACTIVE`.
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
  `party.not_a_member`, `party.invite_gone`, `party.invite_usage`, `party.declined`,
  `party.joined`, `party.left`, `party.kicked`, `party.new_leader` (todos con `name`),
  `party.you_were_kicked`, `party.disbanded`, `party.shared_on`, `party.shared_off`.

### Gremios (T5.1, `server/internal/session/guild.go`)
Reglas y números en `02-game-design.md` ("Gremios") y `balance.yaml` `guild`.
- **`GuildCommand{action, name, text, guild_id}`**. Los miembros se nombran por nombre de
  personaje (pueden estar desconectados). Cada comando cuenta para el anti-flood del chat.
  - `CREATE` (`name` = el gremio), `INVITE` / `REVOKE` (`name` = un personaje conectado),
    `ACCEPT` / `DECLINE` (`guild_id` de la invitación), `LEAVE`, `KICK`, `PROMOTE`,
    `DEMOTE`, `TRANSFER` (`name` = un miembro), `MOTD` (`text`; vacío lo borra) y
    `DISBAND` (`name` repite el nombre del gremio, como confirmación).
  - El chat hace lo mismo: `/guild create|invite|revoke|accept|decline|leave|kick|promote|
    demote|motd|transfer|disband ...`; `accept`, `decline` y `disband` llevan el nombre del
    gremio. Sin argumentos o con una acción desconocida → `guild.usage`.
- **`GuildUpdate{guild_id, name, motd, rank, members[], pending[], invitations[]}`**: el
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
- **Daño periódico**: cada golpe es un golpe más (`Effect 10 + elemento`, `FloatingText`,
  `CreatureHealth`, `PlayerStats` al afectado).
- **Velocidad**: el afectado recibe `PlayerStats.speed` y quien lo ve `CreatureSpeed`; los
  `CreatureMove.duration_ms` siguientes ya usan la velocidad nueva.
- **Efecto 7** (`EffectBuff`): un hechizo de condición sobre su objetivo o una cura.
- `magic.nothing_to_cure`: una cura sin nada que curar (no gasta maná).
- **Invisibilidad, filtrada en el servidor**: al volverse invisible, quien lo conocía recibe
  `CreatureDisappear`. Mientras dure, nadie más lo recibe: ni en `FullMapView` /
  `MapSlice`, ni `CreatureAppear` o `CreatureMove`, ni sus golpes, curas o vida
  (`Effect`, `FloatingText`, `CreatureHealth`), ni un `Projectile` hacia él. Su chat local
  llega con su nombre pero sin `pos`. Al terminar le llega `CreatureAppear` a quien ve su
  casilla. Solo su propio cliente lo sigue recibiendo (y lo dibuja semitransparente).
  Un invisible sigue ocupando su casilla: quien intente pisarla recibe `WalkRejected` (un
  camino por click lo rodea) y los monstruos lo esquivan. Es una pista aceptada.

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
| `PlayerConditions` | Lista completa de las condiciones propias activas (T3.2) |
| `PartyUpdate` / `PartyInvitation` | Estado completo del grupo propio; invitación recibida (T3.3) |
| `TutorialStep` | Paso actual del tutorial y su progreso, o su fin (T4.2) |
| `StationOpen` | Estación de oficio usada: `pos`, `item_id`, unidades llevadas de sus ingredientes (`owned`) y `tools` llevadas; llega de nuevo tras cada `Craft` (T3.4) |
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
